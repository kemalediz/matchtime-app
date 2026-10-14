/**
 * TEAMS PROPOSED AND APPROVED IN A CLUB'S ADMIN GROUP (2026-10-14): the
 * pure half.
 *
 * Why: FNF wants MatchTime to pick balanced teams, but its admins reveal
 * the teams themselves, as a graphic, in another group. So the teams are
 * proposed to the admins in the club's admin group, changed there, and
 * approved there, and nothing is posted in the players' group.
 *
 * This module holds what needs no database and no model:
 *
 *   - the admin-group team commands, read as WHOLE messages, English and
 *     Turkish, deterministically (`parseTeamCommand`);
 *   - a typed name, placed on a player on the teams by the club's own
 *     rules (`resolveSheetName`, through `nameCandidates`);
 *   - when the "Teams ready" proposal and the reminder are due;
 *   - what changed in the teams since the admin group was last told;
 *   - every sentence, in the club's language.
 *
 * The impure half is `team-proposal.ts`.
 */
import { t } from "./i18n/t";
import { londonWallClockToUtc, formatLondon } from "./london-time";
import { nameCandidates } from "./admin-group-squad-rules";

// ── The commands ───────────────────────────────────────────────────────

export type TeamCommand =
  | { kind: "show" }
  | { kind: "reshuffle" }
  /** Every way to read the two names, the most likely first. */
  | { kind: "swap"; pairs: Array<[string, string]> }
  | { kind: "move"; name: string };

/** Longer than this is a conversation, not a command. */
const MAX_COMMAND_LENGTH = 80;

/** A command is never about more than this many words of names. */
const MAX_NAME_WORDS = 4;

