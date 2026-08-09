# C09 18 个内置工具与外部 Provider

- 状态：只有 `finish_task` 工厂；其余待实现
- 目标阶段：D3–D6
- 代码位置：建议 `src/tools/builtin/`、`src/providers/`
- 硬依赖：[C00](00-shared-contracts.md)、[C02](02-storage-artifacts.md)、[C03](03-permission-engine.md)、[C07](07-tool-registry.md)、[C08](08-tool-runtime.md)
- 下游消费者：C10、C11、C13、C15

## 1. 目标

提供完成 Coding 任务所需的最小固定工具目录。工具只实现确定性能力；选择哪个工具、调用顺序和何时重规划由模型和 AgentEventLoop 决定，不把 Bug 修复或功能开发写成固定工作流。

## 2. Provider 分层

```text
builtin tools
├─ filesystem provider  list/search/read/patch/write/delete
├─ command provider     run command/install dependency
├─ git provider         status/diff/log/publish snapshot
├─ search provider      Exa search
├─ web provider         bounded fetch
├─ github provider      commit/push/PR + reconciliation
└─ control provider     ask/update plan/finish
```

Provider 管理 OS/SDK/CLI 细节；ToolDefinition 管理模型可见 schema；ToolRuntime 统一权限和执行。工具不得自行读取批准 token。

## 3. 总清单与依赖顺序

除 `finish_task` 工厂外，本节及后续各工具 schema 均为目标目录（规划中），当前 Registry 未注册这些工具，Provider 也尚不存在。

| 顺序 | 工具 | 风险 | 副作用 | 重试 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | `list_files` | automatic | none | safe | D3 |
| 2 | `search_text` | automatic | none | safe | D3 |
| 3 | `read_file` | automatic | none | safe | D3 |
| 4 | `git_status` | automatic | none | safe | D3 |
| 5 | `git_diff` | automatic | none | safe | D3 |
| 6 | `git_log` | automatic | none | safe | D3 |
| 7 | `ask_user` | control | none | never | D3–D5 |
| 8 | `update_plan` | control | none | safe | D3 |
| 9 | `apply_patch` | task_authorized | workspace_write | never | D4 |
| 10 | `write_file` | task_authorized | workspace_write | never | D4 |
| 11 | `run_command` | task_authorized | workspace_write | never | D4 |
| 12 | `delete_file` | single_confirmation | workspace_write | never | D4 |
| 13 | `install_dependency` | single_confirmation | workspace_write | never | D4 |
| 14 | `finish_task` | control | none | safe | D4 |
| 15 | `web_search` | automatic | none | safe | D6 |
| 16 | `web_fetch` | automatic | none | safe | D6 |
| 17 | `prepare_git_publish` | single_confirmation | none | safe | D6 |
| 18 | `commit_push_create_pr` | single_confirmation | external_write | reconcile | D6 |

`prepare_git_publish` 本身只读，但归入发布审批流程：它生成绑定参数和批准摘要，不执行 commit/push/PR。

## 4. 共享工具要求

- `TOOLS-FR-001`：所有路径输入都相对授权 workspace 解析，并返回规范化相对路径。
- `TOOLS-FR-002`：读取/搜索设置结果数、字节、深度、超时和 ignore 边界，明确标记 truncated。
- `TOOLS-FR-003`：写入携带 expected code/file version；发现用户并发修改时拒绝。
- `TOOLS-FR-004`：每个结果提供摘要、完整性状态和可选 ArtifactRef。
- `TOOLS-FR-005`：所有命令使用受控 cwd、环境 allowlist、输出上限和进程树取消。
- `TOOLS-FR-006`：Provider 原始错误映射为稳定 category，不能把 stderr 全量拼进 error message。
- `TOOLS-FR-007`：工具不得声明任务完成；只有 `finish_task` 可以提出完成声明，仍需 C10 验证。

## 5. 本地只读工具

### `list_files`

```ts
input:  { path?: string; glob?: string; maxDepth?: number; maxEntries?: number }
output: { entries: FileEntry[]; truncated: boolean; ignoredCount: number }
```

- 遵守 `.gitignore`、应用 ignore 和敏感目录 denylist。
- 不跟随逃出 workspace 的 symlink/junction。
- 排序稳定：目录优先后按规范化路径。
- 验收：大目录、循环 junction、无权限目录、上限和空目录 fixture。

### `search_text`

```ts
input:  { query: string; paths?: string[]; mode: "literal" | "regex";
          caseSensitive?: boolean; maxMatches?: number }
output: { matches: TextMatch[]; truncated: boolean; engine: string }
```

