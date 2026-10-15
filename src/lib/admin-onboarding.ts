/**
 * THE STANDARD WELCOME NOTICES TO A CLUB'S ADMINS (2026-10-15): the
 * database half. The rules, the text and why each line is true are in
 * admin-onboarding-rules.ts. No model.
 *
 *   queueGettingReady(orgId, now)     A, called once by `goLiveClub`
 *                                     (club-setup.ts) after the GO commits.
 *                                     Claims `org-<id>:getting-ready`, then
 *                                     queues it through `sendAdminNotice`
 *                                     (the admin group, else admins by DM,
 *                                     held to 09:00 overnight). Never throws.
 *   firstTeamsInstructions({...})     B, one hook in `computeDuePosts`
 *                                     (bot-scheduler.ts), keyed through
 *                                     `adminNoticeInstructions`, so it is
 *                                     posted only in the admin group's
 *                                     hours. Never throws.
 *   markAdminOnboardingSent({...})    scripts/mark-admin-onboarding-sent.ts:
 *                                     claims both for a club told by hand.
 */
import { db } from "./db";
import { adminNoticeInstructions, loadAdminChannel, sendAdminNotice, type LoadedAdminChannel } from "./admin-channel";
import type { PiCaps } from "./admin-channel-rules";
import type { DueInstruction } from "./bot-scheduler";
import { selectRegistrationMatch } from "./registration-match-select";
import { organisersAnnounce } from "./list-announcer";
import { effectiveTeamsReadyTime } from "./team-proposal-rules";
import { seedNudgeAlreadySent, seedPoolUnseeded } from "./seed-nudge-rules";
import { loadSeedState, SEED_RATINGS_PATH } from "./seed-nudge";
import {
  ADMIN_ONBOARDING_KIND,
  adminOnboardingClaimKeys,
  buildFirstTeamsNotice,
  buildGettingReady,
  decideFirstTeams,
  firstTeamsAlreadySent,
  firstTeamsKey,
  firstTeamsPrecheck,
  gettingReadyKey,
  type GettingReadyClub,
} from "./admin-onboarding-rules";

/** Where the money collector is picked (the Payments card). */
export const GETTING_READY_SETTINGS_PATH = "/admin/settings";

const LIVE_MATCH_STATUSES: Array<"UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED"> = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

/** Does a notice queued now for this club land in its admin group? The same
 *  test `sendAdminNotice` makes. */
function routesToGroup(ch: LoadedAdminChannel): boolean {
  return ch.cfg.mode === "admin-group" && !!ch.cfg.adminGroupId && ch.adminGroupPostable !== false;
}

export type GettingReadyResult =
  | { status: "queued"; channel: "dm" | "admin-group"; queued: number; text: string }
  | { status: "nothing-to-say" | "already" | "no-club" | "no-recipient" | "failed" };

/**
 * A: "Getting <club> ready", for a club that has just gone live. Once per
 * club. A club with nothing to tell its admins by DM gets nothing and no
 * claim. Any failure is logged and costs this notice only, never the GO.
 */
export async function queueGettingReady(orgId: string, now: Date = new Date()): Promise<GettingReadyResult> {
  try {
    const club = (await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        name: true,
        language: true,
        squadMode: true,
        featureAttendance: true,
        listAnnouncer: true,
        benchPickMode: true,
        paymentCollectionEnabled: true,
        paymentHolderId: true,
      },
    })) as GettingReadyClub | null;
    const channel = club ? await loadAdminChannel(orgId) : null;
    if (!club || !channel) return { status: "no-club" };
    const audience = routesToGroup(channel) ? "group" : "dm";

    const [matches, activities] = await Promise.all([
      db.match.findMany({
        where: { activity: { orgId }, status: { in: LIVE_MATCH_STATUSES } },
        orderBy: { date: "asc" },
        select: { id: true, date: true, status: true },
      }),
      db.activity.findMany({ where: { orgId, isActive: true }, select: { dayOfWeek: true } }),
    ]);
    const next = selectRegistrationMatch(matches ?? [], now);
    const input = {
      club,
      nextMatchDate: next?.date ?? null,
      activityDays: (activities ?? []).map((a) => a.dayOfWeek),
    };
    const preview = buildGettingReady({ ...input, audience, link: "" });
    if (!preview) return { status: "nothing-to-say" };

    const { count } = await db.sentNotification.createMany({
      data: [{ key: gettingReadyKey(orgId), kind: ADMIN_ONBOARDING_KIND }],
      skipDuplicates: true,
    });
    if (count !== 1) return { status: "already" };

    const needsLink = club.paymentCollectionEnabled === true && !club.paymentHolderId;
    const res = await sendAdminNotice({
      orgId,
      now,
      nextPath: needsLink ? GETTING_READY_SETTINGS_PATH : null,
      text: (link, aud) =>
        buildGettingReady({ ...input, audience: aud, link }) ?? buildGettingReady({ ...input, audience: "group", link }) ?? "",
    });
    if (res.queued === 0) {
      // Nobody to tell: release the claim, so a later run can still say it.
      await db.sentNotification.deleteMany({ where: { key: gettingReadyKey(orgId) } });
      return { status: "no-recipient" };
    }
    console.log(`[admin-onboarding] org ${orgId}: getting-ready queued (${res.channel}, ${res.queued})`);
    return {
      status: "queued",
      channel: res.channel === "admin-group" ? "admin-group" : "dm",
      queued: res.queued,
      text: buildGettingReady({ ...input, audience: res.channel === "admin-group" ? "group" : "dm", link: "" }) ?? preview,
    };
  } catch (err) {
    console.error(`[admin-onboarding] org ${orgId}: getting-ready not queued: ${(err as Error)?.name ?? "error"}`);
    return { status: "failed" };
  }
}

