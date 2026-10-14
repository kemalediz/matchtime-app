/**
 * TEAMS PROPOSED AND APPROVED IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * Why: FNF wants MatchTime to pick balanced teams, but its admins reveal
 * the teams themselves, as a graphic, in another group. So the teams are
 * proposed to the admins in the club's linked admin group, changed there,
 * and approved there.
 *
 * WHAT ADMINS TYPE in the admin group (whole messages, English or
 * Turkish, read by `parseTeamCommand`, no model):
 *
 *   teams | takımlar          the teams as they stand; built first if none
 *   reshuffle | yeniden       build new teams (asks for YES again)
 *   swap A B | A ile B değiş  swap two players between the teams
 *   move A | A'yı taşı        move one player to the other team
 *   YES | EVET                the teams are final (TEAMS_PUBLISHED)
 *
 * Every change reposts the teams in the admin group. Names are placed on
 * the players on the teams by the club's own rules (`nameCandidates`); an
 * unknown or ambiguous name gets one short line and changes nothing.
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
 * ONE QUESTION AT A TIME (the YES rule, decided 2026-10-14). A YES in the
 * admin group always answers the last thing MatchTime asked there:
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
import { generateTeamsForMatch, type GenerateTeamsResult } from "./team-generation";
import { formatTeamsPost } from "./group-copy";
import { resolveTeamLabels } from "./team-labels";
import { formatLondon } from "./london-time";
import { selectRegistrationMatch } from "./registration-match-select";
import { lockTeamSlots, type SlotFillTx } from "./team-slot-fill";
import { isBillingPaused } from "./club-billing-rules";
import { organisersAnnounce } from "./list-announcer";
import { loadOrganisersAnnounce } from "./list-announcer-store";
import { sendGraphicToAdminChannel } from "./admin-group-graphics";
import { t } from "./i18n/t";
import {
  buildChangeNotice,
  buildNameProblems,
  buildReminderText,
  buildTeamsText,
  diffSheets,
  isProposalDue,
  isReminderDue,
  effectiveTeamsReadyTime,
  parseTeamCommand,
  resolveSheetName,
  resolveSwap,
  unevenSides,
  type ChangeItem,
  type SheetPlayer,
  type SheetSlot,
  type SheetTeam,
} from "./team-proposal-rules";

export interface TeamProposalDeps {
  /** The shared generator. Injected in tests only. */
  generate?: (matchId: string) => Promise<GenerateTeamsResult>;
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
  | "teams-uneven"
  | "teams-final";

export interface TeamReply {
  outcome: TeamReplyOutcome;
  replyText: string;
}

const ACTIVE: Array<"UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED"> = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

