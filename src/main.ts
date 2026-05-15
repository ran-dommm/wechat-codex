#!/usr/bin/env node
import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { loadAccount } from './wechat/accounts.js';
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
import type { BridgeTurnSource } from './codex/native-bridge.js';
import { runCodexAuthCli } from './codex/auth-cli.js';
import { useAuthProfile } from './codex/auth-profiles.js';
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

const queuedMessages: QueuedCodexMessage[] = [];

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

const MAX_DEFERRED_WECHAT_TEXTS = 20;
const TERMINAL_QUEUE_GRACE_MS = 1500;
const WECHAT_SEND_INTERVAL_MS = 2500;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function runCleanupLegacy(): void {
  const legacyPaths = [
    join(DATA_DIR, 'accounts'),
    join(DATA_DIR, 'sessions'),
  ];
  for (const legacyPath of legacyPaths) {
    if (existsSync(legacyPath)) {
      rmSync(legacyPath, { recursive: true, force: true });
      console.log(`已删除: ${legacyPath}`);
    } else {
      console.log(`不存在，跳过: ${legacyPath}`);
    }
  }
}

// ── Daemon ──────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const maybeAccount = loadAccount();

  if (!maybeAccount) {
    console.error('未找到账号，请先运行 npm run setup');
    process.exit(1);
  }

  const account = maybeAccount;
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session = sessionStore.load();
  if (session.state === 'processing') {
    session.state = 'idle';
    sessionStore.save(session);
  }
  const sender = createSender(api, account.accountId, account.baseUrl, account.botToken);

  const cwd = session.workingDirectory || config.workingDirectory;
  ensureUsableDirectory(cwd);

  let lastRecipient: WechatRecipient | null = session.lastRecipient ?? null;
  let activeTempFiles: string[] = [];
  let outgoingWechatSend: Promise<void> = Promise.resolve();
  let deferredWechatTexts: string[] = [];
  let queuedDispatchTimer: NodeJS.Timeout | null = null;
  let lastWechatSendAtMs = 0;

  function enqueueWechatSend(work: () => Promise<void>): Promise<void> {
    const next = outgoingWechatSend.then(work, work);
    outgoingWechatSend = next.catch(() => undefined);
    return next;
  }

  async function retryWechatSend(label: string, work: () => Promise<void>): Promise<void> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await work();
        return;
      } catch (err) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) break;
        logger.warn('WeChat send failed, retrying', { label, attempt, error: errMsg });
        await sleep(500 * attempt);
      }
    }
    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${label} failed after ${maxAttempts} attempts: ${errMsg}`);
  }

  async function waitForWechatSendSlot(): Promise<void> {
    const elapsed = Date.now() - lastWechatSendAtMs;
    if (lastWechatSendAtMs > 0 && elapsed < WECHAT_SEND_INTERVAL_MS) {
      await sleep(WECHAT_SEND_INTERVAL_MS - elapsed);
    }
  }

  async function sendTextNow(text: string, recipient: WechatRecipient): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await waitForWechatSendSlot();
      await retryWechatSend('send text', () => sender.sendText(recipient.userId, recipient.contextToken, chunk));
      lastWechatSendAtMs = Date.now();
    }
  }

  function rememberDeferredWechatText(text: string): void {
    deferredWechatTexts.push(text);
    if (deferredWechatTexts.length > MAX_DEFERRED_WECHAT_TEXTS) {
      deferredWechatTexts = deferredWechatTexts.slice(-MAX_DEFERRED_WECHAT_TEXTS);
    }
  }

  function shouldDeferFailedWechatText(text: string): boolean {
    const trimmed = text.trimStart();
    return !trimmed.startsWith('💭') && !trimmed.startsWith('⌨️ 终端输入：');
  }

  async function sendTextToWechat(text: string): Promise<void> {
    const recipient = lastRecipient;
    if (!recipient) {
      rememberDeferredWechatText(text);
      logger.warn('Deferring text: no WeChat recipient yet', {
        textLength: text.length,
        deferredCount: deferredWechatTexts.length,
      });
      return;
    }
    await enqueueWechatSend(async () => {
      try {
        await sendTextNow(text, recipient);
      } catch (err) {
        logger.warn('Failed to send to WeChat', { error: err instanceof Error ? err.message : String(err) });
        if (shouldDeferFailedWechatText(text)) {
          rememberDeferredWechatText(text);
        }
      }
    });
  }

  function setLastRecipient(recipient: WechatRecipient): void {
    lastRecipient = recipient;
    session.lastRecipient = recipient;
    sessionStore.save(session);
    flushDeferredWechatTexts();
  }

  function flushDeferredWechatTexts(): void {
    if (!lastRecipient || deferredWechatTexts.length === 0) return;
    const pending = deferredWechatTexts;
    deferredWechatTexts = [];
    void sendTextToWechat(`（以下为此前因没有微信收件人而暂存的终端同步消息）\n\n${pending.join('\n\n')}`);
  }

  async function sendImageToWechat(imagePath: string): Promise<void> {
    const recipient = lastRecipient;
    if (!recipient) {
      logger.warn('Drop image: no WeChat recipient yet', { imagePath });
      return;
    }
    await enqueueWechatSend(async () => {
      try {
        await retryWechatSend('send image', () => sender.sendImage(recipient.userId, recipient.contextToken, imagePath));
      } catch (err) {
        logger.warn('Failed to send image to WeChat', { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async function sendAttachmentToWechat(
    attachment: { kind: 'image' | 'file' | 'voice' | 'video'; path: string },
  ): Promise<void> {
    const recipient = lastRecipient;
    if (!recipient) {
      logger.warn('Drop attachment: no WeChat recipient yet', { attachment });
      return;
    }
    if (!existsSync(attachment.path)) {
      logger.warn('Drop attachment: file not found', { attachment });
      await sendTextToWechat(`⚠️ 无法发送附件（文件不存在）：${attachment.path}`);
      return;
    }
    await enqueueWechatSend(async () => {
      try {
        const { userId, contextToken } = recipient;
        if (attachment.kind === 'image') {
          await retryWechatSend('send image attachment', () => sender.sendImage(userId, contextToken, attachment.path));
        } else if (attachment.kind === 'file') {
          await retryWechatSend('send file attachment', () => sender.sendFile(userId, contextToken, attachment.path));
        } else if (attachment.kind === 'voice') {
          await retryWechatSend('send voice attachment', () => sender.sendVoice(userId, contextToken, attachment.path));
        } else if (attachment.kind === 'video') {
          await retryWechatSend('send video attachment', () => sender.sendVideo(userId, contextToken, attachment.path));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to send attachment to WeChat', { attachment, error: errMsg });
        try {
          await sendTextNow(`⚠️ 发送附件失败 (${attachment.kind}): ${attachment.path}\n${errMsg.slice(0, 400)}`, recipient);
        } catch (fallbackErr) {
          logger.warn('Failed to send attachment error notice to WeChat', {
            attachment,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      }
    });
  }

  async function sendWechatMessageToCodex(
    userText: string,
    media: ReturnType<typeof extractFirstSupportedMedia>,
    fromUserId: string,
    contextToken: string,
  ): Promise<void> {
    session.state = 'processing';
    sessionStore.save(session);
    setLastRecipient({ userId: fromUserId, contextToken });

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
          sessionStore.save(session);
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
        sessionStore.save(session);
        await sendTextToWechat('⚠️ 未提取到可发送给 Codex 的内容，请重试。');
        cleanupTempFiles(tempFiles);
        return;
      }

      activeTempFiles = tempFiles;
      bridge.setCwd(session.workingDirectory || config.workingDirectory);
      await bridge.sendWechatTurn(prompt, imagePaths.length ? imagePaths : undefined);
    } catch (err) {
      session.state = 'idle';
      sessionStore.save(session);
      cleanupTempFiles(tempFiles);
      activeTempFiles = [];
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send to Codex', { error: errMsg });
      await sendTextToWechat(`⚠️ ${errMsg.slice(0, 1200)}`);
    }
  }

  function processNextQueued(): void {
    if (queuedDispatchTimer) {
      clearTimeout(queuedDispatchTimer);
      queuedDispatchTimer = null;
    }
    const next = dequeueQueuedMessage(queuedMessages);
    if (next) {
      logger.info('Processing queued message');
      void sendWechatMessageToCodex(next.userText, next.media, next.fromUserId, next.contextToken);
    }
  }

  function clearQueuedMessages(): number {
    const count = queuedMessages.length;
    queuedMessages.length = 0;
    return count;
  }

  function scheduleProcessNextQueued(source: BridgeTurnSource): void {
    if (queuedDispatchTimer) return;
    const delayMs = source === 'terminal' ? TERMINAL_QUEUE_GRACE_MS : 0;
    if (delayMs === 0) {
      processNextQueued();
      return;
    }
    queuedDispatchTimer = setTimeout(() => {
      queuedDispatchTimer = null;
      processNextQueued();
    }, delayMs);
    queuedDispatchTimer.unref?.();
  }

  async function switchCodexAuthProfile(
    profileName: string,
    fromUserId: string,
    contextToken: string,
  ): Promise<void> {
    if (bridge.isBusy) {
      await sender.sendText(fromUserId, contextToken, '⚠️ Codex 正在处理任务，暂不能切换认证账号。请等待完成，或用 /now 中断后再切换。');
      return;
    }

    try {
      const result = useAuthProfile(profileName);
      await bridge.restart(session.workingDirectory || config.workingDirectory);
      const lines = [
        `✅ Codex 认证账号已切换为: ${profileName}`,
        '已重启 Codex 会话。配置文件、AGENTS.md 和当前工作目录保持不变。',
      ];
      if (result.backupPath) {
        lines.push(`原 auth.json 已备份: ${result.backupPath}`);
      }
      await sender.sendText(fromUserId, contextToken, lines.join('\n'));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to switch Codex auth profile', { profileName, error: errMsg });
      await sender.sendText(fromUserId, contextToken, `⚠️ Codex 认证账号切换失败：${errMsg.slice(0, 500)}`);
    }
  }

  // ── Native Codex Bridge ──

  const mode = (session.mode ?? config.mode ?? 'workspace') as 'plan' | 'workspace' | 'danger';
  const bridge = new NativeCodexBridge(cwd, {
    onWechatReply: (text) => {
      return sendTextToWechat(text);
    },
    onWechatAttachment: (attachment) => {
      return sendAttachmentToWechat(attachment);
    },
    onTurnFinalized: ({ source }) => {
      if (activeTempFiles.length > 0 || session.state !== 'idle') {
        session.state = 'idle';
        sessionStore.save(session);
      }
      if (activeTempFiles.length > 0) {
        cleanupTempFiles(activeTempFiles);
        activeTempFiles = [];
      }
      scheduleProcessNextQueued(source);
    },
    onWechatTurnComplete: () => {
      // Legacy hook retained for compatibility; queue progression and cleanup
      // are handled in onTurnFinalized to cover all completion paths.
    },
    onError: (msg) => logger.error('Bridge error', { error: msg }),
    onTerminalUserMessage: (message) => {
      if (!message.trim().startsWith('/')) return false;
      const result = routeCommand({
        session,
        updateSession: (partial) => {
          Object.assign(session, partial);
          sessionStore.save(session);
          if (partial.workingDirectory) {
            bridge.setCwd(partial.workingDirectory);
          }
        },
        clearSession: () => sessionStore.clear(session),
        text: message,
      });
      const reply = result.codexAuthProfile
        ? '请使用 npm run codex-auth use <name> 在终端切换 Codex 认证账号，或从微信端发送 /codex-auth use <name>。'
        : result.reply ?? (result.handled ? '终端命令已处理。' : '');
      if (reply) {
        void sendTextToWechat(`⌨️ 终端命令：${message}\n\n${reply}`);
        return true;
      }
      return false;
    },
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

      setLastRecipient({ userId: fromUserId, contextToken });

      // Handle slash commands (work even when busy)
      if (isSlashCommand) {
        const slashCommand = extractSlashCommandName(userText);
        const updateSession = (partial: Partial<Session>) => {
          Object.assign(session, partial);
          sessionStore.save(session);
          if (partial.workingDirectory) {
            bridge.setCwd(partial.workingDirectory);
          }
        };

        const ctx: CommandContext = {
          session,
          updateSession,
          clearSession: () => {
            const dropped = discardPendingFiles(fromUserId);
            if (dropped > 0) {
              logger.info('Dropped pending files on /clear', { fromUserId, count: dropped });
            }
            return sessionStore.clear(session);
          },
          text: userText,
        };

        const result: CommandResult = routeCommand(ctx);
        if (result.codexAuthProfile) {
          await switchCodexAuthProfile(result.codexAuthProfile, fromUserId, contextToken);
          return;
        }
        if (result.nowPrompt !== undefined) {
          const droppedExternal = clearQueuedMessages();
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
            const queueLength = enqueueQueuedMessage(queuedMessages, {
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
          const queueLength = enqueueQueuedMessage(queuedMessages, {
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
} else if (command === 'codex-auth') {
  runCodexAuthCli(process.argv.slice(3));
} else if (command === 'cleanup-legacy') {
  runCleanupLegacy();
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
