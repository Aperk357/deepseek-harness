import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  projectNightwatchHarness,
  recordNightwatchReconciliation,
  NightwatchAttemptId,
  type PersistedNightwatchHarnessProjection,
} from '@deepseek-ai/dsh-experimental-nightwatch-session'
import * as checkpointPolicy from '../src/index.ts'
import {
  EFFECT_ATTEMPT_ID,
  EFFECT_CALL_ID,
  EFFECT_FENCE,
  EFFECT_MISSION_ID,
  EFFECT_REQUEST,
  EFFECT_SESSION_ID,
  PdvEffectStore,
} from './fixtures/pdv-effect-child.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childScript = fileURLToPath(new URL('./fixtures/pdv-effect-child.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const roots: string[] = []
const CHILD_FAILPOINT_TIMEOUT_MS = 30_000
const RECOVERY_TEST_TIMEOUT_MS = 60_000

async function waitForMarker(path: string, expected: string): Promise<void> {
  const content = await vi.waitFor(async () => {
    const current = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error(`effect child did not publish ${JSON.stringify(expected)}`, { cause: error })
    })
    if (current === expected || !expected.startsWith(current)) return current
    throw new Error(`effect child has not finished publishing ${JSON.stringify(expected)}`)
  }, { interval: 10, timeout: CHILD_FAILPOINT_TIMEOUT_MS })
  expect(content).toBe(expected)
}

