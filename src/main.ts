import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { buildCodexPrompt, cleanupTempFiles, extractFirstSupportedMedia, extractText, prepareMediaForCodex } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { NativeCodexBridge } from './codex/native-bridge.js';
import { DEFAULT_WORKING_DIRECTORY, loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { dequeueQueuedMessage, enqueueQueuedMessage } from './message-queue.js';
import { DATA_DIR } from './constants.js';
import { splitMessage } from './utils/chunk.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

interface QueuedCodexMessage {
  userText: string;
  media: ReturnType<typeof extractFirstSupportedMedia>;
  fromUserId: string;
  contextToken: string;
}

const queuedMessages = new Map<string, QueuedCodexMessage[]>();

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

  // ── Native Codex Bridge ──

  const mode = (session.mode ?? config.mode ?? 'workspace') as 'plan' | 'workspace' | 'danger';
  const bridge = new NativeCodexBridge(cwd, {
    onWechatReply: (text) => {
      void sendTextToWechat(text);
    },
    onWechatTurnComplete: () => {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      cleanupTempFiles(activeTempFiles);
      activeTempFiles = [];
      processNextQueued();
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
          clearSession: () => sessionStore.clear(account.accountId, session),
          text: userText,
        };

        const result: CommandResult = routeCommand(ctx);
        if (result.reply) {
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
