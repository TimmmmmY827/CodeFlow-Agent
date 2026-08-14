# ADR-0004：C02 使用 Node 内置 SQLite 运行时

- 状态：接受，需持续复核
- 日期：2026-08-14

## 背景

C02 需要本地同步事务、WAL、foreign keys、busy timeout 和可控 checkpoint。项目运行基线已经是 Node 24；内置 `node:sqlite` 可以避免额外原生依赖，并把 `DatabaseSync` 限制在存储 adapter 内。

Node 24 仍会为 `node:sqlite` 输出 `ExperimentalWarning`，其 API 稳定性弱于正式稳定模块。该风险不能由 provider 接口泄漏到 Agent core，也不能被测试通过所掩盖。

## 决策

1. C02 当前使用 Node 24+ 的 `node:sqlite`，公开 repository/EventStore/ArtifactStore 接口保持 provider 无关，不暴露 `DatabaseSync`。
2. CI 固定执行 migration、事务回滚、WAL checkpoint、busy、损坏和全量契约测试；Node 版本升级必须先通过这些门禁。
3. 所有 `node:sqlite` 调用集中在 `src/storage/sqlite/` 与 C02 文件 provider，禁止下游组件直接依赖其实验 API。
4. 如果 Node 后续版本产生不兼容变化或取消所需保证，优先在 adapter 内迁移到稳定 SQLite provider，不改变 C01/C02 公共语义。

## 后果

- `package.json` 要求 Node `>=24`，运行时出现 ExperimentalWarning 属于已知风险，不代表测试失败。
- 发布前需要在目标 Windows Node 版本上运行 `pnpm check` 和存储故障测试。
- 该决策不降低对 WAL durability、物理清理、路径边界或迁移 fail-closed 的要求。
