/**
 * TEAMS PROPOSED AND APPROVED IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * Why: FNF wants MatchTime to pick balanced teams, but its admins reveal
 * the teams themselves, as a graphic, in another group. So the teams are
 * proposed to the admins in the club's linked admin group, changed there,
 * and approved there.
 *
 * WHAT ADMINS ASK in the admin group, in their own words, English or
 * Turkish (2026-10-16): read by the SHARED pipeline, the router's
 * `balancer` route and the teams extractor, in `admin-group-understand.ts`,
 * which hands this file a `TeamCommand`:
 *
 *   show       the teams as they stand; built first if none
 *   reshuffle  build new teams (asks for YES again), keeping anyone put
 *              on a side or put together
 *   change     the teams as they stand, as ONE change with any number of
 *              names (2026-10-29): people change side as said, the two
 *              teams swap over, or people go to a side or together, which
 *              moves the fewest players and keeps the sides even (the one
 *              sent back is the one that keeps the ratings closest); with
 *              no teams yet, a side or a pair is a build that keeps them
 *   suggest    "Recommend swaps": the swap that evens the ratings most,
 *              made on proposed teams (YES still needed), only said on
 *              final ones
 *
 * A YES that approves them goes through the safe-YES rule first
 * (`admin-group-confirm-rules.ts`), then `answerTeamsYes`.
 *
 * Every change reposts the teams in the admin group. Names are placed on
 * the players on the teams by the club's own rules (`nameCandidates`); an
 * unknown or ambiguous name gets one short line and changes nothing, the
 * rest of the same change included.
 *
 * "TEAMS READY". A club setting, a London time on match day or "off";
 * not set, it is 10:00 when the organisers announce the list and teams
 * and off otherwise. From that time until kickoff the due-posts poll
 * (`teamProposalJobs`, one hook in `bot-scheduler.ts`) builds the teams,
 * once, with the shared generator, if the squad is full enough to balance
 * (the balancer's own minimum, two full sides), and posts the proposal in
 * the admin group. Nobody approved by kickoff minus 2 hours: one reminder.
 * After approval, a change in the teams (a drop-out, a replacement
 * inheriting the dropped player's slot through `team-slot-fill.ts`, a
 * change on the website) is told to the admin group once.
 *
 * ONE QUESTION AT A TIME (decided 2026-10-14). Teams and a pasted list
 * are never both waiting for YES:
 *
 *   - posting teams for approval supersedes a pasted squad list still
 *     waiting for YES (the reply says the list was not applied);
 *   - a pasted list asked about after the teams sets the teams aside, so
 *     the next YES applies the list, never the teams (the reply says the
 *     teams still need approving; "teams" asks again).
 *
 * The reply to every YES names what it did ("Teams are final." or
 * "Done: ..." for a list). A pick round's own YES (organiser pick) is read
 * before both, as it always was.
 *
 * NOTHING IN THE PLAYERS' GROUP while the organisers announce the list and
 * teams (`Organisation.listAnnouncer = "organisers"`, list-announcer.ts,
 * read through `loadOrganisersAnnounce`). When they do not,
 * YES posts the final teams in the players' group, once. Nothing here ever
 * posts in the players' group on its own initiative.
 *
 * NO AUTHORISATION LIVES HERE. `admin-group.ts` proves the sender is an
 * owner or admin of the club first; the scheduler acts for the club.
 * Logs carry ids and counts only.
 */
import { db } from "./db";
import { generateTeamsForMatch, matchRatingsFor, type GenerateTeamsOptions, type GenerateTeamsResult } from "./team-generation";
import { formatTeamsPost } from "./group-copy";
import { resolveTeamLabels } from "./team-labels";
import { formatLondon } from "./london-time";
import { selectRegistrationMatch } from "./registration-match-select";
import { lockTeamSlots, type SlotFillTx } from "./team-slot-fill";
import { isBillingPaused } from "./club-billing-rules";
import { organisersAnnounce } from "./list-announcer";
import { loadOrganisersAnnounce } from "./list-announcer-store";
import { redrawTeamSheet, sendGraphicToAdminChannel } from "./admin-group-graphics";
import { t } from "./i18n/t";
import {
  bestSwap,
  buildChangeNotice,
  buildNameProblems,
  buildReminderText,
  buildTeamsText,
  diffSheets,
  isProposalDue,
  isReminderDue,
  effectiveTeamsReadyTime,
  planTeamChange,
  resolveSheetName,
  resolveSwap,
  unevenSides,
  type ChangeItem,
  type NameResolution,
  type SheetPlayer,
  type SheetSlot,
  type SheetTeam,
  type TeamCommand,
} from "./team-proposal-rules";
import { recordMatchTimeQuestion, teamsAskRef } from "./admin-group-log";

