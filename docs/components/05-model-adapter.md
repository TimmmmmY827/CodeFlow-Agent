# C05 ModelAdapter 与 DeepSeekResponsesAdapter

- 状态：非流式文本最小实现，tool calling/续接/协议测试缺失
- 目标阶段：D2
- 代码位置：`src/model/model-adapter.ts`、`deepseek-responses-adapter.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)
- 下游消费者：C06、C11、C14、C15

## 1. 目标

把 DeepSeek Responses API 转换成供应商无关的模型流，使 AgentEventLoop 能接收文本、计划、工具调用、reasoning 续接项、用量和错误，而不依赖 OpenAI SDK 类型。

## 2. 职责边界

### 必须负责

- 请求构造、SSE 解析、供应商事件归一化和 AbortSignal。
- 文本增量、工具调用参数增量、完成项和 usage。
- 协议要求的 reasoning item 内部续接，但不向普通 UI/导出暴露。
- DeepSeek 错误分类、有限重试提示和响应 ID。
- 模型/供应商能力声明。

### 明确不负责

- 执行工具、批准权限、构建完整项目上下文或决定任务完成。
- 在 Adapter 内自动联网搜索或保存 Session。

## 3. 前置依赖与解锁条件

| 依赖 | 需要稳定的能力 | 未满足时禁止 |
| --- | --- | --- |
| C00 | usage、结构化错误、取消和序列化类型 | 定义公共 Adapter 返回值 |
| C01 | model started/completed、span 和结构化失败 context 所需字段 | 接入 AgentEventLoop |

C05 的 tool call 契约必须在 C11 开发真实循环前冻结；C06 依赖其输入 item 与工具 schema 格式。

## 4. 公共接口

### 4.1 当前可编译基线

当前接口只有 `generate({ input: string, signal, deadlineAt })`，返回一次性 `outputText`、response ID 和 usage；没有 tools、stream、continuation、capabilities 或结构化错误流。

### 4.2 目标接口（规划中）

下列流式接口须在 C05 契约测试完成后才能供 C06/C11 接线：

```ts
interface ModelRequest {
  runId: StableId;
  stepId: StableId;
  spanId: StableId;
  modelCallId: StableId;
  attempt: number;
  model: string;
  input: ModelInputItem[];
  tools: ModelToolDefinition[];
  reasoningEffort: "low" | "medium" | "high";
  maxOutputTokens: number;
  continuation: ModelContinuationHandle | null;
  signal: AbortSignal;
}

type ModelStreamEvent =
  | (ModelEventIdentity & { type: "response.started"; responseId: string })
  | (ModelEventIdentity & { type: "text.delta"; delta: string })
  | (ModelEventIdentity & { type: "tool_call.delta"; callId: string; name: string; argumentsDelta: string })
  | (ModelEventIdentity & { type: "tool_call.completed"; call: ModelToolCall })
  | (ModelEventIdentity & { type: "reasoning.continuation"; handle: ModelContinuationHandle })
  | (ModelEventIdentity & { type: "usage"; usage: UsageRecord; completeness: "partial" | "final" })
  | (ModelEventIdentity & { type: "response.completed"; finishReason: string })
  | (ModelEventIdentity & { type: "response.failed"; error: StructuredError; retryAdvice: RetryAdvice });

interface ModelEventIdentity {
  runId: StableId;
  stepId: StableId;
  spanId: StableId;
  modelCallId: StableId;
  attempt: number;
  responseId: string | null;
}

interface ModelContinuationHandle {
  handleId: StableId;
  provider: string;
  protocolVersion: string;
  contentHash: string;
}

interface RetryAdvice {
  allowed: boolean;
  reasonCode: string;
  retryAfterMs: number | null;
  emittedCompleteToolCall: boolean;
  usageCompleteness: "none" | "partial" | "final";
}

