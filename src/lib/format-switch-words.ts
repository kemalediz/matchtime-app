/**
 * ONE GAME SWITCHED TO ANOTHER SIZE BY WHATSAPP (2026-11-03, Kemal: every
 * admin feature also works by tagging MatchTime). "@Match Time make it 8
 * aside", "@Match Time 6 kişilik oynayalım", and an organiser's yes to
 * MatchTime's own suggestion to go up a size.
 *
 * The admin extractor (the model) reads the words into `switch_format`
 * facts: `size` as said, `aSide` when it counts one side, `matchDay` when a
 * day is named. Code turns that into players a side, picks the game (the
 * next one, or the one on the day named, exactly as a cancel does) and
 * switches it through the one core (`format-resize.ts`).
 *
 * Organisers only: the callers check, as for every admin action.
 */
import { db } from "./db";
import { pickHqMatch } from "./match-cancel-rules";
import { resizeMatch, type ResizeOutcome } from "./format-resize";
import { flexFormatCopy } from "./i18n/flex-format";

export async function applySwitchFormatWords(p: {
  orgId: string;
  perSide: number;
  matchDay: string | null;
  actorUserId: string;
  via: string;
  lang: string | null;
  now: Date;
}): Promise<{ outcome: ResizeOutcome; replyText: string }> {
  const matches = await db.match.findMany({
    where: { activity: { orgId: p.orgId }, isHistorical: false, date: { gt: p.now } },
    select: { id: true, date: true, status: true },
  });
  const match = pickHqMatch(matches, p.now, "cancel", p.matchDay, false);
  if (!match) return { outcome: "format-no-match", replyText: flexFormatCopy(p.lang).noMatch };
  const r = await resizeMatch({ matchId: match.id, perSide: p.perSide, actorUserId: p.actorUserId, via: p.via, now: p.now });
  return { outcome: r.outcome, replyText: r.replyText };
}
