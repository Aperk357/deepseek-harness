/** Package-owned invariant companion for the Nightwatch session projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyNightwatchHarnessEvent, nightwatchHarnessProjectionDefinition } from './projection.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-nightwatch-session'

/** Cordis companion plugin name. */
export const name = 'experimental-nightwatch-session-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']

/** Reject invalid Nightwatch event relationships before publication. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    try {
      const state = session.events.reduce(
        (current, event) => applyNightwatchHarnessEvent(current, event),
        nightwatchHarnessProjectionDefinition.init(),
      )
      /* v8 ignore next -- null and mismatch are covered by fold and late-load tests respectively. */
      if (state.projection !== null && state.projection.sessionId !== session.id) {
        throw new Error(`binding session "${state.projection.sessionId}" does not match "${session.id}"`)
      }
    } catch (error: unknown) {
      /* v8 ignore next -- strict folds throw Error instances. */
      const message = error instanceof Error ? error.message : String(error)
      fail(`cannot reconstruct session "${session.id}": ${message}`)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'nightwatch/mission-bound' && event.type !== 'nightwatch/effect-reconciled') return
    try {
      const state = session.events.reduce(
        (current, committed) => applyNightwatchHarnessEvent(current, committed),
        nightwatchHarnessProjectionDefinition.init(),
      )
      const next = applyNightwatchHarnessEvent(state, event)
      if (next.projection !== null && next.projection.sessionId !== session.id) {
        throw new Error(`binding session "${next.projection.sessionId}" does not match "${session.id}"`)
      }
    } catch (error: unknown) {
      /* v8 ignore next -- strict folds throw Error instances. */
      const message = error instanceof Error ? error.message : String(error)
      fail(`session event ${event.seq} violates the Nightwatch stream: ${message}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
