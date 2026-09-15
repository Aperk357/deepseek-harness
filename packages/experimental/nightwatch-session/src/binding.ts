/** Durable Nightwatch work-item binding operations over a live DSH session. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'
import type { NightwatchHarnessState } from './projection.ts'

/** Input that identifies the Nightwatch work item governing one DSH session. */
export interface BindNightwatchMissionInput {
  workId: NightwatchWorkId
  correlationId: string
  failureDomain: string
  leaseId: string
  fenceEpoch: number
  effectTool: string
}

/** Caller-verified canonical receipt for one crash-ambiguous bounded effect. */
export interface RecordNightwatchReconciliationInput {
  workId: NightwatchWorkId
  callId: ToolCallId
  request: string
  result: string
  attemptId: NightwatchAttemptId
  leaseId: string
  fenceEpoch: number
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

async function flushDurably(ctx: Context, session: Session, purpose: 'binding' | 'receipt'): Promise<void> {
  const requiredEventCount = session.seq
  if (!await ctx.sessions.flush(session)) throw new Error(`Nightwatch ${purpose} requires session persistence`)
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error(`Nightwatch ${purpose} requires session persistence`)
  let reader
  try {
    reader = await persistence.open(session.id, 'read')
    const persisted = await reader.read()
    if (persisted.events.length < requiredEventCount) {
      throw new Error(`persisted prefix ends at ${persisted.events.length}, required prefix ends at ${requiredEventCount}`)
    }
  } catch (error: unknown) {
    throw new Error(`Nightwatch ${purpose} requires session persistence`, { cause: error })
  } finally {
    await reader?.close()
  }
}

const stateFor = (ctx: Context, session: Session): NightwatchHarnessState => {
  const state = ctx.get('sessionProjections')?.stateOf(session, 'nightwatchHarness')
  if (state === undefined) throw new Error('Nightwatch binding requires its session projection')
  return state
}

const bindingFor = (ctx: Context, session: Session, input: BindNightwatchMissionInput) => {
  const state = stateFor(ctx, session)
  const existing = state.projection
  if (existing !== null && (existing.workId !== input.workId
    || existing.correlationId !== input.correlationId || existing.failureDomain !== input.failureDomain
    || existing.leaseId !== input.leaseId || existing.fenceEpoch !== input.fenceEpoch
    || existing.sessionId !== session.id || existing.effectTool !== input.effectTool)) {
    throw new Error(`DSH session "${session.id}" is already bound to Nightwatch work item "${existing.workId}"`)
  }
  if (existing === null && state.preBindingToolNames.includes(input.effectTool)) {
    throw new Error('Nightwatch binding must precede its bounded effect call')
  }
  return existing
}

function receiptFor(ctx: Context, session: Session, input: RecordNightwatchReconciliationInput) {
  const binding = stateFor(ctx, session).projection
  if (binding === null || binding.workId !== input.workId || binding.sessionId !== session.id) {
    throw new Error(`DSH session "${session.id}" is not bound to Nightwatch work item "${input.workId}"`)
  }
  const requestSha256 = sha256(input.request)
  const effect = binding.effect
  if (effect === null || effect.callId !== input.callId || effect.requestSha256 !== requestSha256) {
    throw new Error('Nightwatch receipt does not match a durable bounded-effect intent')
  }
  if (input.fenceEpoch < binding.fenceEpoch
    || (input.fenceEpoch === binding.fenceEpoch && input.leaseId !== binding.leaseId)) {
    throw new Error('Nightwatch receipt does not match the bound lease fence')
  }
  if (effect.outcome !== 'UNKNOWN' && effect.receipt === null) {
    throw new Error('Nightwatch receipt requires a prior TOOL_OUTCOME_UNKNOWN repair')
  }
  return {
    requestSha256,
    resultSha256: sha256(input.result),
    existing: effect.receipt,
  }
}

const receiptMatches = (
  existing: NonNullable<NonNullable<NightwatchHarnessState['projection']>['effect']>['receipt'],
  input: RecordNightwatchReconciliationInput,
  resultSha256: string,
): boolean => existing !== null
  && existing.resultSha256 === resultSha256
  && existing.attemptId === input.attemptId
  && existing.leaseId === input.leaseId
  && existing.fenceEpoch === input.fenceEpoch

/**
 * Bind one Nightwatch work item to a live session and flush before returning.
 * An identical repeat is write-free; another work identity is rejected.
 * @param ctx - Cordis context carrying the live session store and persistence listener.
 * @param session - exact live DSH session that runs the work item.
 * @param input - canonical Nightwatch work identity.
 * @throws When persistence is absent, identity drifts, or the stream invariant rejects publication.
 * @remarks Flushes pending session events before validation is rechecked, then flushes the new binding.
 */
export async function bindNightwatchMission(
  ctx: Context,
  session: Session,
  input: BindNightwatchMissionInput,
): Promise<void> {
  if (input.workId.length === 0 || input.correlationId.length === 0 || input.failureDomain.length === 0
    || input.leaseId.length === 0 || input.effectTool.length === 0) {
    throw new Error('Nightwatch binding requires non-empty authority and effect identities')
  }
  if (!Number.isSafeInteger(input.fenceEpoch) || input.fenceEpoch < 1) {
    throw new Error('Nightwatch binding fence epoch must be a positive safe integer')
  }
  const before = bindingFor(ctx, session, input)
  await flushDurably(ctx, session, 'binding')
  const after = bindingFor(ctx, session, input)
  if (before !== null || after !== null) return
  session.append('nightwatch/mission-bound', {
    workId: input.workId,
    correlationId: input.correlationId,
    failureDomain: input.failureDomain,
    leaseId: input.leaseId,
    fenceEpoch: input.fenceEpoch,
    sessionId: session.id,
    effectTool: input.effectTool,
  })
  /* v8 ignore next -- preflight and postflush share the same persistence participant. */
  await flushDurably(ctx, session, 'binding')
}

/**
 * Record one caller-verified receipt after DSH repaired a started tool call as
 * outcome-unknown. Exact repeats are write-free; any identity, request, or
 * fence change rejects before append.
 * @param ctx - Cordis context carrying the live session store and persistence listener.
 * @param session - exact bound DSH session whose effect is being reconciled.
 * @param input - canonical receipt identity, request, result, attempt, and fence.
 * @throws When persistence or recovery preconditions fail, or receipt evidence conflicts.
 * @remarks Hashes request/result text, appends one evidence event, and flushes the session.
 */
export async function recordNightwatchReconciliation(
  ctx: Context,
  session: Session,
  input: RecordNightwatchReconciliationInput,
): Promise<void> {
  if (input.workId.length === 0 || input.attemptId.length === 0 || input.leaseId.length === 0) {
    throw new Error('Nightwatch receipt requires non-empty work, lease, and attempt identities')
  }
  if (!Number.isSafeInteger(input.fenceEpoch) || input.fenceEpoch < 1) {
    throw new Error('Nightwatch receipt fence epoch must be a positive safe integer')
  }
  let state = receiptFor(ctx, session, input)
  if (state.existing !== null) {
    if (receiptMatches(state.existing, input, state.resultSha256)) {
      /* v8 ignore next -- exact retries reuse the already-proven persistence participant. */
      await flushDurably(ctx, session, 'receipt')
      return
    }
    throw new Error('Nightwatch reconciliation conflicts with the durable receipt')
  }
  await flushDurably(ctx, session, 'receipt')
  state = receiptFor(ctx, session, input)
  if (state.existing !== null) {
    if (!receiptMatches(state.existing, input, state.resultSha256)) {
      throw new Error('Nightwatch reconciliation conflicts with the durable receipt')
    }
    await flushDurably(ctx, session, 'receipt')
    return
  }
  session.append('nightwatch/effect-reconciled', {
    workId: input.workId,
    callId: input.callId,
    requestSha256: state.requestSha256,
    resultSha256: state.resultSha256,
    attemptId: input.attemptId,
    leaseId: input.leaseId,
    fenceEpoch: input.fenceEpoch,
  })
  /* v8 ignore next -- preflight and postflush share the same persistence participant. */
  await flushDurably(ctx, session, 'receipt')
}
