# Agent Note：Nightwatch 绑定 DSH session substrate，但不迁移权威

Status: implemented

[English](2026-08-30-nightwatch-shared-harness-session-binding.md) | 中文

## 问题

Eyes-On 需要在 Nightwatch 监督的 worker 崩溃后保持操作员连续性。DSH 已证明 JSONL checkpoint-before-effect 恢复与无重复 reconciliation，Nightwatch 已拥有 mission、audit gate、evidence 与 closeout。直接集成仍需要一个持久身份接缝与读模型，同时不能创建另一套 scheduler、ledger、lease、fence 或状态权威。

## 决定

私有实验 DSH 包为每个 session 追加一个已 flush 的 `nightwatch/mission-bound` 事件，并在 `TOOL_OUTCOME_UNKNOWN` 后追加一个由调用方验证的 `nightwatch/effect-reconciled` receipt。不可变绑定携带 Nightwatch 的 `workId`、`correlationId`、`failureDomain`、准入时的 `leaseId`/`fenceEpoch` 与 `effectTool`；这些只是引用，不迁移权威。严格增量 fold 验证本包拥有的关系，不直接读取 Session 历史。注册的 `nightwatchHarness` observation 不声明持久性；只有 persisted-read helper 把完整 persistence snapshot 标为 `PERSISTED`。

DSH 只拥有自己的 transcript、checkpoint 边界与派生投影。Nightwatch 继续拥有 mission lifecycle、audit、gate、evidence 与 AAR。实际 effect owner 继续拥有原子幂等与 stale-fence 拒绝权威。Eyes-On 继续作为只读控制平面组合方。

本变更把 PR1 硬崩溃证明移植到当前 handle-based persistence API，而不复制研究：派发前绑定 synthetic Nightwatch 权威元组，恢复后记录已验证的后继 epoch receipt，证明不再次调用 effect，建立终态 `session/end-seed` 固定点，再证明十个恢复周期产生零 JSONL 或 SQLite 字节漂移。

## 影响

消费方可以从持久 DSH 事件重建绑定工作项在 effect 调用时的模型路由、effect intent 摘要、崩溃歧义状态与已验证 receipt。不透明 Nightwatch 标识防止跨边界误替换。本包 invariant 在发布前拒绝格式错误的关系。相同绑定与 receipt 调用收敛且不增加 Nightwatch 事件；缺少 persistence、身份漂移、请求漂移和冲突 receipt 都会 fail closed。

Nightwatch 文件与 Eyes-On HTTP route 不属于此已实现切片。现有 Nightwatch result ingestion 与 Eyes-On worker-status composition 仍是兼容集成接缝；此处不存在并行状态存储。

## 曾考虑的替代方案

**让 DSH 成为 mission ledger。**否决，因为 Nightwatch 已拥有 mission、audit、gate、evidence 与 AAR 状态。

**在 DSH 包内读写 Nightwatch 文件。**否决，因为 transport 耦合会模糊权威，并让通用 session substrate 拥有 subsystem persistence。

**创建 Eyes-On continuity store。**否决，因为 Eyes-On 是操作员控制平面，应组合 canonical read model，而不应成为另一套 lifecycle authority。

**把记录的 lease/fence 快照当作实时权威。**否决，因为 effect sink 必须原子验证当前 owner。Adapter 拒绝 fence 回退与同 epoch 冲突 lease，接受调用方已验证的后继 epoch，并且不主张权威。