export interface TeamProposalDeps {
  /** The shared generator. Injected in tests only. */
  generate?: (matchId: string, opts: GenerateTeamsOptions) => Promise<GenerateTeamsResult>;
  /** The rating each player is balanced on (`matchRatingsFor`). Injected in tests only. */
  ratings?: (matchId: string, orgId: string, userIds: string[]) => Promise<Map<string, number>>;
  /** Do the organisers announce the teams themselves? */
  announce?: (org: { id: string }) => boolean | Promise<boolean>;
}

export type TeamReplyOutcome =
  | "teams-shown"
  | "teams-built"
  | "teams-not-built"
  | "teams-no-match"
  | "teams-no-teams"
  | "teams-swapped"
  | "teams-moved"
  | "teams-name-unclear"
  | "teams-same-team"
  | "teams-already-there"
  | "teams-uneven"
  | "teams-changed"
  | "teams-unchanged"
  | "teams-suggested"
  | "teams-suggested-final"
  | "teams-suggest-none"
  | "teams-final";

export interface TeamReply {
  outcome: TeamReplyOutcome;
  replyText: string;
}

const ACTIVE: Array<"UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED"> = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

const gen = (deps: TeamProposalDeps | undefined) =>
  deps?.generate ?? ((id: string, opts: GenerateTeamsOptions) => generateTeamsForMatch(id, opts));
const ratingsOf = (deps: TeamProposalDeps | undefined) => deps?.ratings ?? matchRatingsFor;
const announces = async (deps: TeamProposalDeps | undefined, orgId: string): Promise<boolean> =>
  deps?.announce ? deps.announce({ id: orgId }) : loadOrganisersAnnounce(orgId);

// ── Reading the match and its teams ───────────────────────────────────

interface MatchRow {
  id: string;
  activityId: string;
  date: Date;
  status: string;
  teamLabels?: string[] | null;
}

async function activeMatches(orgId: string): Promise<MatchRow[]> {
  const activities = await db.activity.findMany({ where: { orgId }, select: { id: true } });
  if (activities.length === 0) return [];
  return (await db.match.findMany({
    where: { activityId: { in: activities.map((a) => a.id) }, status: { in: ACTIVE } },
    orderBy: { date: "asc" },
  })) as unknown as MatchRow[];
}

/** The match the admin group's commands are about: the club's registration match. */
async function commandMatch(orgId: string, now: Date): Promise<MatchRow | null> {
  return selectRegistrationMatch(await activeMatches(orgId), now) ?? null;
}

interface Sheet {
  match: MatchRow;
  orgId: string;
  slots: SheetSlot[];
  players: SheetPlayer[];
  nameOf: Map<string, string>;
  /** Confirmed players with no team. */
  unseatedIds: string[];
  /** Every confirmed player, on the teams or not: who a build can name. */
  squad: SheetPlayer[];
  labels: [string, string];
  kickoff: string;
  venue: string;
  perTeam: number;
  confirmed: number;
}

async function loadSheet(match: MatchRow, lang: string | null | undefined, extraUserIds: string[] = []): Promise<Sheet> {
  const activity = (await db.activity.findUnique({ where: { id: match.activityId } })) as unknown as {
    orgId: string;
    sportId: string;
    venue: string;
  };
  const [org, sport, rows, attendance] = await Promise.all([
    db.organisation.findUnique({ where: { id: activity.orgId } }),
    db.sport.findUnique({ where: { id: activity.sportId } }),
    db.teamAssignment.findMany({ where: { matchId: match.id }, orderBy: { id: "asc" } }),
    db.attendance.findMany({ where: { matchId: match.id } }),
  ]);
  const confirmedIds = new Set(attendance.filter((a) => a.status === "CONFIRMED").map((a) => a.userId));
  const slots: SheetSlot[] = rows.map((r) => ({
    slotId: r.id,
    userId: r.userId,
    team: r.team as SheetTeam,
    playing: confirmedIds.has(r.userId),
  }));
  const seated = new Set(slots.map((s) => s.userId));
  const unseatedIds = [...confirmedIds].filter((id) => !seated.has(id));
  const ids = [...new Set([...slots.map((s) => s.userId), ...unseatedIds, ...extraUserIds])];
  const [users, aliases] = await Promise.all([
    ids.length ? db.user.findMany({ where: { id: { in: ids } } }) : Promise.resolve([]),
    ids.length ? db.userAlias.findMany({ where: { orgId: activity.orgId, userId: { in: ids } } }) : Promise.resolve([]),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? "?"]));
  const asPlayer = (userId: string): SheetPlayer => ({
    userId,
    name: nameOf.get(userId) ?? "?",
    aliases: aliases.filter((a) => a.userId === userId).map((a) => a.alias),
  });
  const players: SheetPlayer[] = slots.map((s) => asPlayer(s.userId));
  const squad: SheetPlayer[] = [...confirmedIds].map(asPlayer);
  return {
    match,
    orgId: activity.orgId,
    slots,
    players,
    nameOf,
    unseatedIds,
    squad,
    labels: resolveTeamLabels(match, org, sport, lang),
    kickoff: formatLondon(match.date, "HH:mm"),
    venue: activity.venue,
    perTeam: sport?.playersPerTeam ?? 0,
    confirmed: confirmedIds.size,
  };
}

