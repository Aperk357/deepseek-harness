/** Package-owned invariant companion for the Nightwatch session projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-nightwatch-session'

/** Cordis companion plugin name. */
export const name = 'experimental-nightwatch-session-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']

/** No runtime invariant: projection schemas and session vocabulary owners enforce relations. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
