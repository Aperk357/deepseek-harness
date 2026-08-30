/** Snapshot-only SDK composition that binds root work before its first model step. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { bindNightwatchMission } from '../../src/binding.ts'
import { NightwatchWorkId } from '../../src/brand.ts'

/** Fixture plugin name. */
export const name = 'nightwatch-sdk-binding-fixture'
/** Session persistence must be mounted before the fixture runs. */
export const inject = ['sessions']

/**
 * Bind each root SDK session before its first model-facing step.
 * @param ctx - assembled SDK runtime context.
 */
export function apply(ctx: Context): void {
  const bound = new WeakSet<object>()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.parentSession === undefined && !bound.has(agent.session)) {
      await bindNightwatchMission(ctx, agent.session, {
        workId: NightwatchWorkId('NIGHTWATCH-SDK-SNAPSHOT'),
        effectTool: 'nightwatch_snapshot_effect',
      })
      bound.add(agent.session)
    }
    return next()
  }, { global: true })
}
