# SunCodexClaw

`SunCodexClaw` 是一个面向飞书工作流的 Codex 机器人项目。

现在仓库里也带了一条实验性的 `OpenClaw Weixin` 接入线，用来验证“我们的机器人是否能按 OpenClaw 那种扫码登录 + 长轮询方式接进微信”。

它不是把 LLM 包一层聊天壳，而是把飞书消息、Codex 工作区、本地文件、云文档进度、多账号运行和本机执行能力串成一条真正能干活的链路。

![Quick Start](docs/images/quickstart-terminal.svg)

## 2026-03-19 最近更新

这次更新主要有两件事，而且都已经接到线上机器人里了：

1. 飞书附件行为更接近真实助理
   - 如果回复里引用的是本地图片，机器人会直接上传到飞书并发送原生图片消息。
   - 如果回复里引用的是本地文件，默认不会把本地路径原样发到飞书里，只会保留正常文案或文件名。
   - 当用户明确说“把文件发我”“给我附件”“导出/下载文件”这类话时，机器人会把本地文件作为飞书文件直接发送，而不是只给一个本地路径。

2. 加入了 OpenClaw 风格的本地记忆 bundle
   - 每个机器人账号有自己独立的一份本地记忆文件，互不串线。
   - 记忆不是简单堆聊天记录，而是拆成 `profile_facts`、`role_memory`、`recent_summary`、`activated_history`、`live_tool_facts` 五部分。
   - 记忆文件存放在 `.runtime/feishu/memory/<account>.json`。
   - 同一个机器人下，所有线程共享这份总记忆；不同机器人之间完全独立。
   - 记忆写入前会做过滤和摘要，不会把一大段代码、临时路径、附件指令之类的噪音直接塞进去。

一句话说，现在它已经不是“每个线程一小段上下文”的水平，而是“每个机器人有自己的长期本地记忆 + 每个线程保留短期上下文”。

## 2026-03-22 微信实验接入

这次补的是一条最小可跑的微信通道，不是把 OpenClaw 整套搬进来。

- 新增 `tools/weixin_openclaw_bot.js`
  - 直接复用 `@tencent-weixin/openclaw-weixin` 暴露出来的协议
  - 支持二维码登录、长轮询收消息、Codex 回复、typing 状态
  - 支持微信图片/文件入站下载后交给 Codex
  - 支持通过 `[[WEIXIN_SEND_IMAGE:...]]` / `[[WEIXIN_SEND_FILE:...]]` 把本地图片和文件回发到微信
- 新增 `tools/weixin_openclaw_login_watch.js`
  - 支持扫码状态守护
  - 扫码确认后自动把 token 写入本地 secrets
  - 在 macOS 上通过 `launchctl` 拉起微信回复进程
- 新增 `tools/lib/openclaw_weixin_media.js`
  - 封装微信媒体上传、下载和解密
- 新增 `config/weixin_openclaw/default.example.json`
- 新增接入说明：`docs/openclaw-weixin-integration.md`

现阶段已经支持文本、图片、文件主链；语音和视频还没接完。
如果你是通过 macOS 的 `launchctl` 常驻运行，建议把 `codex.bin` 配成绝对路径，避免后台环境找不到 `codex`。

## 一句话

我自己写了一个 Codex 版本的 OpenClaw：`SunCodexClaw`。

名字是这么宣传的，但这里只是产品方向和交互目标与 OpenClaw 接近，没有直接借 OpenClaw 的代码。

它解决的问题很直接：

1. 不想浪费 token。
2. 不想让机器人只会陪聊，不会干活。
3. 不想每次都切 IDE、切终端、切飞书。
4. 不想多机器人互相污染工作区和上下文。
5. 不想附件、图片、语音、进度反馈这些体验太差。
6. 不想记忆只是“多带几轮聊天记录”。

## 它是什么

项目核心就是：