function teamsText(sheet: Sheet, lang: string | null | undefined, final: boolean, announce: boolean): string {
  const side = (team: SheetTeam) =>
    sheet.slots.filter((s) => s.team === team).map((s) => ({ name: sheet.nameOf.get(s.userId) ?? "?", out: !s.playing }));
  return buildTeamsText({
    lang,
    final,
    announce,
    redLabel: sheet.labels[0],
    yellowLabel: sheet.labels[1],
    red: side("RED"),
    yellow: side("YELLOW"),
    unseated: sheet.unseatedIds.map((id) => sheet.nameOf.get(id) ?? "?"),
    kickoff: sheet.kickoff,
    venue: sheet.venue,
  });
}

/** Too few confirmed to balance: the balancer's own minimum, two full sides. */
const neededFor = (sheet: Sheet) => sheet.perTeam * 2;
const isShort = (sheet: Sheet) => sheet.confirmed < neededFor(sheet);

function shortSquadText(sheet: Sheet, lang: string | null | undefined): string {
  return t(lang).tp_short_squad({ kickoff: sheet.kickoff, confirmed: sheet.confirmed, needed: neededFor(sheet) });
}

/** Players still playing on each side of the sheet. */
function sideCounts(sheet: Sheet): { red: number; yellow: number } {
  const n = (team: SheetTeam) => sheet.slots.filter((x) => x.team === team && x.playing).length;
  return { red: n("RED"), yellow: n("YELLOW") };
}

// ── The proposal row ──────────────────────────────────────────────────

/**
 * The states in which the teams are the question waiting for YES:
 * "proposed", and "uneven-asked" (the sides were uneven and the first YES
 * was answered with a warning; the next YES makes them final). Any change
 * reposts them and goes back to "proposed".
 */
const WAITING = ["proposed", "uneven-asked"];

interface ProposalRow {
  id: string;
  orgId: string;
  matchId: string;
  state: string;
  askedAt: Date;
  approvedAt: Date | null;
  toldSheet: unknown;
  remindedAt: Date | null;
  updatedAt: Date;
}

/**
 * The teams are now the question in the admin group: the proposal is
 * (re)opened, and a pasted list still waiting for YES is superseded. True
 * when a live list was superseded, so the reply can say so.
 */
async function askAboutTeams(orgId: string, matchId: string, now: Date): Promise<boolean> {
  const liveLists = await db.adminSquadProposal.count({ where: { orgId, resolvedAt: null, expiresAt: { gte: now } } });
  await db.adminSquadProposal.updateMany({ where: { orgId, resolvedAt: null }, data: { resolvedAt: now, outcome: "superseded" } });
  await db.adminTeamProposal.upsert({
    where: { matchId },
    create: { orgId, matchId, state: "proposed", askedAt: now },
    update: { state: "proposed", askedAt: now, approvedAt: null, approvedByUserId: null },
  });
  return liveLists > 0;
}

/** The proposal text, with the "list not applied" line when one was
 *  superseded. Recorded as MatchTime's question about these teams, so a
 *  YES that follows it (or quotes it) is known to be about them
 *  (`admin-group-confirm-rules.ts`). */
async function propose(sheet: Sheet, lang: string | null | undefined, now: Date, announce: boolean): Promise<string> {
  const superseded = await askAboutTeams(sheet.orgId, sheet.match.id, now);
  const text = teamsText(sheet, lang, false, announce);
  const out = superseded ? `${t(lang).tp_list_superseded}\n\n${text}` : text;
  await recordMatchTimeQuestion({ orgId: sheet.orgId, askRef: teamsAskRef(sheet.match.id), text: out, now });
  return out;
}

/**
 * A pasted squad list was just asked about in the admin group: the teams
 * waiting for YES (if any) are set aside, so the next YES applies the
 * list. Returns how many were set aside (0 or 1).
 */
