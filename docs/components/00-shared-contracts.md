# C00 共享契约

- 状态：部分实现，需在 D2 前冻结首版
- 目标阶段：D1–D2
- 代码位置：`src/shared/`、跨模块 type/schema 文件
- 硬依赖：无
- 下游消费者：C01–C15

## 1. 目标

为组件间通信提供稳定、供应商无关且可序列化的基础类型，避免模型、工具、存储和 UI 各自定义 ID、时间、错误、版本、取消和结果语义。

## 2. 职责边界

### 必须负责

- 稳定 ID、时间戳、schema 版本和配置版本的格式。
- 通用 `Result`、结构化错误、用量、代码快照和 Artifact 引用。
- 取消信号和 deadline 的传递约定。
- JSON 可序列化与向后兼容规则。

### 明确不负责

- 业务状态机、权限决策、供应商错误翻译和数据库实现。
- 长期记忆、MCP、多 Agent 消息协议。

## 3. 核心数据契约

```ts
type StableId = string; // 生成后不可变，MVP 使用 UUID

interface CodeSnapshot {
  workspacePath: string;
  codeVersion: string | null; // Git HEAD 或受控工作区版本
  diffHash: string | null;
  configVersion: string;
}

interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  durationMs: number;
}

interface StructuredError {
  category: string;
  message: string;
  retryable: boolean;
  sideEffectStatus: "none" | "not_started" | "applied" | "unknown" | "compensated";
  recovery: string | null;
}
```

所有跨组件对象必须能通过 JSON 往返序列化。文件句柄、SDK response、Error 实例、AbortController 和进程对象只能存在于运行时边界，不能写入事件或数据库。

## 4. 功能需求

- `SHARED-FR-001`：ID 在创建点生成，不得由显示名称、路径或数组下标代替。
- `SHARED-FR-002`：所有持久化时间使用 UTC ISO-8601；耗时使用单调时钟毫秒值。
- `SHARED-FR-003`：每个可持久化 schema 带独立版本，读取方拒绝未知的破坏性版本。
- `SHARED-FR-004`：`codeVersion` 与 `diffHash` 分开保存；未初始化 Git 的工作区使用明确的工作区版本策略，不能填假 HEAD。
- `SHARED-FR-005`：成本以美元数值记录，同时保留供应商原始 usage 供重新计价。
- `SHARED-FR-006`：取消使用同一 `AbortSignal` 沿调用链传递；组件不得吞掉取消并继续发起新副作用。
- `SHARED-FR-007`：错误 category 是稳定机器标识符，message 是可显示文本，两者不能互相替代。

## 5. 版本与兼容性

- 新增可选字段属于向后兼容；删除、改名、改变含义属于破坏性变更。
- 破坏性事件/数据库变更必须提供迁移或明确拒绝旧数据。
- Provider 版本、模型 ID、工具 schema 版本和应用配置版本必须能够进入 trace。
- 核心接口不导出 OpenAI、Exa、SQLite 或 GitHub SDK 类型。

## 6. 安全与隐私

- `SHARED-SR-001`：任何名为 key/token/password/secret/reasoning 的原始值不得进入普通导出。
- `SHARED-SR-002`：审批引用可以进入审计，但批准令牌原文和凭证不能进入模型上下文。
- `SHARED-SR-003`：路径必须保留规范化值与用户显示值的边界，安全判断只使用规范化绝对路径。

## 7. 验收标准

- `SHARED-AC-001`：所有跨模块持久化类型可 JSON 往返且关键字段不丢失。
- `SHARED-AC-002`：同一操作输入无论对象 key 顺序如何都产生相同 operation hash。
- `SHARED-AC-003`：未知 schema 主版本被显式拒绝并产生结构化错误。
- `SHARED-AC-004`：取消信号从 Application 传到模型、工具和子进程测试替身。
- `SHARED-AC-005`：类型检查证明核心公开接口不含供应商 SDK 类型。

## 8. 实现顺序

1. 汇总当前重复类型并建立 `src/shared/` 导出面。
2. 增加 schema 版本、错误类别和 CodeSnapshot。
3. 为序列化、时间、hash 和取消编写契约测试。
4. 迁移 C01/C03/C05/C07 使用共享类型。
5. 冻结 D2 首版；后续变更按本索引的高影响规则处理。