- 飞书 WebSocket 长连接收消息
- 按账号把消息路由到对应的 `codex cwd`
- 用 `codex exec --json` 执行任务
- 把过程写回飞书消息或飞书云文档
- 支持按内容自动选择普通文本 / Markdown 卡片 / 图片 / 文件回复
- 支持图片分析、语音转写、文件读取、文件回传、本地长期记忆、Skills、本机操作

这套东西特别适合“在飞书里提任务，机器人直接去代码库和电脑上干活，再把过程和结果回给你”这种工作方式。

## 现在有哪些能力

### 1. 真正执行，不只聊天

- 机器人底层直接跑本机 `codex exec`
- 可以读写工作区文件、执行命令、改代码、产出文件
- 能把结果再原样回到飞书

### 2. 飞书适配很深

- 支持群聊 `@`
- 支持“先 @ 再发图片 / 文件 / 语音”的连续工作流
- 支持飞书云文档进度
- 支持图片和文件的原生发送
- 支持多账号统一启停和 LaunchAgents

### 3. 记忆不是堆聊天记录

- 线程内仍然保留有限轮 `history`
- 机器人账号层面额外保留一份本地 memory bundle
- 新线程也能继承该机器人已经记住的偏好和历史事实
- 不同账号各自独立，不共享记忆

### 4. 对附件更友好

- 用户发来的文件会先下载到本地，再交给 Codex 读取
- 回复中的本地图片会自动转成飞书图片消息
- 用户明确要文件时，本地文件会自动转成飞书文件消息

### 5. 可以持续反馈进度

- 可以直接回消息
- 也可以持续把过程写到飞书云文档
- 比“假流式输出”更稳，也更适合长任务

## 和通用聊天壳的区别

相对 OpenClaw 这类更通用的聊天壳，这个项目更强调“在飞书里把事做完”：

- 更像执行器：
  - 它跑的是本机 `codex`
  - 所以天然能连上你的工作区、命令、文件和本地产物
- 更像工作流机器人：
  - 它不是只回一句话
  - 它还会处理图片、文件、语音、进度文档和最终附件
- 更适合多机器人：
  - 每个账号可以有独立 `cwd`
  - 每个账号也有独立本地记忆文件
- 更节省上下文：
  - 线程内只保留有限轮历史
  - 长期信息走本地 memory bundle，而不是无限堆聊天记录

## 工作方式

你在飞书里给机器人发消息，机器人大致按这条路径工作：

1. 收到文本 / 图片 / 文件 / 语音消息
2. 归一化成适合 Codex 的输入
3. 读取该机器人自己的本地 memory bundle
4. 在账号绑定的 `codex.cwd` 里执行 `codex exec`
5. 持续记录进度
6. 把最终回复、图片、文件或云文档链接回发到飞书
7. 过滤并更新该机器人的本地记忆

所以它的核心不是“聊天”，而是“飞书消息驱动的本机执行”。

## 安装

建议直接在你平时跑 Codex 的那台机器上 clone：

```bash
git clone git@github.com:Sunbelife/SunCodexClaw.git
cd SunCodexClaw
npm install
```

## 先决条件

在使用前，你需要先有：

- 可正常使用的 `codex` CLI
- 可用的 Codex / OpenAI token 或已登录态
- 一台能运行 `codex` 的机器
- 一个飞书企业自建应用

官方参考：

