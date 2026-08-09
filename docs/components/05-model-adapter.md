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
| C01 | model started/delta/completed/failed 事件所需字段 | 接入 AgentEventLoop |

C05 的 tool call 契约必须在 C11 开发真实循环前冻结；C06 依赖其输入 item 与工具 schema 格式。

## 4. 公共接口

```ts
interface ModelRequest {
  model: string;
  input: ModelInputItem[];
  tools: ModelToolDefinition[];
  reasoningEffort: "low" | "medium" | "high";
  maxOutputTokens: number;
  continuation: ModelContinuation | null;
  signal: AbortSignal;
}

type ModelStreamEvent =
  | { type: "response.started"; responseId: string }
  | { type: "text.delta"; delta: string }
  | { type: "tool_call.delta"; callId: string; name: string; argumentsDelta: string }
  | { type: "tool_call.completed"; call: ModelToolCall }
  | { type: "reasoning.continuation"; item: ModelContinuation }
  | { type: "usage"; usage: UsageRecord }
  | { type: "response.completed"; finishReason: string }
  | { type: "response.failed"; error: StructuredError };

interface ModelAdapter {
  capabilities(): ModelCapabilities;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

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
- `MODEL-FR-009`：单次模型调用的自动重试上限为 2；只在没有产生不可安全重复的下游行为时重试。

## 6. DeepSeek 配置

- 默认模型：`deepseek-v4-flash`。
- API：Responses API，thinking 开启，评估基线 `reasoning.effort=high`。
- Key：只从 `DEEPSEEK_API_KEY` 或未来系统凭证读取。
- base URL：Provider 配置，不进入 Agent core。
- 模型、base URL、超时和 reasoning effort 进入配置版本与 trace；Key 不进入。

## 7. 错误、重试与恢复

| category | 可重试 | 处理 |
| --- | --- | --- |
| `model_rate_limited` | 是 | 尊重 retry-after，预算允许时最多 2 次 |
| `model_timeout` | 是 | 未产生完整 tool call 时可重试 |
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

## 10. 实现任务建议

1. 扩展公共 ModelInput/StreamEvent/ToolCall schema。
2. 建 DeepSeek SSE 录制 fixture 和重放器。
3. 实现流式解析、参数汇聚、usage 与 reasoning continuation。
4. 实现错误翻译、取消和重试边界。
5. 通过契约测试后交给 C06/C11，不先在 Loop 中解析供应商事件。
