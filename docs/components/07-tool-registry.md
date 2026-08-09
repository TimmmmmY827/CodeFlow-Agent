# C07 ToolDefinition 与 ToolRegistry

- 状态：注册、查询、列表和基础元数据已实现
- 目标阶段：D1–D3
- 代码位置：`src/tools/tool.ts`、`tool-registry.ts`
- 硬依赖：[C00 共享契约](00-shared-contracts.md)
- 下游消费者：C06、C08、C09、C11、C15

## 1. 目标

提供固定、审核过、版本化的工具目录，使模型看到的 schema、PermissionEngine 使用的风险信息和 ToolRuntime 执行的实现来自同一事实源。

## 2. 职责边界

### 必须负责

- 工具名称、描述、输入/输出 schema、风险、副作用和重试策略。
- 工具来源、版本、能力标签和启用条件。
- 重名/版本冲突检测、固定顺序和面向模型的定义投影。
- 按运行环境筛选工具，但不主动发现任意第三方工具。

### 明确不负责

- 参数执行、权限决策、tool call 解析、动态 MCP/Skills 或 UI。

## 3. ToolDefinition

```ts
interface ToolDefinition<I, O> {
  name: string;
  version: string;
  description: string;
  risk: "automatic" | "task_authorized" | "single_confirmation" | "control";
  sideEffect: "none" | "workspace_write" | "external_write";
  retryPolicy: "safe" | "reconcile" | "never";
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  availability: ToolAvailability;
  execute(input: I, context: ToolExecutionContext): Promise<O>;
}
```

当前代码缺 `version`、`outputSchema` 和 availability，实施 C07 时必须补齐。

## 4. 功能需求

- `REG-FR-001`：名称全局唯一，使用稳定 snake_case；同名不同实现不得静默覆盖。
- `REG-FR-002`：注册时验证描述长度、schema 可转模型 JSON Schema、风险与副作用组合合法。
- `REG-FR-003`：`external_write` 必须使用 `single_confirmation` 且 retry policy 为 `reconcile` 或 `never`。
- `REG-FR-004`：`automatic` 工具不得声明写副作用。
- `REG-FR-005`：Registry 可以生成 ModelToolDefinition，但不得把 execute、凭证或内部路径暴露给模型。
- `REG-FR-006`：工具可因 OS、Git 仓库、gh 登录或 API Key 缺失而 unavailable；不可用原因进入 manifest。
- `REG-FR-007`：MVP 启动时一次性注册固定目录，运行中不从仓库/网页动态加载代码。
- `REG-FR-008`：目录 hash 进入 configVersion，Session 恢复时发现变化必须重新确认上下文。

## 5. 合法组合

| risk | sideEffect | retryPolicy | 允许 |
| --- | --- | --- | --- |
| automatic | none | safe | 是 |
| task_authorized | workspace_write | never/safe（需工具证明） | 是 |
| single_confirmation | workspace_write | never | 是 |
| single_confirmation | external_write | reconcile | 是 |
| control | none | safe/never | 是 |
| automatic | external_write | 任意 | 否 |

## 6. 错误与恢复

- 重名、非法组合、schema 无法投影：启动失败，不跳过后继续。
- 可选 Provider 不可用：工具标记 unavailable，CLI/config 展示原因。
- Session 恢复时工具版本缺失：允许查看 trace，禁止盲目继续执行。
- 工具升级改变 schema：视为新版本，旧批准和 operation hash 失效。

## 7. 安全要求

- `REG-SR-001`：仓库内容不能注册工具或修改风险元数据。
- `REG-SR-002`：工具描述不含 Key、用户绝对私有路径或可执行 Prompt 注入内容。
- `REG-SR-003`：任何 external write 工具必须声明对账能力或明确不支持重试。

## 8. 验收标准

- `REG-AC-001`：18 个 MVP 工具都有唯一 name/version、输入/输出 schema 和合法策略组合。
- `REG-AC-002`：重名、非法策略组合和不可投影 schema 在启动测试中失败。
- `REG-AC-003`：Model tool 列表与 Runtime registry 名称/schema hash 一致。
- `REG-AC-004`：Windows、非 Git 目录、未登录 gh、缺少 Exa Key 的 availability 正确。
- `REG-AC-005`：恢复旧工具版本的 Session 得到可解释阻止信息。

## 9. 实现任务建议

1. 扩展 ToolDefinition 元数据和 output schema。
2. 增加策略组合 validator 与目录 hash。
3. 实现 availability probe，不执行副作用。
4. 建 18 工具目录清单和模型定义投影。
5. 将 C06/C08/C09/C11 统一改为只从 Registry 获取定义。
