# SunCodexClaw

`SunCodexClaw` 是一个面向飞书工作流的 Codex 机器人项目。

它不是把 LLM 包一层聊天壳，而是把飞书消息、Codex 工作区、文件读写、云文档进度、多账号运行和本机执行能力串成一条能真正干活的链路。

![Quick Start](docs/images/quickstart-terminal.svg)

## 一句话

我自己写了一个 Codex 版本的 OpenClaw：`SunCodexClaw`。

名字是这么宣传的，但这里只是功能和概念方向和 OpenClaw 比较接近，没有借鉴 OpenClaw 的代码。

它主要解决了这些问题：

1. 浪费 Token 的问题：这个项目说多少就费多少，不浪费。
2. 稳定性差的问题：没有额外网关，直接运行，不会动不动就崩。
3. 只能陪聊、不干活的问题：它直接连的是 `Codex CLI`，可以写代码、改项目、干真活。
4. 多 Agent 协作的问题：支持多个机器人一起干活，互相独立进程、独立路径、互不干扰。
5. 记忆和扩展的问题：它本身就有记忆，也支持 Skills，因为底层就是 Codex。
6. 飞书反馈体验的问题：收到消息会马上回复，不会装死；推送文档里会持续告诉你实时进展，比流式靠谱，也比腹泻式回复靠谱。
7. 飞书附件能力的问题：支持图片、文件的输入和输出，也可以把你发来的文件落到电脑上处理。
8. 电脑操作能力的问题：因为底层是 Codex，所以支持直接操作你的电脑；在 GPT 5.4 下，这类操作的准确度也明显更高。

我最近一段时间都是用它干活。

一顿饭下来，我的网页可以改好几版。

## 用起来如图

