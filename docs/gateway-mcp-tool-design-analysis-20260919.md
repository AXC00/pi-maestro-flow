# Gateway MCP 工具设计分析

> 本文分析 Gateway daemon 作为 MCP server 的工具目录、调用管线、认证授权、隧道准入与 Fabric MCP 桥接设计。
> 视角是**服务端工具面**;`/gateway` 命令与 Overlay 控制面见 [gateway-command-mcp-tool-design.md](./gateway-command-mcp-tool-design.md),Fabric 挂载租约契约见 [fabric/mcp-federation.md](./fabric/mcp-federation.md),隧道配置见 [gateway-tunnel-configuration.md](./gateway-tunnel-configuration.md)。
>
> 代码基线:`packages/pi-maestro-flow/src/gateway/`、`src/mcp/`、`src/ssh-manager/`(2026-09-19)。

## 1. 总体架构:一个 Catalog,多种传输

核心设计是**单一注册/分发源 + 多传输宿主**(`catalog.ts:1`:"The single registration and dispatch source for every Gateway transport"):

```text
┌─ stdio relay (stdio-relay.ts) ─→ 本地 IPC socket (ipc.ts, ownerToken 帧认证)
│                                    │
├─ Streamable HTTP MCP (http-server.ts, /mcp 路径, bearer/OAuth/pairing)
│                                    ├─→ GatewayRuntime.createMcpServer(principal)
├─ tunnel-ingress 监听器 (loopback 明文, 供 cloudflare/openai/ssh-reverse 隧道)
│                                    │        ├─ ListTools → catalog.list()
├─ SSH 远端 (pi 侧 ssh 工具 describe/call/start_pi)
│                                    │        └─ CallTool → runtime.call()
└─ Fabric 数据面 (HTTPS exchange/events + WSS connector)
                                     └─→ FabricEndpointDispatcher → McpEndpointBridge
```

每个传输在认证后调用 `runtime.createMcpServer(principal)`(`runtime.ts:593`),得到一个绑定固定 principal 的 MCP `Server`——**principal 在会话建立时固化**,之后每个 `tools/call` 都携带它进入 `runtime.call()`。

## 2. 工具目录:粗粒度 action 复用

`GATEWAY_TOOL_NAMES` 固定 17 个工具(`contracts.ts:87`):

```text
workspace, board, host, exec, job, file, teammate, session, todo,
monitor, handoff, skill, maestro_cli, browser, device, endpoint, route
```

设计要点:

- **Action 复用而非细粒度工具**:每个工具是一个服务门面,`inputSchema` 用 `oneOf` + `action: const` 判别(如 `BOARD_SCHEMA` 16 个 action)。这把 MCP 工具数量压到 17 个,与 pi 侧 `mcp` 代理工具的设计哲学一致(`tool-registrar.ts:2` 注释:"1 tool instead of 100s")。
- **统一信封**:所有 handler 返回 `GatewayResult{ok,status,data,error{code,message,retryable},meta{requestId,principalId,startedAt,durationMs}}`;MCP 层同时填 `content[text=JSON]` 和 `structuredContent`,`isError = !result.ok`(`runtime.ts:609-620`)。
- **能力声明内嵌**:`entry()` 自动派生 `capability=gateway.<name>`、`requiredCapabilities`、MCP annotations(readOnlyHint/destructiveHint 等);`fabricEntry()` 改用 `fabric.control.<name>` 命名空间。
- **双平面工具**:`workspace` 按 `args.version === "fabric.control.v1"` 分流到 `fabricWorkspace` 或普通 `workspace` 服务(`catalog.ts:432`)——同一工具名下承载两个授权域。

## 3. 调用管线 `runtime.call()`(`runtime.ts:470-590`)

分层防御,顺序固定:

1. **准入**:phase 检查(closed → `gateway_closed`;quiescing 只放行 `status/result/get/logs` 读);requestId 采纳(≤256 字符)或生成。
2. **查找 + 参数校验**:catalog 命中 → `validateGatewayValue` 按该工具的 inputSchema 校验(`additionalProperties:false` 全部拒绝未知字段)。
3. **能力检查**:Fabric 控制请求走 `principalHasFabricControlPlane`,其余走 `principalHasGatewayAction`(`capabilities.ts`)。
4. **open 模式变更闸**:`auth.mode=open` 下的 HTTP 非读 action 需 `allow_open_mutations` 显式配置,否则一次性警告(兼容桥)。
5. **策略执行**:`policy.checkRequest/checkOutput` 字节上限、`withConcurrency("request")` 并发配额、`monitor.wait` 单独按 principal 限流并归一化 timeout。
6. **审计**:每次调用写 audit,outcome ∈ allowed/denied/error,deniedCodes 白名单分类。

## 4. 认证与授权模型

- **Principal**:`{id, transport: stdio|http, scopes[], workspaceId?, authenticated, source}`。stdio/IPC principal 是 `local-owner`,`transport==="stdio"` 直接全通(`capabilities.ts:31`)——本地信任锚。
- **HTTP 认证链**(`auth.ts`):Fabric origin grant → bearer → OAuth(授权码+PKCE+动态注册)→ pairing store。`gateway.tunnel` audience 凭证**只在 loopback 来源**被接受(`auth.ts:98`),公网边界拒绝。
- **Scope 匹配**(`gatewayScopeGrants`):显式兼容梯队 `*`/`gateway`/`gateway.*`/精确 `gateway.tool.action`/`gateway.tool`/`gateway.tool.*`/legacy 裸 `tool`/`tool.*`。
- **Fabric 刻意隔离**:`fabric.data.*` 与 `fabric.control.*` 不从 `gateway.*` 伞继承,open auth 和空 scope 永不隐含 Fabric 权限——防止旧授权模型渗透进配对数据面。
- **会话绑定**:MCP session 映射到 principal,`principalKey` 不等即 403;pairing 撤销订阅会关闭存活会话(revoked set 有界 512)。

## 5. 隧道 MCP 准入(`tunnel/mcp-access.ts` + `mcp-exposure.ts`)

这是设计上最精细的部分:

- **两种 auth kind**:
  - `gateway`:授权委托给远端 Agent 自己的 pairing 凭证;profile 里**禁止写 actions**——该模式下 action 列表是无法强制执行的假 allowlist,宁可拒绝也不接受(`mcp-access.ts:147` 注释)。
  - `managed-forward`:仅 OpenAI Secure profile;enabled 时必须显式 actions;由 daemon 侧 `issueGatewayCredential` 从**规范 profile**(非 provider 输入)投影 scope,铸造 `audience=gateway.tunnel` 的 pairing 凭证(`daemon.ts:264`)。
- **Action 白名单语法**:只允许精确 `gateway.<a>.<b>` 或 `fabric.control.<a>.<b>`,禁通配符,禁 `enrollment/exchange/events/wss/websocket` 段,≤64 条。
- **降级语义**:mcpAccess 未启用时凭证策略回退到 `gateway.host.status` 单一 scope(兼容旧行为)。
- **暴露投影**(`mcp-exposure.ts`):status/catalog 只输出 allowlisted 描述符;ephemeral(Quick)隧道不投影 `observed.endpoint`——provider 输出可能含 bearer URL。
- **ingress 监听器**:loopback-only 明文、拒绝 open auth、禁 HTTP upgrade(WSS 限制在主监听器)、与主监听器共享 auth 状态;daemon 启动恢复时先撤销所有 OpenAI tunnel pairing(凭证是进程本地的,不可 adopt)。

## 6. Fabric MCP 路径(远端 MCP server 挂进 pi)

双向设计:

**源端**(`fabric/mcp-endpoint.ts`):`McpEndpointBridge` 实现 `FabricEndpointHandler`,支持 `mcp.initialize/mcp.list/mcp.call` 三个 operation。每个 endpointId 注册一个 HTTPS source URL(禁凭证/fragment)。SDK `Client`+`StreamableHTTPClientTransport` 仍是 MCP 协议权威,Fabric 只拥有外层 route。**每个 await 前后都 reauthorize**(workspace generation、registration 身份、route 代数),关闭 TOCTOU 撤销窗口。