export async function setAsideTeamProposal(orgId: string): Promise<number> {
  const res = await db.adminTeamProposal.updateMany({ where: { orgId, state: { in: WAITING } }, data: { state: "set-aside" } });
  return res.count;
}

// ── The commands ──────────────────────────────────────────────────────

/** "me" is the sender; anything else by the club's own name rules. */
function resolveName(raw: string, players: SheetPlayer[], senderUserId: string): NameResolution {
  if (raw.trim().toLowerCase() === "me") {
    return players.some((p) => p.userId === senderUserId) ? { kind: "one", userId: senderUserId } : { kind: "unknown" };
  }
  return resolveSheetName(raw, players);
}

/**
 * Every name of one change, resolved before anything is written. Any name
 * that does not land on one player fails the whole change (2026-10-29).
 */
function resolveAll(
  raws: string[],
  players: SheetPlayer[],
  senderUserId: string,
): { ok: true; ids: string[] } | { ok: false; problems: Array<{ raw: string; res: NameResolution }> } {
  const ids: string[] = [];
  const problems: Array<{ raw: string; res: NameResolution }> = [];
  for (const raw of raws) {
    const res = resolveName(raw, players, senderUserId);
    if (res.kind === "one") ids.push(res.userId);
    else if (!problems.some((p) => p.raw === raw)) problems.push({ raw, res });
  }
  return problems.length ? { ok: false, problems } : { ok: true, ids };
}

/**
 * The generator's pins for new teams: each person put on a side, then each
 * group put together on the side one of them was put on, else Red (the
 * colour means nothing; the players' group pins a pairing the same way,
 * `pipeline/engine.ts`). First instruction about a person wins.
 */
function pinsFor(
  sides: Array<{ ids: string[]; to: SheetTeam }>,
  together: string[][],
): Record<string, SheetTeam> {
  const pins: Record<string, SheetTeam> = {};
  for (const s of sides) for (const id of s.ids) pins[id] ??= s.to;
  for (const group of together) {
    if (new Set(group).size < 2) continue;
    const side = group.map((id) => pins[id]).find((t): t is SheetTeam => !!t) ?? "RED";
    for (const id of group) pins[id] ??= side;
  }
  return pins;
}

/**
 * One team change asked for in the admin group by a proven owner or
 * admin, as the shared pipeline read it (the router's `balancer` route,
 * then the teams extractor: `admin-group-understand.ts`).
 */