interface SchedulerMatch {
  id: string;
  date: Date;
  status: string;
  maxPlayers: number;
  attendances: ReadonlyArray<{ userId: string; status: string }>;
}

/**
 * B: "Teams for <weekday>", in the admin group, once the squad is first set
 * for the club's first proposed teams. `withSeed` on the result says the
 * seed line went with it, so the caller skips the seed nudge on this poll
 * (its delivery key already counts as that nudge on every later one).
 */
export async function firstTeamsInstructions(args: {
  org: {
    id: string;
    live: boolean;
    adminGroupId: string | null;
    teamsReadyTime: string | null;
    listAnnouncer: string | null;
    billingPaused: boolean;
  };
  features: { squadMode: string; attendance: boolean; teamBalancing: boolean; language: string };
  matches: ReadonlyArray<SchedulerMatch>;
  sentKeys: ReadonlySet<string>;
  now: Date;
  piCaps: PiCaps;
  getChannel: () => Promise<LoadedAdminChannel | null>;
}): Promise<{ instructions: DueInstruction[]; withSeed: boolean }> {
  const none = { instructions: [], withSeed: false };
  const { org, features, now } = args;
  try {
    const organisers = organisersAnnounce(org);
    const readyTime = effectiveTeamsReadyTime(org.teamsReadyTime, organisers);
    const next =
      args.matches
        .filter((m) => m.status !== "COMPLETED" && m.status !== "CANCELLED" && m.date.getTime() > now.getTime())
        .sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? null;
    const confirmed = next ? next.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.userId) : [];
    const base = {
      now,
      live: org.live,
      squadMode: features.squadMode,
      attendance: features.attendance,
      adminGroupLinked: !!org.adminGroupId,
      billingPaused: org.billingPaused,
      readyTime,
      alreadySent: firstTeamsAlreadySent(org.id, args.sentKeys),
      match: next ? { date: next.date, status: next.status, confirmed: confirmed.length, maxPlayers: next.maxPlayers } : null,
    };
    if (!firstTeamsPrecheck(base).due || !next) return none;
    if (!args.piCaps.adminGroup) return none;

    const full = confirmed.length >= next.maxPlayers;
    const pasteApplied = full
      ? false
      : !!(await db.adminSquadProposal.findFirst({ where: { orgId: org.id, matchId: next.id, outcome: "applied" }, select: { id: true } }));
    if (!full && !pasteApplied) return none;
    const anyProposal = !!(await db.adminTeamProposal.findFirst({ where: { orgId: org.id }, select: { id: true } }));
    const decision = decideFirstTeams({ ...base, pasteApplied, anyProposal });
    if (!decision.due) return none;

    const channel = await args.getChannel();
    // Only where the proposal itself will be posted: the admin group.
    if (!channel || !routesToGroup(channel)) return none;

    let seed: { anySeeded: boolean } | null = null;
    if (features.teamBalancing && !seedNudgeAlreadySent(org.id, args.sentKeys)) {
      const state = await loadSeedState(org.id, confirmed);
      const pool = state.manualNudge ? null : seedPoolUnseeded(state);
      if (pool?.unseeded) seed = { anySeeded: pool.count < pool.total };
    }
    const withSeed = seed !== null;
    const lang = channel.language ?? features.language;
    const instructions = await adminNoticeInstructions({
      channel,
      piCaps: args.piCaps,
      sentKeys: args.sentKeys,
      now,
      key: (who) => firstTeamsKey(org.id, who, withSeed),
      notice: {
        nextPath: withSeed ? SEED_RATINGS_PATH : null,
        text: (link) =>
          buildFirstTeamsNotice({
            lang,
            matchDate: next.date,
            readyTime,
            confirmed: confirmed.length,
            maxPlayers: next.maxPlayers,
            organisers,
            seed: seed ? { anySeeded: seed.anySeeded, link } : null,
          }),
      },
    });
    return { instructions, withSeed: withSeed && instructions.length > 0 };
  } catch (err) {
    console.error(`[admin-onboarding] org ${org.id}: first-teams not computed on this poll:`, err instanceof Error ? err.message : err);
    return none;
  }
}

export type MarkAdminOnboardingResult =
  | { status: "no-club"; arg: string }
  | { status: "dry-run" | "marked"; orgId: string; club: string; keys: string[]; alreadyClaimed: string[] };

/**
 * scripts/mark-admin-onboarding-sent.ts: claim both notices for a club its
 * manager has already told by hand (FNF, 2026-10-15), so neither is ever
 * sent. Dry run by default; `apply` writes the claims. Idempotent.
 */
export async function markAdminOnboardingSent(args: { arg: string; apply: boolean }): Promise<MarkAdminOnboardingResult> {
  const org = await db.organisation.findFirst({
    where: { OR: [{ id: args.arg }, { slug: args.arg }] },
    select: { id: true, name: true },
  });
  if (!org) return { status: "no-club", arg: args.arg };
  const keys = adminOnboardingClaimKeys(org.id);
  const existing = await db.sentNotification.findMany({ where: { key: { in: keys } }, select: { key: true } });
  const alreadyClaimed = existing.map((r) => r.key);
  if (!args.apply) return { status: "dry-run", orgId: org.id, club: org.name, keys, alreadyClaimed };
  await db.sentNotification.createMany({
    data: keys.map((key) => ({ key, kind: ADMIN_ONBOARDING_KIND })),
    skipDuplicates: true,
  });
  return { status: "marked", orgId: org.id, club: org.name, keys, alreadyClaimed };
}
