import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '../../src/index.ts'

export const EFFECT_SESSION_ID = SessionId('pdv-effect-recovery')
export const EFFECT_CALL_ID = ToolCallId('pdv-effect-call')
export const EFFECT_MISSION_ID = 'pdv-mission-1'
export const EFFECT_ATTEMPT_ID = 'pdv-attempt-1'
export const EFFECT_FENCE = 1
export const EFFECT_REQUEST = '{"operation":"synthetic-pdv-effect","value":1}'

type EffectRow = {
  mission_id: string
  tool_call_id: string
  submitted_attempt_id: string
  submitted_fence: number
  request_sha256: string
  result: string
}

type AuthorityRow = { mission_id: string; attempt_id: string; fence: number }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Test-only durable sink that models PDV idempotency and fencing around one external effect.
 * The mission/call receipt key deliberately survives lease attempts; submitted fields preserve
 * the effect author's epoch while current authority gates every apply and reconciliation read.
 */
export class PdvEffectStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS pdv_authority (
        mission_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK(fence > 0)
      );
      CREATE TABLE IF NOT EXISTS pdv_effects (
        mission_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        submitted_attempt_id TEXT NOT NULL,
        submitted_fence INTEGER NOT NULL,
        request_sha256 TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY(mission_id, tool_call_id)
      );
    `)
  }

  claim(missionId: string, attemptId: string, fence: number): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT mission_id, attempt_id, fence FROM pdv_authority WHERE mission_id = ?')
        .get(missionId) as AuthorityRow | undefined
      if (current === undefined) {
        this.db.prepare('INSERT INTO pdv_authority VALUES (?, ?, ?)').run(missionId, attemptId, fence)
        return
      }
      if (fence < current.fence || (fence === current.fence && attemptId !== current.attempt_id)) {
        throw new Error('STALE_FENCE')
      }
      if (fence > current.fence) {
        this.db.prepare('UPDATE pdv_authority SET attempt_id = ?, fence = ? WHERE mission_id = ?')
          .run(attemptId, fence, missionId)
      }
    })
  }

  apply(input: {
    missionId: string
    attemptId: string
    fence: number
    callId: string
    request: string
  }): { replayed: boolean; result: string } {
    return this.transaction(() => {
      const authority = this.db.prepare('SELECT mission_id, attempt_id, fence FROM pdv_authority WHERE mission_id = ?')
        .get(input.missionId) as AuthorityRow | undefined
      if (authority?.attempt_id !== input.attemptId || authority.fence !== input.fence) {
        throw new Error('STALE_FENCE')
      }
      const requestSha256 = sha256(input.request)
      const existing = this.db.prepare('SELECT mission_id, tool_call_id, submitted_attempt_id, submitted_fence, request_sha256, result FROM pdv_effects WHERE mission_id = ? AND tool_call_id = ?')
        .get(input.missionId, input.callId) as EffectRow | undefined
      if (existing !== undefined) {
        if (existing.submitted_fence > input.fence) throw new Error('FUTURE_RECEIPT')
        if (existing.request_sha256 !== requestSha256) throw new Error('IDEMPOTENCY_CONFLICT')
        return { replayed: true, result: existing.result }
      }
      const result = `effect:${requestSha256}`
      this.db.prepare('INSERT INTO pdv_effects VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.missionId, input.callId, input.attemptId, input.fence, requestSha256, result)
      return { replayed: false, result }
    })
  }

  reconcile(input: {
    missionId: string
    attemptId: string
    fence: number
    callId: string
    request: string
  }): { replayed: true; result: string } {
    const authority = this.db.prepare('SELECT mission_id, attempt_id, fence FROM pdv_authority WHERE mission_id = ?')
      .get(input.missionId) as AuthorityRow | undefined
    if (authority?.attempt_id !== input.attemptId || authority.fence !== input.fence) {
      throw new Error('STALE_FENCE')
    }
    const existing = this.db.prepare('SELECT mission_id, tool_call_id, submitted_attempt_id, submitted_fence, request_sha256, result FROM pdv_effects WHERE mission_id = ? AND tool_call_id = ?')
      .get(input.missionId, input.callId) as EffectRow | undefined
    if (existing === undefined) throw new Error('EFFECT_NOT_FOUND')
    if (existing.submitted_fence > input.fence) throw new Error('FUTURE_RECEIPT')
    if (existing.request_sha256 !== sha256(input.request)) throw new Error('IDEMPOTENCY_CONFLICT')
    return { replayed: true, result: existing.result }
  }

  snapshot(): { authority: AuthorityRow[]; effects: EffectRow[] } {
    const authority = this.db.prepare('SELECT mission_id, attempt_id, fence FROM pdv_authority ORDER BY mission_id').all() as AuthorityRow[]
    const effects = this.db.prepare('SELECT mission_id, tool_call_id, submitted_attempt_id, submitted_fence, request_sha256, result FROM pdv_effects ORDER BY mission_id, tool_call_id').all() as EffectRow[]
    return { authority, effects }
  }

  close(): void {
    this.db.close()
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function waitForCrash(): Promise<never> {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

class EffectAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: EFFECT_CALL_ID, name: 'pdv_effect', arguments: EFFECT_REQUEST },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function main(): Promise<void> {
  const [phase, root, marker] = process.argv.slice(2)
  if ((phase !== 'after-checkpoint' && phase !== 'after-effect') || root === undefined || marker === undefined) {
    throw new Error('usage: pdv-effect-child.ts <after-checkpoint|after-effect> <root> <marker>')
  }

  const store = new PdvEffectStore(resolve(root, 'pdv-effects.sqlite'))
  store.claim(EFFECT_MISSION_ID, EFFECT_ATTEMPT_ID, EFFECT_FENCE)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  ctx.llm.registerAdapter(['pdv-effect'], new EffectAdapter())
  ctx.tools.register({
    name: 'pdv_effect',
    description: 'records one synthetic PDV effect',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() {
      if (phase === 'after-checkpoint') {
        await writeFile(marker, 'checkpoint-passed')
        return waitForCrash()
      }
      store.apply({
        missionId: EFFECT_MISSION_ID,
        attemptId: EFFECT_ATTEMPT_ID,
        fence: EFFECT_FENCE,
        callId: EFFECT_CALL_ID,
        request: EFFECT_REQUEST,
      })
      await writeFile(marker, 'effect-committed')
      return waitForCrash()
    },
  })

  const handle = await ctx.agents.create({
    sessionId: EFFECT_SESSION_ID,
    agentOptions: { provider: 'pdv-effect', model: 'synthetic-v1' },
  })
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'exercise the PDV effect boundary' }],
    source: { kind: 'user' },
  }))
  await waitForCrash()
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
