import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import {
  buildCodexPrompt,
  cleanupTempFiles,
  downloadIncomingFileToPending,
  extractFirstSupportedMedia,
  extractText,
  prepareMediaForCodex,
  type PendingDownloadedFile,
} from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { NativeCodexBridge } from './codex/native-bridge.js';
import { DEFAULT_WORKING_DIRECTORY, loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { dequeueQueuedMessage, enqueueQueuedMessage } from './message-queue.js';
import { DATA_DIR, TMP_DIR } from './constants.js';
import { splitMessage } from './utils/chunk.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

interface QueuedCodexMessage {
  userText: string;
  media: ReturnType<typeof extractFirstSupportedMedia>;
  fromUserId: string;
  contextToken: string;
}

const queuedMessages = new Map<string, QueuedCodexMessage[]>();

// Per-user pending files. When a user sends one or more file messages via
// WeChat, we stash them here (on disk) until the user sends a follow-up
// text message with the processing request, at which point all pending
// files are attached to the Codex turn and cleared.
const pendingIncomingFiles = new Map<string, PendingDownloadedFile[]>();

function appendPendingFile(userId: string, file: PendingDownloadedFile): number {
  const arr = pendingIncomingFiles.get(userId) ?? [];
  arr.push(file);
  pendingIncomingFiles.set(userId, arr);
  return arr.length;
}

function takePendingFiles(userId: string): PendingDownloadedFile[] {
  const arr = pendingIncomingFiles.get(userId) ?? [];
  pendingIncomingFiles.delete(userId);
  return arr;
}

function discardPendingFiles(userId: string): number {
  const arr = pendingIncomingFiles.get(userId) ?? [];
  for (const f of arr) {
    try {
      unlinkSync(f.path);
    } catch {
      // ignore
    }
    try {
      const parent = dirname(f.path);
      if (parent.startsWith(TMP_DIR)) {
        rmSync(parent, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
  pendingIncomingFiles.delete(userId);
  return arr.length;
}

function formatPendingFileBlock(files: PendingDownloadedFile[], userRequest: string): string {
  const list = files
    .map((f, idx) => `${idx + 1}. ${f.fileName} — 绝对路径: ${f.path}`)
    .join('\n');
  const trimmedRequest = userRequest.trim();
  const requestBody = trimmedRequest
    || '（用户未给出具体指令，请先阅读每个文件的内容并回复其概要、结构以及可能的处理建议。）';
  return [
    `以下是用户通过微信上传的 ${files.length} 个文件，请根据「用户需求」处理这些文件。`,
    '',
    '待处理文件：',
    list,
    '',
    '用户需求：',
    requestBody,
  ].join('\n');
}

interface WechatRecipient {
  userId: string;
  contextToken: string;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue || '');
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function openFile(filePath: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'darwin' ? [filePath] : platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

function extractSlashCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).trim();
  return cmd ? cmd.toLowerCase() : null;
}

function formatResetAtTimestamp(epochSeconds?: number): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return '未知';
  const ts = epochSeconds * 1000;
  if (!Number.isFinite(ts)) return '未知';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatRateLimitLine(label: string, usedPercent: number, windowMinutes?: number, resetsAt?: number): string {
  const remaining = Math.max(0, 100 - usedPercent);
  const windowText = typeof windowMinutes === 'number' ? `${windowMinutes} 分钟窗口` : '窗口未知';
  const usedText = usedPercent.toFixed(1);
  const remainText = remaining.toFixed(1);
  return `${label}: 已用 ${usedText}% / 剩余 ${remainText}% (${windowText}, 重置: ${formatResetAtTimestamp(resetsAt)})`;
}

function formatQuotaStatusLines(snapshot: ReturnType<NativeCodexBridge['getLatestRateLimits']>): string[] {
  if (!snapshot) {
    return ['Codex 剩余额度: 暂无数据（等待 Codex 产生 token_count 事件后更新）'];
  }

  const lines = ['Codex 剩余额度:'];
  if (snapshot.planType) {
    lines.push(`套餐: ${snapshot.planType}`);
  }
  if (snapshot.primary) {
    lines.push(formatRateLimitLine('主额度', snapshot.primary.usedPercent, snapshot.primary.windowMinutes, snapshot.primary.resetsAt));
  }
  if (snapshot.secondary) {
    lines.push(formatRateLimitLine('次额度', snapshot.secondary.usedPercent, snapshot.secondary.windowMinutes, snapshot.secondary.resetsAt));
  }
  if (!snapshot.primary && !snapshot.secondary) {
    lines.push('暂无窗口数据');
  }
  return lines;
}

function ensureUsableDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`不是目录: ${cwd}`);
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const qrPath = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    const isHeadlessLinux = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
      } catch {
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(qrPath, pngData);
      openFile(qrPath);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${qrPath}\n`);
    }

    console.log('等待扫码绑定...');
    try {
      await waitForQrScan(qrcodeId);
      console.log('绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  try {
    unlinkSync(qrPath);
  } catch {
    logger.warn('Failed to clean up QR image', { path: qrPath });
  }

  const workingDir = await promptUser('请输入默认工作目录', DEFAULT_WORKING_DIRECTORY);
  const config = loadConfig();
  config.workingDirectory = workingDir;
  if (!config.mode) {
    config.mode = 'workspace';
  }
  saveConfig(config);

  console.log('\n设置完成！运行 npm start 启动服务');
}

// ── Daemon ──────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const maybeAccount = loadLatestAccount();

  if (!maybeAccount) {
    console.error('未找到账号，请先运行 npm run setup');
    process.exit(1);
  }

  const account = maybeAccount;
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session = sessionStore.load(account.accountId);
  if (session.state === 'processing') {
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }
  const sender = createSender(api, account.accountId, account.baseUrl, account.botToken);

  const cwd = session.workingDirectory || config.workingDirectory;
  ensureUsableDirectory(cwd);

  let lastRecipient: WechatRecipient | null = null;
  let activeTempFiles: string[] = [];

  async function sendTextToWechat(text: string): Promise<void> {
    if (!lastRecipient) return;
    try {
      for (const chunk of splitMessage(text)) {
        await sender.sendText(lastRecipient.userId, lastRecipient.contextToken, chunk);
      }
    } catch (err) {
      logger.warn('Failed to send to WeChat', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function sendImageToWechat(imagePath: string): Promise<void> {
    if (!lastRecipient) return;
    try {
      await sender.sendImage(lastRecipient.userId, lastRecipient.contextToken, imagePath);
    } catch (err) {
      logger.warn('Failed to send image to WeChat', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function sendAttachmentToWechat(
    attachment: { kind: 'image' | 'file' | 'voice' | 'video'; path: string },
  ): Promise<void> {
    if (!lastRecipient) {
      logger.warn('Drop attachment: no WeChat recipient yet', { attachment });
      return;
    }
    if (!existsSync(attachment.path)) {
      logger.warn('Drop attachment: file not found', { attachment });
      await sendTextToWechat(`⚠️ 无法发送附件（文件不存在）：${attachment.path}`);
      return;
    }
    try {
      const { userId, contextToken } = lastRecipient;
      if (attachment.kind === 'image') {
        await sender.sendImage(userId, contextToken, attachment.path);
      } else if (attachment.kind === 'file') {
        await sender.sendFile(userId, contextToken, attachment.path);
      } else if (attachment.kind === 'voice') {
        await sender.sendVoice(userId, contextToken, attachment.path);
      } else if (attachment.kind === 'video') {
        await sender.sendVideo(userId, contextToken, attachment.path);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to send attachment to WeChat', { attachment, error: errMsg });
      await sendTextToWechat(`⚠️ 发送附件失败 (${attachment.kind}): ${attachment.path}\n${errMsg.slice(0, 400)}`);
    }
  }

  async function sendWechatMessageToCodex(
    userText: string,
    media: ReturnType<typeof extractFirstSupportedMedia>,
    fromUserId: string,
    contextToken: string,
  ): Promise<void> {
    session.state = 'processing';
    sessionStore.save(account.accountId, session);
    lastRecipient = { userId: fromUserId, contextToken };

    const tempFiles: string[] = [];
    let prompt = userText.trim();
    let imagePaths: string[] = [];

    // Pluck any files the user has accumulated via previous WeChat file
    // messages. They ride along with this turn's request and get cleaned up
    // after the turn completes.
    const pendingFiles = takePendingFiles(fromUserId);
    for (const f of pendingFiles) {
      tempFiles.push(f.path);
    }

    try {
      if (media) {
        const prepared = await prepareMediaForCodex(media);
        tempFiles.push(...prepared.tempFiles);

        if (prepared.immediateReply) {
          session.state = 'idle';
          sessionStore.save(account.accountId, session);
          await sendTextToWechat(prepared.immediateReply);
          cleanupTempFiles(tempFiles);
          return;
        }

        prompt = buildCodexPrompt(userText, prepared);
        imagePaths = prepared.imagePaths;
      }

      if (pendingFiles.length > 0) {
        prompt = formatPendingFileBlock(pendingFiles, prompt);
      }

      if (!prompt) {
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        await sendTextToWechat('⚠️ 未提取到可发送给 Codex 的内容，请重试。');
        cleanupTempFiles(tempFiles);
        return;
      }

      activeTempFiles = tempFiles;
      bridge.setCwd(session.workingDirectory || config.workingDirectory);
      await bridge.sendWechatTurn(prompt, imagePaths.length ? imagePaths : undefined);
    } catch (err) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      cleanupTempFiles(tempFiles);
      activeTempFiles = [];
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send to Codex', { error: errMsg });
      await sendTextToWechat(`⚠️ ${errMsg.slice(0, 1200)}`);
    }
  }

  function processNextQueued(): void {
    const next = dequeueQueuedMessage(queuedMessages, account.accountId);
    if (next) {
      logger.info('Processing queued message', { accountId: account.accountId });
      void sendWechatMessageToCodex(next.userText, next.media, next.fromUserId, next.contextToken);
    }
  }

  function clearQueuedMessages(accountId: string): number {
    const count = queuedMessages.get(accountId)?.length ?? 0;
    queuedMessages.delete(accountId);
    return count;
  }

  // ── Native Codex Bridge ──

  const mode = (session.mode ?? config.mode ?? 'workspace') as 'plan' | 'workspace' | 'danger';
  const bridge = new NativeCodexBridge(cwd, {
    onWechatReply: (text) => {
      void sendTextToWechat(text);
    },
    onWechatAttachment: (attachment) => {
      void sendAttachmentToWechat(attachment);
    },
    onTurnFinalized: () => {
      if (activeTempFiles.length > 0 || session.state !== 'idle') {
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
      }
      if (activeTempFiles.length > 0) {
        cleanupTempFiles(activeTempFiles);
        activeTempFiles = [];
      }
      processNextQueued();
    },
    onWechatTurnComplete: () => {
      // Legacy hook retained for compatibility; queue progression and cleanup
      // are handled in onTurnFinalized to cover all completion paths.
    },
    onError: (msg) => logger.error('Bridge error', { error: msg }),
    onExit: (code) => {
      logger.info('Codex exited', { code });
      monitor.stop();
      process.exit(code ?? 0);
    },
  }, mode);

  // ── WeChat Monitor ──

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (msg.message_type !== MessageType.USER) return;
      if (!msg.from_user_id || !msg.item_list) return;

      const contextToken = msg.context_token ?? '';
      const fromUserId = msg.from_user_id;
      const userText = extractTextFromItems(msg.item_list);
      const media = extractFirstSupportedMedia(msg.item_list);
      const isSlashCommand = userText.startsWith('/');

      lastRecipient = { userId: fromUserId, contextToken };

      // Handle slash commands (work even when busy)
      if (isSlashCommand) {
        const slashCommand = extractSlashCommandName(userText);
        const updateSession = (partial: Partial<Session>) => {
          Object.assign(session, partial);
          sessionStore.save(account.accountId, session);
          if (partial.workingDirectory) {
            bridge.setCwd(partial.workingDirectory);
          }
        };

        const ctx: CommandContext = {
          accountId: account.accountId,
          session,
          updateSession,
          clearSession: () => {
            const dropped = discardPendingFiles(fromUserId);
            if (dropped > 0) {
              logger.info('Dropped pending files on /clear', { fromUserId, count: dropped });
            }
            return sessionStore.clear(account.accountId, session);
          },
          text: userText,
        };

        const result: CommandResult = routeCommand(ctx);
        if (result.nowPrompt !== undefined) {
          const droppedExternal = clearQueuedMessages(account.accountId);
          const { interrupted, clearedQueued: droppedBridge } = bridge.interruptAndClearQueue();
          const prompt = result.nowPrompt.trim();
          const droppedTotal = droppedExternal + droppedBridge;

          if (!prompt) {
            const lines = [
              interrupted ? '⛔ 已发送中断信号。' : '⚠️ 当前无可中断的会话进程。',
              `🧹 已清空排队消息 ${droppedTotal} 条。`,
              '用法: /now <你要立刻执行的内容>',
            ];
            await sender.sendText(fromUserId, contextToken, lines.join('\n'));
            return;
          }

          await sender.sendText(
            fromUserId,
            contextToken,
            `⚡ 已中断并清空排队 ${droppedTotal} 条，正在立即执行 /now 请求。`,
          );
          void sendWechatMessageToCodex(prompt, undefined, fromUserId, contextToken);
          return;
        }
        if (result.reply) {
          if (slashCommand === 'cwd' && session.workingDirectory) {
            try {
              await bridge.restart(session.workingDirectory);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error('Failed to restart bridge after /cwd', { error: errMsg });
              await sender.sendText(
                fromUserId,
                contextToken,
                `⚠️ 工作目录已记录，但重启 Codex 失败：${errMsg.slice(0, 200)}`,
              );
              return;
            }
          }
          if (slashCommand === 'status') {
            const quotaLines = formatQuotaStatusLines(bridge.getLatestRateLimits());
            await sender.sendText(fromUserId, contextToken, `${result.reply}\n\n${quotaLines.join('\n')}`);
            return;
          }
          await sender.sendText(fromUserId, contextToken, result.reply);
          return;
        }
        if (result.codexPrompt) {
          if (bridge.isBusy) {
            const queueLength = enqueueQueuedMessage(queuedMessages, account.accountId, {
              userText: result.codexPrompt,
              media,
              fromUserId,
              contextToken,
            });
            await sender.sendText(fromUserId, contextToken,
              `⏳ 正在处理上一条消息，已加入队列（前面还有 ${queueLength} 条）`);
            return;
          }
          void sendWechatMessageToCodex(result.codexPrompt, media, fromUserId, contextToken);
          return;
        }
        if (result.handled) return;
      }

      // If the user sent a generic file, stash it and wait for a text request.
      // This avoids pasting raw file contents into Codex's TUI input box and
      // ensures all accumulated files + the eventual request go to Codex
      // together in a single turn.
      if (media && media.kind === 'file') {
        try {
          const downloaded = await downloadIncomingFileToPending(media.item);
          if (!downloaded) {
            await sender.sendText(fromUserId, contextToken,
              '⚠️ 文件已收到，但下载或解密失败。请重发。');
            return;
          }
          const total = appendPendingFile(fromUserId, downloaded);
          const lines = [
            `📎 已接收文件：${downloaded.fileName}`,
            `目前共有 ${total} 个待处理文件。`,
            '',
            '请继续发送文件，或发送对这些文件的处理需求（例如「转成 CSV」「统计坐标点数量」）。',
            '收到文字需求后，我会把所有文件和需求一起交给 Codex。',
          ];
          if (userText.trim()) {
            lines.push('');
            lines.push('（本条消息中的文字已忽略；下一条发送文字需求即可触发处理。）');
          }
          await sender.sendText(fromUserId, contextToken, lines.join('\n'));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error('Failed to stash pending file', { error: errMsg });
          await sender.sendText(fromUserId, contextToken,
            `⚠️ 保存文件失败：${errMsg.slice(0, 200)}`);
        }
        return;
      }

      // Queue if busy
      if (bridge.isBusy) {
        if (!isSlashCommand && (userText || media)) {
          const queueLength = enqueueQueuedMessage(queuedMessages, account.accountId, {
            userText,
            media,
            fromUserId,
            contextToken,
          });
          await sender.sendText(fromUserId, contextToken,
            `⏳ 正在处理上一条消息，这条已加入队列（前面还有 ${queueLength} 条）。处理完会自动继续，无需重发。`);
          return;
        }
        await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后...');
        return;
      }

      if (!userText && !media) {
        await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、图片、语音、音频或视频');
        return;
      }

      void sendWechatMessageToCodex(userText, media, fromUserId, contextToken);
    },
    onSessionExpired: () => {
      logger.warn('WeChat session expired');
    },
  };

  const monitor = createMonitor(api, callbacks);

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    await bridge.stop();
    monitor.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('Daemon started', { accountId: account.accountId, cwd });

  const modeDesc = mode === 'plan' ? 'plan (read-only)'
    : mode === 'danger' ? 'danger (no sandbox)'
    : 'workspace (writable sandbox, auto-approve off)';
  console.log(`[wechat-codex] Starting native Codex TUI (cwd: ${cwd})`);
  console.log(`[wechat-codex] Mode: ${modeDesc}  |  approval_policy: never`);
  console.log('[wechat-codex] WeChat messages will be forwarded to Codex automatically.\n');

  await bridge.start();

  // bridge.start() launches the native TUI which takes over the terminal.
  // The WeChat monitor runs in the background.
  await monitor.run();
}

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