- 首选 `rg`；不可用时使用兼容实现并记录 engine。
- 每项保留 path、line、column、preview；二进制默认跳过。
- regex 编译、灾难性模式、输出和运行时间有边界。
- 验收：Unicode、CRLF、忽略文件、非法 regex、超限和无匹配。

### `read_file`

```ts
input:  { path: string; startLine?: number; endLine?: number; maxBytes?: number }
output: { path: string; content: string; encoding: "utf8";
          lineRange: [number, number]; sha256: string; truncated: boolean }
```

- 默认拒绝二进制和无法可靠解码的文件。
- 读取后再次确认真实路径仍在 workspace。
- 返回读取内容 hash，供写工具 expected version 使用。
- 验收：空文件、无结尾换行、CRLF、UTF-8、越界行、并发替换。

### `git_status`

```ts
input:  { includeUntracked?: boolean }
output: { repositoryRoot: string; head: string | null; branch: string | null;
          entries: GitStatusEntry[] }
```

- 使用 porcelain 机器格式解析，不解析本地化人类文本。
- 非 Git 工作区返回可判定结果，不伪造 clean。
- 验收：detached HEAD、初始仓库、rename、冲突、untracked。

### `git_diff`

```ts
input:  { scope: "working" | "staged" | "base"; base?: string; paths?: string[] }
output: { summary: DiffSummary; diffHash: string; artifact: ArtifactReference | null;
          truncated: boolean }
```

- 大 patch 总是 Artifact 化；摘要保留文件、增删行、二进制标记。
- 路径参数只允许 workspace repo 内。
- 验收：staged/unstaged、binary、rename、无 diff、超大 diff。

### `git_log`

```ts
input:  { maxCount?: number; path?: string; from?: string }
output: { commits: GitCommitSummary[]; truncated: boolean }
```

- 固定字段格式返回 hash、父节点、作者时间、标题；不执行任意 pretty format。
- 验收：空仓库、merge、非 ASCII message、路径过滤。

## 6. 控制工具

### `ask_user`

```ts
input:  { question: string; reason: string; choices?: Choice[]; sensitive?: boolean }
output: { answer: string; selectedChoiceId: string | null }
```

- Loop 发 `user.input.requested` 并进入 `WAITING_USER`；CLI 回答后发 received。
- 不得把批准请求伪装为普通问题；高风险操作只能走审批契约。
- 恢复 Session 时仍能显示未回答问题且不会重复生成。

### `update_plan`

```ts
input:  { revision: number; reason: string; steps: PlanStep[] }
output: { acceptedRevision: number }
```

- revision 必须单调；一次最多一个 in_progress。
- 计划是模型可见/用户可见状态，不是隐藏 reasoning。
- 每次更新产生 `plan.updated`，保存变更原因。

### `finish_task`

输入使用 C10 CompletionClaim；输出为 verified/rejected 及原因。

- 必须注入真实 CodeSnapshotProvider。
- rejected 不终止 Session，Loop 回 RUNNING 并展示缺失证据。
- 不能仅以“代码已写完”作为完成声明。

## 7. 工作区写工具

### `apply_patch`

```ts
input:  { patch: string; expectedCodeVersion: string; expectedFiles: FileVersion[] }
output: { changedFiles: FileChange[]; newCodeVersion: string; diffHash: string }
```

- 只接受统一 patch 语义；路径、hunk 和 expected hash 全部预校验后再写。
- 任一 hunk 失败时不部分提交，或返回可证明的部分状态并停止。
- 保留用户无关改动，禁止用整文件覆盖替代复杂 patch。
- 验收：多文件、CRLF、并发编辑、路径穿越、部分 hunk 失败。

### `write_file`

```ts
input:  { path: string; content: string; mode: "create" | "replace";
          expectedSha256: string | null }
output: { path: string; beforeSha256: string | null; afterSha256: string }
```

- create 遇到已有文件拒绝；replace 必须提供匹配 hash。
- 先写同目录临时文件再原子替换；保留可配置换行策略。
- 不负责删除文件或递归建任意工作区外目录。

### `run_command`

```ts
input:  { executable: string; args: string[]; cwd?: string; timeoutMs?: number;
          env?: Record<string, string>; purpose: string }
output: { exitCode: number | null; stdout: OutputRef; stderr: OutputRef;
          durationMs: number; timedOut: boolean }
```

