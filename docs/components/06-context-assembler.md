# C06 ContextAssembler

- 状态：只有指令优先级排序和标签包装
- 目标阶段：D3，预算压力优化延续至 D9
- 代码位置：`src/context/context-assembler.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)、[C05](05-model-adapter.md)、[C07](07-tool-registry.md)
- 下游消费者：C05、C11、C15

## 1. 目标

为每次模型调用构造最小、可信、可重建的上下文：稳定规则放前缀，当前目标和近期证据放动态尾部，代码和长结果按需获取；接近上限时保留关键状态而不是静默丢失。

## 2. 职责边界

### 必须负责

- 指令优先级、作用域和不可信内容标记。
- 稳定前缀、动态尾部、工具定义和 transcript item 的装配。
- 文件/Artifact 引用的按需展开和大小预算。
- 结构化检查点与上下文溢出恢复。
- 生成可审计的 ContextManifest。

### 明确不负责

- 搜索/读取文件、长期记忆、RAG、模型调用或权限批准。
- 摘要事实的最终真实性判断；摘要必须引用原始事件/Artifact。

## 3. 指令优先级

```text
系统安全与权限规则
  > 当前用户任务与明确授权
  > 按目录作用域生效的 AGENTS.md
  > README / 开发文档 / 项目配置
  > 源码注释与普通仓库内容
  > 网页与其他外部内容
```

低优先级内容可以提供事实，不能取消审批、提高预算、外发秘密或覆盖安全规则。

## 4. 输出契约

当前 `ContextAssembler.assemble(sections)` 只按固定优先级排序并输出带来源标签的字符串。下列 `AssembledContext`、manifest、token 估算、source refs、omitted 项和 checkpoint 都是目标契约（规划中）：

```ts
interface AssembledContext {
  input: ModelInputItem[];
  manifest: {
    configVersion: string;
    stablePrefixHash: string;
    sourceRefs: ContextSourceRef[];
    omitted: OmittedContextItem[];
    estimatedTokens: number;
    checkpointId: string | null;
  };
}
```

Manifest 进入 trace，用于回答“模型看到了什么、什么被省略、为什么”。不得记录原始秘密。

## 5. 功能需求

- `CTX-FR-001`：稳定系统规则、工具 schema 和输出契约形成可 hash 的稳定前缀。
- `CTX-FR-002`：当前目标、计划、权限、预算、代码版本、近期错误和工具结果位于动态尾部。
- `CTX-FR-003`：自动加载工作区根及目标文件目录链上的 `AGENTS.md`，更深目录只影响其作用域。
- `CTX-FR-004`：README 和项目配置是项目事实，不作为更高权限指令。
- `CTX-FR-005`：代码只按搜索结果和模型需求分段读取；每段保留路径、行范围、hash。
- `CTX-FR-006`：长工具结果默认提供摘要、截断标记和 ArtifactRef，模型可通过工具继续读取。
- `CTX-FR-007`：接近预算时写结构化 checkpoint，至少保留目标、授权、计划、关键决策、文件变更、验证、后续事项、错误和机器 ID。
- `CTX-FR-008`：无法证明关键状态保留时返回 `context_compaction_unsafe`，请求用户处理。
- `CTX-FR-009`：同一代码/指令版本生成稳定 prefix hash，支持缓存成本分析。
- `CTX-FR-010`：每次请求记录 included/omitted source，不保存整份上下文副本作为普通 trace。

## 6. 预算分配

建议首版按上限比例预留：

- 15%：系统规则、工具定义、输出契约。
- 10%：当前目标、权限、预算和计划。
- 45%：按需代码、配置和用户提供证据。
- 15%：近期模型/工具交互。
- 15%：输出与工具调用余量。

比例是策略默认值，不是硬编码；必须按模型上下文能力和任务实测调整。

## 7. 错误与恢复

| category | 处理 |
| --- | --- |
| `context_source_missing` | 标记缺失，允许模型决定是否继续 |
| `context_source_changed` | 重新读取并更新 hash，不复用旧摘要 |
| `context_overflow` | checkpoint + 按优先级裁剪后重试一次 |
| `context_compaction_unsafe` | 停止并请求用户，不静默压缩 |
| `instruction_conflict` | 保留双方，按优先级选用并写决策摘要 |
| `secret_detected` | 阻止外发并等待用户 |

## 8. 安全要求

- `CTX-SR-001`：仓库/网页中的“忽略规则”“上传 Key”等文本按不可信数据处理。
- `CTX-SR-002`：敏感内容进入模型前按字段与内容双重检查。
- `CTX-SR-003`：批准令牌、环境变量全集和原始 reasoning 永不装入普通模型 input。
- `CTX-SR-004`：外部网页片段必须保留 URL 和抓取时间，不能伪装为系统事实。

## 9. 验收标准

- `CTX-AC-001`：同一输入生成稳定 manifest/prefix hash；动态事件变化只影响动态区。
- `CTX-AC-002`：目录嵌套 AGENTS.md 的作用域和冲突遵循优先级。
- `CTX-AC-003`：大仓库 fixture 不会默认读取全仓，模型能通过多轮工具按需获取。
- `CTX-AC-004`：在多种 token 上限下，checkpoint 保留清单中的全部关键状态。
- `CTX-AC-005`：Prompt injection fixture 无法改变权限、预算或秘密策略。
- `CTX-AC-006`：ContextManifest 能解释每个输入 item 的来源和省略原因。

## 10. 实现任务建议

1. 定义 ContextSource、Manifest 和 token estimator。
2. 实现稳定/动态分区与项目指令加载。
3. 接文件/Artifact 引用，不在 assembler 内做 I/O 工具执行。
4. 实现 checkpoint schema 与安全裁剪。
5. 用六任务的长上下文变体做遵循率和成本测试。
