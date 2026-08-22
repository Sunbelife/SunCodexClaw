# 部署 SunCodexClaw Relay

Relay 只负责在 CLI 和机器人电脑之间转发端到端加密的 WebSocket 帧。它不运行 Codex，不持有聊天密钥，也不保存消息正文。

## 要求

- 一台有公网入口的 Linux 服务器。
- 一个解析到该服务器的域名，例如 `relay.example.com`。
- Docker Compose。
- Caddy、Nginx 或其他支持 WebSocket 的 HTTPS 反向代理。

## 启动 Relay

在服务器 clone 仓库，然后进入部署目录：

```bash
cd SunCodexClaw/deploy/relay
```

生成一段只用于注册机器人电脑的随机密钥，并放进 `.env`：

```bash
openssl rand -hex 32
```

`.env` 内容：

```dotenv
SCC_RELAY_REGISTRATION_KEY=上一步生成的随机值
```

启动：

```bash
docker compose up -d --build
```

Relay 默认只映射到服务器的 `127.0.0.1:8782`，不会把明文 WebSocket 端口直接暴露到公网。

## 配置 WSS

把 [`Caddyfile.example`](./Caddyfile.example) 里的域名换成真实域名，交给宿主机 Caddy。Caddy 会自动申请 TLS 证书，并把 HTTPS/WSS 请求转发到 Relay。

验证：

```bash
curl https://relay.example.com/healthz
```

正常响应包含：

```json
{"ok":true,"service":"suncodexclaw-relay"}
```

机器人电脑使用的地址是：

```text
wss://relay.example.com
```

## Relay 保存的数据

Docker volume `relay-data` 中只有 `registry.json`，内容包括：

- 随机机器 ID。
- 机器人电脑认证 secret 的 SHA-256 哈希。
- 首次注册时间。

不保存原始认证 secret、客户端端到端密钥、prompt、机器人回复或工具输出。

## 更新

```bash
git pull
cd deploy/relay
docker compose up -d --build
```
