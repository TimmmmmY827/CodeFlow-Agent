# 项目目录与组件边界

```text
CodeFlow-Agent/
├─ .github/workflows/       # Windows CI
├─ docs/                    # 架构、路线图、组件需求设计和 ADR
├─ src/
│  ├─ agent/                # Agent 动态循环与任务生命周期
│  ├─ app/                  # 依赖组装和应用用例
│  ├─ cli/                  # Commander 命令和 Ink 视图
│  ├─ completion/           # 完成声明、证据、安全否决和版本绑定
│  ├─ context/              # 指令优先级与上下文装配
│  ├─ eval/                 # 评估任务、验证器和对照契约
│  ├─ events/               # 追加式事实事件和状态投影
│  ├─ model/                # 模型抽象与 DeepSeek 适配器
│  ├─ policy/               # 权限、批准和预算
│  ├─ shared/               # 无业务依赖的通用类型
│  ├─ storage/              # SQLite schema、仓储和 artifact
│  ├─ tools/                # 工具定义、注册、运行时与内置工具
│  └─ trace/                # 脱敏导出与可观察性
└─ tests/                   # 跨组件确定性测试
```

## 组织原则

1. **单仓库、单进程、模块化单体**：符合 1 人两周约束。
2. **接口在内、实现向外**：Agent core 不直接依赖 OpenAI/DeepSeek、Exa、GitHub 或 SQLite 类型。
3. **事实与视图分离**：事件只追加，CLI 状态由 reducer 派生。
4. **策略与执行分离**：ToolRuntime 不能自行批准高风险操作。
5. **大结果外置**：长日志、patch 和网页正文进入 artifact，事件保存 hash 和引用。
6. **先验证再扩展**：多 Agent、长期记忆、RAG、MCP、强沙盒保留边界但不实现。

## 代码所有权

MVP 为一人项目，不建立组织级 CODEOWNERS。用模块边界表达责任，跨越 `policy`、`storage`、`events` 或外部写入边界的修改必须在 PR 中说明安全与恢复影响。
