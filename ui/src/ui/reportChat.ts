/**
 * Reporting a problem from a chat (docs/telemetry.md "Report from a chat"):
 * "Report this" under a reply and `/report …` in the composer, in a space's
 * chat and in the AI panel. Both ask the core to draft the report — the
 * same path an agent's `report_problem` tool takes — and the report window
 * opens on it. Nothing is sent from here.
 *
 * ```text
 * Report this ─┐
 * /report …  ──┴─▶ api.draftReport ─▶ ReportDraft ─▶ ui.openReport ─▶ window
 *                         └─ also as the `report_draft` event (agents' path)
 * ```
 */
import { api } from '../core/api';
import type { PrId } from '../gen/contract';
import type { RootStore } from '../stores/RootStore';

const COMMAND = /^\/report(?:\s+([\s\S]*))?$/;

/** What follows `/report` (maybe empty), when `text` is that command and
 *  no skill of yours is called `report`; else `null`, and it goes to the
 *  agent as typed. */
export function reportCommand(
  text: string,
  skills: readonly { id: string }[] = [],
): string | null {
  const m = COMMAND.exec(text.trim());
  if (!m || skills.some((s) => s.id === 'report')) return null;
  return (m[1] ?? '').trim();
}

/** Drafts a report about `chat` (a PR's id or a space's chat key) and opens
 *  the window on it: about `message`, or the chat's latest reply. A refusal
 *  is toasted by api.ts. */
export async function reportChat(
  store: RootStore,
  chat: PrId,
  message: string | null,
  description?: string,
): Promise<void> {
  try {
    const draft = await api.draftReport({
      chat,
      message,
      description: description || null,
    });
    store.ui.openReport(draft);
  } catch {
    // toasted by api.ts
  }
}
