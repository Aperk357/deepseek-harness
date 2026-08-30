/** Types for Nightwatch work-item binding and its operator projection. */

/** Sanitized state derived from one DSH session log for operator clients. */
export interface NightwatchHarnessProjection {
  workId: string
  sessionId: string
  effectTool: string
  phase: 'BOUND' | 'RUNNING' | 'RECOVERY_REQUIRED' | 'RECOVERED' | 'SUCCEEDED' | 'FAILED'
  provider: string | null
  model: string | null
  durableEffect: {
    callId: string
    requestSha256: string
    outcome: 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED'
    receipt: {
      attemptId: string
      fence: number
      resultSha256: string
    } | null
  } | null
  lastDurableSeq: number
  lastDurableEventType: string
  sourceUpdatedAt: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Binds one Nightwatch work item to this exact DSH session. */
    'nightwatch/mission-bound': { workId: string; sessionId: SessionId; effectTool: string }
    /** Records a caller-verified canonical receipt without making DSH its authority. */
    'nightwatch/effect-reconciled': {
      workId: string
      callId: string
      requestSha256: string
      resultSha256: string
      attemptId: string
      fence: number
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Sanitized Nightwatch-bound Harness lifecycle for operator clients. */
    nightwatchHarness: NightwatchHarnessProjection | null
  }
}
