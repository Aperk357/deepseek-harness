/** Strict session-log fold for Nightwatch-bound Harness operator state. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'
import type { NightwatchHarnessObservation, PersistedNightwatchHarnessProjection } from './types.ts'

interface NightwatchHarnessState {
  projection: NightwatchHarnessObservation | null
  route: { provider: string; model: string } | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { nightwatchHarness: NightwatchHarnessState }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const nonempty = z.string().min(1)
const projectionSchema = z.object({
  workId: nonempty.transform(NightwatchWorkId),
  sessionId: nonempty.transform(SessionId),
  effectTool: nonempty,
  effectPhase: z.enum(['IDLE', 'RUNNING', 'RECOVERY_REQUIRED', 'RECOVERED', 'SUCCEEDED', 'FAILED']),
  effect: z.object({
    callId: nonempty.transform(ToolCallId), requestSha256: sha256Schema,
    provider: nonempty.nullable(), model: nonempty.nullable(),
    outcome: z.enum(['PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']),
    receipt: z.object({
      attemptId: nonempty.transform(NightwatchAttemptId),
      fence: z.number().int().positive(), resultSha256: sha256Schema,
    }).strict().nullable(),
  }).strict().nullable(),
  lastEventSeq: z.number().int().nonnegative(), lastEventType: nonempty,
  sourceUpdatedAt: z.number().nonnegative(),
}).strict()
const stateSchema = z.object({
  projection: projectionSchema.nullable(),
  route: z.object({ provider: nonempty, model: nonempty }).strict().nullable(),
}).strict()
const bindingSchema = z.object({
  workId: nonempty.transform(NightwatchWorkId),
  sessionId: nonempty.transform(SessionId), effectTool: nonempty,
}).strict()
const receiptSchema = z.object({
  workId: nonempty.transform(NightwatchWorkId), callId: nonempty.transform(ToolCallId),
  requestSha256: sha256Schema, resultSha256: sha256Schema,
  attemptId: nonempty.transform(NightwatchAttemptId), fence: z.number().int().positive(),
}).strict()

const observed = (current: NightwatchHarnessObservation, event: SessionEvent) => ({
  ...current, lastEventSeq: event.seq, lastEventType: event.type, sourceUpdatedAt: event.time,
})

/** Apply one candidate event, rejecting invalid package-owned relationships. */
export function applyNightwatchHarnessEvent(
  state: NightwatchHarnessState,
  event: SessionEvent,
): NightwatchHarnessState {
  if (event.type === 'nightwatch/mission-bound') {
    if (state.projection !== null) throw new Error('Nightwatch session already has a mission binding')
    const data = bindingSchema.parse(event.data)
    return { route: state.route, projection: {
      workId: data.workId, sessionId: data.sessionId, effectTool: data.effectTool,
      effectPhase: 'IDLE', effect: null, lastEventSeq: event.seq,
      lastEventType: event.type, sourceUpdatedAt: event.time,
    } }
  }
  if (event.type === 'nightwatch/effect-reconciled') {
    const data = receiptSchema.parse(event.data)
    const current = state.projection
    if (current === null) {
      throw new Error('Nightwatch receipt does not match the bound work item and effect intent')
    }
    const effect = current.effect
    if (data.workId !== current.workId || effect === null || effect.outcome !== 'UNKNOWN'
      || data.callId !== effect.callId || data.requestSha256 !== effect.requestSha256) {
      throw new Error('Nightwatch receipt does not match the bound work item and effect intent')
    }
    return { route: state.route, projection: {
      ...observed(current, event), effectPhase: 'RECOVERED',
      effect: { ...effect, outcome: 'SUCCEEDED', receipt: {
        attemptId: data.attemptId, fence: data.fence, resultSha256: data.resultSha256,
      } },
    } }
  }
  const current = state.projection
  if (event.type === 'request/header') {
    return { projection: current === null ? null : observed(current, event), route: {
      provider: event.data.header.config.provider, model: event.data.header.config.model,
    } }
  }
  if (current === null) return state
  if (event.type === 'tool/call' && event.data.name === current.effectTool) {
    if (current.effect !== null) {
      throw new Error('Nightwatch binding already has a bounded effect call')
    }
    return { route: state.route, projection: {
      ...observed(current, event), effectPhase: 'RUNNING', effect: {
        callId: event.data.callId,
        requestSha256: createHash('sha256').update(event.data.arguments).digest('hex'),
        provider: state.route?.provider ?? null, model: state.route?.model ?? null,
        outcome: 'PENDING', receipt: null,
      },
    } }
  }
  if (event.type === 'tool/result' && current.effect?.callId === event.data.message.source.callId) {
    const unknown = event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'
    const failed = !unknown && event.data.error !== undefined
    return { route: state.route, projection: {
      ...observed(current, event),
      effectPhase: unknown ? 'RECOVERY_REQUIRED' : failed ? 'FAILED' : 'SUCCEEDED',
      effect: { ...current.effect, outcome: unknown ? 'UNKNOWN' : failed ? 'FAILED' : 'SUCCEEDED' },
    } }
  }
  return { route: state.route, projection: observed(current, event) }
}

/** Nightwatch Harness projection unit registered through the session-projection service. */
export const nightwatchHarnessProjectionDefinition = {
  key: 'nightwatchHarness', stateVersion: 2, stateSchema,
  init: (): NightwatchHarnessState => ({ projection: null, route: null }),
  apply: (state, event) => applyNightwatchHarnessEvent(state, event),
  wire: { viewSchema: projectionSchema.nullable(), view: state => state.projection },
} satisfies ProjectionDefinition<'nightwatchHarness', NightwatchHarnessState>

/**
 * Fold a complete ordered persistence snapshot into durable operator evidence.
 * @param sessionId - identity attached to the inspected persistence record.
 * @param events - complete ordered event list from that same inspection.
 * @returns Persisted operator evidence, or null before binding.
 * @throws When payload shape, ordering, identity, or package-owned relations are invalid.
 * @remarks Pure and write-free; never accepts a live buffer as durable evidence.
 */
export function projectNightwatchHarness(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): PersistedNightwatchHarnessProjection | null {
  const state = events.reduce(
    (current, event) => applyNightwatchHarnessEvent(current, event),
    nightwatchHarnessProjectionDefinition.init(),
  )
  if (state.projection === null) return null
  if (state.projection.sessionId !== sessionId) {
    throw new Error(`Nightwatch binding session "${state.projection.sessionId}" does not match "${sessionId}"`)
  }
  return { ...projectionSchema.parse(state.projection), durability: 'PERSISTED' }
}