- 默认不用 shell 字符串；确需 shell 的命令必须单独标记和审查。
- 过滤提权、系统配置、破坏性 Git、工作区外删除和凭证读取。
- 取消终止进程树；5 秒未终止标记错误和剩余进程证据。
- 即使 exit 0 也不自动等于任务验证通过。

### `delete_file`

```ts
input:  { path: string; expectedSha256: string; reason: string }
output: { deleted: boolean; priorSha256: string }
```

- MVP 只删除单个工作区内文件，不递归删除目录。
- 批准摘要绑定 path/hash/reason；文件变化使批准失效。
- 删除后验证路径不存在并记录 diff。

### `install_dependency`

```ts
input:  { ecosystem: string; packages: PackageSpec[]; dev: boolean;
          expectedManifestHash: string; expectedLockHash: string | null }
output: { command: string[]; changedFiles: FileChange[]; verification: VerificationRef }
```

- 包名和版本必须明确；禁止任意命令伪装成安装。
- 只支持已识别 package manager，批准摘要展示包、版本和预期文件。
- 安装脚本策略遵循包管理器安全设置；网络失败不盲目换源。

## 8. 联网工具

### `web_search`

```ts
input:  { query: string; maxResults?: number; domains?: string[]; recencyDays?: number }
output: { results: SearchResult[]; provider: string; costUsd: number | null }
```

- Provider 接口首版实现 Exa；查询前检查 Key、token、大段源码和私有标识符。
- 保存查询 hash、来源 URL、摘要、费用和失败，不记录 API Key。
- Exa 不可用时返回明确降级，离线 Coding 任务可继续。

### `web_fetch`

```ts
input:  { url: string; maxBytes?: number }
output: { finalUrl: string; status: number; mediaType: string;
          content: OutputRef; fetchedAt: string }
```

- 仅允许 HTTP/HTTPS，阻止 localhost、私网、file/data 协议和 DNS 重绑定。
- 限制 redirect 次数、响应大小、类型和超时。
- 网页内容标记为不可信外部数据，保留最终 URL。

## 9. GitHub 两阶段发布工具

### `prepare_git_publish`

```ts
input:  { remote: string; baseBranch: string; headBranch: string;
          commitMessage: string; prTitle: string; prBody: string }
output: PublishPlan // HEAD, status, diffHash, remote URL, existing PR, operationHash
```

- 只读检查 Git/gh 登录、remote、分支、用户改动、秘密扫描和现有 PR。
- 输出绑定最终参数的批准摘要，不执行 add/commit/push/PR。
- 工作树或参数变化后 plan 失效，必须重新 prepare。

### `commit_push_create_pr`

```ts
input:  { plan: PublishPlan; approvalId: string }
output: { commitSha: string; remoteBranch: string; prUrl: string;
          reconciliation: "confirmed" }
```

- Runtime 校验 operation hash 和一次性批准后执行。
- 只暂存 plan 明确列出的路径；不使用 force push，不自动 merge。
- 任一网络响应丢失时返回 unknown；恢复先查本地 commit、远端 branch 和现有 PR。
- 重复执行相同 plan 必须返回既有真实结果，不创建重复 PR。

## 10. 工具实现依赖门

| Wave | 可开始条件 | 交付 |
| --- | --- | --- |
| T1 | C07/C08 接口通过 | 六个本地只读工具 |
| T2 | C01/C11 状态接口可用 | ask_user、update_plan |
| T3 | C03 task auth + workspace snapshot 稳定 | patch/write/command |
| T4 | C10 Gate 稳定 | finish_task 接线 |
| T5 | 单次审批可持久化 | delete/install |
| T6 | 秘密检查和 Provider 接口稳定 | web search/fetch |
| T7 | Git 状态、operation hash、UNKNOWN 恢复稳定 | prepare/commit-push-PR |

## 11. 整体验收标准

- `TOOLS-AC-001`：18 个 ToolDefinition 全部通过 schema、策略组合和模型投影测试。
- `TOOLS-AC-002`：所有文件/命令路径穿越、junction 和并发版本 fixture 被阻止。
- `TOOLS-AC-003`：六个只读工具可完成“阅读并解释仓库”的完整 trace。
- `TOOLS-AC-004`：写工具只修改允许文件并产生 diff/验证证据。
- `TOOLS-AC-005`：未审批的 delete/install/publish execute 次数为零。
- `TOOLS-AC-006`：外部写响应丢失时不会产生重复 commit、branch 或 PR。
- `TOOLS-AC-007`：取消后 2 秒内停止新工具，5 秒内终止可控命令进程树。
