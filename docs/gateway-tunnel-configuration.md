# Gateway Tunnel 配置指南

本文记录 Pi Maestro Gateway 当前支持的公网入口配置：Cloudflare Quick、Cloudflare Named、OpenAI Secure 和 Managed OpenSSH Reverse。多设备连接与路由的目标架构见 [Pi Maestro Multi-Device Fabric](./fabric/README.md)。普通 MCP server 的注册与 OAuth 认证仍使用 `/mcp`，见 [MCP server setup](../packages/pi-maestro-flow/optional/MCP-SETUP.md)；本文只讨论现有 Gateway ingress tunnel。

## 1. 基础 HTTP 与认证

Gateway 默认 MCP endpoint 是 `http://127.0.0.1:9090/mcp`。公网 tunnel 应继续让 Gateway HTTP 监听 loopback，由 tunnel 或服务器反向代理提供 HTTPS。

固定公网 origin 必须使用 `oauth` 或 `dual`，并使 `auth.oauth.server_url` 与启用的 persistent profile `public_url` 完全一致：

```yaml
server:
  host: 127.0.0.1
  port: 9090
  disable_localhost_protection: true
  trust_proxy_headers: true
auth:
  mode: oauth
  oauth:
    password: change-this-operations-password
    server_url: https://mcp.example.com
    token_ttl_ms: 86400000
transport:
  http:
    enabled: true
    host: 127.0.0.1
    port: 9090
    path: /mcp
    tls:
      enabled: false
```

配置文件不做环境变量插值；示例 password 必须替换，并保护 Gateway 配置文件权限。`dual` 模式还必须配置 `auth.token`。

最终 MCP URL 的规则是：

```text
MCP URL = tunnel endpoint/public_url + transport.http.path
```

例如 `public_url: https://mcp.example.com` 和 `path: /mcp` 得到 `https://mcp.example.com/mcp`。`/mcp` 只是 MCP path，不是可单独代理的完整 OAuth 服务。公网代理必须转发整个 origin，至少覆盖：

- `/.well-known/oauth-protected-resource` 及其 MCP-path 变体；
- `/.well-known/oauth-authorization-server`；
- `/authorize`、`/token`、`/register`；
- 配置的 MCP path，例如 `/mcp`。

## 2. `/gateway tunnel` 与独立配置 TUI

Pi 内的 `/gateway tunnel` 是公网 MCP 入口的专用人工操作面；`/mcp` 仍只管理 Pi 通用 MCP servers，`/gateway` 和 `/gateway config` 的既有主页/通用配置行为不变。Tunnel 页面只展示 allowlist connection descriptor，不显示 tunnel ID、opaque ID、bearer、runtime key、authorization file、argv 或 provider 原始诊断。

固定 profile 的 MCP access policy 使用精确 action，权限仍由 Gateway host 的 `GatewayRuntime.call()` 执行；`workspaceId` 只约束已有 workspace policy 覆盖的资源，不构成全局 Fabric 租户沙箱：

```yaml
tunnels:
  profiles:
    - id: openai-prod
      provider: openai
      mode: secure
      lifecycle: persistent
      enabled: false
      public_url: https://openai-tunnel.example.com
      mcp_access:
        enabled: true
        auth:
          kind: managed-forward
          provider: openai
          workspace_id: "0000000000000000000000000000000000000000000000000000000000000000"
        actions:
          - gateway.host.status
          - fabric.control.device.list
          - fabric.control.endpoint.describe
          - fabric.control.route.open
```

`actions` 是新配置的规范键；`scopes` 仅作为兼容输入。配置加载同时接受 `mcp_access`/`mcpAccess`、`workspace_id`/`workspaceId` 等别名，但新文档和新配置应优先使用上面的形式。`managed-forward` 只适用于 OpenAI Secure；`auth.kind: gateway` 不接受 profile action allowlist，公网客户端仍遵循 Gateway 自身的 OAuth/bearer 策略。禁止 wildcard/umbrella、`fabric.data`、Fabric enrollment/exchange/events 或 Connector WSS scopes。`workspace_id` 必须是已有 workspace policy 的 64 位小写十六进制 ID，不是任意租户标签。

辅助 tunnel ingress 只绑定 `127.0.0.1`，共享 Gateway runtime/auth/catalog/policy/audit；native HTTPS 与 Fabric Connector WSS 不降级、不经 tunnel 转发。OpenAI 的 `gateway.tunnel` bearer 只用于 tunnel-client 到 loopback Gateway 的内部 hop，写入受保护的临时授权文件；它不是给公网 MCP 客户端复制的 token。

