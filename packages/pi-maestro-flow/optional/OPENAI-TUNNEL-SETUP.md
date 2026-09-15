# OpenAI Secure MCP Tunnel 配置指南（实验性）

本文档用于 `/install` 的 `openai-tunnel` 安装项。该能力只编排用户自行取得的外部 `tunnel-client`，并通过原生 Gateway 配置引用凭证环境变量。新配置的生命周期入口是 `tunnels.profiles` 中的 OpenAI Secure profile；`tunnels.openai` 保留给安装探测和兼容的 provider 级命令。

## PURPOSE

为原生 Gateway 显式启用实验性的 OpenAI Secure MCP Tunnel，并验证外部 client、凭证引用和 tunnel readiness。

必须保留以下边界：

- **experimental**：默认关闭，只有 `tunnels.openai.enabled: true` 才启用。
- **no auto-download**：Pi 和 `/install` 绝不下载、更新或替换 `tunnel-client`。
- **no provisioning**：Pi 绝不创建、认领或删除 OpenAI tunnel；tunnel 必须已由用户通过外部受信流程预配。
- **reference-only secrets**：Gateway YAML 只保存环境变量名称，不保存 tunnel id、runtime API key 或其他 secret 值。

## PREREQUISITES

- 原生配置路径为 `~/.pi/agent/gateway/config.yaml`；不要写入旧 MCPX 配置。
- 用户已通过 OpenAI 支持的外部流程预配 tunnel，并能自行管理其生命周期。
- 用户已从受信来源手工安装符合公开 CLI contract 的 `tunnel-client`，版本至少为 `0.0.14`。不要由 AI 猜测下载 URL或执行下载安装。
- Gateway 启动环境中已有两个凭证引用。默认名称是 `CONTROL_PLANE_TUNNEL_ID` 和 `CONTROL_PLANE_API_KEY`；值由用户的 secret manager、服务管理器或当前 shell 注入。
- `pi-maestro-gateway` 可启动，并且本地 HTTP MCP transport 可用。

## TASK

### 1. 只收集非敏感配置

按 INTERACTIVE INPUTS 确认：

- `tunnel-client` 的现有绝对路径；
- 两个环境变量的**名称**；
- 用户已经预配 tunnel 且接受 experimental 语义。

不要询问、显示、复制或写入这两个环境变量的值。只让用户在其既有 secret 管理边界中确认变量对 Gateway 进程可用。

### 2. 验证外部 client

由用户确认 client 来源后，仅执行身份检查：

```bash
"<absolute-path-to-tunnel-client>" --version
```

版本必须是受支持的 `0.0.x`，且不低于 `0.0.14`。缺失或不兼容时停止并报告；不得自动下载、升级或换用未知二进制。

### 3. 更新原生 Gateway 配置

在 `~/.pi/agent/gateway/config.yaml` 中合并以下 section，保留所有其他 section 和注释：

```yaml
server:
  disable_localhost_protection: true
  trust_proxy_headers: true
auth:
  mode: oauth
  oauth:
    password: replace-with-an-operations-password
    server_url: "https://mcp.example.test"
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
    binary_path: "/absolute/path/to/tunnel-client"
    tunnel_id_env: "CONTROL_PLANE_TUNNEL_ID"
    runtime_key_env: "CONTROL_PLANE_API_KEY"
    minimum_version: "0.0.14"
    credential_ttl_ms: 300000
  profiles:
    - id: "openai-prod"
      provider: "openai"
      mode: "secure"
      lifecycle: "persistent"
      enabled: true
      public_url: "https://mcp.example.test"
      tunnel_id_env: "CONTROL_PLANE_TUNNEL_ID"
      runtime_key_env: "CONTROL_PLANE_API_KEY"
      credential_ttl_ms: 300000
      mcp_access:
        enabled: true
        auth: { kind: "managed-forward", provider: "openai" }
        actions:
          - "gateway.host.status"
          - "fabric.control.device.list"
```

`profiles.openai-prod.enabled` 是 canonical persistent desired state；`tunnels.openai.enabled` 仍需保持为 `true`，这样 `/install list` 才会报告已安装，并兼容旧的 `tunnel start openai default` 入口。新部署请始终使用 `tunnel profile ... openai-prod`，避免绕过 profile 的 MCP access policy。

约束：

- `binary_path` 指向用户已经安装的 client；不得触发下载。
- `tunnel_id_env` 与 `runtime_key_env` 是环境变量名，不是 credential 值。
- 不得把 tunnel id、API key、bearer token 或任何 secret literal 写入 YAML。
- `credential_ttl_ms` 是 Gateway 发放给 client 的短期本地凭证 TTL；`profiles` 中的 OpenAI Secure profile 允许范围为 `60000..3600000`，兼容的 `tunnels.openai` provider defaults 允许 `1000..3600000`，推荐两处都保留 `300000`。
- 如需 MCP 转发，必须显式配置 profile 的 `mcp_access`。actions 只能是精确的 `gateway.<tool>.<action>` 或 `fabric.control.<tool>.<action>`，不能使用通配符，也不能包含 Fabric enrollment/exchange/events/WSS 路由。
- MCP ingress 始终由 Gateway 在 `127.0.0.1` 上监听，并保留 MCP session/header/body 语义；Fabric HTTPS/WSS 仍只在 native TLS listener 上提供。
- 不要编辑 `/gateway` UI 的实现；本安装项直接使用 native Gateway config。

