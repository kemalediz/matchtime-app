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

/** A person the message puts on a named side. */
export interface SideRef {
  name: string;
  to: "RED" | "YELLOW";
}

/**
 * A team change asked for in the admin group. Not parsed from the text:
 * the shared pipeline reads the message (router `balancer`, then the
 * teams extractor) and `teamCommandFromFacts` turns its facts into this.
 *
 *   show       the teams as they stand (built first if none)
 *   reshuffle  new teams, keeping anyone put on a side or put together
 *   change     the teams as they stand, changed as asked, as ONE change
 *              (2026-10-29, FNF HQ: nine names, eight swaps on eight
 *              lines, "swap them over" were all "Which players?"):
 *                swapSides  every player changes side
 *                moves      these people change side, exactly as said
 *                sides      these people go to the side named
 *                together   each group ends up on one side
 *              `sides` and `together` move the fewest players and keep
 *              the sides even (`planTeamChange`).
 *   suggest    the one swap that evens the ratings most
 *   restore    an earlier set of teams back (2026-10-30, FNF HQ: "These
 *              are the final teams", replying to Tuesday's sheet): the
 *              teams of MatchTime's own sheet the message replies to, from
 *              the stored sheet, never read from the words
 *   set        the two sides written out in the message (a pasted sheet),
 *              as the teams extractor read them; code checks every fact
 *              before anything is written (`checkSheetFacts`)
 *
 * reshuffle, and show or a side or a pair with no teams yet, BUILD teams:
 * only when asked of MatchTime by fact, a tag or a reply to MatchTime
 * (Kemal, 2026-10-30), `handleTeamCommand`'s `addressed`.
 */
export type TeamCommand =
  | { kind: "show" }
  | { kind: "reshuffle"; sides: SideRef[]; together: string[][] }
  | { kind: "change"; swapSides: boolean; moves: string[]; sides: SideRef[]; together: string[][] }
  | { kind: "suggest" }
  | { kind: "restore" }
  | { kind: "set"; red: string[]; yellow: string[] };

/**
 * The teams extractor's facts for an admin-group message, as a command.
 * "unclear" when they name no usable change (a rename, which the admin
 * group does not do, or a change naming nobody): the caller says so in
 * one line. Any number of names is one change.
 */
export function teamCommandFromFacts(facts: {
  action: "show" | "generate" | "rename" | "swap" | "suggest" | "clear" | "restore" | "set";
  swaps: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
  moves?: string[];
  pairings?: string[][];
  swapSides?: boolean;
  sides?: { red: string[]; yellow: string[] };
}): TeamCommand | { kind: "unclear" } {
  const sides: SideRef[] = facts.swaps.map((x) => ({ name: x.personRef.trim(), to: x.team })).filter((x) => x.name);
  const together = (facts.pairings ?? []).map((g) => g.map((n) => n.trim()).filter(Boolean)).filter((g) => g.length >= 2);
  if (facts.action === "show") return { kind: "show" };
  if (facts.action === "suggest") return { kind: "suggest" };
  if (facts.action === "restore") return { kind: "restore" };
  if (facts.action === "set") {
    const clean = (xs: string[] | undefined) => (xs ?? []).map((n) => n.trim()).filter(Boolean);
    const red = clean(facts.sides?.red);
    const yellow = clean(facts.sides?.yellow);
    return red.length && yellow.length ? { kind: "set", red, yellow } : { kind: "unclear" };
  }
  if (facts.action === "generate") return { kind: "reshuffle", sides, together };
  // The organisers' group neither renames nor clears teams (2026-10-30:
  // "clear" is a players' group action, `team-clear.ts`).
  if (facts.action === "rename" || facts.action === "clear") return { kind: "unclear" };
  const moves = (facts.moves ?? []).map((m) => m.trim()).filter(Boolean);
  const swapSides = facts.swapSides === true;
  if (!swapSides && moves.length === 0 && sides.length === 0 && together.length === 0) return { kind: "unclear" };
  return { kind: "change", swapSides, moves, sides, together };
}

