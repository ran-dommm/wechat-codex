# wechat-codex

`wechat-codex` 是一个把微信消息桥接到本机 Codex CLI 的服务。  
你可以在微信里发文字/图片/语音/音视频，服务会自动整理上下文并转交给 Codex，再把回复回传到微信。

## 支持的功能

- 微信消息转发到本机 Codex（双向桥接）
- 终端与微信双输入并存（同一实例可接收两端输入）
- 自动排队：当 Codex 正在处理上一条请求时，新消息进入队列，完成后自动续跑
- 多媒体支持：
  - 图片：下载并解密后作为图片上下文传给 Codex
  - 微信语音：使用微信侧已有转写文本
  - 音频文件：自动提取音轨并转写
  - 视频：自动提取关键帧 + 音频转写（可用时）
  - 普通文件（如 `.geojson`/`.json`/`.txt`）：先落盘暂存，等待你发送处理需求后再与需求一起提交给 Codex
- 会话指令（微信中斜杠命令）：
  - `/help` 查看帮助
  - `/status` 查看当前会话状态
  - `/cwd <path>` 切换工作目录
  - `/model <name>` 切换模型（会话级）
  - `/mode <plan|workspace|danger>` 切换运行模式（需重启生效）
  - `/clear` 清空当前会话
  - `/skills` 列出可用 skills

## 基础配置要求

## 1) 运行环境

- Linux / macOS / Windows
- Node.js `>= 22`（推荐使用 Node.js LTS）
- 已安装并可在命令行直接运行 `codex`
- 已安装 `OpenClaw`（用于微信侧/桥接侧相关能力）
- 已安装 `Clawbot`（用于机器人端能力）
- 可访问微信桥接所需网络环境

建议先验证 Node 与 npm：

```bash
node -v
npm -v
```

若本机没有 Node.js 22，可用 `nvm` 安装：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node -v
```

### OpenClaw 安装


```bash
npm install -g openclaw@latest
```

### Clawbot 安装


```bash
npx -y @tencent-weixin/openclaw-weixin-cli@latest install
```

安装后请确保命令可执行（或服务可正常启动）：

```bash
openclaw --help
clawbot --help
codex --help
```

## 2) 依赖工具（媒体增强相关）

若你需要处理音频/视频，建议安装：

- `ffmpeg`
- `ffprobe`
- `whisper`（用于语音转写）

如果缺少这些工具，文字与图片流程仍可工作，但音视频处理会降级并给出提示。

## 3) 默认数据目录

默认数据目录：`~/.wechat-codex-bridge`

其中包括（运行时自动创建）：

- `config.env`（运行配置）
- `logs/`（日志）
- `tmp/`（媒体临时文件）

你可以通过环境变量自定义目录：

- `WCB_DATA_DIR=/your/path`

## 配置方式

支持两种配置方式：初始化向导 + 手动编辑配置文件。

## 发送文件前的 AGENTS.md 配置（必做）

要让 Codex 在微信里真正发送文件/语音/视频，需要在工作目录下配置 `AGENTS.md`，明确告诉模型使用附件指令块。  
否则模型通常只会返回文本说明，不会触发桥接层的附件发送。

`wechat-codex` 约定：当最终回复末尾包含 `wechat-attachments` 代码块时，会自动解析并发送附件。

请在你的项目根目录新增（或补充）`AGENTS.md`，加入类似下面的规范：

~~~markdown
# WeChat Attachment Output Rules

当你需要通过微信发送图片、文件、语音、视频时，在最终回复末尾追加如下代码块：

```wechat-attachments
image /absolute/path/to/image.png
file /absolute/path/to/report.pdf
voice /absolute/path/to/voice.mp3
video /absolute/path/to/video.mp4
```

规则：
1. 每行格式：`<type> <path>`
2. `type` 仅支持：`image` / `file` / `voice` / `video`
3. 路径优先使用绝对路径；相对路径会按当前工作目录解析
4. 附件代码块必须放在最终回复末尾，且语法正确
5. 若文件不存在，不要输出该附件行，先给出错误说明
~~~

### 示例（模型输出）

~~~text
已生成周报，请查收。

```wechat-attachments
file /home/you/project/output/weekly-report.pdf
```
~~~

### 验证是否生效

1. 确认当前会话工作目录：微信发送 `/status`
2. 确认该目录下有 `AGENTS.md`
3. 让模型生成并发送一个已存在的测试文件
4. 若未发送成功，检查：
   - 附件块是否在最终回复末尾
   - `type` 是否为 `image|file|voice|video`
   - 路径是否存在且进程可读

## 方式一：初始化向导（推荐）

### 安装依赖并构建

```bash
npm install
```

### 运行初始化

```bash
npm run setup
```

初始化流程会完成：

1. 微信扫码绑定账号
2. 交互式设置默认工作目录（`workingDirectory`）
3. 写入 `config.env`

### 启动服务

```bash
npm start
```

## 方式二：手动编辑配置文件

配置文件路径：`~/.wechat-codex-bridge/config.env`（或你自定义的 `WCB_DATA_DIR` 下同名文件）

示例：

```env
workingDirectory=/home/you/project
model=gpt-5.4
mode=workspace
```

字段说明：

- `workingDirectory`：默认工作目录（必填，且必须存在）
- `model`：会话默认模型（可选）
- `mode`：运行模式（可选，默认 `workspace`）
  - `plan`：只读分析模式
  - `workspace`：工作区可写模式
  - `danger`：无沙箱模式（高风险）

> 注意：`mode` 影响 Codex 启动参数。修改后需要重启服务才生效。

## 快速开始（最短路径）

```bash
npm install
npm run setup
npm start
```

然后在微信里直接发消息即可。

## 常用微信命令

```text
/help
/status
/cwd /path/to/workspace
/model gpt-5.4
/mode workspace
/clear
/skills
```

## 常见问题

### 1) 启动时报 “未找到账号”

先运行：

```bash
npm run setup
```

完成扫码绑定后再 `npm start`。

### 2) 音视频无法处理

请检查以下命令是否可用：

```bash
ffmpeg -version
ffprobe -version
whisper --help
```

### 3) 工作目录报错（不存在或不是目录）

- 确认 `config.env` 里的 `workingDirectory` 合法
- 或在微信中执行 `/cwd <目录>` 动态切换

### 4) 微信上传文件后为什么不会立即调用 Codex？

这是当前设计：文件消息先保存到本地暂存目录，微信会提示你“请输入对文件的处理需求”。

- 你可以连续发送多个文件，系统会累计等待
- 当你再发一条文字需求时，系统会把“需求 + 所有待处理文件路径”一次性发给 Codex
- 这样可以避免把文件原始内容误粘贴到 TUI 输入框，也避免“需要手动按 Enter 才发送”的问题

## 安全建议

- `danger` 模式会以无沙箱方式执行本机 Codex，请仅在可信环境下使用
- 建议把桥接服务放在最小权限账号下运行
- 定期清理数据目录中的历史日志与临时文件
