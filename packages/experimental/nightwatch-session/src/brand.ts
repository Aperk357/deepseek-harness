/** Opaque Nightwatch identifiers crossing the DSH boundary. */

import type { Branded } from '@deepseek-ai/dsh-brand'

export type NightwatchWorkId = Branded<'NightwatchWorkId'>
export type NightwatchAttemptId = Branded<'NightwatchAttemptId'>

export const NightwatchWorkId = (value: string): NightwatchWorkId => value as NightwatchWorkId
export const NightwatchAttemptId = (value: string): NightwatchAttemptId => value as NightwatchAttemptId