![SunCodexClaw Example 1](https://wx4.sinaimg.cn/mw2000/63dcee2bgy1iazf3yyq1vj21qg1ww4hj.jpg)
![SunCodexClaw Example 2](https://wx2.sinaimg.cn/mw2000/63dcee2bgy1iazf3zfejej21qg1wwwyy.jpg)
![SunCodexClaw Example 3](https://wx3.sinaimg.cn/mw2000/63dcee2bgy1iazf3zy9wuj21qg1wwtsa.jpg)

## 这是什么

项目核心是：

- 飞书 WebSocket 长连接收消息
- 按账号把消息路由到对应的 `codex cwd`
- 用 `codex exec --json` 执行任务
- 把过程写回飞书消息或飞书云文档
- 支持按需把最终回复渲染成飞书 Markdown 卡片
- 支持图片分析、图片回传、语音输入转写、文件读取、文件回传、线程记忆、Skills、本机操作

这套项目特别适合那种“在飞书里提任务，机器人直接去代码库和电脑上干活，再把过程回给你”的工作方式。

## 和 OpenClaw 的区别

相对 OpenClaw 这类更通用的聊天外壳，这个项目的设计重点是“在飞书里把事做完”：

- 更稳定：
  - 没有额外网关，机器人就是直接在本机运行
  - 链路更短、少一层中间环节，所以更不容易出现那种突然崩溃、整体掉线的问题
- 更省 token：
  - 只保留有限轮历史，而不是无上限堆聊天记录
  - 图片和文件先下载到本地，再把本地路径交给 Codex，避免把大块原文反复塞进上下文
  - 进度默认走飞书消息或云文档，不把完整过程反复塞回模型
- 更像真正干活的机器人：
  - 它直接跑本机 `codex exec`
  - 所以可以读写文件、执行命令、在工作目录里改代码、产出文件并回发给飞书
- 支持多 agent 同时运行：
  - 可以给不同 agent 配独立目录
  - 互不干扰，并行处理各自的任务和工作区
- 对飞书适配更深：
  - 支持群聊 `@` 触发
  - 支持“先 @ 再单独发文件/图片”的连续工作流
  - 支持按内容自动切换普通文本 / Markdown 卡片回复
  - 群里运行中的任务默认不会被别人打断；只有同一发送者再次明确 `@` 机器人，才会中断并重跑
  - 支持飞书云文档进度、文档排版、文档链接回发
  - 支持多账号、多机器人统一启停和 LaunchAgents
- 自带记忆：
  - 每个会话有线程上下文
  - 支持 `/thread new`、`/thread switch`、`/reset`
- 同样支持 Skills：
  - 机器人背后跑的是 Codex
  - 只要你的 Codex 环境能用 Skills，这个机器人也能用
- 可以操作电脑：
  - 本质上是 Codex 在你的机器上执行
  - 在 `codex` 权限允许的前提下，可以直接处理本机文件、命令和项目工作区

如果你要的是“飞书里的助手真的能去代码库和电脑上干活”，这个项目比一个通用聊天壳更合适。

## 工作方式

你在飞书里给机器人发消息，机器人会按下面的路径工作：

1. 收到文本 / 图片 / 文件 / 语音消息
2. 归一化成适合 Codex 的输入
3. 在账号绑定的 `codex.cwd` 里执行 `codex exec`
4. 持续记录进度
5. 把最终回复、文件或云文档链接回发到飞书

这意味着它的核心不是“聊天”，而是“消息驱动的本机执行”。

## 先决条件

在使用这个项目之前，你需要先有：

- 可正常使用的 `codex` CLI
- 对应的 Codex / OpenAI token 或已登录态
- 一台能运行 `codex` 的机器
- 一个飞书企业自建应用

官方参考：

- [OpenAI Codex getting started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started)
- [Codex CLI and ChatGPT plan access](https://help.openai.com/en/articles/11381614-codex-cli-and-chatgpt-plan-access)
- [OpenAI API keys](https://platform.openai.com/api-keys)
- [飞书开放平台控制台](https://open.feishu.cn/app)
- [飞书开放平台文档首页](https://open.feishu.cn/document/home/index)

## 安装

建议直接在你平时用来跑 Codex 的环境里 clone 这个项目。

```bash
git clone git@github.com:Sunbelife/SunCodexClaw.git
cd SunCodexClaw
npm install
```

如果你是在 Codex 的工作环境里操作，直接把这个仓库 clone 到本机，再按下面步骤配置即可。

## 配置模型

当前读取顺序是：

1. 命令行参数
2. 环境变量
3. `config/secrets/local.yaml`
4. `config/feishu/<account>.json`

推荐把配置拆成两层：

- `config/secrets/local.yaml`
  - 放敏感项和本机私有配置
  - 例如：飞书应用密钥、Bot Open ID、Codex token、语音转写 key
- `config/feishu/<account>.json`
  - 放非敏感运行项
  - 例如：回复模式、工作目录、进度模式、群聊触发规则

如果要启用语音输入，建议配置一个 `speech` 段；不单独配置 `speech.api_key` 时，默认会复用 `codex.api_key` 做转写。

![Config Layout](docs/images/config-layout.svg)

目录结构：

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
└── README.md
```

## 配置示例

先复制模板：

```bash
cp config/secrets/local.example.yaml config/secrets/local.yaml
cp config/feishu/default.example.json config/feishu/default.json
```

### `config/secrets/local.yaml`

这是推荐的主配置位置，尤其是敏感项：

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
      require_mention: true
      require_mention_group_only: true
      progress:
        enabled: true
        mode: "doc"
        doc:
          title_prefix: "AI 助手｜任务进度"
          share_to_chat: true
          link_scope: "same_tenant"
          include_user_message: true
          write_final_reply: true
      codex:
        bin: "codex"
        api_key: "sk-..."
        model: "gpt-5.4"
        reasoning_effort: "xhigh"
        cwd: "/absolute/path/to/workspace"
        add_dirs:
          - "/absolute/path/to/another/workspace"
        history_turns: 6
        sandbox: "danger-full-access"
        approval_policy: "never"
```

### `config/feishu/<account>.json`

这个文件适合放本机非敏感覆盖：

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
      "title_prefix": "AI 助手｜任务进度"
    }
  },
  "codex": {
    "cwd": "/absolute/path/to/workspace",
    "add_dirs": [
      "/absolute/path/to/another/workspace"
    ]
  }
}
```

### 配置建议

- 密钥尽量只放 `local.yaml`
- `config/feishu/<account>.json` 留给运行参数
- 部署时优先显式填写 `bot_name`，让群里 `@` 识别和 `bot_open_id` 自动探测更稳定
- 每个机器人单独配置 `codex.cwd`
- 如果需要跨多个目录工作，可以额外配置 `codex.add_dirs`
- `bot_open_id` 可以不手填，群里第一次成功 `@` 机器人后会自动探测并持久化
- 如果你已经通过 `codex login` 登录，也可以不填 `codex.api_key`

## 快速验证

先做 dry run：

```bash
node tools/feishu_ws_bot.js --account assistant --dry-run
```

如果输出里看到这些关键信号，基本就通了：

- `app_id_found=true`
- `app_secret_found=true`
- `codex_found=true`
- `progress_mode=doc` 或你自己的配置值
- `codex_cwd=...`

## 飞书开放平台设置

### 控制台入口

- 控制台首页：[open.feishu.cn/app](https://open.feishu.cn/app)
- 文档首页：[open.feishu.cn/document/home/index](https://open.feishu.cn/document/home/index)

### 操作路径

![Feishu Paths](docs/images/feishu-console-paths.svg)

在飞书开放平台里，你至少会走这几条路径：

- 机器人能力：
  - 飞书开放平台 → 应用详情 → 机器人
- 事件订阅：
  - 飞书开放平台 → 应用详情 → 开发配置 → 事件与回调
- 权限配置：
  - 飞书开放平台 → 应用详情 → 权限管理与授权 → 权限配置

### 需要拿到的值

你需要把这些值配进 `local.yaml` 或环境变量：

- `app_id`
- `app_secret`
- `encrypt_key`
- `verification_token`
- `bot_name`
- `bot_open_id`（可选，缺省时会在第一次成功 `@` 机器人后自动探测并写回 `local.yaml`）

### 必订阅事件

- `im.message.receive_v1`

没有这个事件，机器人就收不到消息。

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

### 当前项目实测使用的完整权限清单

<details>
<summary>展开查看完整 scopes</summary>

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:document.content:read",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive",
      "drive:drive.metadata:readonly",
      "drive:drive.search:readonly",
      "drive:drive:readonly",
      "drive:drive:version",
      "drive:drive:version:readonly",
      "event:ip_list",
      "im:app_feed_card:write",
      "im:biz_entity_tag_relation:read",
      "im:biz_entity_tag_relation:write",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.announcement:read",
      "im:chat.announcement:write_only",
      "im:chat.chat_pins:read",
      "im:chat.chat_pins:write_only",
      "im:chat.collab_plugins:read",
      "im:chat.collab_plugins:write_only",
      "im:chat.managers:write_only",
      "im:chat.members:bot_access",
      "im:chat.members:read",
      "im:chat.members:write_only",
      "im:chat.menu_tree:read",
      "im:chat.menu_tree:write_only",
      "im:chat.moderation:read",
      "im:chat.tabs:read",
      "im:chat.tabs:write_only",
      "im:chat.top_notice:write_only",
      "im:chat.widgets:read",
      "im:chat.widgets:write_only",
      "im:chat:create",
      "im:chat:delete",
      "im:chat:moderation:write_only",
      "im:chat:operate_as_owner",
      "im:chat:read",
      "im:chat:readonly",
      "im:chat:update",
      "im:datasync.feed_card.time_sensitive:write",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.urgent",
      "im:message.urgent.status:write",
      "im:message.urgent:phone",
      "im:message.urgent:sms",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_depts",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "im:tag:read",
      "im:tag:write",
      "im:url_preview.update",
      "im:user_agent:read",
      "sheets:spreadsheet",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}
```

</details>

## 启动

前台跑单个账号：

```bash
node tools/feishu_ws_bot.js --account assistant
```

统一管理多账号：

```bash
bash tools/feishu_bot_ctl.sh list
bash tools/feishu_bot_ctl.sh start all
bash tools/feishu_bot_ctl.sh status all
bash tools/feishu_bot_ctl.sh logs assistant --follow
bash tools/feishu_bot_ctl.sh restart assistant
bash tools/feishu_bot_ctl.sh stop all
```

## 开机自启

macOS 下可安装 LaunchAgents：

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

如需自定义：

```bash
export SUNCODEXCLAW_LAUNCHCTL_PREFIX="com.example.suncodexclaw.feishu"
```

## 消息能力

### 文本

- 支持普通文本回复
- 支持多轮上下文
- 支持 `/threads`、`/thread new`、`/thread switch`、`/thread current`、`/reset`

### 图片

- 图片会先下载到本地
- 再作为输入交给 Codex 分析
- 如果 Codex 产出图片，可以回发原生图片消息

如果 Codex 想把本机图片发回飞书，可以在输出里单独占行写：

```text
[[FEISHU_SEND_IMAGE:/absolute/or/relative/path]]
```

机器人会自动上传并回发原生图片消息。当前单图片限制是 `10 MB`。

### 语音

- 支持直接接收飞书语音消息
- 机器人会先下载语音，再转写成文字交给 Codex
- 默认复用 `codex.api_key` 做转写，也可以单独配置 `speech.api_key`

### 文件读取

用户发飞书文件时，机器人会：

1. 下载到本地临时目录
2. 把临时路径写进 prompt
3. 让 Codex 直接读取文件
4. 回复后清理临时目录

### 文件发送

如果 Codex 想把本机文件发回飞书，可以在输出里单独占行写：

```text
[[FEISHU_SEND_FILE:/absolute/or/relative/path]]
```

机器人会自动上传并回发文件。当前单文件限制是 `30 MB`。

### 群聊触发

默认是：

- P2P 可直接聊
- 群里需要 `@机器人`

同时支持一个很适合干活的补偿链路：

- 同一个人先 `@机器人`
- 2 分钟内单独发文件 / 图片 / 富文本
- 机器人仍会把后续消息算进同一轮任务

群聊里还有一个默认保护策略：

- 某个人已经 `@机器人` 并触发任务后，其他人后续发消息不会直接把这轮任务顶掉
- 只有发起任务的那个人再次明确 `@机器人`，当前任务才会被 supersede 并改跑新需求

## 云文档进度

支持两种进度模式：

- `message`
- `doc`

`doc` 模式下会：

- 创建飞书云文档
- 持续写入进度
- 用标题、加粗、代码块排版
- 把执行命令、`stdout`、`stderr`、最终回复写进去
- 在会话里只发文档链接和最终结果

这套模式很适合长任务，因为聊天窗口不会被刷爆。

## Skills、记忆和电脑操作

这个项目本身不重新发明 Skills、记忆和电脑控制，而是把 Codex 原生能力接进飞书：

- Skills：
  - 你的 Codex 环境能用 Skills，这个机器人就能用
- 记忆：
  - 每个 chat 都有线程历史
  - 每个线程只保留有限轮，兼顾效果和 token 成本
- 电脑操作：
  - 通过 Codex 在本机工作区里执行
  - 能读文件、改代码、跑命令、产出文件、把文件发回飞书

## 常见问题

### 1. 机器人不回

优先检查：

- `--dry-run` 是否能看到 `app_id_found=true`
- 飞书应用是否已发布
- 是否真的订阅了 `im.message.receive_v1`
- 群里是否真正 `@` 到了这个 bot

### 2. 云文档能创建，但发不出链接

通常是 `docx` 已开，但 `drive` 没开全。至少补：

- `drive:drive`
- `drive:drive.metadata:readonly`

### 3. 文件回发失败

检查：

- 文件是否存在
- 是否是普通文件
- 是否超过 `30 MB`
- 飞书权限里是否有消息发送和资源相关权限

### 4. Codex 明明装了，但机器人起不来

检查：

- `codex --version`
- `which codex`
- LaunchAgents 环境里是否能拿到 `codex`
- token 是不是已经通过 `codex` 登录或在配置里提供

## 安全建议

- 不要提交 `config/secrets/local.yaml`
- 不要把真实的 `config/feishu/*.json` 推到公开仓库
- 给每个机器人单独配置 `codex.cwd`
- 对能改代码、能操作电脑的机器人，明确评估 `sandbox` 和 `approval_policy`
