/**
 * Settings → About → "Copy diagnostics" / "Share diagnostics": the local
 * log (redacted with the remote rules: names and paths hashed, no account,
 * no email) with an app-info header, for a problem report.
 */
import type { AppFacts } from './types';

export interface DiagnosticsInput {
  facts: AppFacts;
  installId: string | null;
  /** JSONL, newest last (`telemetry.exportText()`). */
  log: string;
  now?: number;
}

export function diagnosticsText(d: DiagnosticsInput): string {
  const header = [
    `theodore-mobile ${d.facts.app_version} (${d.facts.build_env}, ${d.facts.channel}, build ${d.facts.build})`,
    `${d.facts.platform} · ${d.facts.os} ${d.facts.os_version}`,
    `install ${d.installId ?? 'unknown'} · exported ${new Date(d.now ?? Date.now()).toISOString()}`,
    'Redacted on the device: no messages, titles, emails or tokens; names and paths hashed.',
    '',
  ];
  return `${header.join('\n')}${d.log}\n`;
}

/** How many records the text carries (its JSONL lines). */
export const recordCount = (log: string): number =>
  log ? log.split('\n').filter((l) => l.startsWith('{')).length : 0;
