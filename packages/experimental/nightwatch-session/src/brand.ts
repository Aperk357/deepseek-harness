/** Opaque Nightwatch identifiers crossing the DSH boundary. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for a Nightwatch work item. */
export type NightwatchWorkId = Branded<'NightwatchWorkId'>
/** Opaque identifier for one Nightwatch execution attempt. */
export type NightwatchAttemptId = Branded<'NightwatchAttemptId'>

/** Brand an untrusted work-item string after boundary validation. */
export const NightwatchWorkId = (value: string): NightwatchWorkId => value as NightwatchWorkId
/** Brand an untrusted attempt string after boundary validation. */
export const NightwatchAttemptId = (value: string): NightwatchAttemptId => value as NightwatchAttemptId
