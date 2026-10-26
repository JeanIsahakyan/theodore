import type { HostKind } from '../gen/contract';

/** The host of a link/ref `open_pr` understands (GitHub, GitLab, Bitbucket;
 *  `owner/repo#n` is GitHub), or `null` for anything else. */
export function prUrlHost(text: string): HostKind | null {
  const t = text.trim();
  if (/^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(t)) {
    return 'github';
  }
  if (/^https?:\/\/gitlab\.com\/.+\/-\/merge_requests\/\d+/.test(t)) {
    return 'gitlab';
  }
  if (
    /^https?:\/\/bitbucket\.org\/[^/\s]+\/[^/\s]+\/pull-requests\/\d+/.test(t)
  ) {
    return 'bitbucket';
  }
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(t)) return 'github';
  return null;
}

/** True for links/refs `open_pr` understands, on a host `hostOn` allows
 *  (Settings → Labs keeps GitLab and Bitbucket off by default). */
export function looksLikePrUrl(
  text: string,
  hostOn: (host: HostKind) => boolean = () => true,
): boolean {
  const host = prUrlHost(text);
  return host !== null && hostOn(host);
}
