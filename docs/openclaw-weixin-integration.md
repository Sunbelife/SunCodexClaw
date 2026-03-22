# OpenClaw Weixin 接入

这次不是把 `npx -y @tencent-weixin/openclaw-weixin-cli@latest install` 生搬进 `SunCodexClaw`，而是把它背后的微信协议单独抽出来，给我们自己的机器人补了一条最小可跑的微信入口。

## 结论

可以接，但不能直接把那条 `npx install` 当成我们机器人的启动命令。

原因很简单：

- `@tencent-weixin/openclaw-weixin-cli` 只是安装器。
- 它真正做的是：
  - 检查本机有没有 `openclaw`
  - 安装 `@tencent-weixin/openclaw-weixin` 插件
  - 触发扫码登录
  - 重启 `openclaw gateway`
- 我们当前仓库不是 OpenClaw 运行时，而是自己的 Feishu + Codex 机器人。

所以要“模拟这个方法接入微信”，正确做法不是套一层 OpenClaw，而是直接复用它公开插件里的微信收发协议。

## 这次已经落下来的能力

- `tools/weixin_openclaw_bot.js`
  - 支持扫码登录
  - 支持长轮询 `getupdates`
  - 支持把微信文本、图片、文件消息送进 `codex exec`
  - 支持把回复按微信文本分片发回去
  - 支持通过 `[[WEIXIN_SEND_IMAGE:...]]` / `[[WEIXIN_SEND_FILE:...]]` 直接回发本地图片和文件
  - 支持按发送方隔离 `codex` 会话上下文
  - 支持 `typing` 状态
- `tools/lib/openclaw_weixin_client.js`
  - 封装了 `getupdates / sendmessage / getconfig / sendtyping`
  - 封装了二维码登录轮询
- `tools/lib/openclaw_weixin_media.js`
  - 封装了微信媒体上传、下载、AES 解密和附件落盘
- `config/weixin_openclaw/default.example.json`
  - 给了独立的微信通道配置模板

## 当前还没补完的地方

- 多账号统一启停脚本
- 和 Feishu 那套长期 memory bundle 的复用
- 语音 / 视频消息处理

也就是说，现在这条线已经能证明“我们的机器人可以按 OpenClaw 那个微信接法跑起来”，而且文本、图片、文件都已经打通；只是整体还属于实验版。

## 用法

先准备配置：

```bash
cp config/weixin_openclaw/default.example.json config/weixin_openclaw/default.json
```

扫码登录：

```bash
node tools/weixin_openclaw_bot.js --account default --login
```

启动机器人：

```bash
node tools/weixin_openclaw_bot.js --account default
```

只轮询一轮做联调：

```bash
node tools/weixin_openclaw_bot.js --account default --once
```

## macOS 常驻运行注意

如果你准备让微信机器人通过 `launchctl` 常驻运行，建议把 `codex.bin` 配成绝对路径。

例如：

```json
{
  "codex": {
    "bin": "/Applications/Codex.app/Contents/Resources/codex"
  }
}
```

原因很简单：`launchctl` 的后台环境经常拿不到你交互终端里的 PATH，直接写 `codex` 可能会报 `spawn codex ENOENT`。

## secrets 写入位置

扫码成功后，微信 token 会写入：

```yaml
config:
  weixin_openclaw:
    default:
      token: "..."
      base_url: "https://ilinkai.weixin.qq.com"
      account_id: "..."
      user_id: "..."
```

也就是和我们现有 `local.yaml` 的 secrets 体系保持一致，不另外散落一份凭据文件。
