# C05 ModelAdapter 与 DeepSeekChatAdapter

- 状态：Issue #7 最小闭环切片已实现；非流式文本、单/多 tool calling、本地 transcript 重建、usage、取消和稳定错误已交付
- 目标阶段：D2；SSE、reasoning continuation 与真实 API smoke test 延后到核心闭环验证后
- 代码位置：`src/model/model-adapter.ts`、`deepseek-chat-adapter.ts`；`deepseek-responses-adapter.ts` 仅保留兼容别名
- 测试位置：`tests/model-adapter.test.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)
- 下游消费者：C06、C11、C14、C15
- 主线决策：[Issue #7](https://github.com/TimmmmmY827/CodeFlow-Agent/issues/7)

## 1. 目标

把 DeepSeek 官方 Chat Completions tool-calling 协议转换成供应商无关的单次模型结果，使 AgentEventLoop 能接收文本、完整工具调用、用量和稳定错误，而不依赖 OpenAI SDK 类型。

Issue #7 固定了当前优先级：先用 `deepseek-v4-flash` 跑通“模型→本地只读工具→观察→重规划”闭环，再按真实证据补 SSE 和 reasoning continuation。DeepSeek 当前官方 tool-calling 文档使用 Chat Completions，而不是旧设计假设的 Responses API，因此 Provider 已按官方协议修正；旧类名只作为兼容别名，不再代表实际传输协议。

## 2. 职责边界

### 当前必须负责

- 构造非流式 Chat Completions 请求，只发送本地声明的 function tools。
- 一次 `generate` 只发起一次供应商业务请求；Adapter 和 SDK 都不自动重试。
- 按供应商顺序返回零个、一个或多个完整 tool call；参数必须是完整 JSON object，不猜测修复。
- 用本地 transcript 的 message、assistant tool calls 和 tool result 重建多轮输入，不依赖服务端 Session。
- 归一化 input/output/cached/total token、响应 ID、模型 ID、finish reason 和耗时；未知价格保持 `costUsd=null`。
- 传递取消和 deadline，提供稳定错误 category、retryable、retry-after 和 provider response ID。
- 暴露能力矩阵，明确当前不支持 streaming、reasoning continuation 和服务端工具。

### 明确不负责

- 执行工具、批准权限、构建完整项目上下文、决定任务完成或执行重试。
- 在 Adapter 内自动联网搜索、保存 Session、写 AgentEvent 或把模型输出当作授权/验证事实。
- 在 C14 敏感 transcript 能力完成前启用 thinking/reasoning 原文续接。

## 3. 前置依赖与解锁条件

| 依赖 | 已使用的稳定能力 | 边界 |
| --- | --- | --- |
| C00 | usage、结构化错误、取消、固定 UTC 与 JSON 类型 | 公共返回值和 Provider 边界不泄漏 SDK 类型 |
| C01 | model started/completed、span 和结构化失败 context | C11 负责把模型调用结果写成事实，C05 不直接写事件 |

C05 的非流式 tool-call 契约已可供 Issue #7 的 C11 最小循环接线。若 C11 需要改变该公共契约，必须先更新本文件和 C05 契约测试，再审计 C06/C14/C15。

## 4. 当前公共接口

```ts
interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

interface ModelToolCall {
  callId: string;
  name: string;
  argumentsJson: string; // 供应商返回的完整字节顺序
  arguments: JsonObject; // 完整响应后解析，不修复非法 JSON
}

type ModelInputItem =
  | { type: "message"; role: "system" | "user" | "assistant"; content: string }
  | { type: "assistant_tool_calls"; content: string | null; calls: ModelToolCall[] }
  | { type: "tool_result"; callId: string; output: string };

interface ModelRequest extends CancellationContext {
  input: string | ModelInputItem[];
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  maxOutputTokens?: number;
}

interface ModelResponse {
  responseId: string;
  model: string;
  outputText: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage: ModelUsage;
}

