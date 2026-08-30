import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { NightwatchWorkId } from '../src/brand.ts'
import * as NightwatchInvariant from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(NightwatchInvariant)
  return ctx
}

describe('Nightwatch stream invariant', () => {
  it('rejects session mismatch and duplicate binding before publication', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('session-1'))
      expect(() => session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('work-1'), sessionId: SessionId('other'), effectTool: 'bounded',
      })).toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT' }))
      expect(session.events).toEqual([])

      session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('work-1'), sessionId: session.id, effectTool: 'bounded',
      })
      expect(() => session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('work-1'), sessionId: session.id, effectTool: 'bounded',
      })).toThrow('already has a mission binding')
      expect(session.events).toHaveLength(1)

      const unrelated = ctx.sessions.create(SessionId('unrelated-event'))
      unrelated.append('turn/start', { turn: 1 })
      expect(unrelated.events).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects pre-binding and second bounded calls before publication', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('bounded-call-order'))
      session.append('tool/call', {
        turn: 1, step: 1, callId: ToolCallId('prior'), name: 'bounded', arguments: '{}',
      })
      const committedPriorCall = [...session.events]
      expect(() => session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('work-1'), sessionId: session.id, effectTool: 'bounded',
      })).toThrow('must precede')
      expect(session.events).toEqual(committedPriorCall)

      const bound = ctx.sessions.create(SessionId('second-bounded-call'))
      bound.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('work-2'), sessionId: bound.id, effectTool: 'bounded',
      })
      bound.append('tool/call', {
        turn: 1, step: 1, callId: ToolCallId('first'), name: 'bounded', arguments: '{}',
      })
      const committed = [...bound.events]
      expect(() => bound.append('tool/call', {
        turn: 1, step: 2, callId: ToolCallId('second'), name: 'bounded', arguments: '{}',
      })).toThrow('already has a bounded effect call')
      expect(bound.events).toEqual(committed)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a corrupt restored seed during session creation', async () => {
    const ctx = await setup()
    try {
      const sessionId = SessionId('corrupt-restored-seed')
      const seed = [{
        type: 'nightwatch/mission-bound', seq: 0, time: 1_000,
        data: { workId: NightwatchWorkId('work-1'), sessionId: SessionId('wrong'), effectTool: 'bounded' },
      }] as SessionEvent[]
      expect(() => ctx.sessions.create(sessionId, { seed })).toThrow('cannot reconstruct')
      expect(ctx.sessions.get(sessionId)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects corrupt existing state when the companion loads late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('late-load'))
    session.append('nightwatch/mission-bound', {
      workId: NightwatchWorkId('work-1'), sessionId: SessionId('wrong'), effectTool: 'bounded',
    })
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(NightwatchInvariant)).rejects.toMatchObject({ code: 'INVARIANT' })
    await ctx.fiber.dispose()
  })
})