**分发器**(`endpoint-dispatcher.ts`):route→endpoint 精确绑定(非首匹配)、deadline ≤ route lease、kind 匹配、owned registration 完整代数四元组、pending 上限、取消竞速、**dispatch 返回后二次 authorize** 再校验一次 registration 未变。

**pi 侧**(`mcp/fabric-transport.ts` + `fabric-mount-registry.ts` + `fabric-route-guard.ts`):

- `FabricMcpClientTransport` 实现 MCP `Transport`,把 `initialize/tools/list/tools/call` 映射到 `mcp.*` operation,每个请求携带 `workspaceId+workspaceGeneration`,deadline 被 `lease.expiresAt` 钳制;`notifications/cancelled` 中止 pending。
- **变更不重放**:`mcp-mutation` 路由上的 tools/call 遇不确定失败(cancelled/deadline/unavailable)抛 `FabricMcpOutcomeUnknownError`——"可能已到达端点,结果未知,绝不静默重放"。
- `FabricMcpMountRegistry`:挂载为 ephemeral server(`providerNamespace:serverName`),不写 MCP config/cache,lazy 生命周期,引用计数;`McpContinuationAuthority` 代数围栏所有异步回调,route 失效即吊销挂载并隐藏工具。

## 7. pi 侧消费面

- `ssh` 工具(`ssh-manager/llm-tool.ts`):`ensure_gateway` 启动会话级远端 Gateway → `describe <tool>` 取权威 inputSchema → `call` 按 exact action 调用;`start_pi` 走 `session.create + session.start-pi` 返回 taskId/monitorHandle(`gateway-session-launch.ts` 用 host/session/monitor 三次 envelope 校验 principal 不变)。
- `mcp` 工具:统一代理,本地服务器 + Fabric 挂载服务器都汇聚到 `McpServerManager`。

## 8. 评价

**优点**

- **收敛性好**:17 个粗粒度工具 + action oneOf,schema 即协议文档;`GATEWAY_MCP_INSTRUCTIONS` 把治理规则(先知识门、CAS/operationId、handoff 语义)放进 server instructions 而非散落各 schema。
- **围栏纪律一致**:从 pairing 撤销→会话关闭、workspace/endpoint/route generation、continuation authority,到 dispatch 前后双检,"await 之后重新授权"是贯穿全栈的固定模式。
- **失败封闭**:未知 action/字段/工具全拒;隧道 action 禁通配;mutation 不确定结果不重放;open 模式变更需显式确认。
- **兼容处理显式化**:legacy scope 伞、snake_case 别名(冲突即拒)、`allow_open_mutations` 警告桥——兼容路径都有注释标注意图。

**观察点(非缺陷,但值得注意)**

- `tools/list` 对任何已认证 principal 返回**全部 17 个工具的完整 schema**(`runtime.ts:600` 不过滤 scope)。能力在 call 时强制,所以安全无虞,但低权 principal 能看到完整攻击面/描述;若未来要按 scope 投影工具列表,这里是切入点。
- `workspace` 工具双平面复用靠 `version` 字段分流,schema 是 legacy actions 与 fabric actions 的并集——调用方需理解两套语义共存于一个工具名下。
- action 复用使单个 inputSchema 很大(BOARD_SCHEMA 16 个 oneOf 分支),对 MCP 客户端的 schema 渲染/token 占用有成本——这是用工具数量换来的权衡,与 pi `mcp` 代理工具同源。
- tunnel-ingress 是明文 loopback,依赖"外部隧道进程在本机"这一信任假设;设计已用 audience 隔离 + loopback 限定 + 启动撤销来收敛,但 `gateway.tunnel` 凭证泄露即等于其 scope 内权限(无 mTLS/持有者绑定)。

## 9. 总结

这是一个**以 catalog 为单一事实源、以 generation/CAS 围栏为一致性手段、以显式 scope 为授权边界**的设计,安全语义集中在少数几个可审计的模块(`capabilities.ts`、`policy.ts`、`mcp-access.ts`、`endpoint-dispatcher.ts`)。
