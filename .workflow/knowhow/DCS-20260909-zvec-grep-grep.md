---
title: zvec-grep 作为语义搜索补充而非 grep 替代
type: decision
created: 2026-09-09T01:24:36.882Z
keywords:
  - zvec-grep
  - 语义检索
  - 精确搜索
  - Pi集成
  - 索引一致性
sourceRef: "https://github.com/zvec-ai/zvec-grep"
decisionState: accepted
lifecycleStatus: active
relatedPaths:
  - packages/pi-maestro-flow/src/tools/fff.ts
  - .pi/SYSTEM.md
---

## Context

评估将 `zvec-ai/zvec-grep` 接入 Pi 搜索体系，并考虑替换原生 `grep` 与 FFF `ffgrep`。现有搜索边界包括：原生 `grep`/`rg` 用于确定性、穷尽式文本检索，`ffgrep` 用于快速字面量搜索，`fffind` 用于模糊路径搜索。

`zvec-grep` 实际提供两类能力：

- Managed ripgrep：直接扫描工作区，适合精确文本和正则搜索；
- BM25、向量与混合检索：返回排序后的候选样本，适合未知入口、概念搜索和跨文件发现。

## Decision

不要用 `zvec-grep` 替换 `grep`、`rg`、`ffgrep` 或 `fffind`。如需集成，应将其作为可选的独立语义发现工具，例如 `zvec_search`，并保留现有确定性搜索工具作为证据验证和故障降级路径。

路由规则：

1. 已知符号、精确短语、配置键、路径、正则和否定性判断继续使用 `grep`/`rg`/`ffgrep`；
2. 目标位置未知、用户措辞与代码标识符不一致、需要跨文件概念或架构入口时，使用 `zvec-grep`；
3. 排名结果只作为候选，决定性结论必须回到当前源码做精确验证；
4. `possibly_stale` 的索引结果不得用于“仓库中不存在”或完成验证；要求最新状态时必须等待刷新；
5. `fffind` 保留，因为 `zvec-grep` 不提供等价的模糊路径搜索契约。

## Alternatives Considered

| Alternative | Advantages | Problems | Disposition |
| --- | --- | --- | --- |
| 完全替换 grep/ffgrep | 工具数量更少，入口统一 | Indexed route 非穷尽；managed rg 仍是全量扫描；索引新鲜度和 Top-K 排名可能漏报 | Rejected |
| 直接把库加载进 Pi 主进程 | 无 CLI/MCP 转换开销，可使用结构化 JS API | 原生绑定、模型运行时、GPU/内存故障可能拖垮 Pi；资源生命周期复杂 | Rejected for preview integration |
| 独立进程或 MCP 中提供可选语义工具 | 故障隔离，保留现有工具，便于灰度和禁用 | 需要管理版本、进程、索引和健康状态 | Preferred |
| 不集成 | 零维护成本 | 放弃未知入口与跨文件语义发现能力 | Acceptable default until maturity improves |

## Integration Guardrails

- 固定精确 npm 版本，不跟随宽松 semver 自动升级；项目处于 `0.2.x` 公测期，CLI、MCP 和索引兼容策略仍在稳定中。
- 优先通过隔离进程或 MCP 接入；外部进程、监听器、缓存和异步构建必须绑定 generation，握手成功后才发布可见状态，shutdown 时撤销发布并终止或等待所有仍可发布的异步工作。
- Windows 不要直接以 `spawn("zg", ..., { shell: false })` 启动 npm `.cmd` shim；应使用 `cross-spawn`，或以 `process.execPath` 加已解析的 CLI JS 路径启动。启动失败必须与 ripgrep 的“无匹配”退出码 1 区分。
- 不解析不稳定的人类可读输出来建立长期接口；优先使用 MCP 或结构化 JS API，并对版本做能力探测。
- 所有路径必须规范化并限制在 workspace root 内；不得把任意参数直接转发给 shell。
- 限制结果数量和输出字节，传递取消信号，区分无匹配、执行错误、索引未就绪和索引可能过期。
- 默认只允许本地 embedding；远程 embedding 必须由用户显式授权，不能把 API 凭证或授权状态混同于工具调用审批。
- Linux 无 GPU 环境应显式选择 CPU，直到自动设备探测及失败重试的已知风险得到验证性修复。
- 索引目录、模型缓存和数据库 sidecar/WAL/SHM 必须一起纳入容量、完整性和清理边界。

## Evidence and Observed Pitfalls

- 官方 MCP 指南本身建议精确文本、名称、路径和正则继续使用原生 grep/rg；默认 agent 工具集只暴露语义搜索。
- 评估时 npm 包为 `0.2.2`，Node 要求为 `>=22`，包含跨平台 zvec 原生绑定、Transformers、本地模型和 `@vscode/ripgrep`。
- 当前 Windows/Node 22 环境中，`zg query --rg -n -F registerFff ...` 冒烟成功；文档中的顶层 `zg --rg ...` 在该版本返回 `Unknown command: --rg`，说明 CLI 契约需要版本能力探测。
- 社区 Pi 适配器曾在 Windows 把 CLI 启动失败误判为“No matches”，其修复思路是解析 CLI JS 路径并用当前 Node 启动。
- 已公开问题覆盖索引卡住、增量索引写放大、GPU/CPU fallback、OOM、跨语言召回和生产代码排序等风险；这些问题要求集成保持可选和可降级。

## Consequences

### Positive

- 保留 grep 的穷尽性和当前工具兼容性；
- 在未知入口和跨文件探索场景获得额外召回；
- zvec 原生或模型故障不会阻断基础代码搜索；
- 可以通过代表性任务逐步验证价值后再扩大使用范围。

### Negative

- 搜索工具数量增加，路由说明必须清晰；
- 需要维护独立进程、索引、模型缓存、版本和健康诊断；
- 排名结果仍需精确搜索和直接源码读取进行验证。

## References

- https://github.com/zvec-ai/zvec-grep
- https://github.com/zvec-ai/zvec-grep/issues/54
- https://github.com/zvec-ai/zvec-grep/issues/55
- https://github.com/zvec-ai/zvec-grep/issues/115
- https://github.com/zvec-ai/zvec-grep/issues/135
