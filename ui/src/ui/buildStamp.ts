import type { AppInfo } from '../gen/contract';

type Stamp = Pick<AppInfo, 'version' | 'commit' | 'build_env' | 'built_at'>;

/** The first 7 characters of the sha, keeping a `-dirty` mark. */
export function shortCommit(commit: string): string {
  const dirty = commit.endsWith('-dirty');
  const sha = dirty ? commit.slice(0, -'-dirty'.length) : commit;
  return `${sha.slice(0, 7)}${dirty ? '-dirty' : ''}`;
}

/** `0.0.1 · a1b2c3d · staging` (same as the core's `build_info::label`). */
export function buildLabel(info: Stamp): string {
  return `${info.version} · ${shortCommit(info.commit)} · ${info.build_env}`;
}

/** The build date as ISO 8601 UTC, or null when the stamp has none. */
export function builtAtIso(info: Stamp): string | null {
  return info.built_at > 0 ? new Date(info.built_at).toISOString() : null;
}

/** What "Copy" puts on the clipboard for a bug report. */
export function buildReport(info: Stamp): string {
  const built = builtAtIso(info);
  return [
    `Theodore ${buildLabel(info)}`,
    `commit ${info.commit}`,
    ...(built ? [`built ${built}`] : []),
  ].join('\n');
}