配置或 policy 变更在 daemon 在线时会被拒绝保存，避免旧权限继续生效；先停止 daemon，再保存并按需显式启动。固定 profile 切换会先停止旧 profile，更新 OAuth origin 后受控重启；Quick profile 始终 ephemeral，`e/x` 只做临时启停，不持久化 `enabled`。

### 2.1 从 profile 到可用 MCP URL

按以下顺序完成一次配置：

1. **离线编辑 profile**：在 daemon 停止时通过 `/gateway tunnel` 的结构化编辑器或 `pi-maestro-gateway config` 写入 profile。固定 profile 必须让 `auth.oauth.server_url` 与 `public_url` 完全一致；只有启用 `managed-forward` MCP access 时才必须显式写 `enabled: true` 与非空 `actions`，`auth.kind: gateway` 应保持空 action allowlist。启用 MCP access 后 Gateway 会自动创建 loopback 辅助 ingress 并使用实际绑定端口，profile 中的 `local_port` 不应被当作公网端口。
2. **启动 Gateway**：按部署方式启动 daemon，例如：

   ```bash
   pi-maestro-gateway service ensure --config /secure/gateway.yaml --json
   ```

3. **检查并启动**：

   ```bash
   pi-maestro-gateway tunnel doctor --config /secure/gateway.yaml --json
   pi-maestro-gateway tunnel profile status PROFILE --config /secure/gateway.yaml --json
   pi-maestro-gateway tunnel profile start PROFILE --config /secure/gateway.yaml --json
   ```

   `tunnel doctor` 是只读、无副作用的 supervisor 状态检查，不会调用 provider 的外部 doctor；`profile start`/`restart` 才会执行 provider-specific doctor、启动进程并进行 bounded readiness probe。
4. **配置公网 MCP 客户端**：persistent profile 使用 `public_url + transport.http.path`，例如 `https://mcp.example.com/mcp`；Quick profile 使用 `profile status --json` 的 `observed.endpoint` 加 path，每次启动都可能变化。OAuth 客户端应通过公开 origin 的 metadata 自动发现授权端点；bearer 客户端使用 Gateway 配置的 bearer。不要把 OpenAI 内部 `gateway.tunnel` credential、临时 authorization 文件或 `opaqueId` 写进客户端配置。

`profile enable|disable` 修改 persistent profile 的持久启用意图；`profile start|stop|restart` 只操作当前运行实例。切换 persistent provider 时先停用当前 profile，再启用目标 profile。

不启动 Pi 也可以直接打开 Gateway 的终端配置界面：

```bash
pi-maestro-gateway config
pi-maestro-gateway config --config /secure/gateway.yaml
```

TUI 可编辑监听地址与端口、HTTP path、HTTP/stdio/SSH transport 开关、命令默认策略、只读命令自动允许、localhost 保护、代理头信任和日志级别。它会显示当前认证模式与 tunnel profile 数量，但不会显示或修改认证凭据；公网 tunnel 的 profile 编辑、只读 doctor、人工启停和安全连接描述统一在 `/gateway tunnel` 完成。Tunnel 页面快捷键为 `↑↓`/`j k` 选择、`Enter` 结构化添加或编辑、`d` 只读 doctor、`e` 启用、`x` 停用、`s` 保存、`Esc` 返回；保存不会自动启动 tunnel。

输入编号或字段名修改值，`s` 保存，`q` 放弃。保存采用与 CLI 相同的配置解析、校验和原子写入路径，保留未修改字段及未知顶层 section；重启 Gateway 后生效。TUI 会提示非回环监听、开放命令策略或代理信任带来的暴露风险，但不会替你放宽认证安全策略。

先启动或确保 Gateway daemon：

```bash
pi-maestro-gateway service ensure --config /secure/gateway.yaml --json
```

Profile 命令统一适用于四种模式：

```bash
pi-maestro-gateway tunnel profile list --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile status PROFILE --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile start PROFILE --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile stop PROFILE --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile restart PROFILE --generation N --config /secure/gateway.yaml --json
```

`start`/`stop` 只改变当前进程状态，不改变 profile 的持久启用意图。`--generation N` 应使用同一 profile 最新 `status` 中的 generation；过期 generation 会被拒绝，不能绕过 fence 直接操作 PID。Persistent profile 应使用：