export async function handleTeamCommand(args: {
  orgId: string;
  lang: string | null | undefined;
  command: TeamCommand;
  senderUserId: string;
  messageId: string;
  now: Date;
  deps?: TeamProposalDeps;
}): Promise<TeamReply> {
  const { orgId, lang, now, deps, command } = args;
  const s = t(lang);
  const announce = await announces(deps, orgId);

  const match = await commandMatch(orgId, now);
  if (!match) return { outcome: "teams-no-match", replyText: s.tp_no_match };

  const build = async (pins: Record<string, SheetTeam> = {}): Promise<TeamReply> => {
    const res = await gen(deps)(match.id, Object.keys(pins).length ? { pinnedToTeam: pins } : {});
    if (!res.ok) {
      console.log(`[team-proposal] ${args.messageId}: teams not built on match ${match.id}`);
      // A whole sentence, never the generator's bare fragment: the count
      // and what to do when the squad is short, else the reason wrapped
      // as the players' group gets it (`balancer_refusal`).
      const now = await loadSheet(match, lang);
      const replyText = isShort(now) ? shortSquadText(now, lang) : s.balancer_refusal({ reason: res.reason });
      return { outcome: "teams-not-built", replyText };
    }
    const fresh = (await db.match.findUnique({ where: { id: match.id } })) as unknown as MatchRow;
    const sheet = await loadSheet(fresh ?? match, lang);
    console.log(
      `[team-proposal] ${args.messageId}: teams built on match ${match.id}, ${sheet.slots.length} on the teams, ${Object.keys(pins).length} pinned`,
    );
    return { outcome: "teams-built", replyText: await propose(sheet, lang, now, announce) };
  };

  const sheet = await loadSheet(match, lang);
  const final = match.status === "TEAMS_PUBLISHED";
  const label = (team: SheetTeam) => (team === "RED" ? sheet.labels[0] : sheet.labels[1]);
  const nameOf = (id: string) => sheet.nameOf.get(id) ?? "?";
  const unclear = (problems: Array<{ raw: string; res: NameResolution }>): TeamReply => ({
    outcome: "teams-name-unclear",
    replyText: buildNameProblems(lang, problems),
  });

  /** New teams, keeping who was put on a side or together. Named against the whole squad. */
  const buildWith = async (sides: Array<{ name: string; to: SheetTeam }>, together: string[][]): Promise<TeamReply> => {
    const res = resolveAll([...sides.map((x) => x.name), ...together.flat()], sheet.squad, args.senderUserId);
    if (!res.ok) return unclear(res.problems);
    const one = (raw: string) => (resolveName(raw, sheet.squad, args.senderUserId) as { userId: string }).userId;
    return build(pinsFor(sides.map((x) => ({ ids: [one(x.name)], to: x.to })), together.map((g) => g.map(one))));
  };

  if (command.kind === "reshuffle") return buildWith(command.sides, command.together);

  if (command.kind === "show") {
    if (sheet.slots.length === 0) return build();
    if (final) return { outcome: "teams-shown", replyText: teamsText(sheet, lang, true, announce) };
    return { outcome: "teams-shown", replyText: await propose(sheet, lang, now, announce) };
  }

  // No teams yet: a pair or a side is a build that keeps them; a move is not.
  if (sheet.slots.length === 0) {
    if (command.kind === "change" && !command.swapSides && command.moves.length === 0) {
      return buildWith(command.sides, command.together);
    }
    return { outcome: "teams-no-teams", replyText: s.tp_no_teams };
  }

  const rating = async () => {
    const ids = sheet.slots.map((x) => x.userId);
    const map = await ratingsOf(deps)(match.id, sheet.orgId, ids).catch(() => new Map<string, number>());
    return (id: string) => map.get(id) ?? 5;
  };

  let plan: { team: Map<string, SheetTeam>; moved: string[]; evenedBy: string[] };
  let outcome: TeamReplyOutcome = "teams-changed";
  let lead: string | null = null;

  if (command.kind === "suggest") {
    const pick = bestSwap(sheet.slots, await rating());
    if (!pick) return { outcome: "teams-suggest-none", replyText: s.tp_suggest_none };
    const words = { a: nameOf(pick.red), b: nameOf(pick.yellow) };
    console.log(`[team-proposal] ${args.messageId}: suggested a swap on match ${match.id}${final ? " (final, not made)" : ""}`);
    // Final teams stay as they are: the swap is said, not made.
    if (final) return { outcome: "teams-suggested-final", replyText: s.tp_suggested_final(words) };
    plan = planTeamChange({ slots: sheet.slots, moveIds: [pick.red, pick.yellow], rating: () => 5 });
    outcome = "teams-suggested";
    lead = s.tp_suggested(words);
  } else {
    const { moves, sides, together, swapSides } = command;
    const simple = !swapSides && sides.length === 0 && together.length === 0;
    // "swap A and B": the two must be two players, on different teams.
    if (simple && moves.length === 2) {
      const res = resolveSwap([[moves[0], moves[1]]], sheet.players);
      if (res.kind === "problem") return unclear(res.problems);
      const [a, b] = [res.a, res.b].map((id) => sheet.slots.find((x) => x.userId === id)!);
      if (a.team === b.team) {
        return { outcome: "teams-same-team", replyText: s.tp_same_team({ a: nameOf(a.userId), b: nameOf(b.userId) }) };
      }
      outcome = "teams-swapped";
    }
    const res = resolveAll([...moves, ...sides.map((x) => x.name), ...together.flat()], sheet.players, args.senderUserId);
    if (!res.ok) return unclear(res.problems);
    const one = (raw: string) => (resolveName(raw, sheet.players, args.senderUserId) as { userId: string }).userId;
    const sideIds = sides.map((x) => ({ userId: one(x.name), to: x.to }));
    // "put Ali in Red" when he is: one line, as before.
    if (!swapSides && moves.length === 0 && together.length === 0 && sideIds.length === 1) {
      const slot = sheet.slots.find((x) => x.userId === sideIds[0].userId)!;
      if (slot.team === sideIds[0].to) {
        return { outcome: "teams-already-there", replyText: s.tp_already_on({ name: nameOf(slot.userId), team: label(slot.team) }) };
      }
    }
    if (simple && moves.length === 1) outcome = "teams-moved";
    // Every player of one team named, and nobody else ("swap everyone on
    // bibs to non bibs. Switch all 9", read as nine names): moving them
    // all would leave that team empty, so the two teams swap over. Three
    // or more names only; two is "swap A and B", answered above.
    const moveIds = [...new Set(moves.map(one))];
    const playingOn = (team: SheetTeam) => sheet.slots.filter((x) => x.team === team && x.playing).map((x) => x.userId);
    const wholeSide =
      simple &&
      moveIds.length >= 3 &&
      (["RED", "YELLOW"] as const).some((team) => {
        const side = playingOn(team);
        return side.length === moveIds.length && side.every((id) => moveIds.includes(id));
      });
    if (wholeSide) console.log(`[team-proposal] ${args.messageId}: every player of one team named: the teams swap over`);
    plan = planTeamChange({
      slots: sheet.slots,
      swapSides: swapSides || wholeSide,
      moveIds: wholeSide ? [] : moveIds,
      sides: sideIds,
      together: together.map((g) => g.map(one)),
      rating: sideIds.length || together.length ? await rating() : () => 5,
    });
    if (plan.evenedBy.length) {
      const to = plan.team.get(plan.evenedBy[0])!;
      lead = s.tp_evened({ names: plan.evenedBy.map(nameOf).join(", "), team: label(to) });
    }
  }

  const changed = sheet.slots.filter((x) => plan.team.get(x.userId) !== x.team);
  if (changed.length === 0) return { outcome: "teams-unchanged", replyText: s.tp_nothing_to_change };

  // Under the per-match slot lock, as every other seat change: a bench
  // claim landing at the same instant cannot interleave with this.
  await db.$transaction(async (tx) => {
    await lockTeamSlots(tx as unknown as SlotFillTx, match.id);
    for (const slot of changed) {
      await tx.teamAssignment.update({ where: { id: slot.slotId }, data: { team: plan.team.get(slot.userId)! } });
    }
  });

  const after = await loadSheet(match, lang);
  console.log(`[team-proposal] ${args.messageId}: ${outcome} on match ${match.id}, ${changed.length} changed side`);
  const withLead = (text: string) => (lead ? `${lead}\n\n${text}` : text);
  if (final) {
    // Final teams stay final; the admin group has now seen this sheet.
    const row = (await db.adminTeamProposal.findUnique({ where: { matchId: match.id } })) as ProposalRow | null;
    if (row?.state === "approved") {
      await db.adminTeamProposal.update({ where: { id: row.id }, data: { toldSheet: after.slots as unknown as object } });
      await redrawAfterChange(orgId, match.id, now);
    }
    return { outcome, replyText: withLead(teamsText(after, lang, true, announce)) };
  }
  return { outcome, replyText: withLead(await propose(after, lang, now, announce)) };
}