function spawnEffectChild(phase: 'after-checkpoint' | 'after-effect', root: string, marker: string) {
  return execa(process.execPath, ['--import', pathToFileURL(tsxLoader).href, childScript, phase, root, marker], {
    cwd: repoRoot,
    env: { TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
    stdin: 'ignore',
    stdout: 'ignore',
    reject: false,
  })
}

async function hardKill(child: ReturnType<typeof spawnEffectChild>): Promise<void> {
  if (child.pid === undefined) throw new Error('effect child has no process id')
  if (process.platform === 'win32') {
    const killed = await execa('taskkill', ['/pid', String(child.pid), '/t', '/f'], { reject: false })
    expect(killed.exitCode).toBe(0)
  } else {
    child.kill('SIGKILL')
  }
  const exit = await child
  if (process.platform === 'win32') {
    expect(exit.exitCode).not.toBe(0)
  } else {
    expect({ code: exit.exitCode ?? null, signal: exit.signal ?? null })
      .toEqual({ code: null, signal: 'SIGKILL' })
  }
}

async function crashAt(phase: 'after-checkpoint' | 'after-effect'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-pdv-effect-${phase}-`))
  roots.push(root)
  const marker = join(root, 'failpoint')
  await writeFile(marker, '')
  const expected = phase === 'after-checkpoint' ? 'checkpoint-passed' : 'effect-committed'
  const child = spawnEffectChild(phase, root, marker)
  try {
    await waitForMarker(marker, expected)
    await hardKill(child)
    return root
  } catch (error: unknown) {
    child.kill('SIGKILL')
    throw new Error(`effect child failed: ${(await child).stderr}`, { cause: error })
  }
}

async function load(root: string): Promise<SessionEvent[]> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    return [...(await ctx.sessionPersistence.load(EFFECT_SESSION_ID)).events]
  } finally {
    await ctx.fiber.dispose()
  }
}

function outcome(events: SessionEvent[]): Extract<SessionEvent, { type: 'tool/result' }> {
  const result = events.find((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
  if (result === undefined) throw new Error('expected repaired tool result')
  return result
}

class RecoveryTripwireAdapter extends LlmAdapter {
  requests = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    throw new Error('recovery must not dispatch a model request')
  }
}

async function resumeAfterReceipt(root: string, store: PdvEffectStore): Promise<{
  events: SessionEvent[]
  logBytes: Buffer
  modelRequests: number
  operatorStatus: PersistedNightwatchHarnessProjection | null
  receiptResult: string
  toolInvocations: number
}> {
  const receipt = store.reconcile({
    missionId: EFFECT_MISSION_ID,
    attemptId: 'pdv-attempt-4',
    fence: 4,
    callId: EFFECT_CALL_ID,
    request: EFFECT_REQUEST,
  })

  const ctx = new Context()
  const adapter = new RecoveryTripwireAdapter()
  let toolInvocations = 0
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  ctx.llm.registerAdapter(['pdv-recovery'], adapter)
  ctx.tools.register({
    name: 'pdv_effect',
    description: 'must not be reinvoked during receipt-based recovery',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    execute() {
      toolInvocations += 1
      throw new Error('recovery must not reinvoke the effect')
    },
  })

  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: EFFECT_SESSION_ID,
      agentOptions: { provider: 'pdv-recovery', model: 'recovery-v2' },
    })
    await handle.agent.whenIdle()
    await recordNightwatchReconciliation(ctx, handle.agent.session, {
      workId: EFFECT_MISSION_ID,
      callId: EFFECT_CALL_ID,
      request: EFFECT_REQUEST,
      result: receipt.result,
      attemptId: NightwatchAttemptId('pdv-attempt-4'),
      fence: 4,
    })
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    const inspection = await ctx.sessionPersistence.inspect(EFFECT_SESSION_ID)
    const location = ctx.sessionPersistence.locate(inspection.meta)
    if (location?.kind !== 'jsonl') throw new Error('expected JSONL recovery location')
    const result = {
      events: [...inspection.events],
      logBytes: await readFile(location.path),
      modelRequests: adapter.requests,
      operatorStatus: projectNightwatchHarness(EFFECT_SESSION_ID, inspection.events),
      receiptResult: receipt.result,
      toolInvocations,
    }
    return result
  } finally {
    await ctx.fiber.dispose()
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('PDV effect recovery across a hard crash', () => {
  it('persists tool intent before entering an effect body on every supported platform', async () => {
    const root = await crashAt('after-checkpoint')
    const events = await load(root)
    const call = events.find((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call')
    expect(call?.data.callId).toBe(EFFECT_CALL_ID)
    expect(outcome(events).data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })

    const databasePath = join(root, 'pdv-effects.sqlite')
    const store = new PdvEffectStore(databasePath)
    try {
      expect(store.snapshot().effects).toEqual([])
    } finally {
      store.close()
    }
  }, RECOVERY_TEST_TIMEOUT_MS)

  it('reconciles a committed effect by call id without duplicate, drift, or stale writes', async () => {
    const root = await crashAt('after-effect')
    const events = await load(root)
    expect(outcome(events).data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })

    const databasePath = join(root, 'pdv-effects.sqlite')
    const store = new PdvEffectStore(databasePath)
    try {
      const initial = store.snapshot()
      expect(initial.effects).toHaveLength(1)
      expect(initial.effects[0]).toMatchObject({
        mission_id: EFFECT_MISSION_ID,
        tool_call_id: EFFECT_CALL_ID,
        submitted_attempt_id: EFFECT_ATTEMPT_ID,
        submitted_fence: EFFECT_FENCE,
      })
      expect(store.apply({
        missionId: EFFECT_MISSION_ID,
        attemptId: EFFECT_ATTEMPT_ID,
        fence: EFFECT_FENCE,
        callId: EFFECT_CALL_ID,
        request: EFFECT_REQUEST,
      }).replayed).toBe(true)
      expect(() => store.apply({
        missionId: EFFECT_MISSION_ID,
        attemptId: EFFECT_ATTEMPT_ID,
        fence: EFFECT_FENCE,
        callId: EFFECT_CALL_ID,
        request: '{"operation":"changed"}',
      })).toThrow('IDEMPOTENCY_CONFLICT')

      store.claim(EFFECT_MISSION_ID, 'pdv-attempt-2', 2)
      expect(() => store.apply({
        missionId: EFFECT_MISSION_ID,
        attemptId: EFFECT_ATTEMPT_ID,
        fence: EFFECT_FENCE,
        callId: EFFECT_CALL_ID,
        request: EFFECT_REQUEST,
      })).toThrow('STALE_FENCE')
      expect(() => store.reconcile({
        missionId: EFFECT_MISSION_ID,
        attemptId: 'pdv-attempt-2',
        fence: 2,
        callId: EFFECT_CALL_ID,
        request: '{"operation":"changed"}',
      })).toThrow('IDEMPOTENCY_CONFLICT')
      const competingStore = new PdvEffectStore(databasePath)
      try {
        expect(store.reconcile({
          missionId: EFFECT_MISSION_ID,
          attemptId: 'pdv-attempt-2',
          fence: 2,
          callId: EFFECT_CALL_ID,
          request: EFFECT_REQUEST,
        }, () => {
          expect(() => { competingStore.claim(EFFECT_MISSION_ID, 'pdv-attempt-3', 3) })
            .toThrow(/database is locked/)
        }).result).toBe(initial.effects[0]?.result)
        competingStore.claim(EFFECT_MISSION_ID, 'pdv-attempt-3', 3)
        expect(() => store.reconcile({
          missionId: EFFECT_MISSION_ID,
          attemptId: 'pdv-attempt-2',
          fence: 2,
          callId: EFFECT_CALL_ID,
          request: EFFECT_REQUEST,
        })).toThrow('STALE_FENCE')
      } finally {
        competingStore.close()
      }
      store.claim(EFFECT_MISSION_ID, 'pdv-attempt-4', 4)
      const recovered = await resumeAfterReceipt(root, store)
      expect(recovered.modelRequests).toBe(0)
      expect(recovered.operatorStatus).toMatchObject({
        workId: EFFECT_MISSION_ID,
        sessionId: EFFECT_SESSION_ID,
        durability: 'PERSISTED',
        effectPhase: 'RECOVERED',
        // Receipt reconciliation dispatches no model request, so the durable
        // route remains the provider/model that produced the effect intent.
        effect: {
          callId: EFFECT_CALL_ID,
          provider: 'pdv-effect',
          model: 'synthetic-v1',
          outcome: 'SUCCEEDED',
          receipt: { attemptId: 'pdv-attempt-4', fence: 4 },
        },
      })
      expect(recovered.receiptResult).toBe(initial.effects[0]?.result)
      expect(recovered.toolInvocations).toBe(0)
      // The first reconciliation appends its receipt after this lifecycle's
      // end-seed. One next resume seals that new durable seed; only then is the
      // session at the terminal fixed point measured by the ten-cycle proof.
      const settled = await resumeAfterReceipt(root, store)
      expect(settled.operatorStatus).toMatchObject({ durability: 'PERSISTED', effectPhase: 'RECOVERED' })
      expect(settled.events.at(-1)?.type).toBe('session/end-seed')
      const converged = store.snapshot()
      const convergedBytes = await readFile(databasePath)
      for (let cycle = 0; cycle < 10; cycle += 1) {
        const replay = await resumeAfterReceipt(root, store)
        expect(replay.modelRequests).toBe(0)
        expect(replay.receiptResult).toBe(recovered.receiptResult)
        expect(replay.toolInvocations).toBe(0)
        expect(replay.events).toEqual(settled.events)
        expect(replay.logBytes).toEqual(settled.logBytes)
      }
      expect(store.snapshot()).toEqual(converged)
      expect(await readFile(databasePath)).toEqual(convergedBytes)
    } finally {
      store.close()
    }
  }, RECOVERY_TEST_TIMEOUT_MS)
})
