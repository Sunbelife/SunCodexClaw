# Feishu 机器人部署手册

这份手册只保留一条推荐路径：在 macOS 上把每个飞书机器人安装成持久 `LaunchAgent`。

不要再把机器人长期跑在临时 `launchctl submit` 任务上。临时任务一旦被 `remove`、会话波动、或者重启链路打断，就可能直接消失，不会稳定自恢复。

## 目标

- 所有飞书机器人都由 `~/Library/LaunchAgents/*.plist` 托管
- `bash tools/feishu_bot_ctl.sh start|restart|status ...` 会继续沿用 `LaunchAgent` 路径
- 运行中的状态应该显示 `manager=launchagent`

## 前置条件

- Node 使用当前可运行路径：`/usr/local/bin/node`
- Codex 使用绝对路径：`/Applications/Codex.app/Contents/Resources/codex`
- secrets 配置已经写入 `config/secrets/local.yaml`

## 首次安装

安装全部飞书机器人：

```bash
cd /Users/sunbelife/Code/SunCodexClaw

NODE_BIN=/usr/local/bin/node \
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bash tools/install_feishu_launchagents.sh install all
```

只安装单个账号：

```bash
cd /Users/sunbelife/Code/SunCodexClaw

NODE_BIN=/usr/local/bin/node \
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bash tools/install_feishu_launchagents.sh install fei-cxp
```

## 运行态验证

先看 plist 是否已经加载：

```bash
bash tools/install_feishu_launchagents.sh status all
```

再看机器人控制层是否已经识别成 `launchagent`：

```bash
bash tools/feishu_bot_ctl.sh status all
```

理想输出应该像这样：

```text
[loaded] fei-ls plist=/Users/.../Library/LaunchAgents/com.sunbelife.suncodexclaw.feishu.fei-ls.plist
[running] fei-ls pid=... manager=launchagent log=/Users/.../.runtime/feishu/logs/fei-ls.log
```

如果要核对某个账号的 launchd 详情：

```bash
launchctl print gui/$(id -u)/com.sunbelife.suncodexclaw.feishu.fei-ls
```

重点看这几项：

- `type = LaunchAgent`
- `path = /Users/.../Library/LaunchAgents/...plist`
- `state = running`

## 日常管理

重启全部账号：

```bash
bash tools/feishu_bot_ctl.sh restart all
```

重启单个账号：

```bash
bash tools/feishu_bot_ctl.sh restart fei-cxp
```

查看单个账号日志：

```bash
bash tools/feishu_bot_ctl.sh logs fei-cxp --follow
```

## 升级或修复后重装

只要下面任一项发生变化，都建议重新安装对应账号的 `LaunchAgent`：

- `tools/feishu_ws_bot.js`
- `tools/feishu_bot_ctl.sh`
- `tools/install_feishu_launchagents.sh`
- Node 路径
- Codex 路径
- `config/secrets/local.yaml` 中与账号运行环境相关的字段

重装命令：

```bash
cd /Users/sunbelife/Code/SunCodexClaw

NODE_BIN=/usr/local/bin/node \
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bash tools/install_feishu_launchagents.sh install all
```

## 常见问题

### 1. `status` 里看到 `manager=launchctl`

说明这个账号还在跑临时 `submit` 任务，还没有切到持久 `LaunchAgent`。

直接重装该账号：

```bash
NODE_BIN=/usr/local/bin/node \
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bash tools/install_feishu_launchagents.sh install <account>
```

### 2. `install` 时遇到 `Bootstrap failed: 5: Input/output error`

这是 `launchctl` 偶发的 bootstrap 抖动。

处理方式：

```bash
NODE_BIN=/usr/local/bin/node \
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bash tools/install_feishu_launchagents.sh install <account>
```

先单账号重试，不要一上来全量重装。

### 3. 机器人起不来或者刚起就掉

先看：

```bash
bash tools/feishu_bot_ctl.sh status <account>
tail -n 120 .runtime/feishu/logs/<account>.log
```

优先核对：

- `manager` 是不是 `launchagent`
- `codex.bin` 是不是绝对路径
- `node` 路径是不是当前可运行版本
- 日志里有没有 `dyld` / `icu` / `libsimdjson` 这类本机运行时错误
- 日志里有没有 `ws client ready`

## 当前约束

- `LaunchAgent` 能根治“临时 `submit` 任务自己丢了”的问题
- 但如果飞书凭据失效、Node 本机运行时损坏、或者飞书长连接本身异常，仍然需要按日志继续排障