```bash
pi-maestro-gateway tunnel profile enable PROFILE --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile disable PROFILE --config /secure/gateway.yaml --json
```

`enable` 会写入配置并同步固定 OAuth origin；若 daemon 已在线，它会先受控重启，使新的 live HTTP auth/origin 生效，再启动 profile。`disable` 会先停止在线实例再清除启用意图。配置只允许一个 enabled persistent profile。切换时先 `disable` 当前 profile，再 `enable` 目标 profile。

Daemon 启动时会 reconcile profile：enabled persistent profile 会启动或在 PID、executable、process-start identity 和 invocation digest 验证成功后恢复；ephemeral profile 不会自动恢复。Daemon 正常退出会 quiesce persistent 进程但保留运行意图，下一次启动再恢复。Generation fence、restart budget、进程 ownership 和状态文件由 tunnel manager/supervisor 统一管理。

## 3. Cloudflare Quick Tunnel

Quick Tunnel 适合临时测试。URL 每次可能变化，不是固定生产入口，也不会在 daemon 重启时自动恢复。

```yaml
auth:
  mode: bearer
  token: replace-with-a-long-random-token
transport:
  http:
    enabled: true
    host: 127.0.0.1
    port: 9090
    path: /mcp
    tls:
      enabled: false
tunnels:
  profiles:
    - id: quick
      enabled: true
      provider: cloudflare
      mode: quick
      lifecycle: ephemeral
      binary_path: /usr/local/bin/cloudflared
      local_port: 9090
```

启动后从 status 的 `observed.endpoint` 读取 `https://<random>.trycloudflare.com`，最终 MCP URL 是该 endpoint 加 `/mcp`：

```bash
pi-maestro-gateway tunnel profile start quick --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile status quick --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile stop quick --config /secure/gateway.yaml --json
```

Provider 不下载 `cloudflared`，会拒绝重复或无法完整枚举的 Quick 进程。若改用 OAuth，Quick URL 每次变化后都必须同步 `auth.oauth.server_url`；需要稳定 OAuth origin 时应改用 Named 或 SSH Reverse。

## 4. Cloudflare Named Tunnel

Named Tunnel 使用固定 HTTPS origin。`credentials_file` 与 `token_file` 必须二选一，且必须是绝对路径、存在的非 symlink 普通文件。

```yaml
server:
  disable_localhost_protection: true
  trust_proxy_headers: true
auth:
  mode: oauth
  oauth:
    password: change-this-operations-password
    server_url: https://mcp.example.com
    token_ttl_ms: 86400000
transport:
  http:
    enabled: true
    host: 127.0.0.1
    port: 9090
    path: /mcp
    tls:
      enabled: false
tunnels:
  profiles:
    - id: cloudflare-prod
      enabled: true
      provider: cloudflare
      mode: named
      lifecycle: persistent
      public_url: https://mcp.example.com
      tunnel_id: production-gateway
      binary_path: /usr/local/bin/cloudflared
      token_file: /secure/cloudflared.token
      local_port: 9090
```

使用通用 `profile status|enable|disable|start|stop|restart` 命令。Provider 只引用 credential/token 文件，不把其内容放入 argv 或持久状态；Named 日志也不会写入 durable exit detail。

## 5. OpenAI Secure Tunnel（experimental）

OpenAI provider 只编排受支持的外部 `tunnel-client` CLI，不自动下载、安装或 provision。当前 contract 要求兼容的 `0.0.x` client，默认最低版本为 `0.0.14`。Tunnel ID 与 runtime key 只通过环境变量引用；不要把秘密值写入 profile。

```yaml
server:
  disable_localhost_protection: true
  trust_proxy_headers: true
auth:
  mode: oauth
  oauth:
    password: change-this-operations-password
    server_url: https://openai-tunnel.example.com
    token_ttl_ms: 86400000
transport:
  http:
    enabled: true
    host: 127.0.0.1
    port: 9090
    path: /mcp
    tls:
      enabled: false
tunnels:
  openai:
    enabled: true
    binary_path: /opt/openai/bin/tunnel-client
    tunnel_id_env: CONTROL_PLANE_TUNNEL_ID
    runtime_key_env: CONTROL_PLANE_API_KEY
    minimum_version: 0.0.14
    credential_ttl_ms: 300000
  profiles:
    - id: openai-prod
      enabled: true
      provider: openai
      mode: secure
      lifecycle: persistent
      public_url: https://openai-tunnel.example.com
      tunnel_id_env: CONTROL_PLANE_TUNNEL_ID
      runtime_key_env: CONTROL_PLANE_API_KEY
      credential_ttl_ms: 300000
      mcp_access:
        enabled: true
        auth:
          kind: managed-forward
          provider: openai
        actions:
          - gateway.host.status
          - fabric.control.device.list
```

