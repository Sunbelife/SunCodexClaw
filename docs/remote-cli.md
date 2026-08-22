# SunCodexClaw 远程 CLI

远程 CLI 让另一台电脑通过互联网连接运行 SunCodexClaw 的电脑，列出机器人、创建独立 CLI 会话，并持续与指定机器人对话。

默认链路参考 CC Pocket/Claude Remote Control 的出站消息模式：

```text
远程电脑：scc CLI  ── WSS 密文 ── 公网 Relay ── WSS 密文 ── 机器人电脑：Remote Gateway
                                                                    │
                                                                    └─ 本机机器人/Codex
```

机器人电脑和远程电脑都只主动访问 Relay，不需要公网 IP、端口映射、同一局域网或 Tailscale。Relay 只按机器 ID 转发 AES-256-GCM 密文，不持有客户端端到端密钥，也不保存聊天正文。

## 支持的能力

- 一个 CLI 保存多台机器人电脑，并用别名切换。
- 列出一台电脑上配置的全部机器人和运行状态。
- 创建、查看和复用 CLI 专属会话。
- 发送任务，查看 Codex 执行进度和最终回复。
- 每台客户端电脑使用独立 token，可随时撤销。
- 机器人电脑断线后指数退避自动重连。
- Remote Gateway 不返回飞书密钥、Codex API Key、工作区路径或本机日志路径。

当前版本支持文本和执行进度；远程附件上传/下载暂未开放。

## 一、准备公网 Relay

Relay 是一个很小的 WebSocket 转发服务，需要运行在有 HTTPS/WSS 域名的公网服务器上。仓库提供了 Docker 和 Caddy 示例，见 [`deploy/relay/README.md`](../deploy/relay/README.md)。

部署完成后会得到类似地址：

```text
wss://relay.example.com
```

同时为 Relay 设置一段机器注册密钥 `SCC_RELAY_REGISTRATION_KEY`。这段密钥只在首次把机器人电脑注册到 Relay 时使用，不会放进发给远程 CLI 的连接 token。

## 二、在机器人电脑上启用 Remote Gateway

进入 SunCodexClaw 仓库：

```bash
cd /Users/sunbelife/Code/SunCodexClaw
npm install
```

首次设置：

```bash
npm run remote:setup -- \
  --relay wss://relay.example.com \
  --registration-key 'Relay机器注册密钥' \
  --machine-name "我的机器人电脑" \
  --name "第一台远程电脑"
```

命令会输出：

- `transport: relay`：表示使用消息中继，不是直连本机端口。
- `tokenId`：以后撤销这台客户端时使用。
- `connectionToken`：以 `scc2_` 开头，只显示这一次，复制到远程电脑。

将 Gateway 安装为 macOS 登录后自动运行的服务：

```bash
npm run remote:install
```

查看配置、运行状态和连接日志：

```bash
npm run remote:status
bash tools/install_remote_gateway_launchagent.sh status
npm run remote:logs
```

日志出现下面的内容表示机器人电脑已经主动连接 Relay：

```text
SCC_RELAY_HOST_CONNECTED relay=wss://relay.example.com machine=我的机器人电脑
```

## 三、在另一台电脑安装 CLI

先安装 [Node.js LTS](https://nodejs.org/en/download)。如果另一台电脑已经 clone 了本仓库，在仓库目录中一行完成更新、安装和绑定：

```bash
git pull origin sun && npm install -g --omit=optional . && scc machine add home 'scc2_这里粘贴connectionToken'
```

如果还没有仓库，一行首次安装：

```bash
git clone -b sun https://github.com/Sunbelife/SunCodexClaw.git && cd SunCodexClaw && npm install -g --omit=optional . && scc machine add home 'scc2_这里粘贴connectionToken'
```

也可以在机器人电脑生成仅 10 KB 左右的独立 CLI 安装包，再复制到另一台电脑：

```bash
npm run remote:cli:pack
npm install -g ~/Downloads/suncodexclaw-cli-1.2.0.tgz
```

确认安装和绑定：

```bash
scc --help
scc machine list
```

CLI 会从 token 读取 Relay 地址和机器身份，自动向机器人电脑发送加密消息：

```bash
scc machine list
scc -m home bot list
scc -m home chat fei-ls
```

发送一次任务：

```bash
scc -m home ask fei-ls "检查一下项目测试为什么失败"
```

## 四、连接多台机器人电脑

每台机器人电脑都连接同一个 Relay，但各自拥有独立机器身份和密钥。在 CLI 中保存不同别名：

```bash
scc machine add home 'scc2_第一台电脑的token'
scc machine add office 'scc2_第二台电脑的token'
scc machine add studio 'scc2_第三台电脑的token'

scc machine list
scc machine use office
scc bot list
scc -m home bot list
```

## 五、新建和撤销客户端 token

以后增加一台远程电脑，在机器人电脑的仓库里运行：

```bash
npm run remote:pair -- --name "办公室 MacBook"
```

查看已经签发的 token：

```bash
npm run remote:token:list
```

列表不会再次显示 token 或端到端密钥明文。撤销某台客户端：

```bash
npm run remote:token:revoke -- --id tok_xxx
```

撤销即时生效，不需要重启 Gateway。

## 六、会话命令

```bash
scc -m home thread list fei-ls
scc -m home thread new fei-ls "代码排查"
scc -m home chat fei-ls --thread studio-xxx
scc -m home ask fei-ls "继续刚才的排查" --thread studio-xxx
```

CLI 会话不会自动把回复发进飞书，也不要求绑定飞书 `chat_id`。

## 安全说明

- `connectionToken` 等同于远程操作该机器人电脑的凭证，不要发到群聊、工单或代码仓库。
- Relay 链路使用 WSS；消息正文另外使用 token 内的 256 位密钥做 AES-256-GCM 端到端加密。
- Relay 注册表只保存机器人电脑认证密钥的 SHA-256 哈希，不保存原始密钥、客户端密钥或消息体。
- Gateway 和 CLI 配置均以仅当前用户可读的 `0600` 权限保存。
- Remote Gateway 与本机 Dashboard 分离，不提供配置编辑、密钥读取、机器人启停等管理接口。
- 本机审计日志位于 `.runtime/remote_gateway/audit.jsonl`，只记录时间、客户端 token ID、接口和状态，不记录聊天正文。
- 端到端加密不是沙箱；机器人仍然拥有其本机 Codex 配置授予的文件和命令权限。

## 兼容的直连模式

Relay 是默认推荐方式。局域网、Tailscale 或已有 HTTPS Tunnel 仍可使用原来的直连模式：

```bash
npm run remote:setup -- \
  --direct \
  --host 127.0.0.1 \
  --port 8732 \
  --url https://你的Tunnel域名
```

直连模式生成旧版 `scc1_` token；Relay 模式生成 `scc2_` token。CLI 同时兼容两种格式。