interface ModelAdapter {
  provider: string;
  model: string;
  capabilities(): ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

`MODEL_ADAPTER_PROTOCOL_VERSION` 当前为 `model-adapter:v1`。输入 string 只是单条 user message 的兼容简写；真实循环应保存并传回 `ModelInputItem[]`。`assistant_tool_calls` 保留一次响应中多个调用的分组，紧随其后的 `tool_result` 用 call ID 配对。

核心层只看这些归一化对象；OpenAI SDK 类型只能出现在 DeepSeek Provider 文件内。`DeepSeekCompletionTransport` 是无 SDK 类型的测试边界，不是另一个模型协议。

## 5. 当前功能需求

- `MODEL-FR-001`：支持单次响应返回零个、一个或多个 tool call，并保持 call ID、调用顺序与 `argumentsJson` 字节顺序。
- `MODEL-FR-002`：工具参数只在完整响应后解析为 JSON object；非法、截断、重复 call ID 或非法工具名返回 `model_invalid_tool_call`，不得交给 C08。
- `MODEL-FR-004`：多轮请求由本地 transcript 重建，不发送 `previous_response_id`，不依赖服务端 Session。
- `MODEL-FR-005`：usage 包括 input/output/cached/total token；未知价格保持 `costUsd=null` 并保留供应商 usage JSON。
- `MODEL-FR-006`：只注册本地 function tool；不启用服务端搜索、MCP 或其他供应商工具。
- `MODEL-FR-008`：能力矩阵明确声明 `streaming=false`、`reasoningContinuation=false`；不支持参数在发请求前拒绝。
- `MODEL-FR-009`：一次 `generate` 只对应一个供应商业务 attempt；OpenAI SDK 配置 `maxRetries=0`。C11 在 C04 `maxRetriesPerOperation` 内创建新 attempt。
- `MODEL-FR-011`：C11 按 modelCallId+attempt 结算；Adapter 永远不伪造价格。Issue #7 要求 C11 接线时优先使用版本化 DeepSeek 本地定价表，仍未知则让 C04 进入 `pricing_unknown`。

## 6. DeepSeek 配置与协议

- 默认模型：`deepseek-v4-flash`。
- API：官方 OpenAI-compatible Chat Completions，非流式，`n=1`。
- thinking：当前显式关闭；reasoning continuation 等 C14 敏感 transcript 后再启用。
- tools：function only，最多 128 个，默认 `tool_choice=auto`，允许并行返回但由 C11/C08 决定实际调度。
- strict schema：只允许在明确配置 `/beta` endpoint 时启用；标准 endpoint 请求前拒绝。
- Key：由 composition root 从 `DEEPSEEK_API_KEY` 或未来系统凭证注入；不进入 core、trace 或错误 message。
- base URL/模型/超时：属于 Provider 配置；配置版本由 C11/C12 记录，Adapter 不记录秘密。

协议依据：[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)、[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)。

## 7. 错误、重试与恢复

| category | 可重试 | 当前处理 |
| --- | --- | --- |
| `cancelled` | 否 | 停止当前请求，不创建新 attempt |
| `model_rate_limited` | 是 | 返回 retry-after，由 C11/C04 决定是否新建 attempt |
| `model_timeout` | 是 | 当前非流式响应没有可提交的 partial result；由 C11 决定重试 |
| `model_invalid_tool_call` | 否 | 不修复参数，不执行工具；要求模型重新规划 |
| `model_auth_failed` | 否 | 请求用户检查配置，错误不包含 Key |
| `model_context_overflow` | 条件 | 交 C06 压缩后由 C11 决定一次新 attempt |
| `model_invalid_request` | 否 | 修正模型配置或工具 schema |
| `model_service_unavailable` | 是 | 由 C11/C04 控制新 attempt |
| `model_protocol_changed` | 否 | fail closed，更新 Provider 契约后再恢复 |

任何 Provider 异常只产生稳定、脱敏 message；原始 SDK Error 不跨 Adapter 边界。

## 8. 安全与隐私

- `MODEL-SR-001`：完整秘密检测器随 C06 ContextManifest 接线实现；当前调用者不得把未筛选的整仓库或环境变量作为 input。此项仍显式延期，不能据此宣称 C05 全量完成。
- `MODEL-SR-002`：Adapter 不读取工作区、环境变量全集或 Git 凭证；它只发送调用者显式传入的 input/tools。
- `MODEL-SR-003`：当前关闭 reasoning；后续启用必须先接 C14 敏感存储、删除传播和脱敏导出。
- `MODEL-SR-004`：模型文本和 tool call 是建议，不是授权、验证证据或外部事实；C03/C08/C10 仍是安全权威。

## 9. 验收证据

Issue #7 当前切片：

- `MODEL-AC-MVP-001`：`tests/model-adapter.test.ts` 覆盖文本、单/多 tool call、调用顺序、完整 JSON 参数和 usage。
- `MODEL-AC-MVP-002`：fixture 覆盖本地 transcript 重建，且请求不使用服务端 Session/response continuation。
- `MODEL-AC-MVP-003`：取消、过期 deadline、rate limit、协议漂移和非法 tool call 映射为稳定错误；所有路径单次 `generate` 最多调用一次 transport。
- `MODEL-AC-MVP-004`：能力矩阵和请求 fixture 证明 streaming、thinking 和服务端搜索未启用；核心契约不 import SDK 类型。
- `MODEL-AC-MVP-005`：`pnpm check` 与 `pnpm start -- --help` 是交付门禁。

核心闭环跑通后再验收：SSE 事件顺序/断流完整性、2 秒内停止流读取、reasoning continuation 与脱敏导出、真实 API smoke test、跨 attempt 事件身份。这些项目未实现，不用空实现标记完成。

## 10. 下一步接线

1. C11 使用 `generate` 做一次 durable model attempt，并把 response/tool calls/usage 投影到本地 transcript 与 C01 事实。
2. C09 先提供 Issue #7 的六个只读工具，C11 通过 C08 执行；ModelAdapter 绝不直接调用工具。
3. C11 加入版本化 DeepSeek 定价表并通过 C04 reserve→execute→settle。
4. 第一条端到端可审计 trace 完成后，再依据真实延迟与恢复问题决定是否升级到流式 `model-adapter:v2`。