/** Lower case, Turkish dotless i folded, accents gone: for the keywords only. */
function fold(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const SHOW = new Set(["teams", "team", "the teams", "show teams", "show the teams", "takimlar", "takimlari goster"]);
const RESHUFFLE = new Set([
  "reshuffle",
  "re-shuffle",
  "reshuffle teams",
  "reshuffle the teams",
  "shuffle",
  "new teams",
  "regenerate",
  "regenerate teams",
  "yeniden",
  "yeniden karistir",
  "karistir",
  "yeni takimlar",
]);

/** A name as typed: one to four words, letters in it, no digits. */
function nameOk(s: string): boolean {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= MAX_NAME_WORDS && /\p{L}/u.test(s) && !/\d/.test(s);
}

/** "Bilal'i", "Ali'yi", "Tom'u": the Turkish case ending, after an apostrophe. */
function stripTurkishSuffix(s: string): string {
  return s.replace(/['’](?:y)?[ıiuü]$/u, "").trim();
}

function swapPairs(rest: string): Array<[string, string]> | null {
  const sep = rest.split(/\s+(?:and|with|for|&|ve)\s+|\s*,\s*/i);
  if (sep.length === 2) {
    const [a, b] = sep.map((x) => x.trim());
    return a && b && nameOk(a) && nameOk(b) ? [[a, b]] : null;
  }
  if (sep.length > 2) return null;
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > MAX_NAME_WORDS * 2) return null;
  // "swap Ali and": half a command, not a player called "and".
  if (words.some((w) => /^(?:and|with|for|ve|ile|&)$/i.test(w))) return null;
  const pairs: Array<[string, string]> = [];
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    if (nameOk(a) && nameOk(b)) pairs.push([a, b]);
  }
  return pairs.length ? pairs : null;
}

/**
 * Is this whole message one of the admin-group team commands? Null when
 * it is anything else, so the message goes on to the readers after this
 * one (a pasted list, a squad change). No model, ever.
 *
 *   teams | takımlar                   show the teams (build them if none)
 *   reshuffle | yeniden                build new teams
 *   swap A B | swap A and B            swap two players between the teams
 *   A ile B değiş | değiş A B
 *   move A | A'yı taşı | A diğer takıma   move one player to the other team
 *
 * YES and EVET are not read here: `isAdminGroupYes` reads them.
 */
export function parseTeamCommand(text: string): TeamCommand | null {
  if (typeof text !== "string") return null;
  let s = text.replace(/\s+/g, " ").trim();
  if (!s || s.length > MAX_COMMAND_LENGTH || text.includes("\n")) return null;
  s = s.replace(/^@\s*match\s*time\b[,:]?\s*/i, "").replace(/[.!?]+$/, "").trim();
  if (!s) return null;
  const key = fold(s);

  if (SHOW.has(key)) return { kind: "show" };
  if (RESHUFFLE.has(key)) return { kind: "reshuffle" };

  // EN swap: "swap A B", "swap A and B".
  let m = /^swap\s+(.+)$/i.exec(s);
  if (m) {
    const pairs = swapPairs(m[1]);
    return pairs ? { kind: "swap", pairs } : null;
  }
  // TR swap: "A ile B değiş", "A ile B'yi değiştir", "A ile B yer değiştir".
  m = /^(.+?)\s+ile\s+(.+?)\s+(?:yer\s+)?de[gğ][iı][sş](?:t[iı]r)?$/iu.exec(s);
  if (m) {
    const a = m[1].trim();
    const b = stripTurkishSuffix(m[2]);
    return nameOk(a) && nameOk(b) ? { kind: "swap", pairs: [[a, b]] } : null;
  }
  // TR swap, verb first: "değiş A B".
  m = /^de[gğ][iı][sş](?:t[iı]r)?\s+(.+)$/iu.exec(s);
  if (m) {
    const pairs = swapPairs(m[1].replace(/\s+ile\s+/i, " and "));
    return pairs ? { kind: "swap", pairs } : null;
  }

  // EN move: "move A", "move A to the other team".
  m = /^move\s+(.+?)(?:\s+(?:to\s+)?(?:the\s+)?other\s+(?:team|side))?$/i.exec(s);
  if (m) return nameOk(m[1]) ? { kind: "move", name: m[1].trim() } : null;
  // TR move: "A'yı taşı", "taşı A", "A diğer takıma".
  m = /^(.+?)\s+ta[sş][ıi]$/iu.exec(s) ?? /^(.+?)\s+di[gğ]er\s+tak[ıi]ma(?:\s+ge[cç]sin)?$/iu.exec(s);
  if (m) {
    const name = stripTurkishSuffix(m[1]);
    return nameOk(name) ? { kind: "move", name } : null;
  }
  m = /^ta[sş][ıi]\s+(.+)$/iu.exec(s);
  if (m) return nameOk(m[1]) ? { kind: "move", name: m[1].trim() } : null;

  return null;
}

// ── A name, on the teams ───────────────────────────────────────────────

export interface SheetPlayer {
  userId: string;
  name: string;
  /** `UserAlias.alias` rows for this player in this club. */
  aliases: string[];
}

export type NameResolution = { kind: "one"; userId: string } | { kind: "ambiguous"; names: string[] } | { kind: "unknown" };

/**
 * Which player on the teams a typed name means, by the same rules a pasted
 * list uses (`nameCandidates`: the whole name, an alias, a first name).
 * Only the players on the teams are candidates, so "Ali" can be unique
 * here when the club has three.
 */
export function resolveSheetName(raw: string, players: SheetPlayer[]): NameResolution {
  const ids = nameCandidates(raw, players);
  if (ids.length === 1) return { kind: "one", userId: ids[0] };
  if (ids.length > 1) {
    const nameOf = new Map(players.map((p) => [p.userId, p.name]));
    return { kind: "ambiguous", names: ids.map((id) => nameOf.get(id) ?? "?") };
  }
  return { kind: "unknown" };
}

export type SwapResolution =
  | { kind: "ok"; a: string; b: string }
  | { kind: "problem"; problems: Array<{ raw: string; res: NameResolution }> };

/**
 * The first reading of "swap ..." where both names land on one player
 * each, and on two different players. When none does, the problems of
 * the reading that came closest (fewest problems, then the first).
 */
export function resolveSwap(pairs: Array<[string, string]>, players: SheetPlayer[]): SwapResolution {
  let best: Array<{ raw: string; res: NameResolution }> | null = null;
  for (const [ra, rb] of pairs) {
    const a = resolveSheetName(ra, players);
    const b = resolveSheetName(rb, players);
    if (a.kind === "one" && b.kind === "one" && a.userId !== b.userId) return { kind: "ok", a: a.userId, b: b.userId };
    const problems = [
      ...(a.kind === "one" ? [] : [{ raw: ra, res: a }]),
      ...(b.kind === "one" ? [] : [{ raw: rb, res: b }]),
    ];
    // The same player twice: say who the second name is.
    if (problems.length === 0) problems.push({ raw: rb, res: { kind: "unknown" } });
    if (!best || problems.length < best.length) best = problems;
  }
  return { kind: "problem", problems: best ?? [] };
}

// ── "Teams ready": the setting and the timing ─────────────────────────

/** The setting's default: 10:00 London on match day. */
export const DEFAULT_TEAMS_READY_TIME = "10:00";

/** One reminder in the admin group this long before kickoff, if nobody approved. */
export const REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

/** "HH:MM" (zero-padded) or "off"; null when it is neither. */
export function normaliseTeamsReadyTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "off") return "off";
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** The ready time on the match's own London day; null when off or invalid. */
export function teamsReadyAt(kickoff: Date, readyTime: string): Date | null {
  const time = normaliseTeamsReadyTime(readyTime);
  if (!time || time === "off") return null;
  return londonWallClockToUtc(kickoff, time);
}

