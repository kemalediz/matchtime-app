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
import { messageMentionsBotExplicitly } from "./interaction-contract";

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

/**
 * The match score MatchTime is waiting to hear (2026-10-16,
 * `admin-group-score.ts`): the latest played match has no result, or
 * MatchTime asked which team won a scoreline.
 */
export type ScoreWaiting =
  /** `mom`: the organisers pick Man of the Match (mom-chooser.ts) and it is
   *  not recorded yet, so it is asked for with the score. */
  | { kind: "result"; day: string; labels: readonly [string, string]; mom?: boolean }
  /** The score is saved; the organisers' Man of the Match is not yet. */
  | { kind: "mom"; day: string }
  | { kind: "which-team"; first: number; second: number; labels: readonly [string, string]; askedAt: Date };

/**
 * What MatchTime is waiting for and what was said here lately. The message
 * an HQ reply quotes is NOT here: the router shows it right above the
 * message, in the one wording every reply reader shares
 * (`RouterMessage.reply`, slice S4; it replaced this file's
 * `REPLYING TO MatchTime | another organiser` line).
 */
export function organisersContext(p: {
  pending: PendingWithLabel[];
  recent: Array<Pick<HqLogRow, "fromMatchTime" | "text">>;
  score?: ScoreWaiting | null;
}): string[] {
  const lines: string[] = [];
  if (p.pending.length === 0 && !p.score) lines.push("WAITING: nothing.");
  if (p.score) {
    const w = p.score;
    lines.push(
      w.kind === "mom"
        ? `WAITING: the rest of ${w.day}'s result: who was Man of the Match.`
        : w.kind === "result"
          ? `WAITING: the final score of ${w.day}'s match, ${w.labels[0]} against ${w.labels[1]}${w.mom ? ", and its Man of the Match" : ""}.`
          : `WAITING: which team won ${w.first}-${w.second}, ${w.labels[0]} or ${w.labels[1]}, asked at ${formatLondon(w.askedAt, "HH:mm")}.`,
    );
  }
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
  if (p.recent.length > 0) {
    lines.push("EARLIER HERE, oldest first:");
    for (const r of p.recent) lines.push(`- ${r.fromMatchTime ? "MatchTime" : "an organiser"}: ${oneLine(r.text, 200)}`);
  }
  return lines;
}

/**
 * WHO AN HQ MESSAGE IS SAID TO (2026-10-17). Pure, so the live check
 * (`scripts/live-check-hq-chatter.ts`) decides exactly as production does.
 *
 *   tagged              an @tag of MatchTime (never the bare word, which is
 *                       talk ABOUT MatchTime)
 *   addressed           tagged, or a WhatsApp reply to MatchTime's own message
 *   toAnotherOrganiser  a reply to someone else's message, not tagged: the
 *                       organisers talking to each other (FNF HQ 2026-10-16,
 *                       "Imti Rafi AH back")
 */
export function hqAddressing(p: { text: string; quoted: QuotedMessage | null; quotedIsMatchTime: boolean }): {
  tagged: boolean;
  addressed: boolean;
  toAnotherOrganiser: boolean;
} {
  const tagged = messageMentionsBotExplicitly({ body: p.text });
  return { tagged, addressed: p.quotedIsMatchTime || tagged, toAnotherOrganiser: !!p.quoted && !p.quotedIsMatchTime && !tagged };
}
