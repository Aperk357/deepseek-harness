# Agent Note: Nightwatch binds to the DSH session substrate without moving authority

Status: implemented

English | [中文](2026-08-30-nightwatch-shared-harness-session-binding.zh.md)

## Problem

Eyes-On needs operator continuity across Nightwatch-supervised worker crashes. DSH already proves JSONL checkpoint-before-effect recovery and no-duplicate reconciliation, while Nightwatch already owns missions, audit gates, evidence, and closeout. A direct integration still needed a durable identity seam and a read model without creating another scheduler, ledger, lease, fence, or state authority.

## Decision

The private experimental DSH package appends one flushed `nightwatch/mission-bound` event per session and one caller-verified `nightwatch/effect-reconciled` receipt after `TOOL_OUTCOME_UNKNOWN`. The immutable binding carries Nightwatch's `workId`, `correlationId`, `failureDomain`, admitted `leaseId`/`fenceEpoch`, and `effectTool`; these are references, not transferred authority. Its strict incremental fold validates package-owned relationships without reading Session history directly. The registered `nightwatchHarness` observation is durability-neutral; the persisted-read helper alone labels a complete persistence snapshot `PERSISTED`.

DSH owns only its transcript, checkpoint boundary, and derived projection. Nightwatch remains authoritative for mission lifecycle, audit, gates, evidence, and AAR. The actual effect owner remains authoritative for atomic idempotency and stale-fence rejection. Eyes-On remains a read-only control-plane composer.

The PR1 hard-crash proof is ported to the current handle-based persistence API rather than duplicated: it binds the synthetic Nightwatch authority tuple before dispatch, records a verified successor-epoch receipt after recovery, proves no reinvocation, establishes the terminal `session/end-seed` fixed point, and then proves ten recovery cycles produce zero JSONL or SQLite byte drift.

## Consequences

Consumers can reconstruct a bound work item's effect-time model route, effect intent digest, crash-ambiguous state, and verified receipt from persisted DSH events. Opaque Nightwatch identifiers prevent accidental cross-boundary substitution. The package invariant rejects malformed relations before publication. Identical binding and receipt calls converge without Nightwatch events, while missing persistence, identity drift, request drift, and conflicting receipts fail closed.

Nightwatch files and Eyes-On HTTP routes remain outside this implemented slice. Existing Nightwatch result ingestion and Eyes-On worker-status composition remain the compatible integration seams; no parallel state store exists here.

## Alternatives considered

**Make DSH the mission ledger.** Rejected because Nightwatch already owns mission, audit, gate, evidence, and AAR state.

**Read and write Nightwatch files inside the DSH package.** Rejected because transport coupling would blur authority and make a generic session substrate own subsystem persistence.

**Create an Eyes-On continuity store.** Rejected because Eyes-On is the operator control plane and should compose canonical read models, not become another lifecycle authority.

**Treat the recorded lease/fence snapshot as live authority.** Rejected because the effect sink must atomically validate the current owner. The adapter rejects fence regression and conflicting same-epoch leases, admits caller-verified successor epochs, and makes no authority claim.
