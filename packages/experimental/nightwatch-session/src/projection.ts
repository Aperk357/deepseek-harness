/** Strict session-log fold for Nightwatch-bound Harness operator state. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'
import type { NightwatchHarnessObservation, PersistedNightwatchHarnessProjection } from './types.ts'

export interface NightwatchHarnessState {
  projection: NightwatchHarnessObservation | null
  route: { provider: string; model: string } | null
  preBindingToolNames: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { nightwatchHarness: NightwatchHarnessState }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const nonempty = z.string().min(1)
const bindingFields = {
  workId: nonempty.transform(NightwatchWorkId),
  correlationId: nonempty,
  failureDomain: nonempty,
  leaseId: nonempty,
  fenceEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: nonempty.transform(SessionId),
  effectTool: nonempty,
}
const projectionSchema = z.object({
  ...bindingFields,
  effectPhase: z.enum(['IDLE', 'RUNNING', 'RECOVERY_REQUIRED', 'RECOVERED', 'SUCCEEDED', 'FAILED']),
  effect: z.object({
    callId: nonempty.transform(ToolCallId), requestSha256: sha256Schema,
    provider: nonempty.nullable(), model: nonempty.nullable(),
    outcome: z.enum(['PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']),
    receipt: z.object({
      attemptId: nonempty.transform(NightwatchAttemptId),
      leaseId: nonempty,
      fenceEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), resultSha256: sha256Schema,
    }).strict().nullable(),
  }).strict().nullable(),
  lastEventSeq: z.number().int().nonnegative(), lastEventType: nonempty,
  sourceUpdatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const consistent = value.effect === null
    ? value.effectPhase === 'IDLE'
    : value.effect.outcome === 'PENDING'
      ? value.effectPhase === 'RUNNING' && value.effect.receipt === null
      : value.effect.outcome === 'UNKNOWN'
        ? value.effectPhase === 'RECOVERY_REQUIRED' && value.effect.receipt === null
        : value.effect.outcome === 'FAILED'
          ? value.effectPhase === 'FAILED' && value.effect.receipt === null
          : value.effect.receipt === null
            ? value.effectPhase === 'SUCCEEDED'
            : value.effectPhase === 'RECOVERED'
  if (!consistent) ctx.addIssue({ code: 'custom', message: 'Nightwatch effect phase contradicts its outcome or receipt' })
})
const stateSchema = z.object({
  projection: projectionSchema.nullable(),
  route: z.object({ provider: nonempty, model: nonempty }).strict().nullable(),
  preBindingToolNames: z.array(nonempty),
}).strict()
const bindingSchema = z.object({
  ...bindingFields,
}).strict()
const receiptSchema = z.object({
  workId: nonempty.transform(NightwatchWorkId), callId: nonempty.transform(ToolCallId),
  requestSha256: sha256Schema, resultSha256: sha256Schema,
  attemptId: nonempty.transform(NightwatchAttemptId), leaseId: nonempty,
  fenceEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
    if (state.preBindingToolNames.includes(data.effectTool)) {
      throw new Error('Nightwatch binding must precede its bounded effect call')
    }
    return { route: state.route, preBindingToolNames: [], projection: {
      workId: data.workId, correlationId: data.correlationId, failureDomain: data.failureDomain,
      leaseId: data.leaseId, fenceEpoch: data.fenceEpoch,
      sessionId: data.sessionId, effectTool: data.effectTool,
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
      || data.fenceEpoch < current.fenceEpoch
      || (data.fenceEpoch === current.fenceEpoch && data.leaseId !== current.leaseId)
      || data.callId !== effect.callId || data.requestSha256 !== effect.requestSha256) {
      throw new Error('Nightwatch receipt does not match the bound work item and effect intent')
    }
    return { ...state, projection: {
      ...observed(current, event), effectPhase: 'RECOVERED',
      effect: { ...effect, outcome: 'SUCCEEDED', receipt: {
        attemptId: data.attemptId, leaseId: data.leaseId,
        fenceEpoch: data.fenceEpoch, resultSha256: data.resultSha256,
      } },
    } }
  }
  const current = state.projection
  if (event.type === 'request/header') {
    return { ...state, projection: current === null ? null : observed(current, event), route: {
      provider: event.data.header.config.provider, model: event.data.header.config.model,
    } }
  }
  if (current === null) {
    if (event.type !== 'tool/call') return state
    if (state.preBindingToolNames.includes(event.data.name)) return state
    return { ...state, preBindingToolNames: [...state.preBindingToolNames, event.data.name] }
  }
  if (event.type === 'tool/call' && event.data.name === current.effectTool) {
    if (current.effect !== null) {
      throw new Error('Nightwatch binding already has a bounded effect call')
    }
    return { ...state, projection: {
      ...observed(current, event), effectPhase: 'RUNNING', effect: {
        callId: event.data.callId,
        requestSha256: createHash('sha256').update(event.data.arguments).digest('hex'),
        provider: state.route?.provider ?? null, model: state.route?.model ?? null,
        outcome: 'PENDING', receipt: null,
      },
    } }
  }
  if (event.type === 'tool/result' && current.effect?.callId === event.data.message.source.callId) {
    if (current.effect.outcome !== 'PENDING') {
      throw new Error('Nightwatch bounded effect already has a terminal outcome')
    }
    const unknown = event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'
    const failed = !unknown && event.data.error !== undefined
    return { ...state, projection: {
      ...observed(current, event),
      effectPhase: unknown ? 'RECOVERY_REQUIRED' : failed ? 'FAILED' : 'SUCCEEDED',
      effect: { ...current.effect, outcome: unknown ? 'UNKNOWN' : failed ? 'FAILED' : 'SUCCEEDED' },
    } }
  }
  return { ...state, projection: observed(current, event) }
}

/** Nightwatch Harness projection unit registered through the session-projection service. */
export const nightwatchHarnessProjectionDefinition = {
  key: 'nightwatchHarness', stateVersion: 3, stateSchema,
  init: (): NightwatchHarnessState => ({ projection: null, route: null, preBindingToolNames: [] }),
  apply: (state, event) => applyNightwatchHarnessEvent(state, event),
  wire: { viewSchema: projectionSchema.nullable(), view: state => state.projection },
} satisfies ProjectionDefinition<'nightwatchHarness', NightwatchHarnessState>

/**
 * Fold a complete ordered persistence snapshot into durable operator evidence.
 * @param inspection - persistence-owned metadata and complete ordered event list.
 * @returns Persisted operator evidence, or null before binding.
 * @throws When payload shape, ordering, identity, or package-owned relations are invalid.
 * @remarks Pure and write-free; never accepts a live buffer as durable evidence.
 */
export function projectNightwatchHarness(
  inspection: SessionInspection,
): PersistedNightwatchHarnessProjection | null {
  for (const [index, event] of inspection.events.entries()) {
    if (event.seq !== index) {
      throw new Error(`Nightwatch persisted inspection has non-contiguous event sequence at index ${index}`)
    }
  }
  const state = inspection.events.reduce(
    (current, event) => applyNightwatchHarnessEvent(current, event),
    nightwatchHarnessProjectionDefinition.init(),
  )
  if (state.projection === null) return null
  if (state.projection.sessionId !== inspection.meta.id) {
    throw new Error(`Nightwatch binding session "${state.projection.sessionId}" does not match "${inspection.meta.id}"`)
  }
  return { ...projectionSchema.parse(state.projection), durability: 'PERSISTED' }
}
