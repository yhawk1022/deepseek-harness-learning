<!-- 英文源文件由 scripts/gen-doc-graphs.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-doc-graphs` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/agent-lifecycle.md` 重新记录配对。 -->

# Agent 轮次与步骤生命周期

[English](agent-lifecycle.md) | 中文

此时序图是 [architecture.md](architecture.zh.md#turn-flow) 的配套图示。持久的回放事实保存在 `session/event` 中，实时控制与状态则保存在 `agent/*` 中。

```mermaid
sequenceDiagram
  participant User as 用户（User）
  participant Agent as Agent（智能体）
  participant Driver as 驱动器（Driver）
  participant Hooks as 钩子监听器<br/>hook listeners
  participant Prompt as 系统提示词<br/>ctx.systemPrompt
  participant LLM as LLM（大语言模型）<br/>ctx.llm
  participant Tools as 工具运行时<br/>ctx.tools
  participant Session as 会话（Session）
  participant SDK as UI 或 SDK 监听器<br/>UI or SDK listener
  User->>Agent: followup(content)
  Agent-->>SDK: <code>agent/inbox/spliced</code>
  Agent-->>SDK: <code>agent/inbox/inserted</code> { message }
  Agent->>Driver: 排队输入唤醒驱动器<br/>queued work wakes driver
  Driver-->>SDK: <code>agent/status</code> running（运行中）
  Driver->>Session: <code>turn/start</code>
  Note over Agent,Driver: 领取待处理的 next-step 输入<br/>和一条排队提示词<br/>claim pending next-step input<br/>plus one queued prompt
  Driver-->>SDK: <code>agent/inbox/spliced</code> 纯删除操作（pure deletion）
  Driver-->>SDK: <code>agent/inbox/claimed</code> { message, turn } 逐条消息（per message）
  Driver->>Prompt: <code>system-prompt/assemble</code> waterfall（瀑布式事件）
  Driver->>Hooks: <code>agent/pre-step</code> waterfall（瀑布式事件）
  Hooks-->>Driver: 以 reject 或 enter(messages) 决策为准<br/>authoritative reject or enter(messages)
  alt 候选步骤被拒绝、首批输入为空，或 pre-step 失败<br/>proposed step rejected, first batch empty, or pre-step failed
    Driver-->>Driver: 已领取批次保持移除，当前轮次不执行步骤<br/>claimed batch stays removed, the open turn spends no step
  else 进入候选步骤<br/>enter proposed step
  Driver->>Session: <code>step/start</code>
  Driver->>Hooks: <code>agent/request</code> waterfall（瀑布式事件）
  Driver->>LLM: prepareCall(config, signal)
  Note over Driver,LLM: 在任一异步准备阶段取消，都不提交系统消息或用户消息<br/>cancellation during either async phase commits neither system nor users
  Note over Driver,Session: 按已准备调用的能力同步接纳消息<br/>synchronous admission using the prepared call capability
  Driver->>Session: <code>system/message</code> 逐节点按序协调<br/>ordered per-node reconciliation
  Driver->>Session: <code>user/message</code> 逐条已接纳消息（per entered message）
  Driver->>Session: <code>request/header</code> 和（and）<code>request/context</code> 按需记录（as needed）
  Driver->>Driver: 从日志派生并冻结请求<br/>derive and freeze request from the log
  Driver->>LLM: 绑定已准备调用并经过（bound prepared call through） <code>llm/stream</code> waterfall（瀑布式事件）
  LLM-->>Driver: StreamChunk*（流式分片）
  Driver-->>SDK: <code>agent/assistant-stream</code> chunk*（分片）
  alt 适配器最终失败，或响应流内报告终止请求失败<br/>final adapter or terminal in-band request failure
    Driver->>Session: <code>assistant/attempt</code>
    Driver-->>SDK: <code>agent/assistant-stream</code> 已提交结算的结束帧（committed end）
    Driver->>Hooks: <code>agent/request-error</code> waterfall（瀑布式事件）
    Hooks-->>Driver: 返回重试动作，或保留原始错误<br/>return retry action or preserve the original error
    Note over Driver,LLM: 在当前步骤内重试：准备调用并协调同一份已渲染组装结果，不重复 pre-step 或用户消息准入<br/>retry in the open step: prepare and reconcile the same rendered assembly without repeating pre-step or users
  else 模型请求成功<br/>model request succeeded
  Driver->>Session: <code>assistant/message</code>
  Driver-->>SDK: <code>agent/assistant-stream</code> 已提交结算的结束帧（committed end）
  Driver->>Tools: 按 executionMode 对待执行调用分类<br/>classify pending call by executionMode
  loop 通过屏障和有界滚动池调度，启动前重新分类<br/>barriers and bounded rolling pool, reclassify before start
    opt 调用开始<br/>call starts
      Driver->>Session: <code>tool/call</code>
      Driver->>Tools: 按序执行前置处理，并发执行工具<br/>ordered pre, concurrent execute
      Tools-->>Session: 按需记录由工具负责的事件<br/>tool-owned events when applicable
    end
    opt 按模型调用顺序应提交的下一项结果已就绪<br/>next model-order result ready
      Driver->>Tools: 按序执行后置处理（ordered post）
      Driver->>Session: <code>tool/result</code>
    end
  end
  Driver->>Session: <code>step/end</code>
  opt 自然停止，且 next-step 收件箱为空<br/>natural stop and next-step inbox empty
    Driver->>Hooks: <code>agent/turn-stopping</code> 串行执行轮次结束检查点<br/>serial terminal checkpoint
  end
  opt 存在待处理的 next-step 输入<br/>next-step input is pending
    Driver-->>Driver: 领取待处理的 next-step 输入<br/>claim pending next-step input
    Driver-->>SDK: <code>agent/inbox/claimed</code> { message, turn } 逐条消息（per message）
    Driver->>Hooks: <code>agent/pre-step</code> waterfall（瀑布式事件）
    Hooks-->>Driver: 以 reject 或 enter(messages) 决策为准<br/>authoritative reject or enter(messages)
  end
  end
  end
  Driver->>Session: <code>turn/end</code>
  Driver-->>SDK: <code>agent/status</code> idle（空闲）
```

`assistant/message` 事件会记录每次成功的提供方调用，包括返回空内容或以 `max-tokens` 结束的调用，并嵌入精确的紧凑带时间 stream。空内容不会进入派生历史。失败、重试、取消或 stream error attempt 到达 settlement 时，如果没有 surface message，就会把 stream 记录为 `assistant/attempt`。实时 `agent/assistant-stream` chunk frame 是瞬态数据；回放读取任一种持久 settlement，如果进程在 settlement 前硬中断，则不会留下持久 attempt stream。

`dsh-compaction-basic` 在派生请求之前通过 `agent/pre-step` 处理压力，而 `agent/request-error` 仅用于规范的上下文溢出。任一触发条件满足后，系统都会先执行可选的工具结果剪枝，再选择摘要。恢复发生在仍打开的步骤内，只有剪枝或摘要生成推进 surface replacement generation 时才重试，否则仍以原始请求错误为准。每次重试都会准备调用，并在派生请求之前协调保留的已渲染组装结果，不重复组装、pre-step 或用户消息准入。

以返回的 `agent/pre-step` 决策为准；通过包装 `next()` 的监听器会保留下游消息与 `startsRequestSeries`，除非有意替换。steering（中途引导）和注入的上下文在后续的认领操作取得其下一步骤批次后，会经过同一 waterfall（瀑布式事件）。

需要可回放 transcript（文本记录）数据的 SDK 用户应当消费 `session/event`；`agent/*` 是用于队列与状态、提示词拦截、请求构造、steering、继续执行和错误处理的实时协调接口。

维护模式：英文源文件包含人工维护的 Mermaid 时序图，并由生成器写出；本中文文件作为经评审对侧通过双语配对维护。确切的事件签名位于生成的 Cordis 目录中。
