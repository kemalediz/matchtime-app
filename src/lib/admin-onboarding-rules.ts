/**
 * THE STANDARD WELCOME NOTICES TO A CLUB'S ADMINS (2026-10-15), pure: no
 * Prisma, no clock, no model. The database half is admin-onboarding.ts.
 *
 * WHY. Onboarding FNF, the first self-serve club, the manager posted
 * several messages to its admin group by hand: what was still to do after
 * GO, and how the first teams would work. The owner: "whatever manually we
 * asked you to post in HQ should be standard welcome messages so admins
 * don't forget seed rating and stuff". Both now go out on their own, once
 * per club, through the admin channel (admin-channel.ts), in the club's
 * language.
 *
 * A. "GETTING <CLUB> READY", queued when the club goes live (GO,
 *    club-setup.ts `goLiveClub`). Built from what is still NOT done then,
 *    each line only when true:
 *
 *    money collector   Collect match fees on (`paymentCollectionEnabled`)
 *                      and no `paymentHolderId`. The picker lives only in
 *                      Settings' Payments card, which shows only while
 *                      Collect match fees is on, so a club with payment
 *                      tracking alone is not pointed at it.
 *    paste the list    admin group only, a weekly club with attendance on,
 *                      whose organisers set the squad: they announce
 *                      (`listAnnouncer` "organisers") or pick
 *                      (`benchPickMode` "organiser", an In goes on the
 *                      bench). Read by admin-group-paste.ts on the club's
 *                      registration match: "now" when that match exists;
 *                      otherwise the nightly fixture run
 *                      (cron/generate-matches) adds it, so "from tomorrow".
 *                      No active game at all: no line.
 *    how to tag        admin group only. HQ acts only on a real tag (#482,
 *                      2026-10-31), in every club, so every club is told
 *                      to tag. The main-chat sentence needs attendance
 *                      (an IN or OUT needs no tag: interaction contract).
 *    help              "help" in the admin group (admin-group-help.ts), or
 *                      by DM (dm-help.ts).
 *
 *    The organisers who are in the admin group but not admins on the
 *    website are NOT listed: MatchTime keeps no record of who is in the
 *    admin group (bot-added stores only a member count for a candidate
 *    group), so it cannot know them.
 *
 *    By DM (no admin group, or it routes elsewhere) A goes out only when
 *    there is something to do (the money collector); otherwise there is
 *    nothing a DM would add to the hello.
 *
 * B. "TEAMS FOR <WEEKDAY>", from the scheduler (bot-scheduler.ts), once the
 *    squad is first set for the club's FIRST proposed teams. Only where the
 *    teams are proposed in the admin group (team-proposal.ts
 *    `teamProposalJobs`): a live weekly club with an admin group, not
 *    paused, whose effective Teams ready time (`effectiveTeamsReadyTime`,
 *    10:00 when the organisers announce and nothing is set, else off) falls
 *    before kickoff. Due when the next match is still UPCOMING, before that
 *    time, the club has never had teams proposed (no AdminTeamProposal),
 *    and the squad is set: full, or a pasted list applied for the match
 *    (AdminSquadProposal outcome "applied"). The hook also requires the
 *    notice to land in the admin group, where the proposal will.
 *    The YES line follows the announcer: organisers mode shares the team
 *    sheet the approval sends here; otherwise YES posts the teams in the
 *    main chat (team-proposal.ts `answerTeamsYes`).
 *
 *    THE SEED LINE. Added only while the seed nudge (seed-nudge-rules.ts)
 *    would still fire for the club: team balancing on, not nudged yet (no
 *    claim, no manual message), no peer ratings, most of the squad
 *    unseeded. Then B's delivery key is under the nudge's own namespace
 *    (`org-<id>:seed-nudge:first-teams:<who>`), which
 *    `seedNudgeAlreadySent` reads as sent, so the two never both fire.
 *
 * ONCE. A: the claim `org-<id>:getting-ready`, written before the job is
 * queued. B: the admin channel's delivery keys under `org-<id>:first-teams`
 * (or the seed namespace above). `adminOnboardingClaimKeys` is what
 * scripts/mark-admin-onboarding-sent.ts writes for a club told by hand.
 */
import { t } from "./i18n/t";
import { weekdayLabel } from "./i18n/dates";
import { organisersAnnounce } from "./list-announcer";
import { normaliseBenchPickMode } from "./squad-capacity";
import { seedNudgeKey } from "./seed-nudge-rules";
import { teamsReadyAt } from "./team-proposal-rules";

