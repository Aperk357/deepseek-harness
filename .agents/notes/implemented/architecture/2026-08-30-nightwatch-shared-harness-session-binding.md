# Agent Note: Nightwatch binds to the DSH session substrate without moving authority

Status: implemented

English | [中文](2026-08-30-nightwatch-shared-harness-session-binding.zh.md)

## Problem

Eyes-On needs operator continuity across Nightwatch-supervised worker crashes. DSH already proves JSONL checkpoint-before-effect recovery and no-duplicate reconciliation, while Nightwatch already owns missions, audit gates, evidence, and closeout. A direct integration still needed a durable identity seam and a read model without creating another scheduler, ledger, lease, fence, or state authority.

## Decision

Add a private experimental DSH package that appends one flushed `nightwatch/mission-bound` event per session and one caller-verified `nightwatch/effect-reconciled` receipt after `TOOL_OUTCOME_UNKNOWN`. The pure `nightwatchHarness` projection folds persisted events into an operator-safe status. `effectTool` is part of the immutable binding, so the adapter observes a configured bounded effect rather than claiming all tools.

DSH owns only its transcript, checkpoint boundary, and derived projection. Nightwatch remains authoritative for mission lifecycle, audit, gates, evidence, and AAR. The actual effect owner remains authoritative for atomic idempotency and stale-fence rejection. Eyes-On remains a read-only control-plane composer.

The PR1 hard-crash proof is extended rather than duplicated: it binds the synthetic Nightwatch work identity before dispatch, records the verified fenced receipt after recovery, proves no reinvocation, establishes the terminal `session/end-seed` fixed point, and then proves ten recovery cycles produce zero JSONL or SQLite byte drift.

## Consequences

Consumers can reconstruct a bound work item's last executed model route, effect intent digest, crash-ambiguous state, and verified receipt from persisted DSH events. Identical binding and receipt calls converge without writes, while missing persistence, identity drift, request drift, and conflicting receipts fail closed.

This slice does not connect Nightwatch files or Eyes-On HTTP routes. The next integration must use Nightwatch's existing result-ingestion seam and Eyes-On's existing worker-status adapter; it must not introduce a parallel state store.

## Alternatives considered

**Make DSH the mission ledger.** Rejected because Nightwatch already owns mission, audit, gate, evidence, and AAR state.

**Read and write Nightwatch files inside the DSH package.** Rejected because transport coupling would blur authority and make a generic session substrate own subsystem persistence.

**Create an Eyes-On continuity store.** Rejected because Eyes-On is the operator control plane and should compose canonical read models, not become another lifecycle authority.

**Treat Nightwatch's advisory writer lease as an effect fence.** Rejected because the live primitive is git-writer coordination, not resource-side atomic stale-writer exclusion. Receipt recording therefore accepts only a caller-verified fence and makes no authority claim.
