import type { CommandContext, CommandResult } from './router.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { scanAllSkills, findSkill, type SkillInfo } from '../codex/skill-scanner.js';
import { getCurrentAuthProfile, listAuthProfiles, saveCurrentAuthProfile, validateProfileName } from '../codex/auth-profiles.js';
import type { ExecutionMode } from '../session.js';

const HELP_TEXT = `可用命令：

  /help             显示帮助
  /clear            清除当前会话
  /model <名称>     切换 Codex 模型
  /cwd <路径>       切换工作目录
  /mode <模式>      切换执行模式
  /codex-auth       查看/保存/切换 Codex 认证账号
  /status           查看当前会话状态
  /now <内容>       中断当前回合并清空排队，立即执行内容
  /receive          接收此前暂存的微信回复
  /skills           列出已安装的 skills
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与本机 Codex 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model gpt-5.4', handled: true };
  }
  const previous = ctx.session.model;
  ctx.updateSession({ model: args, threadId: undefined });
  return {
    reply: previous === args
      ? `当前已经是模型: ${args}`
      : `✅ 模型已切换为: ${args}\n正在重启 Codex 会话以应用新模型。`,
    handled: true,
    restartBridge: previous !== args,
  };
}

function expandUserPath(input: string): string {
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  if (input === '~') {
    return homedir();
  }
  return resolve(input);
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /cwd <目录路径>', handled: true };
  }
  const nextPath = expandUserPath(args.trim());
  if (!existsSync(nextPath)) {
    return { reply: `目录不存在: ${nextPath}`, handled: true };
  }
  if (!statSync(nextPath).isDirectory()) {
    return { reply: `不是目录: ${nextPath}`, handled: true };
  }
  ctx.updateSession({ workingDirectory: nextPath, threadId: undefined });
  return {
    reply: `✅ 工作目录已切换为: ${nextPath}\n正在重启 Codex 会话以应用新目录与沙箱范围，请稍候。`,
    handled: true,
    restartBridge: true,
  };
}

const MODE_DESCRIPTIONS: Record<ExecutionMode, string> = {
  plan: '只读分析模式',
  workspace: '工作区可写模式',
  danger: '无沙箱模式',
};

const MODE_ALIASES: Record<string, ExecutionMode> = {
  plan: 'plan',
  workspace: 'workspace',
  danger: 'danger',
  sandbox: 'workspace',
  sudo: 'danger',
};

export function handleMode(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.mode ?? 'workspace';
    const lines = [
      '🔒 当前执行模式: ' + current,
      '',
      '可用模式:',
      '  sandbox — 工作目录可写沙箱（等同 workspace）',
      '  sudo — 无 Codex 沙箱（等同 danger）',
      '  plan — 只读分析模式',
      '  workspace — 工作区可写模式',
      '  danger — 无沙箱模式',
      '',
      '用法: /mode sandbox|sudo|plan|workspace|danger',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const input = args.trim().toLowerCase();
  const mode = MODE_ALIASES[input];
  if (!mode) {
    return {
      reply: `未知模式: ${input}\n可用: sandbox, sudo, plan, workspace, danger`,
      handled: true,
    };
  }
  const previous = ctx.session.mode ?? 'workspace';
  ctx.updateSession({ mode, threadId: undefined });
  const warning = mode === 'danger' ? '\n\n⚠️ danger 模式会以无沙箱方式运行本机 Codex。' : '';
  return {
    reply: previous === mode
      ? `当前已经是: ${mode}\n${MODE_DESCRIPTIONS[mode]}`
      : `✅ 执行模式已切换为: ${mode}\n${MODE_DESCRIPTIONS[mode]}\n正在重启 Codex 会话以应用新模式。${warning}`,
    handled: true,
    restartBridge: previous !== mode,
  };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.mode ?? 'workspace';
  const currentAuth = getCurrentAuthProfile();
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `执行模式: ${mode}`,
    `Codex Auth: ${currentAuth.name ?? (currentAuth.exists ? '未纳入 profile 管理' : '未登录')}`,
    `线程ID: ${s.threadId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleReceive(): CommandResult {
  return { handled: true, receiveDeferred: true };
}

export function handleCodexAuth(args: string): CommandResult {
  const [subcommandRaw, profileNameRaw] = args.split(/\s+/, 2);
  const subcommand = (subcommandRaw || 'current').toLowerCase();

  switch (subcommand) {
    case 'current': {
      const current = getCurrentAuthProfile();
      if (!current.exists) {
        return { reply: '当前未找到 Codex auth.json，请先在终端运行 codex login。', handled: true };
      }
      return {
        reply: [
          `当前 Codex Auth: ${current.name ?? '未纳入 profile 管理'}`,
          `auth.json: ${current.isSymlink ? '软链接' : '普通文件'}`,
          current.targetPath ? `目标: ${current.targetPath}` : '',
        ].filter(Boolean).join('\n'),
        handled: true,
      };
    }
    case 'list': {
      const profiles = listAuthProfiles();
      if (profiles.length === 0) {
        return { reply: '未找到 Codex auth profiles。请先在终端运行 npm run codex-auth save <name>。', handled: true };
      }
      const lines = profiles.map((p) => `${p.isCurrent ? '*' : ' '} ${p.name}`);
      return { reply: `Codex Auth Profiles:\n${lines.join('\n')}`, handled: true };
    }
    case 'use': {
      if (!profileNameRaw) {
        return { reply: '用法: /codex-auth use <name>', handled: true };
      }
      try {
        const profileName = validateProfileName(profileNameRaw);
        return {
          handled: true,
          codexAuthProfile: profileName,
        };
      } catch (err) {
        return { reply: err instanceof Error ? err.message : String(err), handled: true };
      }
    }
    case 'save': {
      if (!profileNameRaw) {
        return { reply: '用法: /codex-auth save <name>', handled: true };
      }
      try {
        const profileName = validateProfileName(profileNameRaw);
        const result = saveCurrentAuthProfile(profileName);
        const lines = [
          result.changed
            ? `✅ 已保存当前 Codex 凭证为: ${profileName}`
            : `当前 Codex 凭证已经是: ${profileName}`,
        ];
        if (result.profilePath) {
          lines.push(`profile: ${result.profilePath}`);
        }
        return { reply: lines.join('\n'), handled: true };
      } catch (err) {
        return { reply: `⚠️ 保存 Codex 凭证失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
      }
    }
    case 'import':
    case 'delete':
      return {
        reply: `微信端不开放 /codex-auth ${subcommand}，请在终端使用 npm run codex-auth ${subcommand}。`,
        handled: true,
      };
    default:
      return {
        reply: [
          '用法:',
          '  /codex-auth current',
          '  /codex-auth list',
          '  /codex-auth save <name>',
          '  /codex-auth use <name>',
        ].join('\n'),
        handled: true,
      };
  }
}

export function handleSkills(): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }
  const lines = skills.map(s => `/${s.name} — ${s.description}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args
      ? `Use the ${skill.name} skill for this request: ${args}`
      : `Use the ${skill.name} skill for the user's request.`;
    return { handled: true, codexPrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
