# wechat-codex

把微信变成 Codex 的聊天入口。  
你在微信里发消息（文字、图片、语音、音视频、文件），`wechat-codex` 会把内容转给本机 Codex，再把结果回传到微信。实现基于ClawBot。


## 这个项目能做什么

- 微信和终端都能给同一个 Codex 会话发消息
- 忙碌时自动排队，不会丢消息
- 支持多媒体输入
- 支持把 Codex 生成的本地文件/图片/语音/视频发回微信
- 支持会话控制命令（切目录、切模型、清空会话等）

### 支持的消息类型

- 文字：直接转给 Codex
- 图片：下载并解密后，作为图片上下文传给 Codex
- 微信语音消息：优先使用微信侧已有转写文本
- 音频文件：自动提取音轨并转写（需要 `ffmpeg` + `ffprobe` + `whisper`）
- 视频：自动抽关键帧 + 语音转写（同样依赖上面 3 个工具）
- 普通文件（如 `.txt` `.json` `.geojson`）：先暂存，等你发“处理需求”后和需求一起交给 Codex

## 1. 准备环境（第一次做）

### 1.1 必备

- Node.js `>= 22`
- npm（随 Node.js 一起安装）
- `codex` 命令可直接使用
- `openclaw` 命令可直接使用
- `clawbot` 命令可直接使用
- 能正常访问微信桥接相关网络

如果你还没安装 Node.js，推荐用 `nvm`：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
```

安装 Codex CLI：

```bash
npm install -g @openai/codex@latest
```

安装后检查：

```bash
node -v
npm -v
codex --help
```

### 1.2 可选（未测试）

安装并检查：

```bash
ffmpeg -version
ffprobe -version
whisper --help
```

## 2. 安装与初始化

在项目目录执行：

```bash
npm install
npm run setup
```

`npm run setup` 会做 3 件事：

1. 弹出或打印微信二维码，让你扫码绑定
2. 让你输入默认工作目录（Codex 在哪里工作）
3. 写入配置文件 `~/.wechat-codex-bridge/config.env`

## 3. 启动服务

```bash
npm start
```

## 4. 如何使用

### 4.1 最简单用法

直接在微信里发一句话，比如：

- “帮我写一个 Python 读取 CSV 的脚本”
- “解释这段报错是什么意思”

系统会自动把消息转给 Codex，并把中间思考内容和回复发回微信。

### 4.2 向Codex发送文件

普通文件（例如 `.txt` / `.json` / `.geojson`）不是“发完立刻处理”，而是两步：

1. 先把文件发给微信机器人（可连续发多个）
2. 再发一条文字需求（例如“把这几个文件合并成一个 CSV 并统计条数”）

### 4.3 让 Codex 把本地文件发回微信

如果你希望 Codex 回传图片/文件/语音/视频，需要把下面的指令放入 ``` ~/.codex/AGENTS.md```   中。


~~~markdown
# WeChat Bridge Attachment Convention

You may be running inside a `wechat-codex` bridge session, which mirrors your
replies to a WeChat user. By default only your visible text is forwarded. To
deliver a file to the WeChat user, append
a fenced block at the very end of your final answer:

```wechat-attachments
image /abs/or/rel/path/to/picture.png
file  /abs/or/rel/path/to/report.pdf
voice /abs/or/rel/path/to/clip.mp3
video /abs/or/rel/path/to/movie.mp4
```

## Rules

- Place the block at the **very end** of the final answer, with a blank line
  before it. No prose may follow the closing ``` fence.
- One attachment per line. The first token is the `kind`; the rest is the path.
- Valid kinds: `image`, `file`, `voice`, `video`.
  - `image`: png, jpg/jpeg, gif, webp, bmp, svg
  - `file`:  everything else — pdf, docx, xlsx, csv, txt, zip, json, logs, …
  - `voice`: mp3, wav, m4a, ogg, aac
  - `video`: mp4, mov, mkv, avi, webm
- Use absolute paths when possible. Relative paths are resolved against the
  current working directory.
- Briefly mention in the visible prose what you are sending so the user has
  context (e.g. "Here is the loss curve you asked for.").
- The file must already exist on disk at the time you emit the block — the
  bridge only forwards, it does not wait for files to appear. If you intend to
  save then send, save first, then emit the block.
- Include the block **only** when the user actually wants the artifact
  delivered. Do not attach files by default.
- **Never** include the fence inside a code example or inside prose — it is
  parsed structurally and false positives will cause misdelivery. If you need
  to discuss the convention itself, use inline code or indented blocks, not a
  fenced block with the `wechat-attachments` info string.

## Examples

Single image:

```
Here is the requested chart.

```wechat-attachments
image /tmp/loss_curve.png
```
```

Multiple files in one reply:

```
Attached: the training report and the raw metrics.

```wechat-attachments
file /home/user/proj/report.pdf
file /home/user/proj/metrics.csv
```
```

No attachment (normal reply — do not emit the block):

```
The experiment is still running; nothing to send yet.
```
```
~~~


## 5. 微信端常用命令

- `/help`：查看帮助
- `/status`：查看当前会话状态（工作目录、模型、模式、线程、剩余额度等）
- `/cwd <路径>`：切换工作目录（会重启 Codex 会话）
- `/model <模型名>`：切换模型
- `/mode <plan|workspace|danger>`：切换运行模式（重启服务后生效）
- `/now <内容>`：中断当前处理并立刻执行这条内容
- `/clear`：清空当前会话
- `/skills`：列出可用 skills

## 6. 配置文件说明

默认配置文件路径：

- `~/.wechat-codex-bridge/config.env`

示例：

```env
workingDirectory=/home/you/project
model=gpt-5.4
mode=workspace
```

字段说明：

- `workingDirectory`：默认工作目录（必填，必须存在）
- `model`：默认模型（可选）
- `mode`：运行模式（默认 `workspace`）
  - `plan`：只读分析
  - `workspace`：可写工作区（推荐）
  - `danger`：无沙箱（高风险）

可通过环境变量修改数据目录：

```bash
export WCB_DATA_DIR=/your/path
```

目录内会自动创建：

- `config.env`
- `logs/`
- `tmp/`

## 7. 常见问题

### Q1: 启动时报“未找到账号”

先执行：

```bash
npm run setup
```

完成扫码绑定后再 `npm start`。

### Q2: 提示工作目录不存在

- 检查 `config.env` 的 `workingDirectory`
- 或在微信发送 `/cwd <正确路径>`

### Q3: 音频/视频一直处理失败

检查这 3 个工具是否可用：

```bash
ffmpeg -version
ffprobe -version
whisper --help
```

### Q4: 改了 `/mode` 为什么没生效

`/mode` 会写入会话设置，但要重启服务后才会按新模式启动 Codex：

```bash
npm start
```

## 8. 安全建议

- 除非你非常确定环境可信，否则不要用 `danger` 模式
- 建议使用最小权限账号运行服务
- 定期清理 `~/.wechat-codex-bridge/tmp` 和日志文件
