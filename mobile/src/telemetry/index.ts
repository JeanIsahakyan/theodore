/** Telemetry (docs/telemetry.md "Mobile"): the logger, product events,
 *  the sharing choice and what every sink reads. */
export { CATALOG, NEVER_SENT, catalogRows, type EventName } from './catalog';
export { useConsent, chosen, type Choice } from './consent';
export { log, newOpId, reportError, telemetry, track } from './log';
export type { AppFacts, Fields, TelemetryRecord } from './types';
