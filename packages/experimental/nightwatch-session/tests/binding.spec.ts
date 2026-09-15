import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { bindNightwatchMission, recordNightwatchReconciliation } from '../src/binding.ts'
import { NightwatchAttemptId, NightwatchWorkId } from '../src/brand.ts'
import { nightwatchHarnessProjectionDefinition } from '../src/projection.ts'

const roots: string[] = []
const WORK_ID = NightwatchWorkId('EYES_ON_NIGHTWATCH_SHARED_HARNESS_CONTINUATION_V1')
const AUTHORITY = {
  correlationId: 'nightwatch-issue-131', failureDomain: 'shared-harness',
  leaseId: 'nightwatch-lease-4', fenceEpoch: 4,
}

async function installProjection(ctx: Context): Promise<void> {
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(nightwatchHarnessProjectionDefinition)
}

async function storedLocation(ctx: Context, root: string, id: SessionIdType): Promise<string> {
  const stored = await ctx.sessionPersistence.stat(id)
  if (stored === undefined) throw new Error(`expected persisted session ${id}`)
  return logPath(root, stored.header.cwd, id, 'none')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bindNightwatchMission', () => {
  it('fails closed when no persistence listener participates', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-unpersisted'))
      const input = {
        workId: NightwatchWorkId('nightwatch-work'), ...AUTHORITY,
        effectTool: 'nightwatch_bounded_effect',
      }
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
    await installProjection(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-issue-131'))
      await ctx.sessionPersistence.create(session.header)
      await Promise.all([
        bindNightwatchMission(ctx, session, {
          workId: WORK_ID,
          ...AUTHORITY,
          effectTool: 'nightwatch_bounded_effect',
        }),
        bindNightwatchMission(ctx, session, {
          workId: WORK_ID,
          ...AUTHORITY,
          effectTool: 'nightwatch_bounded_effect',
        }),
      ])
      const location = await storedLocation(ctx, root, session.id)
      const boundBytes = await readFile(location)

      await bindNightwatchMission(ctx, session, {
        workId: WORK_ID,
        ...AUTHORITY,
        effectTool: 'nightwatch_bounded_effect',
      })
      expect(await readFile(location)).toEqual(boundBytes)
      expect(ctx.sessionProjections.stateOf(session, 'nightwatchHarness')?.projection?.workId).toBe(WORK_ID)

      await expect(bindNightwatchMission(ctx, session, {
        workId: NightwatchWorkId('DIFFERENT_WORK'),
        ...AUTHORITY,
        effectTool: 'nightwatch_bounded_effect',
      }))
        .rejects.toThrow('already bound')
      expect(await readFile(location)).toEqual(boundBytes)

      const late = ctx.sessions.create(SessionId('nightwatch-late-binding'))
      await ctx.sessionPersistence.create(late.header)
      late.append('tool/call', {
        turn: 1, step: 1, callId: ToolCallId('already-entered'),
        name: 'nightwatch_bounded_effect', arguments: '{}',
      })
      await ctx.sessions.flush(late)
      const lateLocation = await storedLocation(ctx, root, late.id)
      const lateBytes = await readFile(lateLocation)
      await expect(bindNightwatchMission(ctx, late, {
        workId: WORK_ID, ...AUTHORITY, effectTool: 'nightwatch_bounded_effect',
      })).rejects.toThrow('must precede')
      expect(await readFile(lateLocation)).toEqual(lateBytes)
      expect(ctx.sessionProjections.stateOf(late, 'nightwatchHarness')?.projection).toBeNull()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes one matching fenced receipt and converges without further writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nightwatch-receipt-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-issue-131'))
      await ctx.sessionPersistence.create(session.header)
      await bindNightwatchMission(ctx, session, {
        workId: WORK_ID,
        ...AUTHORITY,
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
        leaseId: AUTHORITY.leaseId, fenceEpoch: AUTHORITY.fenceEpoch,
      }
      await Promise.all([
        recordNightwatchReconciliation(ctx, session, receipt),
        recordNightwatchReconciliation(ctx, session, receipt),
      ])
      const location = await storedLocation(ctx, root, session.id)
      const convergedBytes = await readFile(location)

      for (let cycle = 0; cycle < 10; cycle += 1) {
        await recordNightwatchReconciliation(ctx, session, receipt)
      }
      expect(await readFile(location)).toEqual(convergedBytes)
      expect(ctx.sessionProjections.stateOf(session, 'nightwatchHarness')?.projection?.effect?.receipt)
        .toMatchObject({ leaseId: AUTHORITY.leaseId, fenceEpoch: 4 })

      await expect(recordNightwatchReconciliation(ctx, session, { ...receipt, fenceEpoch: 3 }))
        .rejects.toThrow('bound lease fence')
      await expect(recordNightwatchReconciliation(ctx, session, {
        ...receipt, leaseId: 'different-lease',
      })).rejects.toThrow('bound lease fence')
      await expect(recordNightwatchReconciliation(ctx, session, { ...receipt, result: 'changed' }))
        .rejects.toThrow('conflicts with the durable receipt')
      await expect(recordNightwatchReconciliation(ctx, session, {
        ...receipt, attemptId: NightwatchAttemptId('changed'),
      }))
        .rejects.toThrow('conflicts with the durable receipt')
      expect(await readFile(location)).toEqual(convergedBytes)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid receipt preconditions before append', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-invalid-receipt'))
      const callId = ToolCallId('nightwatch-effect-invalid')
      const base = {
        workId: NightwatchWorkId('nightwatch-work'), callId, request: '{}', result: 'result',
        attemptId: NightwatchAttemptId('attempt-1'),
        leaseId: AUTHORITY.leaseId, fenceEpoch: AUTHORITY.fenceEpoch,
      }
      await expect(bindNightwatchMission(ctx, session, {
        workId: NightwatchWorkId(''), ...AUTHORITY, effectTool: 'bounded',
      })).rejects.toThrow('non-empty authority and effect identities')
      await expect(bindNightwatchMission(ctx, session, {
        workId: base.workId, ...AUTHORITY, effectTool: '',
      })).rejects.toThrow('non-empty authority and effect identities')
      await expect(bindNightwatchMission(ctx, session, {
        workId: base.workId, ...AUTHORITY, correlationId: '', effectTool: 'bounded',
      })).rejects.toThrow('non-empty authority and effect identities')
      await expect(bindNightwatchMission(ctx, session, {
        workId: base.workId, ...AUTHORITY, fenceEpoch: 0, effectTool: 'bounded',
      })).rejects.toThrow('positive safe integer')
      await expect(recordNightwatchReconciliation(ctx, session, {
        ...base, attemptId: NightwatchAttemptId(''),
      })).rejects.toThrow('non-empty work, lease, and attempt identities')
      await expect(recordNightwatchReconciliation(ctx, session, { ...base, fenceEpoch: 0 }))
        .rejects.toThrow('positive safe integer')
      await expect(recordNightwatchReconciliation(ctx, session, { ...base, fenceEpoch: Number.MAX_SAFE_INTEGER + 1 }))
        .rejects.toThrow('positive safe integer')
      await expect(recordNightwatchReconciliation(ctx, session, base)).rejects.toThrow('is not bound')

      expect(() => session.append('nightwatch/mission-bound', {
        workId: base.workId, ...AUTHORITY,
        sessionId: SessionId('different-session'), effectTool: 'nightwatch_bounded_effect',
      })).toThrow('does not match')
      expect(session.seq).toBe(0)
      const bound = ctx.sessions.create(SessionId('nightwatch-bound-validation'))
      bound.append('nightwatch/mission-bound', {
        workId: base.workId, ...AUTHORITY, sessionId: bound.id, effectTool: 'nightwatch_bounded_effect',
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
        workId: base.workId, ...AUTHORITY, sessionId: matching.id, effectTool: 'nightwatch_bounded_effect',
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
      expect(() => matching.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('definitive-after-unknown'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: false,
            content: [{ type: 'text', text: 'done' }],
          }],
        },
      }, { surfaceOp: 'append' })).toThrow('already has a terminal outcome')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['matching', 4, undefined],
    ['conflicting', 5, 'conflicts with the durable receipt'],
  ] as const)('handles a %s receipt published during persistence preflight', async (_name, writerFence, error) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nightwatch-concurrent-receipt-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const session = ctx.sessions.create(SessionId(`nightwatch-concurrent-${writerFence}`))
      await ctx.sessionPersistence.create(session.header)
      await bindNightwatchMission(ctx, session, { workId: WORK_ID, ...AUTHORITY, effectTool: 'bounded' })
      const callId = ToolCallId('concurrent-call')
      const request = '{}'
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'bounded', arguments: request })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: {
          id: MessageId('concurrent-unknown'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: true,
            content: [{ type: 'text', text: 'unknown' }],
          }],
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append' })
      await ctx.sessions.flush(session)
      let publish = true
      ctx.on('session/flush', (flushed) => {
        if (!publish || flushed !== session) return
        publish = false
        flushed.append('nightwatch/effect-reconciled', {
          workId: WORK_ID, callId,
          requestSha256: createHash('sha256').update(request).digest('hex'),
          resultSha256: createHash('sha256').update('result').digest('hex'),
          attemptId: NightwatchAttemptId('attempt-4'),
          leaseId: AUTHORITY.leaseId, fenceEpoch: writerFence,
        })
      })
      const operation = recordNightwatchReconciliation(ctx, session, {
        workId: WORK_ID, callId, request, result: 'result',
        attemptId: NightwatchAttemptId('attempt-4'),
        leaseId: AUTHORITY.leaseId, fenceEpoch: 4,
      })
      if (error === undefined) await expect(operation).resolves.toBeUndefined()
      else await expect(operation).rejects.toThrow(error)
      expect(ctx.sessionProjections.stateOf(session, 'nightwatchHarness')?.projection?.effect?.receipt)
        .toMatchObject({ fenceEpoch: writerFence })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails if the persistence participant disappears after a concurrent exact receipt', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-concurrent-disposal'))
      const workId = NightwatchWorkId('concurrent-disposal-work')
      const callId = ToolCallId('concurrent-disposal-call')
      session.append('nightwatch/mission-bound', {
        workId, ...AUTHORITY, sessionId: session.id, effectTool: 'bounded',
      })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'bounded', arguments: '{}' })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: {
          id: MessageId('concurrent-disposal-unknown'), role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId, isError: true,
            content: [{ type: 'text', text: 'unknown' }],
          }],
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append' })
      let dispose = (): void => {}
      dispose = ctx.on('session/flush', (flushed) => {
        flushed.append('nightwatch/effect-reconciled', {
          workId, callId,
          requestSha256: createHash('sha256').update('{}').digest('hex'),
          resultSha256: createHash('sha256').update('result').digest('hex'),
          attemptId: NightwatchAttemptId('attempt-1'),
          leaseId: AUTHORITY.leaseId, fenceEpoch: AUTHORITY.fenceEpoch,
        })
        dispose()
      })
      await expect(recordNightwatchReconciliation(ctx, session, {
        workId, callId, request: '{}', result: 'result',
        attemptId: NightwatchAttemptId('attempt-1'),
        leaseId: AUTHORITY.leaseId, fenceEpoch: AUTHORITY.fenceEpoch,
      })).rejects.toThrow('requires session persistence')
      expect(ctx.sessionProjections.stateOf(session, 'nightwatchHarness')?.projection?.effect?.receipt)
        .toMatchObject({ fenceEpoch: AUTHORITY.fenceEpoch })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed for new and repeated receipts without persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-unpersisted-receipt'))
      const callId = ToolCallId('nightwatch-unpersisted-call')
      session.append('nightwatch/mission-bound', {
        workId: NightwatchWorkId('nightwatch-work'), sessionId: session.id,
        ...AUTHORITY,
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
        attemptId: NightwatchAttemptId('attempt-1'),
        leaseId: AUTHORITY.leaseId, fenceEpoch: AUTHORITY.fenceEpoch,
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
    const root = await mkdtemp(join(tmpdir(), 'dsh-nightwatch-post-flush-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await installProjection(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    let flushes = 0
    ctx.on('session/flush', () => {
      flushes += 1
      if (flushes === 2) throw new Error('disk failed after publication')
    })
    try {
      const session = ctx.sessions.create(SessionId('nightwatch-post-flush-failure'))
      await ctx.sessionPersistence.create(session.header)
      await expect(bindNightwatchMission(ctx, session, {
        workId: NightwatchWorkId('work-post-flush'), ...AUTHORITY, effectTool: 'bounded',
      })).rejects.toThrow('disk failed after publication')
      expect(ctx.sessionProjections.stateOf(session, 'nightwatchHarness')?.projection?.workId)
        .toBe('work-post-flush')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