/**
 * An admin's YES, when the teams are the question waiting. Null when they
 * are not (the caller then tries a pasted list's YES).
 */
export async function answerTeamsYes(args: {
  orgId: string;
  lang: string | null | undefined;
  senderUserId: string;
  messageId: string;
  now: Date;
  deps?: TeamProposalDeps;
}): Promise<TeamReply | null> {
  const { orgId, lang, now, deps } = args;
  const s = t(lang);
  const row = (await db.adminTeamProposal.findFirst({
    where: { orgId, state: { in: WAITING } },
    orderBy: { askedAt: "desc" },
  })) as ProposalRow | null;
  if (!row) return null;
  const match = (await db.match.findUnique({ where: { id: row.matchId } })) as unknown as MatchRow | null;
  if (!match || !(ACTIVE as string[]).includes(match.status) || match.date.getTime() < now.getTime() - 6 * 60 * 60 * 1000) {
    // A question about a game that is over: it no longer waits.
    await db.adminTeamProposal.updateMany({ where: { id: row.id, state: row.state }, data: { state: "set-aside" } });
    return null;
  }
  const sheet = await loadSheet(match, lang);
  if (sheet.slots.length === 0) {
    await db.adminTeamProposal.updateMany({ where: { id: row.id, state: row.state }, data: { state: "set-aside" } });
    return { outcome: "teams-no-teams", replyText: s.tp_no_teams };
  }
  // UNEVEN SIDES ASK TWICE (2026-10-14). The first YES on uneven sides is
  // answered with the counts and leaves them unapproved; the next YES,
  // with nothing changed in between, makes them final as they are. A
  // change reposts the teams and puts the question back to "proposed".
  const { red, yellow } = sideCounts(sheet);
  if (row.state === "proposed" && unevenSides(red, yellow)) {
    const asked = await db.adminTeamProposal.updateMany({ where: { id: row.id, state: "proposed" }, data: { state: "uneven-asked" } });
    if (asked.count === 0) return null;
    console.log(`[team-proposal] ${args.messageId}: uneven sides on match ${match.id}, asked again`);
    const replyText = s.tp_uneven_confirm({ redLabel: sheet.labels[0], red, yellowLabel: sheet.labels[1], yellow });
    await recordMatchTimeQuestion({ orgId, askRef: teamsAskRef(match.id), text: replyText, now });
    return { outcome: "teams-uneven", replyText };
  }
  // Claimed once: two admins' YES approve once.
  const claimed = await db.adminTeamProposal.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: "approved", approvedAt: now, approvedByUserId: args.senderUserId, toldSheet: sheet.slots as unknown as object },
  });
  if (claimed.count === 0) return null;
  await db.match.update({ where: { id: match.id }, data: { status: "TEAMS_PUBLISHED" } });

  // The team sheet image, in the admin group, once per match (#260). Final
  // again after a reshuffle: the first one's once-key is spent, so the
  // updated sheet follows as after any other change. A graphic that cannot
  // be queued never undoes the approval.
  const sheetSent = await sendGraphicToAdminChannel(orgId, match.id, "teams", { onceKey: `${match.id}:teams-approved` }).catch((err) => {
    console.error(`[team-proposal] ${args.messageId}: team sheet graphic not queued:`, err instanceof Error ? err.message : "failed");
    return null;
  });
  if (sheetSent && !sheetSent.queued && sheetSent.reason === "already-sent") await redrawAfterChange(orgId, match.id, now);

  if (await announces(deps, orgId)) {
    console.log(`[team-proposal] ${args.messageId}: teams final on match ${match.id}, organisers announce`);
    return { outcome: "teams-final", replyText: s.tp_final_reply_quiet };
  }
  const side = (team: SheetTeam) =>
    sheet.slots.filter((x) => x.team === team && x.playing).map((x) => ({ name: sheet.nameOf.get(x.userId) ?? "?" }));
  await db.botJob.create({
    data: {
      orgId,
      kind: "group",
      // The match, so a reply quoting the teams post resolves to it.
      matchId: match.id,
      text: formatTeamsPost({
        redLabel: sheet.labels[0],
        yellowLabel: sheet.labels[1],
        red: side("RED"),
        yellow: side("YELLOW"),
        kickoff: sheet.kickoff,
        venue: sheet.venue,
        lang,
      }),
    },
  });
  console.log(`[team-proposal] ${args.messageId}: teams final on match ${match.id}, posted to the players' group`);
  return { outcome: "teams-final", replyText: s.tp_final_reply_posted };
}

