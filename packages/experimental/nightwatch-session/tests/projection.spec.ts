import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { nightwatchHarnessProjectionDefinition, projectNightwatchHarness } from '../src/projection.ts'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function event(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 1_000 + seq, data } as unknown as SessionEvent
}
const binding = (sessionId = 'nightwatch-session') => event(0, 'nightwatch/mission-bound', {
  workId: 'nightwatch-work', sessionId: SessionId(sessionId), effectTool: 'bounded_effect',
})
const call = (seq = 2) => event(seq, 'tool/call', {
  turn: 1, step: 1, callId: 'effect-1', name: 'bounded_effect', arguments: '{}',
})
const unknown = (seq = 3) => event(seq, 'tool/result', {
  turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'effect-1' } },
  error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
})
const receipt = (overrides: Record<string, unknown> = {}) => event(4, 'nightwatch/effect-reconciled', {
  workId: 'nightwatch-work', callId: 'effect-1', requestSha256: digest('{}'),
  resultSha256: digest('result'), attemptId: 'attempt-1', fence: 1, ...overrides,
})
function live(events: SessionEvent[]) {
  return events.reduce(
    (state, item) => nightwatchHarnessProjectionDefinition.apply(state, item),
    nightwatchHarnessProjectionDefinition.init(),
  ).projection
}

describe('Nightwatch Harness operator projection', () => {
  it('keeps live observation durability-neutral and persisted reads explicit', () => {
    expect(live([binding()])).toMatchObject({
      workId: 'nightwatch-work', effectPhase: 'IDLE', effect: null,
      lastEventType: 'nightwatch/mission-bound',
    })
    expect(live([binding()])).not.toHaveProperty('durability')
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [binding()]))
      .toMatchObject({ durability: 'PERSISTED', effectPhase: 'IDLE' })
    expect(() => projectNightwatchHarness(SessionId('other'), [binding()]))
      .toThrow('does not match')
  })

  it('captures the route at effect intent and preserves it across a provider swap', () => {
    const projected = projectNightwatchHarness(SessionId('nightwatch-session'), [
      binding(),
      event(1, 'request/header', { header: { config: { provider: 'provider-a', model: 'model-a' } } }),
      call(),
      event(3, 'request/header', { header: { config: { provider: 'provider-b', model: 'model-b' } } }),
    ])
    expect(projected?.effect).toMatchObject({ provider: 'provider-a', model: 'model-a', outcome: 'PENDING' })
  })

  it('projects unknown outcome and matching fenced reconciliation', () => {
    const projected = projectNightwatchHarness(SessionId('nightwatch-session'), [
      binding(), call(1), unknown(2), receipt(),
    ])
    expect(projected).toMatchObject({
      effectPhase: 'RECOVERED', effect: {
        outcome: 'SUCCEEDED', receipt: { attemptId: 'attempt-1', fence: 1, resultSha256: digest('result') },
      },
    })
  })

  it.each([
    ['work identity', { workId: 'other' }],
    ['call identity', { callId: 'other' }],
    ['request digest', { requestSha256: digest('other') }],
  ])('rejects receipt drift: %s', (_name, mutation) => {
    expect(() => projectNightwatchHarness(SessionId('nightwatch-session'), [
      binding(), call(1), unknown(2), receipt(mutation),
    ])).toThrow('Nightwatch receipt does not match')
  })

  it('rejects malformed events, duplicate bindings, and a second unresolved effect', () => {
    expect(() => projectNightwatchHarness(SessionId('nightwatch-session'), [receipt()]))
      .toThrow('Nightwatch receipt does not match')
    expect(() => projectNightwatchHarness(SessionId('nightwatch-session'), [
      binding(), event(1, 'nightwatch/mission-bound', {
        workId: 'nightwatch-work', sessionId: 'nightwatch-session', effectTool: 'bounded_effect',
      }),
    ])).toThrow('already has a mission binding')
    expect(() => projectNightwatchHarness(SessionId('nightwatch-session'), [binding(), call(1), call(2)]))
      .toThrow('already has a bounded effect call')
    expect(() => projectNightwatchHarness(SessionId('nightwatch-session'), [binding(), call(1), unknown(2), receipt({ fence: 0 })]))
      .toThrow()
  })

  it('makes dropped events reconstructable without inventing state', () => {
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [call(0)])).toBeNull()
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [binding(), call(1), unknown(2)]))
      .toMatchObject({ effectPhase: 'RECOVERY_REQUIRED', effect: { outcome: 'UNKNOWN', receipt: null } })
  })

  it('projects pre-binding routes, definitive outcomes, and irrelevant events', () => {
    const header = event(0, 'request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a' } },
    })
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [header])).toBeNull()
    const prefix = [header, binding(), call(2)]
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [
      ...prefix,
      event(3, 'tool/result', {
        message: { source: { kind: 'tool', callId: 'effect-1' } },
      }),
    ])).toMatchObject({ effectPhase: 'SUCCEEDED', effect: { outcome: 'SUCCEEDED' } })
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [
      ...prefix,
      event(3, 'tool/result', {
        message: { source: { kind: 'tool', callId: 'effect-1' } },
        error: { name: 'ToolError', code: 'FAILED' },
      }),
    ])).toMatchObject({ effectPhase: 'FAILED', effect: { outcome: 'FAILED' } })
    expect(projectNightwatchHarness(SessionId('nightwatch-session'), [binding(), event(1, 'turn/start', {})]))
      .toMatchObject({ lastEventType: 'turn/start', effectPhase: 'IDLE' })
  })
})
