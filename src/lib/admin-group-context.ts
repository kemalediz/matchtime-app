/**
 * THE LINES THE SHARED ROUTER IS SHOWN ABOVE AN ORGANISERS' GROUP MESSAGE
 * (2026-10-16). Pure, so the live check (`scripts/live-check-admin-group.ts`)
 * renders exactly what production sends without importing the database.
 * Built by `admin-group-understand.ts`; shown under the router's
 * `ORGANISERS_HEADER` (`pipeline/router.ts`).
 */
import { formatLondon } from "./london-time";
import type { HqLogRow } from "./admin-group-log";
import type { PendingItem, QuotedMessage } from "./admin-group-confirm-rules";
import { replyingToLine } from "./pipeline/router";

export interface PendingWithLabel extends PendingItem {
  /** The game's day, in the club's language, for teams and a partner ask. */
  day: string | null;
  /** A partner club's ask: the asking club's name. */
  club?: string | null;
  /** A free place question: who, joined, and whether it takes it away. */
  names?: string | null;
  undo?: boolean;
  askedAt: Date;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export function organisersContext(p: {
  pending: PendingWithLabel[];
  quoted: QuotedMessage | null;
  quotedIsMatchTime: boolean;
  recent: Array<Pick<HqLogRow, "fromMatchTime" | "text">>;
}): string[] {
  const lines: string[] = [];
  if (p.pending.length === 0) lines.push("WAITING: nothing.");
  for (const i of p.pending) {
    const at = formatLondon(i.askedAt, "HH:mm");
    lines.push(
      i.kind === "teams"
        ? `WAITING: approval of the proposed teams for ${i.day}, asked at ${at}.`
        : i.kind === "partner-ask"
          ? `WAITING: YES to post ${i.club}'s ask for a player in the players' group, for ${i.day}, asked at ${at}.`
          : i.kind === "fee"
            ? i.undo
              ? `WAITING: YES to take the free place away from ${i.names} for ${i.day}, asked at ${at}.`
              : `WAITING: YES to give ${i.names} a free place for ${i.day}, asked at ${at}.`
            : `WAITING: YES to apply the squad list pasted at ${at}.`,
    );
  }
  if (p.quoted?.text || p.quoted?.fromMatchTime) {
    lines.push(replyingToLine(p.quotedIsMatchTime ? "MatchTime" : "another organiser", p.quoted.text ?? ""));
  }
  if (p.recent.length > 0) {
    lines.push("EARLIER HERE, oldest first:");
    for (const r of p.recent) lines.push(`- ${r.fromMatchTime ? "MatchTime" : "an organiser"}: ${oneLine(r.text, 200)}`);
  }
  return lines;
}