- [OpenAI Codex getting started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started)
- [Codex CLI and ChatGPT plan access](https://help.openai.com/en/articles/11381614-codex-cli-and-chatgpt-plan-access)
- [OpenAI API keys](https://platform.openai.com/api-keys)
- [飞书开放平台控制台](https://open.feishu.cn/app)
- [飞书开放平台文档首页](https://open.feishu.cn/document/home/index)

## 配置读取顺序

当前读取顺序是：

1. 命令行参数
2. 环境变量
3. `config/secrets/local.yaml`
4. `config/feishu/<account>.json`

推荐拆成两层：

- `config/secrets/local.yaml`
  - 放敏感项和本机私有配置
  - 例如飞书密钥、Bot Open ID、Codex token
- `config/feishu/<account>.json`
  - 放非敏感运行项
  - 例如回复模式、工作目录、进度模式、群触发规则

![Config Layout](docs/images/config-layout.svg)

## 配置示例

先复制模板：

```bash
cp config/secrets/local.example.yaml config/secrets/local.yaml
cp config/feishu/default.example.json config/feishu/default.json
```

`config/secrets/local.yaml` 示例：

```yaml
config:
  feishu:
    assistant:
      app_id: "cli_xxx"
      app_secret: "..."
      encrypt_key: "..."
      verification_token: "..."
      bot_open_id: "ou_xxx"
      bot_name: "飞书 Codex 助手"
      domain: "feishu"
      reply_mode: "codex"
      reply_prefix: "AI 助手："
      ignore_self_messages: true
      auto_reply: true
      require_mention: true
      require_mention_group_only: true
      progress:
        enabled: true
        mode: "doc"
        message: "已接收，正在执行。"
        doc:
          title_prefix: "Codex 任务进度"
          share_to_chat: true
          link_scope: "same_tenant"
          include_user_message: true
          write_final_reply: true
      codex:
        bin: "codex"
        api_key: "sk-..."
        model: "gpt-5.4"
        reasoning_effort: "xhigh"
        profile: ""
        cwd: "/absolute/path/to/workspace"
        add_dirs:
          - "/absolute/path/to/another/workspace"
        history_turns: 6
        sandbox: "danger-full-access"
        approval_policy: "never"
      speech:
        enabled: true
        api_key: "sk-..."
        model: "gpt-4o-mini-transcribe"
        language: ""
        base_url: "https://api.openai.com/v1"
        ffmpeg_bin: ""
      memory:
        enabled: true
        role_memory: |
          默认用简体中文回复。
          默认先做事，再解释。
```

`config/feishu/<account>.json` 示例：

```json
{
  "bot_name": "AI 助手",
  "reply_mode": "codex",
  "reply_prefix": "AI 助手：",
  "require_mention": true,
  "require_mention_group_only": true,
  "progress": {
    "enabled": true,
    "mode": "doc",
    "doc": {
      "title_prefix": "Codex 任务进度"
    }
  },
  "codex": {
    "cwd": "/absolute/path/to/workspace",
    "add_dirs": [
      "/absolute/path/to/another/workspace"
    ]
  },
  "memory": {
    "enabled": true,
    "role_memory": "默认简洁、直接、少空话。"
  }
}
```

### 配置建议

- 密钥尽量只放 `local.yaml`
- 每个机器人单独配置自己的 `codex.cwd`
- 需要跨目录工作时再加 `codex.add_dirs`
- `memory.role_memory` 适合写“这个机器人应该长期遵守的角色偏好”
- `bot_open_id` 可以不手填，第一次成功 `@` 后会自动探测并持久化
- 如果你已经通过 `codex login` 登录，也可以不填 `codex.api_key`

## 快速验证

先做 dry run：

```bash
node tools/feishu_ws_bot.js --account assistant --dry-run
```

如果看到这些信号，基本就通了：

- `app_id_found=true`
- `app_secret_found=true`
- `codex_found=true`
- `codex_cwd=...`
- `memory_enabled=true`

## 飞书开放平台至少要配什么

### 必订阅事件

- `im.message.receive_v1`

### 最低建议权限

至少建议开这些：

- `im:message`
- `im:message:readonly`
- `im:message.group_msg`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:chat:read`
- `im:chat:readonly`
- `im:chat.members:read`
- `im:resource`
- `docx:document`
- `docx:document:create`
- `docx:document:readonly`
- `docx:document:write_only`
- `drive:drive`
- `drive:drive.metadata:readonly`
- `drive:drive:readonly`

## 启动

前台启动单账号：

```bash
node tools/feishu_ws_bot.js --account assistant
```

使用 `package.json` 里的脚本：

```bash
npm run feishu:ws
npm run feishu:ws:dry
npm run feishu:start
npm run feishu:stop
npm run feishu:restart
npm run feishu:status
```

直接用控制脚本管理多账号：

```bash
bash tools/feishu_bot_ctl.sh list
bash tools/feishu_bot_ctl.sh start all
bash tools/feishu_bot_ctl.sh status all
bash tools/feishu_bot_ctl.sh logs assistant --follow
bash tools/feishu_bot_ctl.sh restart assistant
bash tools/feishu_bot_ctl.sh stop all
```

## 开机自启

macOS 下可以安装 LaunchAgents：

```bash
bash tools/install_feishu_launchagents.sh install all
```

查看状态：

```bash
bash tools/install_feishu_launchagents.sh status all
```

默认 label 前缀是：

```text
com.sunbelife.suncodexclaw.feishu
```

## 消息能力

### 文本

- 支持多轮上下文
- 支持 `/threads`
- 支持 `/thread new`
- 支持 `/thread switch`
- 支持 `/thread current`
- 支持 `/reset`

### 图片

- 飞书图片会先下载到本地，再作为输入交给 Codex
- 如果回复里引用本地图片，会自动转成飞书原生图片消息
- 当前单图片限制是 `10 MB`

如果你仍然想显式指定回发图片，也可以输出：

```text
[[FEISHU_SEND_IMAGE:/absolute/or/relative/path]]
```

### 语音

- 支持直接接收飞书语音消息
- 会先下载语音，再转写成文字交给 Codex
- 默认可复用 `codex.api_key` 做转写，也可以单独配置 `speech.api_key`

### 文件读取

用户发文件时，机器人会：

1. 下载到本地临时目录
2. 把临时路径写进 prompt
3. 让 Codex 直接读取文件
4. 回复后清理临时目录

### 文件发送

- 如果用户明确要文件，机器人会把本地文件直接上传成飞书文件消息
- 默认不会把本地路径原样塞回飞书
- 当前单文件限制是 `30 MB`

如果你想显式指定回发文件，也可以输出：

```text
[[FEISHU_SEND_FILE:/absolute/or/relative/path]]
```

### 云文档进度

- 可以在任务开始时先回复一条“已接收，正在执行”
- 也可以实时把执行过程写到飞书云文档
- 适合长任务、部署任务、批量处理任务

## 本地记忆机制

当前记忆分两层：

### 线程内短期上下文

- 每个飞书会话作用域里有线程状态
- 通过 `/thread new`、`/thread switch`、`/reset` 控制
- 主要用于短期上下文和 Codex thread resume

### 机器人级长期本地记忆

- 每个账号一份本地 bundle：`.runtime/feishu/memory/<account>.json`
- 同一机器人下，跨线程共享
- 不同机器人之间互相隔离

bundle 当前包含：

- `profile_facts`
- `role_memory`
- `recent_summary`
- `activated_history`
- `live_tool_facts`

记忆更新原则：

- 优先保留稳定偏好、角色约束、用户事实
- 最近几轮对话只保留压缩后的摘要
- 工具和附件结果只保留短期事实
- 会过滤本地临时路径、附件指令、长代码块和噪音文本

## 目录结构

```text
SunCodexClaw/
├── config/
│   ├── feishu/
│   │   ├── default.example.json
│   │   └── <account>.json
│   └── secrets/
│       ├── local.example.yaml
│       └── local.yaml
├── docs/images/
├── tools/
│   ├── feishu_ws_bot.js
│   ├── feishu_bot_ctl.sh
│   ├── install_feishu_launchagents.sh
│   └── lib/local_secret_store.js
├── .runtime/feishu/
│   ├── logs/
│   └── memory/
└── README.md
```

## 适合拿它干什么

- 在飞书里直接提代码任务
- 让机器人读文件、改代码、生成产物并回发
- 让多个机器人分别盯不同工作区
- 把机器人当作一个长期在本机待命的飞书执行入口

如果你要的是“飞书里的助手真的能去代码库和电脑上干活”，这个项目会比一个通用聊天壳更合适。
