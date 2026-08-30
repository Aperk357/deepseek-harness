/** Durable Nightwatch work-item binding operations over a live DSH session. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'

/** Input that identifies the Nightwatch work item governing one DSH session. */
export interface BindNightwatchMissionInput {
  workId: NightwatchWorkId
  effectTool: string
}

/** Caller-verified canonical receipt for one crash-ambiguous bounded effect. */
export interface RecordNightwatchReconciliationInput {
  workId: NightwatchWorkId
  callId: ToolCallId
  request: string
  result: string
  attemptId: NightwatchAttemptId
  fence: number
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const bindingFor = (session: Session, input: BindNightwatchMissionInput) => {
  const existing = session.events.find(event => event.type === 'nightwatch/mission-bound')
  if (existing !== undefined && (existing.data.workId !== input.workId
    || existing.data.sessionId !== session.id || existing.data.effectTool !== input.effectTool)) {
    throw new Error(`DSH session "${session.id}" is already bound to Nightwatch work item "${existing.data.workId}"`)
  }
  return existing
}

function receiptFor(session: Session, input: RecordNightwatchReconciliationInput) {
  const binding = session.events.find(event => event.type === 'nightwatch/mission-bound')
  if (binding === undefined || binding.data.workId !== input.workId || binding.data.sessionId !== session.id) {
    throw new Error(`DSH session "${session.id}" is not bound to Nightwatch work item "${input.workId}"`)
  }
  const call = session.events.find((event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
    event.type === 'tool/call' && event.data.callId === input.callId && event.data.name === binding.data.effectTool)
  const requestSha256 = sha256(input.request)
  if (call === undefined || sha256(call.data.arguments) !== requestSha256) {
    throw new Error('Nightwatch receipt does not match a durable bounded-effect intent')
  }
  const latestOutcome = session.events.findLast((event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
    event.type === 'tool/result' && event.data.message.source.callId === input.callId)
  if (latestOutcome?.data.error?.code !== 'TOOL_OUTCOME_UNKNOWN') {
    throw new Error('Nightwatch receipt requires a prior TOOL_OUTCOME_UNKNOWN repair')
  }
  return {
    requestSha256,
    resultSha256: sha256(input.result),
    existing: session.events.find((event): event is Extract<SessionEvent, { type: 'nightwatch/effect-reconciled' }> =>
      event.type === 'nightwatch/effect-reconciled' && event.data.callId === input.callId),
  }
}

const receiptMatches = (
  existing: Extract<SessionEvent, { type: 'nightwatch/effect-reconciled' }>,
  input: RecordNightwatchReconciliationInput,
  requestSha256: string,
  resultSha256: string,
): boolean => existing.data.workId === input.workId
  && existing.data.requestSha256 === requestSha256
  && existing.data.resultSha256 === resultSha256
  && existing.data.attemptId === input.attemptId
  && existing.data.fence === input.fence

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
  const before = bindingFor(session, input)
  if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch binding requires session persistence')
  const after = bindingFor(session, input)
  if (before !== undefined || after !== undefined) return
  session.append('nightwatch/mission-bound', {
    workId: input.workId,
    sessionId: session.id,
    effectTool: input.effectTool,
  })
  /* v8 ignore next -- preflight and postflush share the same persistence participant. */
  if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch binding requires session persistence')
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
  if (!Number.isSafeInteger(input.fence) || input.fence < 1) {
    throw new Error('Nightwatch receipt fence must be a positive safe integer')
  }
  let state = receiptFor(session, input)
  if (state.existing !== undefined) {
    if (receiptMatches(state.existing, input, state.requestSha256, state.resultSha256)) {
      /* v8 ignore next -- exact retries reuse the already-proven persistence participant. */
      if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch receipt requires session persistence')
      return
    }
    throw new Error('Nightwatch reconciliation conflicts with the durable receipt')
  }
  if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch receipt requires session persistence')
  state = receiptFor(session, input)
  /* v8 ignore start -- only a concurrent writer can publish during the awaited preflight. */
  if (state.existing !== undefined) {
    if (!receiptMatches(state.existing, input, state.requestSha256, state.resultSha256)) {
      throw new Error('Nightwatch reconciliation conflicts with the durable receipt')
    }
    if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch receipt requires session persistence')
    return
  }
  /* v8 ignore stop */
  session.append('nightwatch/effect-reconciled', {
    workId: input.workId,
    callId: input.callId,
    requestSha256: state.requestSha256,
    resultSha256: state.resultSha256,
    attemptId: input.attemptId,
    fence: input.fence,
  })
  /* v8 ignore next -- preflight and postflush share the same persistence participant. */
  if (!await ctx.sessions.flush(session)) throw new Error('Nightwatch receipt requires session persistence')
}