在启动 daemon 的同一环境中设置 `CONTROL_PLANE_TUNNEL_ID` 和 `CONTROL_PLANE_API_KEY`。Provider 会发放短期、窄 scope 的 Gateway credential，并在过期前轮换进程。启用 profile 的 `mcp_access` 后，Gateway 会把 OpenAI tunnel-client 的目标绑定到新建的 `127.0.0.1` 辅助 ingress；不要假设它仍使用主 HTTP listener 的 9090 端口。私有临时文件在退出时删除。该 provider 的 runtime credential 无法跨 daemon 采用，因此恢复时会验证并重启进程。完整的外部 client 安装、`/install` 交互输入和回滚步骤见 [OpenAI Secure MCP Tunnel 配置指南](../packages/pi-maestro-flow/optional/OPENAI-TUNNEL-SETUP.md)。

## 6. Managed OpenSSH Reverse Tunnel

SSH Reverse 只调用系统或显式配置的 OpenSSH client。认证来自 ssh-agent、管理员 SSH config 或绝对 `identity_file`；不接受密码、passphrase、私钥内容、额外 argv、环境覆盖或远程命令。

```yaml
server:
  disable_localhost_protection: true
  trust_proxy_headers: true
auth:
  mode: oauth
  oauth:
    password: change-this-operations-password
    server_url: https://mcp.example.com
    token_ttl_ms: 86400000
transport:
  http:
    enabled: true
    host: 127.0.0.1
    port: 9090
    path: /mcp
    tls:
      enabled: false
tunnels:
  profiles:
    - id: ssh-prod
      enabled: true
      provider: ssh
      mode: reverse
      lifecycle: persistent
      public_url: https://mcp.example.com
      host: gateway-edge.example.net
      user: tunnel
      port: 22
      remote_bind_host: 127.0.0.1
      remote_port: 19090
      local_host: 127.0.0.1
      local_port: 9090
      binary_path: /usr/bin/ssh
      identity_file: /secure/id_ed25519
      config_file: /secure/ssh_config
      known_hosts_file: /secure/known_hosts
      connect_timeout_seconds: 10
      server_alive_interval_seconds: 15
      server_alive_count_max: 3
```

文件字段若提供，必须是绝对路径、存在的非 symlink 普通文件。Host/user 不能是 option，local/remote bind 首轮只允许 `127.0.0.1` 或 `::1`。Remote port 只监听服务器 loopback；服务器公网入口由 Caddy/Nginx 提供。

Provider 在 `doctor` 阶段执行 OpenSSH identity/version 和 `ssh -G` 检查，并拒绝 SSH config 中已有的 effective `LocalForward`、`RemoteForward` 或 `DynamicForward`。实际 argv 强制 BatchMode、ExitOnForwardFailure、StrictHostKeyChecking、PermitLocalCommand=no、RequestTTY=no、connect/server-alive 参数和唯一的 `-N -R`。

OpenSSH 的 `ClearAllForwardings=yes` 会清除命令行 `-R`，与 managed reverse tunnel 不可同时生效。因此 provider 明确使用 `ClearAllForwardings=no`，并以前述 `ssh -G` 拒绝额外 forwarding 来保持“恰好一个托管 reverse forwarding”的约束。

常用操作：

```bash
pi-maestro-gateway tunnel profile status ssh-prod --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile enable ssh-prod --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile restart ssh-prod --generation N --config /secure/gateway.yaml --json
pi-maestro-gateway tunnel profile disable ssh-prod --config /secure/gateway.yaml --json
```

Probe 要求 SSH PID 仍存活、本地 Gateway MCP URL 可达，并且 `public_url + /mcp` 返回 MCP 响应或 OAuth protected-resource challenge。只要 sshd、远端反代或 DNS/TLS 尚未就绪，profile 就不会进入 ready。

## 7. 手工 `ssh -R` 兼容方法

