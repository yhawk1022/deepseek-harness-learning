<!-- 英文源文件由 scripts/gen-doc-graphs.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-doc-graphs` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/tool-execution-pipeline.md` 重新记录配对。 -->

# 工具执行流水线

[English](tool-execution-pipeline.md) | 中文

此图展示策略、钩子、沙箱、文件系统守卫、结果重写、最终结果观察和 UI 渲染在不改变循环的情况下何时运行。`tools/pre-execute` waterfall（瀑布式事件）首先运行，随后是单调守卫，然后运行 `tools/execute` 和 `tools/post-execute` waterfall；这三个 waterfall 可以改写一次调用。由定义自身控制的 `projectContent` 在执行后策略之前安装已准备内容；`finalizeContent` 和 `tools/result` 在此之后运行。

```mermaid
flowchart TD
  model["助手消息包含 tool-call 块<br/>Assistant message contains tool-call block"]
  toolCall["会话事件（Session event）： <code>tool/call</code><br/>执行前记录<br/>logged before execution"]
  presentCall["UI 待处理卡片（UI pending card）<br/>presentCall(args)"]
  pre["<code>tools/pre-execute</code> waterfall（瀑布式事件）<br/>钩子、权限、沙箱<br/>hooks, permission, sandbox"]
  guards["已注册的单调守卫（Registered monotonic guards）<br/>只能拒绝或不表态；调用身份受保护<br/>deny or abstain; identity protected"]
  denied["策略拒绝或审批被拒（denied or approval refused）<br/>跳过工具主体（tool body skipped）"]
  approval["<code>ctx.approval</code> 单次审批询问（one-shot prompt）<br/>审批服务缺失或无法作答时拒绝<br/>absent or unanswerable: deny"]
  around["<code>tools/execute</code> waterfall（瀑布式事件）<br/>超时、重试、指标（环绕分发）<br/>timeout, retry, metrics (around dispatch)"]
  toolBody["已注册工具的 execute() 主体<br/>Registered tool execute() body"]
  fsGate["<code>fs/write-intent</code> 或（or）<code>fs/edit-intent</code><br/>仅限 tool-fs 变更（tool-fs mutations only）"]
  owned["工具负责的会话事件（Tool-owned session events）<br/><code>todo/write</code>, <code>fs/observed</code>, <code>hook/invoked</code>, <code>hook/result</code>, <code>tool/ptc-dispatch</code>"]
  project["ToolDefinition.projectContent<br/>执行阶段准备的文本和图片<br/>execution-prepared text and images"]
  post["<code>tools/post-execute</code> waterfall（瀑布式事件）<br/>接纳、阻止、替换、补充上下文<br/>accept, block, replace, add context"]
  normalized["注册表外层规范化（Registry outer normalization）<br/>流水线或结果快照抛出异常时，转换为 isError<br/>pipeline/result snapshot throws become isError"]
  finalize["ToolDefinition.finalizeContent<br/>最后强制执行的仅限内容不变式<br/>last content-only invariant"]
  final["<code>tools/result</code> 同步通知（synchronous notification）<br/>冻结后的最终结果<br/>frozen authoritative outcome"]
  context["当前批次的 additionalContexts 按先进先出处理<br/>Active-batch additionalContexts FIFO<br/>工具结果全部记录后，注入 user/message<br/>injected user/message after recorded tool results"]
  toolResult["会话事件（Session event）： <code>tool/result</code><br/>交给模型的单一结果<br/>single model-facing outcome"]
  allResults["工具批次已结算（Tool batch settled）<br/>tool/result 事件已全部记录<br/>recorded tool/result events complete"]
  presentResult["UI 已完成卡片（UI completed card）<br/>presentResult(args, result)"]
  model --> toolCall
  toolCall --> presentCall
  toolCall --> pre
  pre -->|允许（allow）| guards
  guards -->|允许（allow）| around
  guards -->|拒绝（deny）| denied
  guards -.->|抛出异常（throw）| normalized
  around --> toolBody
  pre -->|拒绝（deny）| denied
  pre -->|询问（ask）| approval
  approval -->|单次允许（allowed-once）| guards
  approval -->|拒绝、取消或不可用（rejected, cancelled, unavailable）| denied
  approval -.->|抛出异常（throw）| normalized
  denied --> project
  pre -.->|抛出异常（throw）| normalized
  toolBody --> fsGate
  fsGate --> toolBody
  toolBody --> owned
  toolBody --> around
  around --> project
  project --> post
  project -.->|抛出异常（throw）| normalized
  around -.->|包装器抛出异常（wrapper throws）| normalized
  post -.->|抛出异常（throw）| normalized
  post --> finalize
  normalized --> finalize
  finalize --> final
  final --> toolResult
  toolResult --> presentResult
  toolResult --> allResults
  allResults --> context
```

文件系统的先读后编辑检查位于 `tool-fs` 之下，通过 `fs/*` 事件实现。通用的前置／后置 waterfall 承载钩子与审批策略；`ctx.approval` 在单调守卫之前处理询问，而不得重新排序的所有者策略仍作为已注册的守卫。超时等环绕分发关注点对 `tools/execute` 进行包装。注册表会对候选结果进行无损快照；如果快照失败，则会先将失败规范化，之后再由可见定义中已随快照固定的 `finalizeContent` 回调强制执行其同步且仅限内容的不变式。随后，`tools/result` 会观察不可变、可由 JSON 无损表示的结果。这样一来，钩子便可跨越不同工具系列，而无需让工具与某个策略服务耦合。PTC mode 会将保留的 `run_code` 传输及其序列化子调用都送入流水线；子调用携带父级 token、记录 `tool/ptc-dispatch`、将拒绝呈现为具有约束力的驳回，并省略 `additionalContexts`，以保持调用与结果相邻。

维护模式：英文源文件包含人工维护的 Mermaid 流程图，并由生成器写出；本中文文件作为经评审对侧通过双语配对维护。确切的工具 schema 与事件签名位于生成的目录中。