interface ModelAdapter {
  capabilities(): ModelCapabilities;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

`ModelStreamEvent` 是 Adapter 与 Loop 之间的归一化运行时流，不与 `AgentEvent` 类型一一对应；C11 应聚合 delta，并按 C01 目录写入 `model.started`/`model.completed`，失败或取消由 completed 事实的 operation/error context 表达。

Continuation handle 只引用 C14 敏感 transcript 中的 provider blob；普通事件、ContextManifest 和导出不保存原文。Adapter 通过注入的敏感记录 resolver 读取 handle，不允许核心层解释供应商 reasoning 数据。

核心层只看归一化 item；DeepSeek/OpenAI SDK 原始对象只能在 Provider 内部出现。

## 5. 功能需求

- `MODEL-FR-001`：支持单次响应返回零个、一个或多个 tool call，并保持 call ID 与参数字节顺序。
- `MODEL-FR-002`：工具参数只在 `tool_call.completed` 后交给 C08；不对不完整 JSON 猜测修复。
- `MODEL-FR-003`：reasoning 续接 item 按供应商协议原样保存到敏感 transcript，普通 UI 只收到计划/决策摘要。
- `MODEL-FR-004`：多轮请求由本地 transcript 重建，不依赖服务端 Session 状态。
- `MODEL-FR-005`：usage 包括 input/output/cached token；未知价格不伪造成本。
- `MODEL-FR-006`：DeepSeek 服务端搜索默认不启用，避免绕过本地工具权限和 trace。
- `MODEL-FR-007`：流式事件必须携带 response/span 关联信息，断流后能判断是否已有可见文本、完整 tool call 或未知 usage。
- `MODEL-FR-008`：Adapter 暴露能力矩阵，不支持的参数在请求前拒绝或显式降级。
- `MODEL-FR-009`：Adapter 的一次 `stream` 调用只对应一个供应商业务 attempt，不自行执行完整请求重试；它返回稳定 retry advice，由 C11 在 C04 `maxRetriesPerOperation` 内决定是否创建下一 attempt。模型策略默认上限可为 2，但有效上限必须取模型策略与 C04 用户预算中的更小值，不能在 Adapter 内独立计数。
- `MODEL-FR-010`：只有 `response.completed` 且 tool call 参数全部 completed 时聚合结果才是 complete；断流后的文本、tool call 和 usage 分别标记完整性，不能合并成伪造成功。
- `MODEL-FR-011`：partial/final usage 使用 modelCallId+attempt 幂等结算；未知价格保持 `costUsd=null`，后续重新计价必须记录 pricing version 和 adjustment。

## 6. DeepSeek 配置

- 默认模型：`deepseek-v4-flash`。
- API：Responses API，thinking 开启，评估基线 `reasoning.effort=high`。
- Key：只从 `DEEPSEEK_API_KEY` 或未来系统凭证读取。
- base URL：Provider 配置，不进入 Agent core。
- 模型、base URL、超时和 reasoning effort 进入配置版本与 trace；Key 不进入。

## 7. 错误、重试与恢复

| category | 可重试 | 处理 |
| --- | --- | --- |
| `model_rate_limited` | 是 | 返回 retry-after 建议，由 C11 决定新 attempt |
| `model_timeout` | 是 | 报告已产生的事件/usage，由 C11 判断是否可重试 |
| `model_stream_interrupted` | 条件 | 保存已收到 item，默认暂停而非拼接猜测 |
| `model_invalid_tool_call` | 否 | 记录原始 artifact，回到循环要求模型重规划 |
| `model_auth_failed` | 否 | 请求用户配置，不输出 Key |
| `model_context_overflow` | 条件 | 交 C06 建检查点后重试一次 |
| `model_protocol_changed` | 否 | 契约失败，停止 Session |

## 8. 安全与隐私

- `MODEL-SR-001`：发送前调用秘密检测器；命中疑似凭证时停止并说明字段来源。
- `MODEL-SR-002`：不把整仓库、环境变量全集或 Git 凭证默认发送。
- `MODEL-SR-003`：reasoning item 使用敏感存储和删除传播，不能进入脱敏导出。
- `MODEL-SR-004`：模型输出是建议，不是授权、验证证据或外部事实。

## 9. 验收标准

- `MODEL-AC-001`：固定 SSE fixtures 覆盖文本、单/多 tool call、参数分片、usage、reasoning 和完成顺序。
- `MODEL-AC-002`：断流发生在每一种事件边界时，归一化结果确定且无伪造 completed。
- `MODEL-AC-003`：AbortSignal 在 2 秒内停止读取流且不发起重试。
- `MODEL-AC-004`：reasoning 续接可完成工具调用后的下一轮，但普通 trace 导出找不到其原文。
- `MODEL-AC-005`：Provider 错误全部映射为稳定 category；核心测试不 import SDK 类型。
- `MODEL-AC-006`：至少一次受控真实 API smoke test 记录模型 ID、协议版本、usage 和成本。
- `MODEL-AC-007`：Adapter fixture 证明单次 stream 最多发起一次供应商业务请求，重试次数不会与 C11 相乘。
- `MODEL-AC-008`：每个流事件都有稳定 run/step/span/call/attempt 关联，晚到和跨 attempt 事件不会被错误聚合。

## 10. 实现任务建议

1. 扩展公共 ModelInput/StreamEvent/ToolCall schema。
2. 建 DeepSeek SSE 录制 fixture 和重放器。
3. 实现流式解析、参数汇聚、usage 与 reasoning continuation。
4. 实现错误翻译、取消和重试边界。
5. 通过契约测试后交给 C06/C11，不先在 Loop 中解析供应商事件。
