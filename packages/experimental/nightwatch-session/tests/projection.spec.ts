import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { nightwatchHarnessProjectionDefinition, projectNightwatchHarness } from '../src/projection.ts'

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
): SessionEvent {
  return { type, seq, time: 1_000 + seq, data } as unknown as SessionEvent
}

function project(events: SessionEvent[]) {
  return events.reduce(
    (state, current) => nightwatchHarnessProjectionDefinition.apply(state, current),
    nightwatchHarnessProjectionDefinition.init(),
  )
}

describe('Nightwatch Harness operator projection', () => {
  it('binds one Nightwatch work item to one DSH session', () => {
    const state = project([
      event(0, 'nightwatch/mission-bound', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        sessionId: SessionId('nightwatch-issue-131'),
        effectTool: 'nightwatch_bounded_effect',
      }),
    ])

    expect(nightwatchHarnessProjectionDefinition.wire.view(state)).toEqual({
      workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
      sessionId: 'nightwatch-issue-131',
      effectTool: 'nightwatch_bounded_effect',
      phase: 'BOUND',
      provider: null,
      model: null,
      durableEffect: null,
      lastDurableSeq: 0,
      lastDurableEventType: 'nightwatch/mission-bound',
      sourceUpdatedAt: 1_000,
    })
  })

  it('projects the durable bounded-effect intent and model route', () => {
    const state = project([
      event(0, 'nightwatch/mission-bound', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        sessionId: SessionId('nightwatch-issue-131'),
        effectTool: 'nightwatch_bounded_effect',
      }),
      event(1, 'request/header', {
        header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
        reason: 'initial',
      }),
      event(2, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'nightwatch-effect-1',
        name: 'nightwatch_bounded_effect',
        arguments: '{"operation":"bounded-nightwatch-effect","value":1}',
      }),
    ])

    expect(nightwatchHarnessProjectionDefinition.wire.view(state)).toEqual({
      workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
      sessionId: 'nightwatch-issue-131',
      effectTool: 'nightwatch_bounded_effect',
      phase: 'RUNNING',
      provider: 'deepseek',
      model: 'deepseek-chat',
      durableEffect: {
        callId: 'nightwatch-effect-1',
        requestSha256: '073a4e460b8942d6b1048f9e2a0fa0a1e292e546ad7382a832c14ce5b84bfe86',
        outcome: 'PENDING',
        receipt: null,
      },
      lastDurableSeq: 2,
      lastDurableEventType: 'tool/call',
      sourceUpdatedAt: 1_002,
    })
  })

  it('projects unknown outcome until a matching fenced receipt is reconciled', () => {
    const prefix = [
      event(0, 'nightwatch/mission-bound', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        sessionId: SessionId('nightwatch-issue-131'),
        effectTool: 'nightwatch_bounded_effect',
      }),
      event(1, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'nightwatch-effect-1',
        name: 'nightwatch_bounded_effect',
        arguments: '{"operation":"bounded-nightwatch-effect","value":1}',
      }),
      event(2, 'tool/result', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'nightwatch-effect-1' } },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }),
    ]

    expect(nightwatchHarnessProjectionDefinition.wire.view(project(prefix))).toMatchObject({
      phase: 'RECOVERY_REQUIRED',
      durableEffect: { outcome: 'UNKNOWN', receipt: null },
    })

    const reconciled = project([
      ...prefix,
      event(3, 'nightwatch/effect-reconciled', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        callId: 'nightwatch-effect-1',
        requestSha256: '073a4e460b8942d6b1048f9e2a0fa0a1e292e546ad7382a832c14ce5b84bfe86',
        resultSha256: '9b8c2a13cdb00841fac38f6b0a16fc7c0670ffa761d65d86e13f4119bc28f58d',
        attemptId: 'nightwatch-attempt-4',
        fence: 4,
      }),
    ])
    expect(nightwatchHarnessProjectionDefinition.wire.view(reconciled)).toMatchObject({
      phase: 'RECOVERED',
      durableEffect: {
        outcome: 'SUCCEEDED',
        receipt: {
          attemptId: 'nightwatch-attempt-4',
          fence: 4,
          resultSha256: '9b8c2a13cdb00841fac38f6b0a16fc7c0670ffa761d65d86e13f4119bc28f58d',
        },
      },
      lastDurableSeq: 3,
      lastDurableEventType: 'nightwatch/effect-reconciled',
    })
  })

  it('rejects a receipt for a different durable request', () => {
    expect(() => project([
      event(0, 'nightwatch/mission-bound', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        sessionId: SessionId('nightwatch-issue-131'),
        effectTool: 'nightwatch_bounded_effect',
      }),
      event(1, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'nightwatch-effect-1',
        name: 'nightwatch_bounded_effect',
        arguments: '{"operation":"bounded-nightwatch-effect","value":1}',
      }),
      event(2, 'nightwatch/effect-reconciled', {
        workId: 'EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1',
        callId: 'nightwatch-effect-1',
        requestSha256: 'changed-request',
        resultSha256: 'result',
        attemptId: 'nightwatch-attempt-4',
        fence: 4,
      }),
    ])).toThrow('Nightwatch receipt does not match')
  })

  it('rejects reconciliation before the effect outcome is unknown', () => {
    expect(() => projectNightwatchHarness([
      event(0, 'nightwatch/mission-bound', {
        workId: 'nightwatch-work', sessionId: SessionId('nightwatch-session'),
        effectTool: 'nightwatch_bounded_effect',
      }),
      event(1, 'tool/call', {
        turn: 1, step: 1, callId: 'effect', name: 'nightwatch_bounded_effect', arguments: '{}',
      }),
      event(2, 'nightwatch/effect-reconciled', {
        workId: 'nightwatch-work', callId: 'effect',
        requestSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        resultSha256: 'result', attemptId: 'attempt', fence: 1,
      }),
    ])).toThrow('Nightwatch receipt does not match')
  })

  it('projects successful, failed, irrelevant, and pre-binding events exactly', () => {
    expect(projectNightwatchHarness([
      event(0, 'turn/start', { turn: 1 }),
    ])).toBeNull()
    const prefix = [
      event(0, 'nightwatch/mission-bound', {
        workId: 'nightwatch-work', sessionId: SessionId('nightwatch-session'),
        effectTool: 'nightwatch_bounded_effect',
      }),
      event(1, 'tool/call', {
        turn: 1, step: 1, callId: 'ignored', name: 'other-tool', arguments: '{}',
      }),
      event(2, 'tool/call', {
        turn: 1, step: 1, callId: 'effect', name: 'nightwatch_bounded_effect', arguments: '{}',
      }),
      event(3, 'tool/result', {
        turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'ignored' } },
      }),
    ]
    expect(projectNightwatchHarness([
      ...prefix,
      event(4, 'tool/result', {
        turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'effect' } },
      }),
    ])).toMatchObject({ phase: 'SUCCEEDED', durableEffect: { outcome: 'SUCCEEDED' } })
    expect(projectNightwatchHarness([
      ...prefix,
      event(4, 'tool/result', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'effect' } },
        error: { name: 'ToolError', code: 'TOOL_FAILED' },
      }),
    ])).toMatchObject({ phase: 'FAILED', durableEffect: { outcome: 'FAILED' } })
  })

  it.each([
    ['work', { workId: 'other' }],
    ['missing effect', { omitCall: true }],
    ['call', { callId: 'other' }],
    ['request', { requestSha256: 'other' }],
  ])('rejects reconciled receipt mismatch: %s', (_name, mutation) => {
    const events = [
      event(0, 'nightwatch/mission-bound', {
        workId: 'nightwatch-work', sessionId: SessionId('nightwatch-session'),
        effectTool: 'nightwatch_bounded_effect',
      }),
    ]
    if (!('omitCall' in mutation)) {
      events.push(event(1, 'tool/call', {
        turn: 1, step: 1, callId: 'effect', name: 'nightwatch_bounded_effect', arguments: '{}',
      }))
    }
    events.push(event(2, 'nightwatch/effect-reconciled', {
      workId: 'workId' in mutation ? mutation.workId : 'nightwatch-work',
      callId: 'callId' in mutation ? mutation.callId : 'effect',
      requestSha256: 'requestSha256' in mutation
        ? mutation.requestSha256
        : '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      resultSha256: 'result', attemptId: 'attempt', fence: 1,
    }))
    expect(() => projectNightwatchHarness(events)).toThrow('Nightwatch receipt does not match')
  })
})
