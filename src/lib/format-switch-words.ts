/**
 * ONE GAME SWITCHED TO ANOTHER SIZE BY WHATSAPP (2026-11-03, Kemal: every
 * admin feature also works by tagging MatchTime). "@Match Time make it 8
 * aside", "@Match Time 6 kişilik oynayalım", and an organiser's yes to
 * MatchTime's own suggestion to go up a size.
 *
 * The admin extractor (the model) reads the words into `switch_format`
 * facts: `size` as said, `aSide` when it counts one side, `matchDay` when a
 * day is named. Code turns that into players a side (`perSideOf`) and:
 *
 *   A YES TO THE SUGGESTION (a reply quoting MatchTime's post, review of
 *   #517): the quoted post is found by its WhatsApp id among the club's own
 *   suggestions (`<matchId>:format-up:<places>:e<n>`), and THAT match is
 *   switched to THAT size, never the next game and never the model's
 *   number. Only while the suggestion still holds: the match is still one
 *   size below it, this is its latest episode, and the bench still holds
 *   two who may be moved in. Otherwise one short line, nothing changed. A
 *   reply quoting any other post of MatchTime's, untagged, does nothing.
 *
 *   A TAGGED ASK: the next game, or the one on the day named, exactly as a
 *   cancel picks it. A size inside the game's range is switched by
 *   `format-resize.ts`; a size the range does not have but another of the
 *   club's formats does (Sutton: "switch to 5 a side", its own 5-a-side
 *   game and kickoff) goes through that existing switch
 *   (`activity-format-switch.ts`), as the switch page does.
 *
 * Organisers only: the callers check, as for every admin action.
 */
import { db } from "./db";
import { pickHqMatch } from "./match-cancel-rules";
import { resizeMatch } from "./format-resize";
import { flexFormatCopy } from "./i18n/flex-format";
import { normaliseLang } from "./i18n/lang";
import { weekdayLabel } from "./i18n/dates";
import { sameWhatsAppMessage } from "./quoted-message";
import { formatUpEpisode, parseFormatUpKey, playerRange, sideAllowed } from "./flex-format-rules";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

export interface SwitchWordsResult {
  outcome: string;
  /** Null: nothing is said (a reply that is not to a suggestion). */
  replyText: string | null;
}

export async function applySwitchFormatWords(p: {
  orgId: string;
  perSide: number;
  matchDay: string | null;
  actorUserId: string;
  via: string;
  lang: string | null;
  now: Date;
  /** The quoted post's WhatsApp id, when the message replies to MatchTime. */
  quotedId?: string | null;
  /** The real @-mention: a tagged ask stands on its own. */
  explicit?: boolean;
}): Promise<SwitchWordsResult> {
  const c = flexFormatCopy(p.lang);
  if (p.quotedId) {
    const yes = await answerSuggestion({ orgId: p.orgId, quotedId: p.quotedId, actorUserId: p.actorUserId, via: p.via, lang: p.lang, now: p.now });
    if (yes) return yes;
    if (p.explicit !== true) return { outcome: "format-not-a-suggestion", replyText: null };
  }

  const matches = await db.match.findMany({
    where: { activity: { orgId: p.orgId }, isHistorical: false, date: { gt: p.now } },
    select: { id: true, date: true, status: true },
  });
  const picked = pickHqMatch(matches, p.now, "cancel", p.matchDay, false);
  if (!picked) return { outcome: "format-no-match", replyText: c.noMatch };

  const other = await otherFormatWith(picked.id, p.perSide);
  if (other) {
    const { MonthlyGameStaysError, switchMatchToActivity } = await import("./activity-format-switch");
    let r: Awaited<ReturnType<typeof switchMatchToActivity>>;
    try {
      r = await switchMatchToActivity({ matchId: picked.id, newActivityId: other.id, actorUserId: p.actorUserId });
    } catch (err) {
      // A monthly club's game stays on its game (club summary B2, K8 a).
      if (err instanceof MonthlyGameStaysError) return { outcome: "format-monthly-keeps-game", replyText: err.message };
      throw err;
    }
    console.log(`[format-switch-words] org=${p.orgId} match=${picked.id} to the club's ${other.name} (${r.maxPlayers} places) by ${p.via}`);
    return {
      outcome: "format-switched-activity",
      replyText: c.activitySwitched({ day: weekdayLabel(normaliseLang(p.lang), r.kickoff), perSide: p.perSide, places: r.maxPlayers }),
    };
  }
  const r = await resizeMatch({ matchId: picked.id, perSide: p.perSide, actorUserId: p.actorUserId, via: p.via, now: p.now });
  return { outcome: r.outcome, replyText: r.replyText };
}

