# CodeFlow Agent

CodeFlow Agent 是一个面向个人开发者的本地 Coding Agent。它把任务计划、模型调用、工具执行、文件修改和验证证据组织成实时任务树与可审计 trace，让 Agent 的执行过程更容易理解、介入和调试。

> 当前状态：架构与 D1 工程骨架。仓库可以构建、测试并运行 CLI 帮助，但尚不能自主完成 Coding 任务。

## MVP 目标

- Windows 本地 CLI/TUI，命令名 `codeflow`。
- DeepSeek V4 Flash 驱动的动态 Agent 循环，不把修复步骤写死。
- 支持已有仓库和空目录中的 Bug 修复、小功能开发。
- 文件、命令、Git、GitHub 和受控联网搜索工具。
- 任务授权、高风险单次确认、取消和恢复。
- 追加式事件、实时任务树、SQLite Session 与可删除 trace。
- TypeScript、Python、Go 六任务评估，以及 OpenCode 对照。

## 快速开始

```powershell
corepack enable
pnpm install
pnpm build
pnpm start -- --help
```

开发模式：

```powershell
pnpm dev -- --help
pnpm check
```

## 首版命令

```text
codeflow run [workspace]
codeflow resume <session>
codeflow sessions
codeflow trace <session>
codeflow config
codeflow eval
```

除 `--help` 和配置检查外，这些命令目前只明确报告尚未实现的里程碑，不会伪装成可用 Agent。

## 架构入口

- [总体架构](docs/architecture.md)
- [组件需求设计与依赖顺序](docs/components/README.md)
- [项目目录与组件边界](docs/project-structure.md)
- [两周路线图](docs/roadmap.md)
- [ADR-0001：模块化单体](docs/decisions/0001-modular-monolith.md)
- [安全边界](SECURITY.md)

## 配置

复制 `.env.example` 并在本地提供凭证。应用必须从环境变量或系统凭证读取 Key，禁止把凭证、原始 reasoning 或疑似秘密写入普通 trace。

## 许可证

项目目前是个人私有原型，尚未授予开源许可证。达到 MVP 发布门槛并完成名称、依赖、安全和秘密检查后再确定许可证并公开仓库。