export const ADMIN_ONBOARDING_KIND = "admin-onboarding";

export const gettingReadyKey = (orgId: string): string => `org-${orgId}:getting-ready`;
export const firstTeamsBaseKey = (orgId: string): string => `org-${orgId}:first-teams`;

/** One recipient's key: "admin-group" or an admin's user id. With the seed
 *  line, under the seed nudge's namespace, so it counts as that nudge too. */
export function firstTeamsKey(orgId: string, who: string, withSeed: boolean): string {
  return withSeed ? seedNudgeKey(orgId, `first-teams:${who}`) : `${firstTeamsBaseKey(orgId)}:${who}`;
}

export function firstTeamsAlreadySent(orgId: string, sentKeys: ReadonlySet<string>): boolean {
  const base = firstTeamsBaseKey(orgId);
  const seeded = seedNudgeKey(orgId, "first-teams:");
  for (const k of sentKeys) if (k === base || k.startsWith(`${base}:`) || k.startsWith(seeded)) return true;
  return false;
}

/** Every claim a club told by hand needs, so neither notice is ever sent. */
export function adminOnboardingClaimKeys(orgId: string): string[] {
  return [gettingReadyKey(orgId), firstTeamsBaseKey(orgId)];
}

// ── A ─────────────────────────────────────────────────────────────────

/** The Organisation columns A reads. */
export interface GettingReadyClub {
  name: string;
  language: string | null;
  squadMode: string | null;
  featureAttendance: boolean | null;
  listAnnouncer: string | null;
  benchPickMode: string | null;
  paymentCollectionEnabled: boolean | null;
  paymentHolderId: string | null;
}

export interface GettingReadyInput {
  club: GettingReadyClub;
  /** Where it lands: the admin group, or admins by DM. */
  audience: "group" | "dm";
  /** The club's registration match (what a pasted list goes on), or null. */
  nextMatchDate: Date | null;
  /** `dayOfWeek` of each active game (0 = Sunday). */
  activityDays: number[];
  /** Settings: the plain URL in the group, a signed-in link by DM. */
  link: string;
}

export type GettingReadyItem =
  | { kind: "collector" }
  | { kind: "paste-now"; weekday: string }
  | { kind: "paste-later"; weekday: string | null }
  | { kind: "no-tag"; mainChat: boolean }
  | { kind: "main-chat" }
  | { kind: "help" };

export function gettingReadyItems(i: GettingReadyInput): GettingReadyItem[] {
  const c = i.club;
  const weekly = c.squadMode !== "monthly";
  const attendance = c.featureAttendance !== false;
  const organisersSetSquad = organisersAnnounce(c) || normaliseBenchPickMode(c.benchPickMode) === "organiser";
  const items: GettingReadyItem[] = [];

  if (c.paymentCollectionEnabled === true && !c.paymentHolderId) items.push({ kind: "collector" });
  if (i.audience === "group") {
    if (weekly && attendance && organisersSetSquad) {
      if (i.nextMatchDate) items.push({ kind: "paste-now", weekday: weekdayLabel(c.language, i.nextMatchDate) });
      else if (i.activityDays.length > 0) {
        const days = [...new Set(i.activityDays)];
        items.push({ kind: "paste-later", weekday: days.length === 1 ? t(c.language).wd_weekday({ dow: days[0] }) : null });
      }
    }
    items.push({ kind: "no-tag", mainChat: attendance });
  } else if (attendance) {
    items.push({ kind: "main-chat" });
  }
  items.push({ kind: "help" });
  return items;
}

/** The whole message, or null when there is nothing worth sending. */
export function buildGettingReady(i: GettingReadyInput): string | null {
  const items = gettingReadyItems(i);
  if (i.audience === "dm" && !items.some((x) => x.kind === "collector")) return null;
  const s = t(i.club.language);
  const lines = items.map((x) => {
    switch (x.kind) {
      case "collector":
        return s.ao_ready_collector({ link: i.link });
      case "paste-now":
        return s.ao_ready_paste_now({ weekday: x.weekday });
      case "paste-later":
        return s.ao_ready_paste_later({ weekday: x.weekday });
      case "no-tag":
        return s.ao_ready_no_tag({ mainChat: x.mainChat });
      case "main-chat":
        return s.ao_ready_main_chat;
      case "help":
        return i.audience === "group" ? s.ao_ready_help_group : s.ao_ready_help_dm;
    }
  });
  return [s.ao_ready_title({ club: i.club.name }), ...lines].join("\n\n");
}