// ── The due-posts poll ────────────────────────────────────────────────

export interface TeamProposalOrg {
  id: string;
  language: string | null;
  adminGroupId: string | null;
  squadMode?: string | null;
  teamsReadyTime?: string | null;
  listAnnouncer?: string | null;
  billingStatus?: string | null;
  whatsappBotEnabled?: boolean | null;
}

/** Today's (London) game still to kick off, the soonest. */
async function matchDayMatch(orgId: string, now: Date): Promise<MatchRow | null> {
  const today = formatLondon(now, "yyyy-MM-dd");
  return (
    (await activeMatches(orgId)).find(
      (m) => m.date.getTime() > now.getTime() && formatLondon(m.date, "yyyy-MM-dd") === today,
    ) ?? null
  );
}

async function queueAdminGroup(orgId: string, text: string, matchId?: string): Promise<void> {
  // The admin channel decides at emit time: the admin group when the Pi
  // can post there (09:00 to 22:59 London), else the owner by DM. Its
  // match, so an HQ reply quoting it resolves to it (slice S4 review).
  await db.botJob.create({ data: { orgId, kind: "admin-group", text, ...(matchId ? { matchId } : {}) } });
}

/**
 * Called on every due-posts poll for a live club (`bot-scheduler.ts`).
 * Queues, as `admin-group` BotJobs, at most one of: the "Teams ready"
 * proposal, the kickoff-minus-2-hours reminder, a change notice after
 * approval. Returns how many it queued. Never posts in the players' group.
 */