### 4. 验证配置状态和运行时

重启 Gateway，使其从启动环境和 YAML 重新加载配置。然后依次执行：

```bash
# 在 Pi 内查看静态 setup probe
/install list

# Gateway 已运行时的只读 supervisor 状态检查
pi-maestro-gateway tunnel doctor --config ~/.pi/agent/gateway/config.yaml --json

# canonical persistent profile 生命周期
pi-maestro-gateway tunnel profile status openai-prod --config ~/.pi/agent/gateway/config.yaml --json
pi-maestro-gateway tunnel profile start openai-prod --config ~/.pi/agent/gateway/config.yaml --json
```

`tunnel doctor` 只读取本地 supervisor 状态，返回 `sideEffects: false`，不会启动 client 或执行 provider doctor。`profile start`/`profile restart` 才会在共享 deadline 内验证 client identity/version、两个环境变量引用、本地 MCP 和外部 client 的 control-plane `/readyz`。若 profile 当前为 disabled，可使用 `tunnel profile enable openai-prod`；该操作会持久化启用意图，并在 daemon 在线时执行受控重启。

旧的 `pi-maestro-gateway tunnel start openai default` / `status openai default` 仍为兼容入口，但不读取 `openai-prod` 的 profile-specific `mcp_access` policy；不要用它验证新的 managed-forward 配置。

不得用 `--experimental`、`--tunnel-id-env` 或 `--runtime-key-env` 携带任何 secret 值；原生配置已经提供显式 opt-in 和变量名。

## INTERACTIVE INPUTS

必须用 `ctx.ui` 询问且只记录非敏感答案：

1. `ctx.ui.confirm`：用户是否已自行预配 tunnel，并理解该 contract 为 experimental、Pi 不会 provisioning。
2. `ctx.ui.input`：已安装 `tunnel-client` 的绝对路径。若不存在或版本低于 `0.0.14`，停止；不要下载。
3. `ctx.ui.input`：tunnel id 的环境变量名称，默认 `CONTROL_PLANE_TUNNEL_ID`。
4. `ctx.ui.input`：runtime key 的环境变量名称，默认 `CONTROL_PLANE_API_KEY`。
5. `ctx.ui.confirm`：用户是否已在 Gateway 启动环境中安全注入这两个变量。只确认可用性，不要求粘贴或持久化值。
6. `ctx.ui.confirm`：是否以 `credential_ttl_ms: 300000` 启用。profile 配置需要修改时只接受 `60000..3600000` 的整数。

任一确认被拒绝时保持 `enabled: false`，不启动 tunnel。

### 公网 MCP 客户端

固定公网 MCP URL 是 `public_url + transport.http.path`，本例为 `https://mcp.example.test/mcp`。公网客户端应通过该 origin 的 OAuth metadata 完成授权；如果 Gateway 使用 bearer 模式，则使用 Gateway 自身配置的 bearer。OpenAI provider 生成的 `gateway.tunnel` credential、loopback URL 和临时 authorization 文件只属于 tunnel-client 到 Gateway 的内部 hop，不能复制到公网客户端配置或日志。

## VERIFY

成功必须同时满足：

1. `tunnel-client --version` 报告受支持的 `0.0.x` 且版本 `>= 0.0.14`。
2. `~/.pi/agent/gateway/config.yaml` 的 `tunnels.openai` 包含 `enabled`、`binary_path`、`tunnel_id_env`、`runtime_key_env`、`minimum_version`、`credential_ttl_ms`，且不含 secret literal。
3. `/install list` 对 `openai-tunnel` 显示 installed；缺失配置为 not-installed，disabled 或缺少被引用环境变量时为 partial。
4. `pi-maestro-gateway tunnel profile start openai-prod --config ~/.pi/agent/gateway/config.yaml --json` 成功通过 provider doctor 和 readiness probe。
5. `pi-maestro-gateway tunnel profile status openai-prod --config ~/.pi/agent/gateway/config.yaml --json` 显示 running/ready；日志和状态中没有 credential 值。

## ROLLBACK

1. 停止受监管 profile：

   ```bash
   pi-maestro-gateway tunnel profile stop openai-prod --config ~/.pi/agent/gateway/config.yaml --json
   pi-maestro-gateway tunnel profile disable openai-prod --config ~/.pi/agent/gateway/config.yaml --json
   ```

2. 如仍使用兼容的 provider 级入口，再将 `~/.pi/agent/gateway/config.yaml` 中 `tunnels.openai.enabled` 改为 `false`；可保留非敏感的 client path、env 名称、minimum version 与 TTL，或删除整个 `openai` mapping。
3. 重启 Gateway，并确认 `tunnel profile status openai-prod` 不再 running。
4. 按用户自己的 secret manager 流程撤销或轮换 runtime key，并从 Gateway 启动环境移除引用；不要把值复制到配置或日志。
5. 如需删除已预配的 tunnel，必须由用户在 OpenAI 的外部管理流程中完成。Pi 的 rollback 不执行 provisioning/deprovisioning，也不卸载或删除 `tunnel-client`。
