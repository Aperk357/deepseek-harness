---
description: "供共享 harness 集成方使用的实验性 Nightwatch 工作项绑定与持久 DSH 会话操作员投影。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-nightwatch-session

[English](README.md) | 中文

## 概述

这个私有实验包把一个 Nightwatch 工作项和一个具名 effect 工具绑定到一个 DSH 会话。它在返回前 flush 绑定，在 `TOOL_OUTCOME_UNKNOWN` 后记录由调用方验证的恢复 receipt，并把持久事件折叠成净化后的操作员视图。它不拥有 scheduler、worker、lease、fence、mission ledger 或外部 effect：Nightwatch 与 effect sink 继续拥有权威，Eyes-On adapter 可以只读消费该投影。

## 目录

- [使用本包](#use-this-package)
- [何时选择或避免](#choose-or-avoid-it)
- [理解契约](#understand-the-contract)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

依次挂载 session store、projection registry 和本插件：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-experimental-nightwatch-session'
```

派发有界工作前，调用 `bindNightwatchMission(ctx, session, { workId, effectTool })`。该函数只追加一次 `nightwatch/mission-bound`，并要求有 session persistence listener 参与。完全相同的重复调用会再次 flush，但不增加事件或字节；身份漂移会被拒绝。

崩溃恢复把已进入的工具调用修复成 `TOOL_OUTCOME_UNKNOWN` 后，当前 canonical effect owner 必须验证自己的 lease/fence 与 receipt。把已验证的 receipt 传给 `recordNightwatchReconciliation`。该函数检查绑定工作、工具调用身份、请求摘要、outcome-unknown 修复、正 fence 形状和已有 receipt。它记录证据，不授予权威。

从 `ctx.sessionProjections.snapshot(session).values.nightwatchHarness` 读取不声明持久性的 observation。要取得持久操作员状态，请把 session persistence 返回的完整有序事件传给 `projectNightwatchHarness(sessionId, inspection.events)`。只有该 helper 添加 `durability: 'PERSISTED'`；实时与 cold registry fold 都不会声称持久性。

<a id="choose-or-avoid-it"></a>
## 何时选择或避免

当一个 DSH session 中的一个有界 effect 必须引用 Nightwatch 工作身份并暴露可重建的恢复证据时，选择本包。不要把它用于 mission scheduling、gate、lease、任意多 effect workflow 或直接 Nightwatch/Eyes-On transport。

若无法挂载这个实验包，继续使用 Nightwatch 现有 mission/result 生命周期，并直接复用 PR1 恢复证明。不要创建替代 state store。

-----

<a id="understand-the-contract"></a>
## 理解契约

| 原语 | 权威方 | 本包行为 |
|---|---|---|
| Session transcript 与 checkpoint 边界 | DSH | 追加并 flush 绑定/receipt 证据 |
| Mission、audit、gates、evidence、AAR | Nightwatch | 仅通过 `workId` 引用；此处绝不复制或修改 |
| Lease/fence 与外部 effect | Nightwatch 或 effect sink 所有者 | 调用方验证；本包记录已验证 receipt |
| 操作员组合 | Eyes-On | 可以只读消费净化投影 |

投影报告绑定、effect 调用时捕获的 provider/model 路由、请求摘要、结果、receipt 元数据，以及最后观察到的序号。之后的 provider/model header 不会改写 effect 路由。Receipt reconciliation 不派发模型请求。

-----

<a id="further-exploration"></a>
## 进一步探索

- [绑定实现](src/binding.ts)
- [严格投影 fold](src/projection.ts)
- [本包 invariant](src/invariant.ts)
- [硬崩溃集成证明](../../session/session-checkpoint-policy/tests/pdv-effect-recovery.spec.ts)
- [所有权决策](../../../.agents/notes/implemented/architecture/2026-08-30-nightwatch-shared-harness-session-binding.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 仅日志生命周期证据

#### 模型看到什么

什么也看不到。`nightwatch/mission-bound` 与 `nightwatch/effect-reconciled` 都是仅日志事件，本包不注册工具、prompt、instruction 或面向 provider 的文本。

#### Token 影响

无；本包不增加请求 token，reconciliation 也不派发模型请求。

#### KV Cache 影响

无；投影与 reconciliation 不组装模型请求，因此保留已有请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **实验性且未发布**——正式发布组合不包含本包。
- **无 Nightwatch transport**——不读写 mission 文件、result 文件、issue 评论、gate、lease 或 ledger。
- **不验证 fence**——正整数只做形状验证；stale-writer 拒绝必须在 canonical effect owner 处原子完成，然后才能把 receipt 传入这里。
- **无 dispatch 或 refill loop**——scheduler、worker execution、terminal closeout 与 refill 仍在此 adapter 外部。
- **每个绑定只有一个有界 effect intent**——第二个匹配工具调用会被拒绝；不支持更广的多 effect 编排。
- **Eyes-On 集成属于消费方工作**——投影已可供操作员使用，但本包不修改或托管 Eyes-On。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

所有权边界与被否决的重复状态设计见[架构说明](../../../.agents/notes/implemented/architecture/2026-08-30-nightwatch-shared-harness-session-binding.zh.md)。

</details>
