/** Registers the Nightwatch-bound Harness operator projection. */

import type { Context } from '@deepseek-ai/cordis'
import { nightwatchHarnessProjectionDefinition } from './projection.ts'

export { projectNightwatchHarness } from './projection.ts'
export { NightwatchAttemptId, NightwatchWorkId } from './brand.ts'
export type { NightwatchAttemptId as NightwatchAttemptIdType, NightwatchWorkId as NightwatchWorkIdType } from './brand.ts'

export type * from './types.ts'
export {
  bindNightwatchMission,
  recordNightwatchReconciliation,
  type BindNightwatchMissionInput,
  type RecordNightwatchReconciliationInput,
} from './binding.ts'

/** Cordis plugin name. */
export const name = 'experimental-nightwatch-session'
/** The projection registry drives and serves this package's fold. */
export const inject = ['sessionProjections']

/**
 * Register the Nightwatch Harness projection unit.
 * @param ctx - Cordis context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(nightwatchHarnessProjectionDefinition)
}