/**
 * Another of the club's games, same sport, with `perSide` a side, when the
 * match's own game's range does not have that size. Null otherwise (the
 * range has it, or there is none): the size switch decides.
 */
async function otherFormatWith(matchId: string, perSide: number): Promise<{ id: string; name: string } | null> {
  if (!(perSide > 0)) return null;
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { id: true, orgId: true, minPlayers: true, maxPlayers: true, sport: { select: { name: true, playersPerTeam: true } } } } },
  });
  if (!m) return null;
  const a = m.activity;
  if (sideAllowed(perSide, playerRange({ minPlayers: a.minPlayers ?? null, maxPlayers: a.maxPlayers ?? null, playersPerTeam: a.sport.playersPerTeam }))) return null;
  const family = a.sport.name.split(" ")[0];
  const acts = await db.activity.findMany({
    where: { orgId: a.orgId, id: { not: a.id } },
    select: { id: true, name: true, sport: { select: { name: true, playersPerTeam: true } } },
    orderBy: { createdAt: "asc" },
  });
  return acts.find((x) => x.sport.name.split(" ")[0] === family && x.sport.playersPerTeam === perSide) ?? null;
}

/**
 * An organiser's yes as a reply to MatchTime's suggestion. Null when the
 * quoted post is not one of this club's suggestions (the caller decides).
 */
async function answerSuggestion(p: {
  orgId: string;
  quotedId: string;
  actorUserId: string;
  via: string;
  lang: string | null;
  now: Date;
}): Promise<SwitchWordsResult | null> {
  const c = flexFormatCopy(p.lang);
  const rows = await db.sentNotification.findMany({
    where: { kind: "group-message", key: { contains: ":format-up:" }, match: { activity: { orgId: p.orgId } } },
    select: { key: true, matchId: true, waStanzaId: true, waMessageId: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const row = rows.find((r) => sameWhatsAppMessage(p.quotedId, r.waStanzaId ?? r.waMessageId) || sameWhatsAppMessage(p.quotedId, r.waMessageId));
  const sug = row ? parseFormatUpKey(row.key) : null;
  if (!row || !sug) return null;

  const match = await db.match.findUnique({
    where: { id: sug.matchId },
    select: { id: true, date: true, status: true, maxPlayers: true, attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } }, select: { userId: true, status: true } } },
  });
  const day = match ? weekdayLabel(normaliseLang(p.lang), match.date) : "";
  const stale = (): SwitchWordsResult => ({ outcome: "format-suggestion-stale", replyText: c.suggestionStale({ day, perSide: sug.places / 2 }) });
  if (!match || !LIVE.includes(match.status) || match.date.getTime() <= p.now.getTime()) return { outcome: "format-too-late", replyText: c.tooLate };
  // Still that suggestion: one size below it, its latest episode, a full
  // squad and two on the bench who may be moved in.
  const keys = (await db.sentNotification.findMany({ where: { matchId: match.id, key: { contains: ":format-up" } }, select: { key: true } })).map((r) => r.key);
  if (match.maxPlayers === sug.places) return { outcome: "format-unchanged", replyText: c.alreadyThat({ day, perSide: sug.places / 2 }) };
  if (match.maxPlayers + 2 !== sug.places || formatUpEpisode(keys, match.id) !== sug.episode) return stale();
  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED").length;
  const benchIds = match.attendances.filter((a) => a.status === "BENCH").map((a) => a.userId);
  const { loadChoseBench } = await import("./monthly-week");
  const chose = benchIds.length > 0 ? await loadChoseBench(db, match.id) : new Set<string>();
  if (confirmed < match.maxPlayers || benchIds.filter((u) => !chose.has(u)).length < 2) return stale();

  const r = await resizeMatch({ matchId: match.id, perSide: sug.places / 2, actorUserId: p.actorUserId, via: `${p.via}:suggestion`, now: p.now });
  return { outcome: r.outcome, replyText: r.replyText };
}
