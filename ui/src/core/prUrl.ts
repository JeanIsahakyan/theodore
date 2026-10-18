/** True for links/refs `open_pr` understands (GitHub, GitLab, owner/repo#n). */
export function looksLikePrUrl(text: string): boolean {
  const t = text.trim();
  return (
    /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(t) ||
    /^https?:\/\/gitlab\.com\/.+\/-\/merge_requests\/\d+/.test(t) ||
    /^[\w.-]+\/[\w.-]+#\d+$/.test(t)
  );
}
