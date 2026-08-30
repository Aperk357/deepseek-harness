/** Pure session-log fold for Nightwatch-bound Harness operator state. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { NightwatchHarnessProjection } from './types.ts'

interface NightwatchHarnessState {
  projection: NightwatchHarnessProjection | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    nightwatchHarness: NightwatchHarnessState
  }
}

const durableEffectSchema = z.object({
  callId: z.string(),
  requestSha256: z.string(),
  outcome: z.enum(['PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']),
  receipt: z.object({
    attemptId: z.string(),
    fence: z.number().int().positive(),
    resultSha256: z.string(),
  }).strict().nullable(),
}).strict()

const projectionSchema = z.object({
  workId: z.string(),
  sessionId: z.string(),
  effectTool: z.string(),
  phase: z.enum(['BOUND', 'RUNNING', 'RECOVERY_REQUIRED', 'RECOVERED', 'SUCCEEDED', 'FAILED']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  durableEffect: durableEffectSchema.nullable(),
  lastDurableSeq: z.number().int().nonnegative(),
  lastDurableEventType: z.string(),
  sourceUpdatedAt: z.number().nonnegative(),
}).strict()

const stateSchema = z.object({ projection: projectionSchema.nullable() }).strict()

/** Nightwatch Harness projection unit registered through the session-projection service. */
export const nightwatchHarnessProjectionDefinition = {
  key: 'nightwatchHarness',
  stateVersion: 1,
  stateSchema,
  init: (): NightwatchHarnessState => ({ projection: null }),
  apply: (state, event) => {
    if (event.type === 'nightwatch/mission-bound') {
      return {
        projection: {
          workId: event.data.workId,
          sessionId: event.data.sessionId,
          effectTool: event.data.effectTool,
          phase: 'BOUND',
          provider: null,
          model: null,
          durableEffect: null,
          lastDurableSeq: event.seq,
          lastDurableEventType: event.type,
          sourceUpdatedAt: event.time,
        },
      }
    }
    const current = state.projection
    if (current === null) return state
    const observed = {
      ...current,
      lastDurableSeq: event.seq,
      lastDurableEventType: event.type,
      sourceUpdatedAt: event.time,
    }
    if (event.type === 'request/header') {
      return {
        projection: {
          ...observed,
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        },
      }
    }
    if (event.type === 'tool/call' && event.data.name === current.effectTool) {
      return {
        projection: {
          ...observed,
          phase: 'RUNNING',
          durableEffect: {
            callId: event.data.callId,
            requestSha256: createHash('sha256').update(event.data.arguments).digest('hex'),
            outcome: 'PENDING',
            receipt: null,
          },
        },
      }
    }
    if (event.type === 'tool/result' && current.durableEffect?.callId === event.data.message.source.callId) {
      if (event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
        return {
          projection: {
            ...observed,
            phase: 'RECOVERY_REQUIRED',
            durableEffect: { ...current.durableEffect, outcome: 'UNKNOWN' },
          },
        }
      }
      const failed = event.data.error !== undefined
      return {
        projection: {
          ...observed,
          phase: failed ? 'FAILED' : 'SUCCEEDED',
          durableEffect: { ...current.durableEffect, outcome: failed ? 'FAILED' : 'SUCCEEDED' },
        },
      }
    }
    if (event.type === 'nightwatch/effect-reconciled') {
      const effect = current.durableEffect
      if (event.data.workId !== current.workId
        || effect === null
        || effect.outcome !== 'UNKNOWN'
        || event.data.callId !== effect.callId
        || event.data.requestSha256 !== effect.requestSha256) {
        throw new Error('Nightwatch receipt does not match the bound work item and durable effect intent')
      }
      return {
        projection: {
          ...observed,
          phase: 'RECOVERED',
          durableEffect: {
            ...effect,
            outcome: 'SUCCEEDED',
            receipt: {
              attemptId: event.data.attemptId,
              fence: event.data.fence,
              resultSha256: event.data.resultSha256,
            },
          },
        },
      }
    }
    return { projection: observed }
  },
  wire: {
    viewSchema: projectionSchema.nullable(),
    view: state => state.projection,
  },
} satisfies ProjectionDefinition<'nightwatchHarness', NightwatchHarnessState>

/**
 * Fold a persisted event snapshot into the sanitized operator projection.
 * Callers must supply events returned by session persistence, not a live buffer,
 * when they rely on the `durableEffect` and `lastDurable*` names.
 * @param events - ordered events from one persisted DSH session snapshot.
 * @returns operator state, or null before a Nightwatch binding exists.
 */
export function projectNightwatchHarness(
  events: readonly SessionEvent[],
): NightwatchHarnessProjection | null {
  const state = events.reduce(
    (current, event) => nightwatchHarnessProjectionDefinition.apply(current, event),
    nightwatchHarnessProjectionDefinition.init(),
  )
  return nightwatchHarnessProjectionDefinition.wire.view(state)
}