/**
 * Is the "Teams ready" proposal due? From the ready time on match day
 * until kickoff. A ready time at or after kickoff never fires (the admins
 * can still type "teams").
 */
export function isProposalDue(p: { now: Date; kickoff: Date; readyTime: string }): boolean {
  const at = teamsReadyAt(p.kickoff, p.readyTime);
  if (!at || at.getTime() >= p.kickoff.getTime()) return false;
  return p.now.getTime() >= at.getTime() && p.now.getTime() < p.kickoff.getTime();
}

/** Is the one "not final yet" reminder due? Kickoff minus 2 hours until kickoff. */
export function isReminderDue(p: { now: Date; kickoff: Date }): boolean {
  const n = p.now.getTime();
  return n >= p.kickoff.getTime() - REMINDER_LEAD_MS && n < p.kickoff.getTime();
}

// ── Organisers announce ───────────────────────────────────────────────

/**
 * Do this club's organisers announce the teams themselves, so MatchTime
 * must never post them in the players' group?
 *
 * A LOCAL STAND-IN. Another change is adding the club setting "organisers
 * announce" (with a helper like `organisersAnnounce(org)`). Until it lands
 * this answers true for every club, which is the safe side: an approval
 * in the admin group posts nothing anywhere else. When the setting lands,
 * swap this body for the real helper; `team-proposal.ts` already does
 * the other branch (post the final teams in the players' group) when it
 * answers false, and its tests cover both.
 */
export function organisersAnnounce(_org: { id: string }): boolean {
  return true;
}

// ── The sheet, and what changed in it ─────────────────────────────────

export type SheetTeam = "RED" | "YELLOW";

/** One `TeamAssignment` row, with whether its holder is CONFIRMED. */
export interface SheetSlot {
  slotId: string;
  userId: string;
  team: SheetTeam;
  playing: boolean;
}

export type SheetChange =
  | { kind: "replaced"; team: SheetTeam; fromUserId: string; toUserId: string }
  | { kind: "moved"; team: SheetTeam; userId: string }
  | { kind: "out"; team: SheetTeam; userId: string }
  | { kind: "back"; team: SheetTeam; userId: string }
  | { kind: "removed"; team: SheetTeam; userId: string }
  | { kind: "added"; team: SheetTeam; userId: string };

/**
 * What changed between the sheet the admin group was told about and the
 * sheet now, slot by slot. A slot that changed hands is a replacement
 * (the inherited slot, `team-slot-fill.ts`); a holder no longer confirmed
 * is a place open. Removed slots come before added ones, each in sheet
 * order.
 */
