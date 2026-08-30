/** Types for Nightwatch work-item binding and its operator projection. */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'

export type NightwatchEffectPhase =
  | 'IDLE' | 'RUNNING' | 'RECOVERY_REQUIRED' | 'RECOVERED' | 'SUCCEEDED' | 'FAILED'

/** Sanitized state derived from one DSH session log for operator clients. */
export interface NightwatchHarnessObservation {
  workId: NightwatchWorkId
  sessionId: SessionId
  effectTool: string
  effectPhase: NightwatchEffectPhase
  effect: {
    callId: ToolCallId
    requestSha256: string
    provider: string | null
    model: string | null
    outcome: 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED'
    receipt: {
      attemptId: NightwatchAttemptId
      fence: number
      resultSha256: string
    } | null
  } | null
  lastEventSeq: number
  lastEventType: string
  sourceUpdatedAt: number
}

/** Observation proven to come from a complete persisted session snapshot. */
export interface PersistedNightwatchHarnessProjection extends NightwatchHarnessObservation {
  durability: 'PERSISTED'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Binds one Nightwatch work item to this exact DSH session. */
    'nightwatch/mission-bound': {
      workId: NightwatchWorkId
      sessionId: SessionId
      effectTool: string
    }
    /** Records a caller-verified canonical receipt without making DSH its authority. */
    'nightwatch/effect-reconciled': {
      workId: NightwatchWorkId
      callId: ToolCallId
      requestSha256: string
      resultSha256: string
      attemptId: NightwatchAttemptId
      fence: number
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Live-buffer Nightwatch Harness state for operator clients. */
    nightwatchHarness: NightwatchHarnessObservation | null
  }
}
