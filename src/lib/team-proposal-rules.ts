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
 *   - the extractor's facts for an admin-group team change, as a command
 *     (`teamCommandFromFacts`);
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

/**
 * A team change asked for in the admin group. Not parsed from the text:
 * the shared pipeline reads the message (router `balancer`, then the
 * teams extractor) and `teamCommandFromFacts` turns its facts into this.
 */
export type TeamCommand =
  | { kind: "show" }
  | { kind: "reshuffle" }
  /** Two named players swap sides. */
  | { kind: "swap"; pairs: Array<[string, string]> }
  /** One named player to the other side, or to `to` when one is named. */
  | { kind: "move"; name: string; to?: "RED" | "YELLOW" };

/**
 * The teams extractor's facts for an admin-group message, as a command.
 * "unclear" when they name no usable change (a rename, which the admin
 * group does not do, or a swap with no players or too many): the caller
 * says so in one line.
 */
export function teamCommandFromFacts(facts: {
  action: "show" | "generate" | "rename" | "swap";
  swaps: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
  moves?: string[];
}): TeamCommand | { kind: "unclear" } {
  if (facts.action === "show") return { kind: "show" };
  if (facts.action === "generate") return { kind: "reshuffle" };
  if (facts.action === "rename") return { kind: "unclear" };
  const moves = (facts.moves ?? []).map((m) => m.trim()).filter(Boolean);
  const sided = facts.swaps.filter((x) => x.personRef.trim());
  if (moves.length === 2 && sided.length === 0) return { kind: "swap", pairs: [[moves[0], moves[1]]] };
  if (moves.length === 1 && sided.length === 0) return { kind: "move", name: moves[0] };
  if (moves.length === 0 && sided.length === 1) return { kind: "move", name: sided[0].personRef.trim(), to: sided[0].team };
  // Two players each put on a named side, one on each: the same as a swap.
  if (moves.length === 0 && sided.length === 2 && sided[0].team !== sided[1].team) {
    return { kind: "swap", pairs: [[sided[0].personRef.trim(), sided[1].personRef.trim()]] };
  }
  return { kind: "unclear" };
}

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

/**
 * The "Teams ready" time in force. An explicit setting (a time, or "off")
 * always wins. With none stored (NULL, every club until an organiser sets
 * it): 10:00 for a club whose organisers announce the list and teams
 * (`Organisation.listAnnouncer = "organisers"`, list-announcer.ts), Off
 * for a club MatchTime announces for, so no such club starts getting
 * proposals it never asked for.
 */
export function effectiveTeamsReadyTime(stored: string | null | undefined, organisersAnnounce: boolean): string {
  if (stored != null) return normaliseTeamsReadyTime(stored) ?? "off";
  return organisersAnnounce ? DEFAULT_TEAMS_READY_TIME : "off";
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

// ── Uneven sides ──────────────────────────────────────────────────────

/**
 * Are the sides uneven? (2026-10-14, the FNF rehearsal: `move A` left
 * 8 v 10 and YES finalised it silently.) An even total must split
 * exactly; an odd one may be one apart and no more. Counts are the
 * players still playing on each side.
 */
export function unevenSides(red: number, yellow: number): boolean {
  return Math.abs(red - yellow) > (red + yellow) % 2;
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
    const red = p.red.filter((x) => !x.out).length;
    const yellow = p.yellow.filter((x) => !x.out).length;
    if (unevenSides(red, yellow)) {
      blocks.push(s.tp_uneven({ redLabel: p.redLabel, red, yellowLabel: p.yellowLabel, yellow }));
    }
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