export function diffSheets(before: SheetSlot[], after: SheetSlot[]): SheetChange[] {
  const out: SheetChange[] = [];
  const nowById = new Map(after.map((s) => [s.slotId, s]));
  const wasById = new Map(before.map((s) => [s.slotId, s]));
  const removed: SheetChange[] = [];
  const added: SheetChange[] = [];
  for (const was of before) {
    const now = nowById.get(was.slotId);
    if (!now) {
      removed.push({ kind: "removed", team: was.team, userId: was.userId });
      continue;
    }
    if (now.userId !== was.userId) {
      out.push({ kind: "replaced", team: now.team, fromUserId: was.userId, toUserId: now.userId });
      continue;
    }
    if (now.team !== was.team) out.push({ kind: "moved", team: now.team, userId: now.userId });
    if (was.playing && !now.playing) out.push({ kind: "out", team: now.team, userId: now.userId });
    if (!was.playing && now.playing) out.push({ kind: "back", team: now.team, userId: now.userId });
  }
  for (const now of after) if (!wasById.has(now.slotId)) added.push({ kind: "added", team: now.team, userId: now.userId });
  return [...out, ...removed, ...added];
}

// ── The words ─────────────────────────────────────────────────────────

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * The teams as the admin group sees them: a proposal (how to change them,
 * then YES) or the final teams. `announce`: the organisers announce the
 * teams themselves, so the YES line says MatchTime will not post them.
 */
export function buildTeamsText(p: {
  lang: string | null | undefined;
  final: boolean;
  announce: boolean;
  redLabel: string;
  yellowLabel: string;
  red: Array<{ name: string; out?: boolean }>;
  yellow: Array<{ name: string; out?: boolean }>;
  /** Confirmed players with no team. */
  unseated: string[];
  kickoff: string;
  venue: string;
}): string {
  const s = t(p.lang);
  const list = (arr: Array<{ name: string; out?: boolean }>) =>
    arr.map((x, i) => `${i + 1}. ${x.name}${x.out ? `  (${s.tp_note_out})` : ""}`).join("\n");
  const header = p.final
    ? s.tp_header_final({ kickoff: p.kickoff, venue: p.venue })
    : s.tp_header_proposed({ kickoff: p.kickoff, venue: p.venue });
  const blocks = [header, `*${p.redLabel}*:\n${list(p.red)}`, `*${p.yellowLabel}*:\n${list(p.yellow)}`];
  if (p.unseated.length > 0) blocks.push(s.tp_unseated({ names: p.unseated.join(", ") }));
  if (p.final) {
    blocks.push(s.tp_final_footer);
  } else {
    const a = firstName(p.red[0]?.name ?? "Ali");
    const b = firstName(p.yellow[0]?.name ?? "Bilal");
    blocks.push(`${s.tp_how_to_change({ a, b })}\n${p.announce ? s.tp_ask_yes_quiet : s.tp_ask_yes_post}`);
  }
  return blocks.join("\n\n");
}

export type ChangeItem =
  | { kind: "replaced"; team: string; from: string; to: string }
  | { kind: "moved" | "out" | "back" | "added" | "removed"; team: string; name: string };

/** After approval: what changed, then the teams as they stand. */
export function buildChangeNotice(p: { lang: string | null | undefined; items: ChangeItem[]; teamsText: string }): string {
  const s = t(p.lang);
  const items = p.items.map((c) => {
    switch (c.kind) {
      case "replaced":
        return s.tp_change_replaced({ to: c.to, from: c.from, team: c.team });
      case "moved":
        return s.tp_change_moved({ name: c.name, team: c.team });
      case "out":
        return s.tp_change_out({ name: c.name, team: c.team });
      case "back":
        return s.tp_change_back({ name: c.name, team: c.team });
      case "added":
        return s.tp_change_added({ name: c.name, team: c.team });
      case "removed":
        return s.tp_change_removed({ name: c.name, team: c.team });
    }
  });
  return `${s.tp_change_header}: ${items.join("; ")}.\n\n${p.teamsText}`;
}

/** A name that did not land on one player, in one sentence each. */
export function buildNameProblems(lang: string | null | undefined, problems: Array<{ raw: string; res: NameResolution }>): string {
  const s = t(lang);
  return problems
    .map((p) =>
      p.res.kind === "ambiguous"
        ? s.tp_name_ambiguous({ name: p.raw, names: p.res.names.join(", ") })
        : s.tp_name_unknown({ name: p.raw }),
    )
    .join(" ");
}

/** The reminder, kickoff minus 2 hours. */
export function buildReminderText(lang: string | null | undefined, kickoff: Date): string {
  return t(lang).tp_reminder({ kickoff: formatLondon(kickoff, "HH:mm") });
}