const gen = (deps: TeamProposalDeps | undefined) => deps?.generate ?? ((id: string) => generateTeamsForMatch(id));
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
  const players: SheetPlayer[] = slots.map((s) => ({
    userId: s.userId,
    name: nameOf.get(s.userId) ?? "?",
    aliases: aliases.filter((a) => a.userId === s.userId).map((a) => a.alias),
  }));
  return {
    match,
    orgId: activity.orgId,
    slots,
    players,
    nameOf,
    unseatedIds,
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

/** The proposal text, with the "list not applied" line when one was superseded. */
async function propose(sheet: Sheet, lang: string | null | undefined, now: Date, announce: boolean): Promise<string> {
  const superseded = await askAboutTeams(sheet.orgId, sheet.match.id, now);
  const text = teamsText(sheet, lang, false, announce);
  return superseded ? `${t(lang).tp_list_superseded}\n\n${text}` : text;
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

/**
 * One admin-group team command from a proven owner or admin. Null when
 * the text is not one, so the message goes on to the next reader.
 */
export async function handleTeamCommand(args: {
  orgId: string;
  lang: string | null | undefined;
  text: string;
  senderUserId: string;
  messageId: string;
  now: Date;
  deps?: TeamProposalDeps;
}): Promise<TeamReply | null> {
  const command = parseTeamCommand(args.text);
  if (!command) return null;
  const { orgId, lang, now, deps } = args;
  const s = t(lang);
  const announce = await announces(deps, orgId);

  const match = await commandMatch(orgId, now);
  if (!match) return { outcome: "teams-no-match", replyText: s.tp_no_match };

  const build = async (): Promise<TeamReply> => {
    const res = await gen(deps)(match.id);
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
    console.log(`[team-proposal] ${args.messageId}: teams built on match ${match.id}, ${sheet.slots.length} on the teams`);
    return { outcome: "teams-built", replyText: await propose(sheet, lang, now, announce) };
  };

  if (command.kind === "reshuffle") return build();

  const sheet = await loadSheet(match, lang);
  const final = match.status === "TEAMS_PUBLISHED";

  if (command.kind === "show") {
    if (sheet.slots.length === 0) return build();
    if (final) return { outcome: "teams-shown", replyText: teamsText(sheet, lang, true, announce) };
    return { outcome: "teams-shown", replyText: await propose(sheet, lang, now, announce) };
  }

  if (sheet.slots.length === 0) return { outcome: "teams-no-teams", replyText: s.tp_no_teams };

  let ids: string[];
  if (command.kind === "swap") {
    const res = resolveSwap(command.pairs, sheet.players);
    if (res.kind === "problem") return { outcome: "teams-name-unclear", replyText: buildNameProblems(lang, res.problems) };
    ids = [res.a, res.b];
    const [a, b] = ids.map((id) => sheet.slots.find((x) => x.userId === id)!);
    if (a.team === b.team) {
      return {
        outcome: "teams-same-team",
        replyText: s.tp_same_team({ a: sheet.nameOf.get(a.userId) ?? "?", b: sheet.nameOf.get(b.userId) ?? "?" }),
      };
    }
  } else {
    const res = resolveSheetName(command.name, sheet.players);
    if (res.kind !== "one") {
      return { outcome: "teams-name-unclear", replyText: buildNameProblems(lang, [{ raw: command.name, res }]) };
    }
    ids = [res.userId];
  }

  // Under the per-match slot lock, as every other seat change: a bench
  // claim landing at the same instant cannot interleave with this.
  await db.$transaction(async (tx) => {
    await lockTeamSlots(tx as unknown as SlotFillTx, match.id);
    const rows = await tx.teamAssignment.findMany({ where: { matchId: match.id, userId: { in: ids } } });
    for (const r of rows) await tx.teamAssignment.update({ where: { id: r.id }, data: { team: r.team === "RED" ? "YELLOW" : "RED" } });
  });

  const after = await loadSheet(match, lang);
  const outcome: TeamReplyOutcome = command.kind === "swap" ? "teams-swapped" : "teams-moved";
  console.log(`[team-proposal] ${args.messageId}: ${command.kind} on match ${match.id}`);
  if (final) {
    // Final teams stay final; the admin group has now seen this sheet.
    const row = (await db.adminTeamProposal.findUnique({ where: { matchId: match.id } })) as ProposalRow | null;
    if (row?.state === "approved") {
      await db.adminTeamProposal.update({ where: { id: row.id }, data: { toldSheet: after.slots as unknown as object } });
    }
    return { outcome, replyText: teamsText(after, lang, true, announce) };
  }
  return { outcome, replyText: await propose(after, lang, now, announce) };
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
    return {
      outcome: "teams-uneven",
      replyText: s.tp_uneven_confirm({ redLabel: sheet.labels[0], red, yellowLabel: sheet.labels[1], yellow }),
    };
  }
  // Claimed once: two admins' YES approve once.
  const claimed = await db.adminTeamProposal.updateMany({
    where: { id: row.id, state: row.state },
    data: { state: "approved", approvedAt: now, approvedByUserId: args.senderUserId, toldSheet: sheet.slots as unknown as object },
  });
  if (claimed.count === 0) return null;
  await db.match.update({ where: { id: match.id }, data: { status: "TEAMS_PUBLISHED" } });

  // The team sheet image, in the admin group, once per match (#260). A
  // graphic that cannot be queued never undoes the approval.
  await sendGraphicToAdminChannel(orgId, match.id, "teams", { onceKey: `${match.id}:teams-approved` }).catch((err) =>
    console.error(`[team-proposal] ${args.messageId}: team sheet graphic not queued:`, err instanceof Error ? err.message : "failed"),
  );

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

async function queueAdminGroup(orgId: string, text: string): Promise<void> {
  // The admin channel decides at emit time: the admin group when the Pi
  // can post there (09:00 to 22:59 London), else the owner by DM.
  await db.botJob.create({ data: { orgId, kind: "admin-group", text } });
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
      await queueAdminGroup(org.id, shortSquadText(sheet, lang));
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
      const res = await gen(deps)(match.id);
      if (!res.ok) {
        // Not this time; the next poll tries again.
        await db.sentNotification.deleteMany({ where: { key } });
        console.log(`[team-proposal] org ${org.id}: teams not built on match ${match.id}`);
        return 0;
      }
      ready = await loadSheet(match, lang);
    }
    await queueAdminGroup(org.id, await propose(ready, lang, now, announce));
    console.log(`[team-proposal] org ${org.id}: proposed teams on match ${match.id} (${ready.slots.length} on the teams)`);
    return 1;
  }

  // 2. Nobody approved by kickoff minus 2 hours: one reminder.
  if (row.state !== "approved" && match.status !== "TEAMS_PUBLISHED") {
    if (row.remindedAt || !isReminderDue({ now, kickoff: match.date })) return 0;
    const claimed = await db.adminTeamProposal.updateMany({ where: { id: row.id, remindedAt: null }, data: { remindedAt: now } });
    if (claimed.count === 0) return 0;
    await queueAdminGroup(org.id, buildReminderText(lang, match.date));
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
  await queueAdminGroup(org.id, buildChangeNotice({ lang, items, teamsText: teamsText(sheet, lang, true, announce) }));
  console.log(`[team-proposal] org ${org.id}: ${changes.length} team change(s) told on match ${match.id}`);
  return 1;
}