未升级到 managed provider 前，可在 Gateway 主机手工启动等价的固定 reverse forwarding。没有自定义 SSH config 时使用 `-F none`，避免继承额外 forwarding：

```bash
ssh -F none -i /secure/id_ed25519 \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/secure/known_hosts \
  -o PermitLocalCommand=no \
  -o RequestTTY=no \
  -o ClearAllForwardings=no \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -p 22 -N \
  -R 127.0.0.1:19090:127.0.0.1:9090 \
  tunnel@gateway-edge.example.net
```

手工进程不受 Gateway generation fence、restart budget、quiesce/recover 或 CLI ownership 管理。若使用自定义 `-F`，先以 `ssh -G` 检查 effective config 中没有其他 forwarding。

## 8. 服务器最小权限

服务器 `sshd_config` 可把 tunnel 用户限制为仅 remote forwarding，并只允许预定 loopback 端口：

```text
Match User tunnel
    AuthenticationMethods publickey
    AllowTcpForwarding remote
    GatewayPorts no
    PermitListen 127.0.0.1:19090
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    MaxSessions 0
```

`PermitTTY no` 本身不会禁止无 PTY 的 exec；示例依靠 `MaxSessions 0` 禁止 shell、exec 和 subsystem session，同时保留 forwarding。OpenSSH 版本支持时，还可在该用户的 `authorized_keys` 上使用 `restrict,port-forwarding,permitlisten="127.0.0.1:19090"`。修改后先执行 `sshd -t`，再按服务器发行版安全 reload；不要让 `remote_bind_host` 变成 `0.0.0.0` 或 `*`。

Gateway provider 不登录服务器修改 sshd，也不创建用户、密钥或 authorized_keys。

## 9. Caddy、Nginx、DNS 与 TLS

Caddy 必须代理整个 origin：

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:19090
}
```

Nginx 等价配置：

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:19090;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

为 `mcp.example.com` 配置指向 tunnel server 的 A/AAAA 记录，并在 Caddy/Nginx 终止 TLS。Gateway 保持 loopback HTTP；`trust_proxy_headers: true` 只用于这个受控 HTTPS proxy 边界。DNS、TLS、Caddy/Nginx 和 sshd 都是管理员的一次性配置，不由 provider 自动修改。

## 10. 安全限制与排障

- **`tunnel doctor` 没有 provider 版本信息**：这是预期行为；它是 state-only 检查。重新执行 `profile start`/`restart` 才会运行 provider doctor。
- **启动 doctor 报 executable unavailable**：确认 `ssh`/`cloudflared`/`tunnel-client` 在 daemon PATH，或配置绝对 `binary_path`；provider 不自动下载。
- **OpenAI 报 `experimental_blocked` 或 `credentials_missing`**：确认使用的是显式 `profiles` profile、`tunnels.openai`/profile 的 opt-in、client 绝对路径和两个环境变量名称；不要把 secret 值作为 CLI 参数传入。
- **MCP access policy 被拒绝**：OpenAI Secure 必须使用 `auth.kind: managed-forward` 并提供非空精确 `actions`；Cloudflare/SSH 不支持 managed-forward action allowlist。
- **SSH doctor 拒绝文件**：确认 identity/config/known-hosts 是绝对路径、存在、普通文件且不是 symlink。
- **SSH doctor 报 forwarding directives**：删除 SSH config 中对该 host 生效的 LocalForward/RemoteForward/DynamicForward；托管 profile 只能拥有一个 `-R`。
- **SSH 启动后立即退出**：检查 known_hosts、ssh-agent/identity 权限、`AllowTcpForwarding remote`、`PermitListen`、remote port 冲突和 `ExitOnForwardFailure` 诊断。
- **local ready、public 不 ready**：依次检查远端 `127.0.0.1:REMOTE_PORT`、Caddy/Nginx upstream、DNS、TLS 和防火墙。
- **MCP 可达但 OAuth 失败**：确认代理的是整个 origin，`public_url` 与 `auth.oauth.server_url` 完全一致，并透传 Host 与 `X-Forwarded-Proto: https`。
- **restart generation stale**：重新读取 `profile status`，使用当前 generation；不要绕过 ownership fence 杀 PID。
- **切换 persistent provider**：先 disable 当前 profile，确认 stopped，再 enable 目标 profile。不要同时启用 Named、OpenAI 或 SSH persistent profiles。
