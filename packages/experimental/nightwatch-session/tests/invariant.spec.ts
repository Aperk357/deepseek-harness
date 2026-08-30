import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