// ── B ─────────────────────────────────────────────────────────────────

export interface FirstTeamsInput {
  now: Date;
  /** Not setting up (`isClubSettingUp`). */
  live: boolean;
  squadMode: string;
  attendance: boolean;
  adminGroupLinked: boolean;
  billingPaused: boolean;
  /** `effectiveTeamsReadyTime`: "HH:mm" or "off". */
  readyTime: string;
  alreadySent: boolean;
  /** The club's next match not yet kicked off (not cancelled or completed). */
  match: { date: Date; status: string; confirmed: number; maxPlayers: number } | null;
  /** A pasted list was applied for that match. */
  pasteApplied: boolean;
  /** The club has had teams proposed before (any AdminTeamProposal). */
  anyProposal: boolean;
}

export type FirstTeamsDecision =
  | { due: true; readyAt: Date }
  | {
      due: false;
      reason:
        | "not-live"
        | "not-weekly"
        | "no-attendance"
        | "no-admin-group"
        | "billing-paused"
        | "no-teams-ready"
        | "already"
        | "no-match"
        | "teams-made"
        | "past-teams-ready"
        | "squad-not-set"
        | "not-first";
    };

type NotDue = Extract<FirstTeamsDecision, { due: false }>;

/** Everything decidable without a query beyond the scheduler's own; the
 *  hook checks it first. Returns the ready instant when all pass. */
export function firstTeamsPrecheck(
  i: Omit<FirstTeamsInput, "pasteApplied" | "anyProposal">,
): NotDue | { due: true; readyAt: Date } {
  if (!i.live) return { due: false, reason: "not-live" };
  if (i.squadMode === "monthly") return { due: false, reason: "not-weekly" };
  if (!i.attendance) return { due: false, reason: "no-attendance" };
  if (!i.adminGroupLinked) return { due: false, reason: "no-admin-group" };
  if (i.billingPaused) return { due: false, reason: "billing-paused" };
  if (i.readyTime === "off") return { due: false, reason: "no-teams-ready" };
  if (i.alreadySent) return { due: false, reason: "already" };
  if (!i.match || i.match.date.getTime() <= i.now.getTime()) return { due: false, reason: "no-match" };
  const readyAt = teamsReadyAt(i.match.date, i.readyTime);
  // A ready time at or after kickoff never proposes (`isProposalDue`).
  if (!readyAt || readyAt.getTime() >= i.match.date.getTime()) return { due: false, reason: "no-teams-ready" };
  if (i.match.status !== "UPCOMING") return { due: false, reason: "teams-made" };
  if (i.now.getTime() >= readyAt.getTime()) return { due: false, reason: "past-teams-ready" };
  return { due: true, readyAt };
}

export function decideFirstTeams(i: FirstTeamsInput): FirstTeamsDecision {
  const pre = firstTeamsPrecheck(i);
  if (!pre.due) return pre;
  const full = i.match!.confirmed >= i.match!.maxPlayers;
  if (!full && !i.pasteApplied) return { due: false, reason: "squad-not-set" };
  if (i.anyProposal) return { due: false, reason: "not-first" };
  return pre;
}

export function buildFirstTeamsNotice(args: {
  lang: string | null | undefined;
  matchDate: Date;
  readyTime: string;
  confirmed: number;
  maxPlayers: number;
  /** The organisers share the teams (`listAnnouncer` "organisers"). */
  organisers: boolean;
  /** The seed line, or null. */
  seed: { anySeeded: boolean; link: string } | null;
}): string {
  const s = t(args.lang);
  const weekday = weekdayLabel(args.lang, args.matchDate);
  const parts = [
    s.ao_teams_title({ weekday }),
    s.ao_teams_set({ confirmed: args.confirmed, max: args.maxPlayers, time: args.readyTime, weekday }),
    s.ao_teams_approve({ organisers: args.organisers }),
  ];
  if (args.seed) parts.push(s.ao_teams_seed({ anySeeded: args.seed.anySeeded, time: args.readyTime, weekday, link: args.seed.link }));
  return parts.join("\n\n");
}
