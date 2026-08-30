import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { bindNightwatchMission, recordNightwatchReconciliation } from '../src/binding.ts'
import { NightwatchAttemptId, NightwatchWorkId } from '../src/brand.ts'

const roots: string[] = []
const WORK_ID = NightwatchWorkId('EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bindNightwatchMission', () => {
  it('fails closed when no persistence listener participates', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-unpersisted'))
      const input = { workId: NightwatchWorkId('nightwatch-work'), effectTool: 'nightwatch_bounded_effect' }
      await expect(bindNightwatchMission(ctx, session, input)).rejects.toThrow('requires session persistence')
      await expect(bindNightwatchMission(ctx, session, input)).rejects.toThrow('requires session persistence')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes one binding and rejects identity drift without byte drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nightwatch-binding-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-issue-131'))
      await Promise.all([
        bindNightwatchMission(ctx, session, {
          workId: WORK_ID,
          effectTool: 'nightwatch_bounded_effect',
        }),
        bindNightwatchMission(ctx, session, {
          workId: WORK_ID,
          effectTool: 'nightwatch_bounded_effect',
        }),
      ])
      const location = ctx.sessionPersistence.locate((await ctx.sessionPersistence.inspect(session.id)).meta)
      if (location?.kind !== 'jsonl') throw new Error('expected JSONL persistence')
      const boundBytes = await readFile(location.path)

      await bindNightwatchMission(ctx, session, {
        workId: WORK_ID,
        effectTool: 'nightwatch_bounded_effect',
      })
      expect(await readFile(location.path)).toEqual(boundBytes)
      expect(session.events.filter(item => item.type === 'nightwatch/mission-bound')).toHaveLength(1)

      await expect(bindNightwatchMission(ctx, session, {
        workId: NightwatchWorkId('DIFFERENT_WORK'),
        effectTool: 'nightwatch_bounded_effect',
      }))
        .rejects.toThrow('already bound')
      expect(await readFile(location.path)).toEqual(boundBytes)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes one matching fenced receipt and converges without further writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nightwatch-receipt-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-issue-131'))
      await bindNightwatchMission(ctx, session, {
        workId: WORK_ID,
        effectTool: 'nightwatch_bounded_effect',
      })
      const callId = ToolCallId('nightwatch-effect-1')
      const request = '{"operation":"bounded-nightwatch-effect","value":1}'
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId,
        name: 'nightwatch_bounded_effect',
        arguments: request,
      })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('nightwatch-unknown-result'),
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: 'outcome unknown after crash' }],
          }],
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append' })
      await ctx.sessions.flush(session)

      const receipt = {
        workId: WORK_ID,
        callId,
        request,
        result: 'nightwatch-result-1',
        attemptId: NightwatchAttemptId('nightwatch-attempt-4'),
        fence: 4,
      }
      await Promise.all([
        recordNightwatchReconciliation(ctx, session, receipt),
        recordNightwatchReconciliation(ctx, session, receipt),
      ])
      const location = ctx.sessionPersistence.locate((await ctx.sessionPersistence.inspect(session.id)).meta)
      if (location?.kind !== 'jsonl') throw new Error('expected JSONL persistence')
      const convergedBytes = await readFile(location.path)

      for (let cycle = 0; cycle < 10; cycle += 1) {
        await recordNightwatchReconciliation(ctx, session, receipt)
      }
      expect(await readFile(location.path)).toEqual(convergedBytes)
      expect(session.events.filter(item => item.type === 'nightwatch/effect-reconciled')).toHaveLength(1)

      await expect(recordNightwatchReconciliation(ctx, session, { ...receipt, fence: 3 }))
        .rejects.toThrow('conflicts with the durable receipt')
      await expect(recordNightwatchReconciliation(ctx, session, { ...receipt, result: 'changed' }))
        .rejects.toThrow('conflicts with the durable receipt')
      await expect(recordNightwatchReconciliation(ctx, session, {
        ...receipt, attemptId: NightwatchAttemptId('changed'),
      }))
        .rejects.toThrow('conflicts with the durable receipt')
      expect(await readFile(location.path)).toEqual(convergedBytes)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid receipt preconditions before append', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-invalid-receipt'))
      const callId = ToolCallId('nightwatch-effect-invalid')
      const base = {
        workId: NightwatchWorkId('nightwatch-work'), callId, request: '{}', result: 'result',
        attemptId: NightwatchAttemptId('attempt-1'), fence: 1,
      }
      await expect(recordNightwatchReconciliation(ctx, session, { ...base, fence: 0 }))
        .rejects.toThrow('positive safe integer')
      await expect(recordNightwatchReconciliation(ctx, session, { ...base, fence: Number.MAX_SAFE_INTEGER + 1 }))
        .rejects.toThrow('positive safe integer')
      await expect(recordNightwatchReconciliation(ctx, session, base)).rejects.toThrow('is not bound')

      expect(() => session.append('nightwatch/mission-bound', {
        workId: base.workId, sessionId: SessionId('different-session'), effectTool: 'nightwatch_bounded_effect',
      })).toThrow('does not match')
      expect(session.events).toEqual([])
      const bound = ctx.sessions.create(SessionId('nightwatch-bound-validation'))
      bound.append('nightwatch/mission-bound', {
        workId: base.workId, sessionId: bound.id, effectTool: 'nightwatch_bounded_effect',
      })
      await expect(recordNightwatchReconciliation(ctx, bound, base)).rejects.toThrow('bounded-effect intent')
      bound.append('tool/call', {
        turn: 1, step: 1, callId, name: 'wrong-tool', arguments: '{}',
      })
      bound.append('tool/call', {
        turn: 1, step: 1, callId, name: 'nightwatch_bounded_effect', arguments: '{"changed":true}',
      })
      await expect(recordNightwatchReconciliation(ctx, bound, base)).rejects.toThrow('bounded-effect intent')
      const matching = ctx.sessions.create(SessionId('nightwatch-missing-unknown'))
      matching.append('nightwatch/mission-bound', {
        workId: base.workId, sessionId: matching.id, effectTool: 'nightwatch_bounded_effect',
      })
      matching.append('tool/call', {
        turn: 1, step: 1, callId, name: 'nightwatch_bounded_effect', arguments: '{}',
      })
      await expect(recordNightwatchReconciliation(ctx, matching, base)).rejects.toThrow('prior TOOL_OUTCOME_UNKNOWN')

      matching.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('unknown-before-success'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: true,
            content: [{ type: 'text', text: 'unknown' }],
          }],
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append' })
      matching.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('definitive-after-unknown'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: false,
            content: [{ type: 'text', text: 'done' }],
          }],
        },
      }, { surfaceOp: 'append' })
      await expect(recordNightwatchReconciliation(ctx, matching, base))
        .rejects.toThrow('prior TOOL_OUTCOME_UNKNOWN')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed for new and repeated receipts without persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-unpersisted-receipt'))
      const callId = ToolCallId('nightwatch-unpersisted-call')
      session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('nightwatch-work'), sessionId: session.id,
        effectTool: 'nightwatch_bounded_effect',
      })
      session.append('tool/call', {
        turn: 1, step: 1, callId, name: 'nightwatch_bounded_effect', arguments: '{}',
      })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('unknown'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: true,
            content: [{ type: 'text', text: 'unknown' }],
          }],
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append' })
      const receipt = {
        workId: NightwatchWorkId('nightwatch-work'), callId, request: '{}', result: 'result',
        attemptId: NightwatchAttemptId('attempt-1'), fence: 1,
      }
      await expect(recordNightwatchReconciliation(ctx, session, receipt))
        .rejects.toThrow('requires session persistence')
      await expect(recordNightwatchReconciliation(ctx, session, receipt))
        .rejects.toThrow('requires session persistence')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves post-append flush failures observable only in the live stream', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let flushes = 0
    ctx.on('session/flush', () => {
      flushes += 1
      if (flushes === 2) throw new Error('disk failed after publication')
    })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-post-flush-failure'))
      await expect(bindNightwatchMission(ctx, session, {
        workId: NightwatchWorkId('work-post-flush'), effectTool: 'bounded',
      })).rejects.toThrow('disk failed after publication')
      expect(session.events.filter(event => event.type === 'nightwatch/mission-bound')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