// ── Changing teams that exist ─────────────────────────────────────────

export interface TeamChangePlan {
  /** Every slot holder's side after the change. */
  team: Map<string, SheetTeam>;
  /** Who changes side because the message said so, in sheet order. */
  moved: string[];
  /** Who else changes side to keep the sides even, in the order chosen. */
  evenedBy: string[];
}

const other = (t: SheetTeam): SheetTeam => (t === "RED" ? "YELLOW" : "RED");

/**
 * One change to the teams as they stand (2026-10-29). In order:
 *
 *   1. `swapSides`: every player changes side;
 *   2. `moveIds`: these change side, exactly as said (an uneven result is
 *      the proposal's own warning, as for any move);
 *   3. `sides` and `together`: each named person is put on a side (a
 *      group goes to the side one of them is put on by name, else the side
 *      most of them are already on, else the first named one's), then,
 *      while the sides are uneven, the player not named anywhere whose
 *      move keeps the ratings closest goes from the bigger side to the
 *      smaller. Nobody out of the game is moved to even the sides.
 *
 * First instruction about a person wins. Pure: ratings come in.
 */
export function planTeamChange(p: {
  slots: SheetSlot[];
  swapSides?: boolean;
  moveIds?: string[];
  sides?: Array<{ userId: string; to: SheetTeam }>;
  together?: string[][];
  rating: (userId: string) => number;
}): TeamChangePlan {
  const start = new Map(p.slots.map((s) => [s.userId, s.team]));
  const team = new Map(start);
  if (p.swapSides) for (const [id, t] of team) team.set(id, other(t));
  const literal = new Set<string>();
  for (const id of p.moveIds ?? []) {
    if (!team.has(id) || literal.has(id)) continue;
    literal.add(id);
    team.set(id, other(team.get(id)!));
  }

  // Who is held where by `sides` and `together`.
  const held = new Map<string, SheetTeam>();
  for (const s of p.sides ?? []) if (team.has(s.userId) && !held.has(s.userId)) held.set(s.userId, s.to);
  const playing = new Set(p.slots.filter((s) => s.playing).map((s) => s.userId));
  for (const group of p.together ?? []) {
    const ids = group.filter((id) => team.has(id));
    if (ids.length < 2) continue;
    const named = ids.map((id) => held.get(id)).find((t): t is SheetTeam => !!t);
    let side = named;
    if (!side) {
      const on = (t: SheetTeam) => ids.filter((id) => team.get(id) === t).length;
      side = on("RED") > on("YELLOW") ? "RED" : on("YELLOW") > on("RED") ? "YELLOW" : team.get(ids[0])!;
    }
    for (const id of ids) if (!held.has(id)) held.set(id, side);
  }
  for (const [id, t] of held) team.set(id, t);

  // Even the sides again, only after a targeted change.
  const evenedBy: string[] = [];
  if (held.size > 0) {
    const fixed = new Set([...held.keys(), ...literal]);
    const n = (t: SheetTeam) => [...team].filter(([id, x]) => x === t && playing.has(id)).length;
    const sum = (t: SheetTeam) => [...team].filter(([id, x]) => x === t && playing.has(id)).reduce((a, [id]) => a + p.rating(id), 0);
    while (unevenSides(n("RED"), n("YELLOW"))) {
      const big: SheetTeam = n("RED") > n("YELLOW") ? "RED" : "YELLOW";
      const candidates = p.slots.filter((s) => team.get(s.userId) === big && playing.has(s.userId) && !fixed.has(s.userId));
      if (candidates.length === 0) break;
      const gapIf = (id: string) => {
        const r = p.rating(id);
        const red = sum("RED") + (big === "RED" ? -r : r);
        const yellow = sum("YELLOW") + (big === "YELLOW" ? -r : r);
        return Math.abs(red - yellow);
      };
      let best = candidates[0].userId;
      for (const c of candidates) if (gapIf(c.userId) < gapIf(best)) best = c.userId;
      team.set(best, other(big));
      fixed.add(best);
      evenedBy.push(best);
    }
  }
  const evened = new Set(evenedBy);
  const moved = p.slots.map((s) => s.userId).filter((id) => team.get(id) !== start.get(id) && !evened.has(id));
  return { team, moved, evenedBy };
}