export async function teamProposalJobs(args: { org: TeamProposalOrg; now: Date; deps?: TeamProposalDeps }): Promise<number> {
  const { org, now, deps } = args;
  if (!org.adminGroupId || org.squadMode === "monthly" || org.whatsappBotEnabled === false || isBillingPaused(org)) return 0;
  const match = await matchDayMatch(org.id, now);
  if (!match) return 0;
  const lang = org.language;
  const announce = deps?.announce ? await deps.announce({ id: org.id }) : organisersAnnounce(org);
  const row = (await db.adminTeamProposal.findUnique({ where: { matchId: match.id } })) as ProposalRow | null;

  // 1. "Teams ready".
  if (!row) {
    if (match.status === "TEAMS_PUBLISHED") return 0;
    if (!isProposalDue({ now, kickoff: match.date, readyTime: effectiveTeamsReadyTime(org.teamsReadyTime, organisersAnnounce(org)) })) return 0;
    const sheet = await loadSheet(match, lang);
    // The balancer's own minimum: two full sides (`generateTeamsForMatch`).
    // Short at the ready time: the admin group is told once per match (the
    // count, and what to do), and the proposal still follows on its own
    // if the squad fills before kickoff. Never repeated on every poll.
    if (sheet.slots.length === 0 && isShort(sheet)) {
      try {
        await db.sentNotification.create({ data: { key: `team-proposal:short:${match.id}`, kind: "admin-notice", matchId: match.id } });
      } catch {
        return 0;
      }
      await queueAdminGroup(org.id, shortSquadText(sheet, lang), match.id);
      console.log(`[team-proposal] org ${org.id}: squad short for teams on match ${match.id} (${sheet.confirmed} of ${neededFor(sheet)})`);
      return 1;
    }
    const key = `team-proposal:auto:${match.id}`;
    try {
      await db.sentNotification.create({ data: { key, kind: "admin-notice", matchId: match.id } });
    } catch {
      return 0;
    }
    let ready = sheet;
    if (sheet.slots.length === 0) {
      const res = await gen(deps)(match.id, {});
      if (!res.ok) {
        // Not this time; the next poll tries again.
        await db.sentNotification.deleteMany({ where: { key } });
        console.log(`[team-proposal] org ${org.id}: teams not built on match ${match.id}`);
        return 0;
      }
      ready = await loadSheet(match, lang);
    }
    await queueAdminGroup(org.id, await propose(ready, lang, now, announce), match.id);
    console.log(`[team-proposal] org ${org.id}: proposed teams on match ${match.id} (${ready.slots.length} on the teams)`);
    return 1;
  }

  // 2. Nobody approved by kickoff minus 2 hours: one reminder.
  if (row.state !== "approved" && match.status !== "TEAMS_PUBLISHED") {
    if (row.remindedAt || !isReminderDue({ now, kickoff: match.date })) return 0;
    const claimed = await db.adminTeamProposal.updateMany({ where: { id: row.id, remindedAt: null }, data: { remindedAt: now } });
    if (claimed.count === 0) return 0;
    const reminder = buildReminderText(lang, match.date);
    await queueAdminGroup(org.id, reminder, match.id);
    await recordMatchTimeQuestion({ orgId: org.id, askRef: teamsAskRef(match.id), text: reminder, now });
    console.log(`[team-proposal] org ${org.id}: reminder on match ${match.id}`);
    return 1;
  }

  // 3. After approval: tell the admin group what changed in the teams.
  if (row.state !== "approved" || match.status !== "TEAMS_PUBLISHED" || !Array.isArray(row.toldSheet)) return 0;
  const told = row.toldSheet as SheetSlot[];
  const sheet = await loadSheet(match, lang, told.map((x) => x.userId));
  const changes = diffSheets(told, sheet.slots);
  if (changes.length === 0) return 0;
  const claimed = await db.adminTeamProposal.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: { toldSheet: sheet.slots as unknown as object },
  });
  if (claimed.count === 0) return 0;
  const name = (id: string) => sheet.nameOf.get(id) ?? "?";
  const label = (team: SheetTeam) => (team === "RED" ? sheet.labels[0] : sheet.labels[1]);
  const items: ChangeItem[] = changes.map((c) =>
    c.kind === "replaced"
      ? { kind: "replaced", team: label(c.team), from: name(c.fromUserId), to: name(c.toUserId) }
      : { kind: c.kind, team: label(c.team), name: name(c.userId) },
  );
  await queueAdminGroup(org.id, buildChangeNotice({ lang, items, teamsText: teamsText(sheet, lang, true, announce) }), match.id);
  console.log(`[team-proposal] org ${org.id}: ${changes.length} team change(s) told on match ${match.id}`);
  await redrawAfterChange(org.id, match.id, now);
  return 1;
}

/**
 * The final teams changed: the updated team sheet graphic follows in the
 * admin group on its own, once the teams have been quiet for a moment
 * (`redrawTeamSheet`). Kemal, 2026-10-16: "poster generation should be
 * automated as soon as the teams are final. no need for any extra
 * command". A graphic that cannot be queued never undoes the change.
 */
async function redrawAfterChange(orgId: string, matchId: string, now: Date): Promise<void> {
  await redrawTeamSheet(orgId, matchId, now).catch((err) =>
    console.error(`[team-proposal] match ${matchId}: updated team sheet not queued:`, err instanceof Error ? err.message : "failed"),
  );
}
