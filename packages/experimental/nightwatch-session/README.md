---
description: "Experimental Nightwatch work-item binding and durable DSH-session operator projection for shared-harness integrators."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-nightwatch-session

English | [中文](README.zh.md)

## Summary

This private experimental package binds one Nightwatch work item and one named effect tool to one DSH session. It flushes the binding before returning, records a caller-verified recovery receipt after `TOOL_OUTCOME_UNKNOWN`, and folds persisted events into a sanitized operator view. It owns no scheduler, worker, lease, fence, mission ledger, or external effect: Nightwatch and the effect sink remain authoritative, while an Eyes-On adapter may consume the projection read-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Choose or avoid it](#choose-or-avoid-it)
- [Understand the contract](#understand-the-contract)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the session store, projection registry, then this plugin:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-experimental-nightwatch-session'
```

Before dispatching bounded work, call `bindNightwatchMission(ctx, session, { workId, effectTool })`. The function appends `nightwatch/mission-bound` once and requires a participating session persistence listener. Exact repeats flush again but add no event or bytes; identity drift rejects.

After crash recovery has repaired an entered tool call to `TOOL_OUTCOME_UNKNOWN`, the current canonical effect owner must validate its lease/fence and receipt. Pass that verified receipt to `recordNightwatchReconciliation`. The function checks the bound work, tool call identity, request digest, outcome-unknown repair, positive fence shape, and existing receipt. It records evidence; it does not grant authority.

Read `ctx.sessionProjections.snapshot(session).values.nightwatchHarness` for a durability-neutral observation. For a durable operator status, call `projectNightwatchHarness(sessionId, inspection.events)` with the complete ordered events returned by session persistence. Only that helper adds `durability: 'PERSISTED'`; live and cold registry folds deliberately make no durability claim.

<a id="choose-or-avoid-it"></a>
## Choose or avoid it

Choose this package when one bounded effect in one DSH session must reference a Nightwatch work identity and expose reconstructable recovery evidence. Avoid it for mission scheduling, gates, leases, arbitrary multi-effect workflows, or direct Nightwatch/Eyes-On transport.

If this experimental package cannot be mounted, keep Nightwatch on its existing mission/result lifecycle and use the PR1 recovery proof directly. Do not create a substitute state store.

-----

<a id="understand-the-contract"></a>
## Understand the contract

| Primitive | Owner | Package behavior |
|---|---|---|
| Session transcript and checkpoint boundary | DSH | Appends and flushes binding/receipt evidence |
| Mission, audit, gates, evidence, AAR | Nightwatch | Referenced by `workId`; never copied or mutated here |
| Lease/fence and external effect | Nightwatch or owning effect sink | Caller validates; package records the verified receipt |
| Operator composition | Eyes-On | May consume sanitized projection read-only |

The projection reports binding, the provider/model route captured when the bounded effect was called, request digest, outcome, receipt metadata, and last observed sequence. Later provider/model headers do not rewrite the effect route. Receipt reconciliation dispatches no model request.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Binding implementation](src/binding.ts)
- [Strict projection fold](src/projection.ts)
- [Package-owned invariant](src/invariant.ts)
- [Hard-crash integration proof](../../session/session-checkpoint-policy/tests/pdv-effect-recovery.spec.ts)
- [Ownership decision](../../../.agents/notes/implemented/architecture/2026-08-30-nightwatch-shared-harness-session-binding.md)

-----

<a id="model-experience"></a>
## Model Experience

### Log-only lifecycle evidence

#### What the model sees

Nothing. `nightwatch/mission-bound` and `nightwatch/effect-reconciled` are log-only events, and the package registers no tool, prompt, instruction, or provider-facing text.

#### Token effect

None; the package adds no request tokens and reconciliation dispatches no model request.

#### KV Cache effect

None; projection and reconciliation preserve existing request prefixes because they do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental and unshipped** — official release compositions do not include this package.
- **No Nightwatch transport** — it does not read or write mission files, result files, issue comments, gates, leases, or ledgers.
- **No fence validation** — a positive integer is shape validation only; stale-writer rejection must occur atomically at the canonical effect owner before a receipt is passed here.
- **No dispatch or refill loop** — scheduler, worker execution, terminal closeout, and refill remain outside this adapter.
- **One bounded effect intent per binding** — a second matching tool call is rejected; broader multi-effect orchestration is unsupported.
- **Eyes-On integration is consumer work** — the projection is operator-ready, but this package does not modify or host Eyes-On.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [architecture note](../../../.agents/notes/implemented/architecture/2026-08-30-nightwatch-shared-harness-session-binding.md) for ownership boundaries and rejected duplicate-state designs.

</details>