/**
 * "Recommend swaps" (2026-10-29): the one swap of two players still
 * playing, one from each side, that brings the sides' rating totals
 * closest. Null when no swap makes them fairer than they are.
 */
export function bestSwap(slots: SheetSlot[], rating: (userId: string) => number): { red: string; yellow: string } | null {
  const on = (t: SheetTeam) => slots.filter((s) => s.team === t && s.playing).map((s) => s.userId);
  const red = on("RED");
  const yellow = on("YELLOW");
  const total = (ids: string[]) => ids.reduce((a, id) => a + rating(id), 0);
  const gap = total(red) - total(yellow);
  let best: { red: string; yellow: string } | null = null;
  let bestGap = Math.abs(gap) - 0.05;
  for (const r of red) {
    for (const y of yellow) {
      const g = Math.abs(gap - 2 * (rating(r) - rating(y)));
      if (g < bestGap) {
        bestGap = g;
        best = { red: r, yellow: y };
      }
    }
  }
  return best;
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

/** A name that did not land on one player, in one sentence each. Named
 *  against the teams, or (a pasted sheet) against the squad. */
export function buildNameProblems(
  lang: string | null | undefined,
  problems: Array<{ raw: string; res: NameResolution }>,
  where: "teams" | "squad" = "teams",
): string {
  const s = t(lang);
  return problems
    .map((p) =>
      p.res.kind === "ambiguous"
        ? s.tp_name_ambiguous({ name: p.raw, names: p.res.names.join(", ") })
        : where === "squad"
          ? s.tp_name_unknown_squad({ name: p.raw })
          : s.tp_name_unknown({ name: p.raw }),
    )
    .join(" ");
}

// ── A whole sheet set at once (2026-10-30) ───────────────────────────

/** One player's side on a stored or pasted sheet. */
export interface SheetSide {
  userId: string;
  team: SheetTeam;
}

/** The same players on the same sides, in any order. */
export function sameSheet(a: readonly SheetSide[], b: readonly SheetSide[]): boolean {
  if (a.length !== b.length) return false;
  const side = new Map(a.map((x) => [x.userId, x.team]));
  return side.size === a.length && b.every((x) => side.get(x.userId) === x.team);
}

/**
 * THE FACTS A WHOLE SHEET MUST MEET before it becomes the teams (an earlier
 * sheet brought back, or one pasted): every player on it is in the squad
 * now, every confirmed player is on a side, and the sides are even
 * (`unevenSides`: an odd squad may be one apart). Pure: ids only.
 */
export function checkSheetFacts(p: {
  target: ReadonlyMap<string, SheetTeam>;
  confirmedIds: readonly string[];
}):
  | { ok: true }
  | { ok: false; notPlaying: string[]; missing: string[]; uneven: { red: number; yellow: number } | null } {
  const confirmed = new Set(p.confirmedIds);
  const notPlaying = [...p.target.keys()].filter((id) => !confirmed.has(id));
  const missing = p.confirmedIds.filter((id) => !p.target.has(id));
  const n = (team: SheetTeam) => [...p.target.values()].filter((x) => x === team).length;
  const red = n("RED");
  const yellow = n("YELLOW");
  const uneven = notPlaying.length === 0 && missing.length === 0 && unevenSides(red, yellow) ? { red, yellow } : null;
  if (notPlaying.length === 0 && missing.length === 0 && !uneven) return { ok: true };
  return { ok: false, notPlaying, missing, uneven };
}

/** The reminder, kickoff minus 2 hours. */
export function buildReminderText(lang: string | null | undefined, kickoff: Date): string {
  return t(lang).tp_reminder({ kickoff: formatLondon(kickoff, "HH:mm") });
}
