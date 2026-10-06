/**
 * Server-side brain for the WhatsApp bot. Computes every message the bot
 * should post right now for a given org, with stable idempotency keys so
 * nothing fires twice.
 *
 * The Pi bot polls `/api/whatsapp/due-posts?groupId=X` every ~5 minutes,
 * receives a list of instructions, executes each one, then ACKs with
 * `/api/whatsapp/ack` so we record a `SentNotification` row against the key.
 *
 * Adding a new notification kind = add a new block to `computeDuePosts()`.
 * Bot code doesn't change.
 *
 * All times assumed to be in UK local (Europe/London) because that's where
 * Sutton FC plays. Hour comparisons use a tiny helper that converts a UTC
 * Date to London wall-clock hour — DST-safe.
 */
import { db } from "./db";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { appUrl } from "./app-url";
import { buildShortMagicLinkUrl } from "./short-link";
import {
  adminGroupJobInstruction,
  adminNoticeInstructions,
  loadAdminChannel,
  type LoadedAdminChannel,
} from "./admin-channel";
import type { PiCaps } from "./admin-channel-rules";
import { getOrgFeatures, type OrgFeatures } from "./org-features";
import { formatLondon } from "./london-time";
import { evaluateFollowupGuard } from "./tentative-followup";
import {
  RECRUIT_CHASE_AFTER_MS,
  ATTENDANCE_ISH_INTENTS,
  buildRecruitChaseText,
  isMatchChaseable,
  isSociableChaseHour,
  recruitChaseKey,
  shouldChaseRecruit,
} from "./recruit-chase";
import { composeChaseText, type ChaseKind } from "./message-analyzer";
import { resolveTeamLabels } from "./team-labels";
import {
  buildDirectPayCollectorNudge,
  buildFeeAskDm,
  buildFeeConfirmPrompt,
  buildPayChaseDm,
  buildRatingDm,
  buildRatingReminderDm,
  buildTentativeFollowupDm,
} from "./dm-copy";
import { isNextUpcomingForPosting } from "./next-upcoming-match";
import { isSameRecurringFixture } from "./match-slot";
import { buildMomAnnouncement } from "./mom-announcement";
import { computeBadgeAnnouncements } from "./badge-announcement-scheduler";
import {
  buildBenchOfferGroupPost,
  buildBenchOfferDm,
  buildBenchIntroLine,
  buildSquadCompleteBenchInvite,
} from "./bench-offer-copy";
import { buildRatePromoPost, buildMatchDayChaseFallback, teamSheetNames } from "./group-copy";
import { dayCommaTimeLabel, dayLabel, dayTimeLabel, longDayTimeLabel, weekdayLabel, weekdayTimeLabel } from "./i18n/dates";
import {
  dropOutDeadlineFor,
  dropOutReminderDue,
  hasWeeklyRhythm,
  listPublishDue,
  weeklyDeadlinesFor,
} from "./weekly-deadlines";
import { normaliseLang, type Lang } from "./i18n/lang";
import {
  RECRUIT_ACK_KIND,
  ROSTER_QUIET_MS,
  ROSTER_SHOWN_KIND,
  hasRosterBlock,
  recruitAckRecently,
  rosterShownRecently,
  squadFingerprint,
  stripRosterBlock,
  type QuietMarkerRow,
} from "./roster-shown";
import { summariseUnpaid, unpaidFollowUpDue } from "./unpaid-rules";
import { recordOpsEvent } from "./ops-alerts";
import {
  feeAskKeys,
  isMonthlyRow,
  loadPaygPool,
  loadRunningMonths,
  loadSchedulerMonths,
  monthForMatch,
  weekListKeyPrefix,
  weekMembers,
  type RunningMonth,
} from "./monthly-week";
import {
  buildWeekList,
  decideListPost,
  weekListHash,
  type WeekMember,
  type WeekStatus,
} from "./monthly-week-rules";
import { buildPaygPoolDm, buildPaygPoolGroupPost, buildWeekListPost } from "./monthly-week-copy";
import { londonMonthStart } from "./squad-month-rules";
import {
  buildAnnounceMatchPost,
  buildAskScorePost,
  buildBenchOfferContext,
  buildBotIntro,
  buildChasePreKickoffFallback,
  buildDailyInListFallback,
  buildDropOutReminderPost,
  buildGearReminder,
  buildListPublishedPost,
  buildMatchDayLockedPost,
  buildMatchDayTeamsBlock,
  buildPaymentPollQuestion,
  buildPreKickoffShortFallback,
  buildRollingAnnouncePost,
  buildRollingDeadlineLine,
  buildSquadFullEveningPost,
  buildSquadRosterBlock,
  buildUnpaidGroupReminder,
  buildUnpaidTailText,
} from "./scheduler-copy";

// All user-facing times in bot-posted messages are Europe/London wall
// clock. Wrap date-fns-tz in a short helper so this file reads cleanly.
function format(d: Date, pattern: string): string {
  return formatLondon(d, pattern);
}

// ───────── Same-sport helpers for switch/cancel-format nudges ────────

/** Find the activity with the smallest playersPerTeam in the same sport
 *  family (e.g. "Football") and smaller than `currentPpt`. Used to offer
 *  a 7-a-side → 5-a-side switch when the squad is short. `isActive` is
 *  not a gate — admins call the venue (Goals etc.) to rebook and flip
 *  the match in the app whenever they want; this helper just surfaces
 *  what's configured for the org. */
async function findSmallerSameSportActivity(
  orgId: string,
  currentSportId: string,
  currentPpt: number,
) {
  const currentSport = await db.sport.findUnique({
    where: { id: currentSportId },
    select: { name: true },
  });
  if (!currentSport) return null;
  const family = currentSport.name.split(" ")[0];
  const acts = await db.activity.findMany({
    where: { orgId },
    include: { sport: true },
  });
  return (
    acts
      .filter((a) => a.sport.name.split(" ")[0] === family && a.sport.playersPerTeam < currentPpt)
      .sort((a, b) => a.sport.playersPerTeam - b.sport.playersPerTeam)[0] ?? null
  );
}

/** Smallest `playersPerTeam` for any activity in this org with the same
 *  sport family as the current activity. Used to decide the cancellation
 *  threshold — e.g. if Football 5-a-side exists, the min viable roster is
 *  10; if only 7-a-side exists, it's 14. */
async function findSmallestSameSportPpt(
  orgId: string,
  currentSportId: string,
  currentPpt: number,
): Promise<number> {
  const currentSport = await db.sport.findUnique({
    where: { id: currentSportId },
    select: { name: true },
  });
  if (!currentSport) return currentPpt;
  const family = currentSport.name.split(" ")[0];
  const acts = await db.activity.findMany({
    where: { orgId },
    include: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const matching = acts.filter((a) => a.sport.name.split(" ")[0] === family);
  if (matching.length === 0) return currentPpt;
  return Math.min(...matching.map((a) => a.sport.playersPerTeam));
}

// ────────────────────────────── Instructions ──────────────────────────────

export type DueInstruction =
  | {
      kind: "group-message";
      key: string;           // idempotency key
      text: string;
      matchId?: string;
      /** Optional — phone numbers (no +) to tag as real WhatsApp mentions. */
      mentions?: string[];
      /** Badges post only (`badge-announcement-scheduler.ts`): the ledger
       *  rows /api/whatsapp/due-posts writes in the same transaction as
       *  the claim. Server-side; stripped before the Pi sees it. */
      badgeLedger?: { userId: string; badgeKey: string; matchId: string }[];
      /** Set when this post carries the squad roster (`roster-shown.ts`):
       *  /api/whatsapp/due-posts records it when it hands the post out,
       *  so the next scheduled post does not list the same squad again.
       *  Server-side; stripped before the Pi sees it. */
      rosterShown?: { fingerprint: string };
    }
  | {
      kind: "group-poll";
      key: string;
      question: string;
      options: string[];
      multi?: boolean;
      matchId?: string;
    }
  // Note: `group-message` + `dm` accept an optional `mentions` array of
  // phone numbers (without +). When present, the bot passes them as
  // whatsapp-web.js mentions so @-prefixed phone numbers in the text
  // become real tagged mentions (notification + clickable). The bot
  // released before this field exists just ignores the extra field
  // — the text renders as plain @-prefixed names.
  | {
      kind: "dm";
      key: string;
      phone: string;         // E.164, no + prefix when the bot uses it as JID
      text: string;
      matchId?: string;
      targetUser?: string;
    }
  | {
      kind: "bench-prompt";
      key: string;
      phone: string;
      text: string;          // the posted group message (@mentions the user)
      matchId: string;
      userId: string;
      // Bot must ACK with the waMessageId so the reaction-watcher can find it.
    }
  | {
      // Retroactively replace the bot's reaction on an existing message.
      // Used when a player's slot changes after their IN was already
      // reacted to (drop-and-shift, slot-emoji rule fixes, historical
      // corrections). The bot calls msg.react(emoji) which swaps any
      // prior reaction the bot account placed on that message.
      // Older bot builds without this kind will skip the instruction;
      // server emits whatever's queued and ACKs only resolve once a
      // bot version that knows the kind reports back.
      kind: "update-reaction";
      key: string;            // `retro-react-<id>`
      waMessageId: string;
      emoji: string;
    }
  | {
      // Slice 2a (2026-09-30): a post in the club's linked ADMIN group,
      // not its community group, so it carries its own group id. Emitted
      // only when the polling Pi sent `x-mt-pi-caps: admin-group`; the Pi
      // sends it only to a group in its admin-group set. Built by
      // src/lib/admin-channel.ts, never here.
      kind: "admin-group-message";
      key: string;
      groupId: string;
      text: string;
      matchId?: string;
    };

export interface DuePostsResult {
  instructions: DueInstruction[];
  waGroupId: string;
  orgId: string;
}

// ───────────── Post-match deadlines, and the lookback they need ───────────
//
// READ BOTH SIDES BEFORE CHANGING EITHER. The scheduler can only act on a
// match while `getMatchesForScheduler` still loads it, and a COMPLETED
// match is loaded for `POST_MATCH_LOOKBACK_DAYS` after kickoff. Every
// deadline below is measured from kickoff as well, so the invariant is:
//
//     every post-match deadline  <  POST_MATCH_LOOKBACK_DAYS
//
// Break it and the work does not fail, it becomes unreachable: no error,
// no log, nothing posted, ever. That is exactly how Sutton FC's 15 Sept
// 2026 Man of the Match result was lost. The lookback was 6 days, the
// backstop fired 5 days after the match inside a single 15:00 to 16:00
// hour, the bot was down across the only window, and by the time it came
// back the match had dropped out of the query. One day of margin between
// two numbers nobody had written down together.
// `src/lib/__tests__/mom-announcement-recovery.test.ts` pins the
// relationship, so narrowing one side alone turns the suite red.

/** Days after kickoff at which the MoM backstop becomes due. */
export const MOM_BACKSTOP_DAYS = 5;
/**
 * London hours the backstop may speak in, 15:00 up to 20:59. It used to
 * be 15:00 to 15:59, one chance a day; an outage across it lost the
 * announcement. 15:00 is still the earliest it will ever speak, and 21:00
 * is the same civil cutoff the early trigger uses, so the group is never
 * woken up by a result.
 */
export const MOM_BACKSTOP_FROM_HOUR = 15;
export const MOM_BACKSTOP_TO_HOUR = 21;
/** Civil hours for the EARLY trigger, 09:00 up to 20:59. Unchanged. */
const MOM_EARLY_FROM_HOUR = 9;
const MOM_EARLY_TO_HOUR = 21;
/**
 * Hard stop for a MoM announcement, in days after kickoff.
 *
 * Why 9. It has to be comfortably more than `MOM_BACKSTOP_DAYS` or the
 * backstop gets no second chance at all, which is the bug this constant
 * exists to close; 9 leaves four clear days of retry after the first
 * backstop afternoon, against a real outage of 46 hours. It cannot be
 * open ended either: a fortnight-old result is not news, and the club
 * plays weekly so the group would read it as this week's match. The
 * common weekly case is handled more precisely by the next-fixture stop
 * in section 6e (we go quiet as soon as the following fixture has been
 * played, usually day 7); this cap is the outer bound for a club whose
 * next fixture is further off or not scheduled at all.
 */
export const MOM_ANNOUNCE_MAX_AGE_DAYS = 9;
/**
 * Deadline for the match-end money flow (the payment poll, the
 * collector's fee ask, the daily pay chase), in days after kickoff.
 *
 * 6 is not a new rule: it is the bound the old 6 day lookback imposed on
 * these three by accident. It is written down so that widening the
 * lookback for the MoM announcement does not silently start posting a
 * payment poll for a week-old match or extend the chase to the 10 days
 * its own comment claims. Extending how long we chase people for money is
 * a product decision, not a side effect of a scheduling fix.
 */
export const POST_MATCH_END_FLOW_MAX_AGE_DAYS = 6;
/**
 * How far back `getMatchesForScheduler` loads COMPLETED matches. One day
 * of slack past the longest deadline above, so a match is still in hand
 * for the whole life of its last piece of work.
 */
export const POST_MATCH_LOOKBACK_DAYS = MOM_ANNOUNCE_MAX_AGE_DAYS + 1;

// ────────────────────────────── Time helpers ──────────────────────────────

/** Hour-of-day 0-23 in Europe/London, DST-safe. */
function londonHour(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  }).formatToParts(at);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

/**
 * Compose a short "don't forget to pay" paragraph for the daily 17:00
 * chase. Returns null when there's nothing honest to report:
 *   - no recent completed match
 *   - everyone ticked the payment poll (nothing to nag about)
 *   - NOBODY has ticked yet — could mean nobody paid, but more likely
 *     means the poll fired before our paid-tracking was live, or the
 *     votes failed to ACK back to the server. In that case "N unpaid"
 *     is false precision. Wait for the first real payment event to
 *     arrive before chasing.
 */
async function buildUnpaidTail(
  activityId: string,
  lang: Lang,
): Promise<{ text: string; mentions: string[] } | null> {
  const lastCompleted = await db.match.findFirst({
    where: { activityId, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      activity: {
        select: {
          orgId: true,
          org: {
            select: { paymentHolderId: true, paymentTrackingEnabled: true },
          },
        },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
      paymentCredits: { select: { count: true } },
    },
  });
  if (!lastCompleted) return null;
  // Org-level kill switch — skip the unpaid tail entirely when the
  // org has opted out of payment tracking. Poll still posts at
  // match-end (gated separately by Match.postMatchEndFlow); only
  // the chase + tracking side-effects go silent.
  if (!lastCompleted.activity.org.paymentTrackingEnabled) return null;

  // The rule lives in `summariseUnpaid` (unpaid-rules.ts) since
  // 2026-10-01, unchanged, so the admin unpaid list (U1) and the
  // weekly-rhythm group reminder count exactly as this tail does:
  //   - the payment holder is left out: they collect the fees, and
  //     chasing them would be embarrassing (null means nobody is left out
  //     until an admin sets one in /admin/settings or onboarding);
  //   - bulk credits ("Amir paid for 4 players") come off the count, for
  //     players whose own Attendance rows are not marked;
  //   - no signal (nobody paid, no credit) or nobody owing: null. False
  //     precision is worse than silence.
  const summary = summariseUnpaid({
    // A regular's row is paid for by the month (monthly squad, slice 5):
    // never unpaid. No club on "weekly" has such a row.
    confirmed: lastCompleted.attendances.filter((a) => !isMonthlyRow(a)),
    payerId: lastCompleted.activity.org.paymentHolderId ?? null,
    creditCount: lastCompleted.paymentCredits.reduce((s, c) => s + c.count, 0),
  });
  if (!summary) return null;
  const unpaid = summary.unpaid;

  // Poll-only format per Sait's suggestion (2026-04-25). No naming,
  // no shaming — point everyone at the original payment poll. Anyone
  // who's already paid clears themselves by ticking their team. The
  // poll-vote → paidAt wiring takes care of the rest.
  const text = buildUnpaidTailText(unpaid, lang);
  // No mentions needed — we don't tag anyone in the poll-only style.
  const mentions: string[] = [];
  return { text, mentions };
}

// `buildSquadRosterBlock` and `buildMatchDayTeamsBlock` moved verbatim to
// `./scheduler-copy.ts` (pure, no Prisma) on 2026-09-17 so the golden
// snapshot can pin their bytes. Same words, same layout.

/** Date-only key for "daily X" idempotency (YYYY-MM-DD in London). */
function londonDateKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

/**
 * One-time introductory message posted on the org's first active
 * activity. Built from the org's ENABLED feature modules only — a
 * group running just MoM + ratings must not be promised attendance /
 * bench / teams / payments it'll never see. No hardcoded owner name
 * (was "Ask @Kemal" — Sutton-specific; other groups have their own
 * admins). Kemal flagged 2026-05-19: any static Sutton value has to
 * become per-group dynamic.
 */
function botIntroMessage(f: OrgFeatures): string {
  // The words live in `scheduler-copy.ts` (pure, golden-pinned) and
  // come from the string table for the org's language.
  return buildBotIntro(
    f,
    buildBenchIntroLine({ lang: f.language, organiser: f.benchPickMode === "organiser" }),
    f.language,
  );
}

// ─────────────────────────── Main entry point ─────────────────────────────

export async function computeDuePosts(
  groupId: string,
  /** TEST-ONLY clock override — the e2e suite passes a fixed instant
   *  (via the x-test-now header on /api/whatsapp/due-posts, gated on
   *  MT_TEST_MODE) so time-of-day windows (rate-dm from 08:00 onward,
   *  reminder 18-19) are deterministic. Never set in prod. */
  nowOverride?: Date,
  /** What the polling Pi said it can do (`x-mt-pi-caps`, slice 2a). An
   *  older Pi sends nothing: no admin-group posts are emitted for it, and
   *  admin notices fall back to the owner by DM. */
  piCaps: PiCaps = { adminGroup: false },
  /** A monthly club's running months, when the caller (the due-posts
   *  route's sweep) has just read them. Null or omitted: read here. */
  preloadedMonths: RunningMonth[] | null = null,
  /** A monthly club's live months (sign-up, slice 3), when the due-posts
   *  route's sweep has just read them. Null or omitted: read here. */
  preloadedLiveMonths: import("./month-signup").SignupMonth[] | null = null,
): Promise<DuePostsResult | null> {
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
  });
  if (!org) return null;

  const now = nowOverride ?? new Date();
  const out: DueInstruction[] = [];

  // The club's admin channel (slice 2a), read at most once per poll and
  // only when an admin notice is actually due, exactly as the admin list
  // used to be.
  let adminChannel: LoadedAdminChannel | null | undefined;
  const getAdminChannel = async (): Promise<LoadedAdminChannel | null> => {
    if (adminChannel === undefined) adminChannel = await loadAdminChannel(org.id);
    return adminChannel;
  };
  const admin: AdminNoticeContext = { piCaps, getChannel: getAdminChannel };

  // Pull every already-sent notification we might care about: those linked
  // to this org's matches, plus any org-wide notifications (matchId=null)
  // keyed by orgId.
  const sent = await db.sentNotification.findMany({
    where: {
      OR: [
        { match: { activity: { orgId: org.id } } },
        { key: { startsWith: `org-${org.id}:` } },
      ],
    },
    select: { key: true },
  });
  const sentKeys = new Set(sent.map((s) => s.key));

  // ── Org-level: one-time bot introduction ─────────────────────────────
  // Fires once per org, the first time the org has at least one active
  // activity AND the bot is enabled. Explains what MatchTime is and how
  // the flow works so group members aren't confused by bot posts.
  {
    const introKey = `org-${org.id}:bot-intro`;
    if (!sentKeys.has(introKey)) {
      const hasActiveActivity = await db.activity.count({
        where: { orgId: org.id, isActive: true },
      });
      if (hasActiveActivity > 0) {
        out.push({
          kind: "group-message",
          key: introKey,
          text: botIntroMessage(await getOrgFeatures(org.id)),
        });
      }
    }
  }

  // ── Provisional-member review DM for admins ─────────────────────────
  // When the analyzer auto-creates Memberships for unknown group senders
  // (see api/whatsapp/analyze/route.ts createProvisionalByName), admins
  // need to review them — set phone, position, seed rating, or remove if
  // not a player. DM each admin once per day while there are unresolved
  // provisional members pending. Idempotency key includes the date and
  // the admin ID so tomorrow's DM fires fresh.
  {
    const provisional = await db.membership.findMany({
      where: { orgId: org.id, provisionallyAddedAt: { not: null }, leftAt: null },
      include: { user: { select: { name: true } } },
      orderBy: { provisionallyAddedAt: "desc" },
      take: 10,
    });
    const channel = provisional.length > 0 ? await getAdminChannel() : null;
    if (channel) {
      const todayKey = formatLondon(now, "yyyy-MM-dd");
      const names = provisional
        .map((p) => p.user.name)
        .filter(Boolean)
        .slice(0, 5)
        .join(", ");
      const more = provisional.length > 5 ? ` (+${provisional.length - 5} more)` : "";
      const count = `${provisional.length} ${provisional.length === 1 ? "person was" : "people were"}`;
      // Through the admin channel (slice 2a). The DM is today's text, byte
      // for byte, with each admin's own signed-in link that names the club
      // (2026-09-30). In an admin group: the plain URL, once.
      out.push(
        ...(await adminNoticeInstructions({
          channel,
          piCaps,
          sentKeys,
          now,
          key: (who) => `org-${org.id}:provisional-review:${who}:${todayKey}`,
          notice: {
            nextPath: "/admin/players",
            text: (link, audience) =>
              audience === "dm"
                ? `✨ *New players to review*: ${count} auto-added after posting in the group:\n\n` +
                  `${names}${more}\n\n` +
                  `Tap to review and set phone/position/rating, or remove:\n${link}\n\n` +
                  `Or open: ${appUrl("/admin/players")}`
                : `✨ *New players to review*: ${count} auto-added after posting in the group:\n\n` +
                  `${names}${more}\n\n` +
                  `Review them and set phone, position and rating, or remove them:\n${link}`,
          },
        })),
      );
    }
  }

  // ── Ad-hoc admin-queued BotJobs (test DMs, one-off messages) ────────
  // Any unsent row is emitted as a matching instruction; idempotency key
  // is `botjob-${id}` so ACK marks sentAt via the existing flow + our
  // separate BotJob update below (see /api/whatsapp/ack).
  {
    const jobs = await db.botJob.findMany({
      where: {
        orgId: org.id,
        sentAt: null,
        // Future-dated personal reminders (sendAfter > now) are NOT yet
        // due — skip them until their time passes. Immediate jobs have
        // sendAfter = null and always pass this filter.
        OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const job of jobs) {
      const key = `botjob-${job.id}`;
      if (sentKeys.has(key)) continue;
      if (job.kind === "dm" && job.phone) {
        out.push({
          kind: "dm",
          key,
          phone: job.phone,
          text: job.text,
        });
      } else if (job.kind === "group") {
        out.push({
          kind: "group-message",
          key,
          text: job.text,
        });
      } else if (job.kind === "admin-group") {
        // An admin notice queued for the admin group (slice 2a,
        // `sendAdminNotice`). Where it goes is decided now, when we know
        // whether this Pi can post there; held overnight; otherwise the
        // owner by DM, so it is never swallowed.
        const channel = await getAdminChannel();
        const instr = channel ? adminGroupJobInstruction(job, channel, piCaps, now) : null;
        if (instr) out.push(instr);
      } else if (job.kind === "group-poll" && job.pollQuestion && job.pollOptions.length >= 2) {
        // Ad-hoc admin-queued poll (e.g. feedback polls). Reuses the
        // same `botjob-<id>` ack key so sentAt clears on delivery.
        out.push({
          kind: "group-poll",
          key,
          question: job.pollQuestion,
          options: job.pollOptions,
          multi: job.pollMulti,
        });
      }
    }
  }

  // ── Tentative-availability follow-up DMs ─────────────────────────────
  // A player who signalled UNCERTAIN availability ("maybe, will confirm
  // later", "in if my back holds up") was recorded as a MAYBE for a match
  // with a dueAt = kickoff − 24h (see lib/tentative-followup.ts). When a
  // row falls due we re-check the player's CURRENT state (the send-time
  // guard): if they've since confirmed/dropped, the squad is full, or the
  // match completed/cancelled, the question is moot — resolve the row
  // silently and DON'T DM. Otherwise DM them a short, PII-safe nudge for a
  // firm IN/OUT. Idempotency key `<matchId>:tentative-followup:<userId>`;
  // notifiedAt is stamped on ACK so it fires exactly once.
  {
    const dueRows = await db.tentativeAvailability.findMany({
      where: {
        resolvedAt: null,
        notifiedAt: null,
        dueAt: { lte: now },
        match: { activity: { orgId: org.id } },
      },
      include: {
        user: { select: { id: true, name: true, phoneNumber: true } },
        match: {
          select: {
            id: true,
            date: true,
            status: true,
            maxPlayers: true,
            // The match's org language: the follow-up is written in it.
            activity: { select: { name: true, org: { select: { language: true } } } },
          },
        },
      },
      orderBy: { dueAt: "asc" },
      take: 20,
    });
    // Per-category opt-out: players with subTentativeDm=false asked not to
    // get the "you were a maybe — in or out?" nudge. Default is subscribed.
    const tentativeOptedOut =
      dueRows.length > 0
        ? new Set(
            (
              await db.membership.findMany({
                where: { orgId: org.id, subTentativeDm: false },
                select: { userId: true },
              })
            ).map((mem) => mem.userId),
          )
        : new Set<string>();
    for (const row of dueRows) {
      const key = `${row.match.id}:tentative-followup:${row.user.id}`;
      if (sentKeys.has(key)) continue;
      if (tentativeOptedOut.has(row.user.id)) continue; // opted out of tentative DMs

      // Send-time guard: re-check current state. Resolve-and-skip when the
      // question is moot; only DM genuinely-unresolved players.
      const confirmedCount = await db.attendance.count({
        where: { matchId: row.match.id, status: "CONFIRMED" },
      });
      const att = await db.attendance.findUnique({
        where: { matchId_userId: { matchId: row.match.id, userId: row.user.id } },
        select: { status: true },
      });
      const decision = evaluateFollowupGuard({
        matchStatus: row.match.status,
        attendanceStatus: att?.status ?? null,
        confirmedCount,
        maxPlayers: row.match.maxPlayers,
      });
      if (decision === "skip") {
        // Moot — mark resolved so it never re-evaluates or DMs.
        await db.tentativeAvailability
          .update({ where: { id: row.id }, data: { resolvedAt: now } })
          .catch(() => {});
        continue;
      }

      // No phone on record → can't DM. Leave the row open (an admin can
      // chase) rather than spam the group; don't resolve.
      if (!row.user.phoneNumber) continue;

      out.push({
        kind: "dm",
        key,
        targetUser: row.user.id,
        phone: row.user.phoneNumber.replace(/^\+/, ""),
        matchId: row.match.id,
        text: buildTentativeFollowupDm({
          playerName: row.user.name,
          activityName: row.match.activity.name,
          whenLabel: dayTimeLabel(row.match.activity.org.language, row.match.date),
          lang: row.match.activity.org.language,
        }),
      });
    }
  }

  // ── Retroactive reactions ───────────────────────────────────────────
  // Queued by registerAttendance (and ad-hoc cleanup scripts) when a
  // prior IN message's slot emoji needs to change. Emit each unsent
  // row; ACK via key `retro-react-<id>` (see /api/whatsapp/ack).
  {
    const retros = await db.retroReaction.findMany({
      where: { orgId: org.id, sentAt: null },
      orderBy: { createdAt: "asc" },
      take: 30,
    });
    for (const r of retros) {
      const key = `retro-react-${r.id}`;
      if (sentKeys.has(key)) continue;
      out.push({
        kind: "update-reaction",
        key,
        waMessageId: r.waMessageId,
        emoji: r.emoji,
      });
    }
  }

  // Load all matches we care about: everything still upcoming, plus every
  // COMPLETED match young enough that post-match work (MoM announcement,
  // rating reminders, the money flow) can still be due on it. The length
  // of this lookback is not free-standing: see the deadline block near
  // the top of this file for the invariant it has to satisfy.
  const windowStart = new Date(now.getTime() - POST_MATCH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const matches = await getMatchesForScheduler(org.id, windowStart);

  // Read ONCE, before the per-match loop, and used twice: the 17:00
  // full-squad post needs `features.bench` while it composes (a post
  // that promises to tag the bench where the scheduler never posts a
  // bench tag would be a lie, and the post-compute filter below can
  // only drop a whole instruction, not a paragraph of one), and the
  // filter itself needs the same object. Moved up from the filter on
  // 2026-09-17; it is a pure read either way, so nothing else changes.
  const features = await getOrgFeatures(org.id);

  // MONTHLY SQUAD (slice 5, 2026-10-06): a club on "monthly" reads its
  // running months once per poll. A club on "weekly" (Sutton FC, and every
  // club before this) makes no query here and every match below gets
  // `null`, which is every branch exactly as it was.
  //
  // If the month's rows cannot be read, a monthly club gets NO posts on
  // this poll rather than its weekly-shaped ones (a payment poll to the
  // regulars, a roster beside the list): the next poll retries, and the
  // failure is recorded on /admin/health. The poll never throws for it.
  let runningMonths: Awaited<ReturnType<typeof loadRunningMonths>> = [];
  if (features.squadMode === "monthly") {
    try {
      // Slice 6: with the months closed lately, so the after-match gates
      // of a month's last game (no payment poll, no "how much each?")
      // outlive the close the morning after it.
      runningMonths = preloadedMonths ?? (await loadSchedulerMonths(org.id, now));
    } catch (err) {
      console.error(`[scheduler] org ${org.id}: the running months could not be read; no posts on this poll:`, err);
      await recordOpsEvent({
        orgId: org.id,
        kind: "monthly-squad",
        severity: "warning",
        title: "Monthly squad: the month could not be read",
        detail: `Scheduled posts were skipped for one poll because the club's running month could not be loaded: ${String(
          (err as Error)?.message ?? err,
        ).slice(0, 300)}`,
        dedupeKey: `months-unreadable:${formatLondon(now, "yyyy-MM-dd")}`,
        now,
      });
      return { instructions: [], waGroupId: groupId, orgId: org.id };
    }
  }

  // MONTHLY SQUAD (slice 3, 2026-10-06): the month's SIGN-UP list, for a
  // month that is "open" (MDs/monthly-squad-plan-2026-10-05.md, 4.1). One
  // message per month, when the list differs from the one the group last
  // saw, at most every 30 minutes, 08:00 to 21:59 London
  // (`decideSignupListPost`). Its keys are `org-<id>:msu:list:`, never the
  // weekly list's `<matchId>:month-list:`. A club on "weekly" makes no
  // query here. A failure costs this one post, never the poll.
  let signupMonths: Array<{ id: string; monthStart: string; fixture: { orgId: string; venue: string; dayOfWeek: number } }> = [];
  if (features.squadMode === "monthly") {
    // The club's live months: the sweep's, else ONE read here for both
    // the sign-up list and the payment posts.
    let liveMonths = preloadedLiveMonths;
    try {
      const { signupListPosts, loadLiveMonths } = await import("./month-signup");
      liveMonths ??= await loadLiveMonths(org.id, now);
      const signup = await signupListPosts(org.id, now, liveMonths);
      signupMonths = signup.months;
      for (const p of signup.posts) out.push({ kind: "group-message", key: p.key, text: p.text });
    } catch (err) {
      console.error(`[scheduler] org ${org.id}: the sign-up list could not be computed on this poll:`, err);
    }
    // Slice 4 (plan 4.2 and 4.3): the priced list (one post per price), the
    // group's count a day before the pay-by date, and a DM to each regular
    // who has not paid. Keys are `org-<id>:mpy:`; each is claimed when it
    // is handed out, so none is sent twice. Bank transfer only: nothing
    // here is a pay link. A club on "weekly" never reaches this.
    try {
      const { monthPaymentPosts } = await import("./month-payment");
      out.push(...(await monthPaymentPosts(org.id, now, liveMonths)));
    } catch (err) {
      console.error(`[scheduler] org ${org.id}: the month's payment posts could not be computed on this poll:`, err);
    }
  }

  for (const m of matches) {
    const found = runningMonths.length > 0 ? monthForMatch(runningMonths, m) : null;
    // A CLOSED month (slice 6) still answers for its played games, so they
    // get no payment poll after the close. It is never the month of a game
    // still to be played: nothing in the weekly flow runs for it any more.
    const month = found?.closed && (m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED") && m.date.getTime() > now.getTime() ? null : found;
    // A match of a month still in SIGN-UP (slice 3): no regulars are on it
    // yet and no week's list is posted, but it is a monthly match all the
    // same, so it is not announced or chased the weekly way.
    const signupMonth =
      !month && signupMonths.length > 0
        ? (signupMonths.find((x) => x.monthStart === londonMonthStart(m.date) && isSameRecurringFixture(x.fixture, m.activity)) ?? null)
        : null;
    const monthly: MonthlyMatchContext | null = month
      ? {
          monthId: month.id,
          seeded: m.rollingSeededAt != null && m.rollingSeededAt.getTime() >= month.createdAt.getTime(),
          members: weekMembers(month, m.id),
          paygPricePence: org.paygPricePence ?? null,
        }
      : signupMonth
        ? { monthId: signupMonth.id, seeded: false, signup: true, members: [], paygPricePence: org.paygPricePence ?? null }
        : null;
    await computeForMatch(m, now, sentKeys, out, groupId, matches, features, admin, monthly);
  }

  // ── Badge announcements (2026-10-01) ──────────────────────────────
  //   One post per match, 18:00 London two days after it, listing the
  //   badges newly earned and never announced. Skipped outright, with no
  //   query, when the club has the feature off; also caught by the
  //   key filter below. See badge-announcements.ts.
  if (features.badgeAnnouncements) {
    out.push(
      ...(await computeBadgeAnnouncements({
        orgId: org.id,
        lang: features.language,
        matches,
        sentKeys,
        now,
      })),
    );
  }

  // ── Per-org feature gate (post-compute filter) ───────────────────
  //   Sections compute as normal; here we drop any instruction whose
  //   capability is switched off for this org. Done as a single
  //   key-classified filter rather than threading flags through every
  //   section — zero control-flow risk to the live scheduler, one
  //   reviewable transform. Unknown / meta / org-scoped keys
  //   (bot-intro, admin DMs, ad-hoc BotJobs, retro-reactions) are
  //   NOT classified → always allowed (fail-open; they're not
  //   user-facing match features). This is how Amir's group runs
  //   MoM + ratings only.
  const featureForKey = (key: string): keyof typeof features | null => {
    const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    if (
      seg.startsWith("announce-match") ||
      seg.startsWith("rolling-announce") ||
      seg.startsWith("dropout-reminder") ||
      seg.startsWith("list-published") ||
      seg.startsWith("evening-update") ||
      seg.startsWith("chase-") ||
      seg.startsWith("pre-kickoff") ||
      seg.startsWith("cancel-nudge") ||
      seg.startsWith("switch-nudge") ||
      seg.startsWith("football-gear-reminder")
    )
      return "attendance";
    // The recruit chase-up says "still after N players", which is only
    // meaningful where capacity is tracked. A ratings-only org has zero
    // CONFIRMED rows by construction, so its squad would read as
    // permanently short and every invited player would be chased.
    if (seg.startsWith("recruit-chase")) return "attendance";
    // The month's list (slice 5) is the squad, so it follows attendance.
    if (seg.startsWith("month-list")) return "attendance";
    // So is the month's sign-up list (slice 3).
    if (seg.startsWith("msu:list")) return "attendance";
    if (seg.startsWith("bench-prompt")) return "bench";
    if (seg.startsWith("mom-")) return "momVoting";
    if (seg.startsWith("badges")) return "badgeAnnouncements";
    if (seg.startsWith("rate-")) return "playerRating";
    if (seg.startsWith("payment-")) return "paymentTracking";
    if (seg.startsWith("unpaid-")) return "paymentTracking";
    if (seg.startsWith("fee-ask")) return "paymentCollection";
    if (seg.startsWith("pay-chase")) return "paymentCollection";
    // ask-score is the "what was the final score?" prompt. Its sole
    // consumer is ELO recomputation, which only runs when teams were
    // generated — i.e. when teamBalancing is on. For rating-only orgs
    // (Sutton Lads 2026-05-28) the prompt's "I'll use it to update
    // everyone's rating for next week" is literally false — peer
    // ratings come from teammates, not from the score. Gate the
    // prompt out unless team balancing is enabled.
    if (seg.startsWith("ask-score")) return "teamBalancing";
    // Everything else: infrastructure / meta → allow.
    return null;
  };
  const gated = out.filter((instr) => {
    // The bench-prompt kind is bench regardless of key shape.
    if (instr.kind === "bench-prompt" && !features.bench) return false;
    const f = featureForKey(instr.key);
    return f === null ? true : features[f];
  });

  return { instructions: gated, waGroupId: groupId, orgId: org.id };
}

type MatchWithIncludes = Awaited<ReturnType<typeof getMatchesForScheduler>>[number];

/**
 * A match of a club on "monthly" that belongs to a RUNNING month (slice 5,
 * MDs/monthly-squad-plan-2026-10-05.md section 5). Null for every match
 * of a weekly club, and for a monthly club's match with no running month:
 * `computeForMatch` then does exactly what it did before monthly mode.
 */
interface MonthlyMatchContext {
  monthId: string;
  /** The month is still in sign-up (slice 3): its list is the sign-up
   *  list, and the cold "say IN" announcement must not go out beside it. */
  signup?: boolean;
  /** The month's regulars have been put onto this match. */
  seeded: boolean;
  members: WeekMember[];
  paygPricePence: number | null;
}

/** How long the PAYG fee question waits for a sent-ack before one re-ask. */
const FEE_REASK_AFTER_MS = 30 * 60 * 1000;

/** What a scheduled admin notice needs: the Pi's capabilities and the
 *  club's admin channel, loaded lazily once per poll (slice 2a). */
interface AdminNoticeContext {
  piCaps: PiCaps;
  getChannel: () => Promise<LoadedAdminChannel | null>;
}

async function getMatchesForScheduler(orgId: string, windowStart: Date) {
  return db.match.findMany({
    where: {
      activity: { orgId },
      isHistorical: false,
      OR: [
        { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
        { status: "COMPLETED", date: { gte: windowStart } },
      ],
    },
    include: {
      activity: {
        include: {
          sport: true,
          // Money-collector + payment-collection flag, for the
          // match-end "how much per player?" DM (gated below).
          org: {
            select: {
              paymentCollectionEnabled: true,
              paymentHolderId: true,
              // The weekly-rhythm unpaid reminder (2026-10-01) is gated on it.
              paymentTrackingEnabled: true,
              teamLabels: true,
              // The group's language: every static post below reads it.
              language: true,
              // Weekly deadlines (2026-09-30, slice 3): club level, resolved
              // per match by `weeklyDeadlinesFor`. All NULL for Sutton FC.
              dropOutDeadlineDay: true,
              dropOutDeadlineTime: true,
              listPublishDay: true,
              listPublishTime: true,
            },
          },
        },
      },
      attendances: { include: { user: { select: { id: true, name: true, phoneNumber: true } } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
      benchConfirmations: { where: { resolvedAt: null } },
      benchSlotOffers: { where: { resolvedAt: null } },
      // Bulk payment credits, for the weekly-rhythm unpaid reminder.
      paymentCredits: { select: { count: true } },
    },
    orderBy: { date: "asc" },
  });
}

// ───────────────────────────── Per-match compute ──────────────────────────

async function computeForMatch(
  m: MatchWithIncludes,
  now: Date,
  sentKeys: Set<string>,
  out: DueInstruction[],
  groupId: string,
  siblingMatches: MatchWithIncludes[],
  features: OrgFeatures,
  admin: AdminNoticeContext,
  /** Monthly squad, slice 5. Null: a weekly club, or no running month. */
  monthly: MonthlyMatchContext | null = null,
) {
  /**
   * LLM compose with a static fallback. If Claude is unavailable
   * (missing API key, network hiccup, rate-limited, etc.) we fall
   * back to whatever static text the call site provided — so the
   * chase always fires with *something*, just less rich.
   */
  async function composeOrFallback(
    kind: ChaseKind,
    staticFallback: () => string,
  ): Promise<string> {
    // ROLLING SQUAD (2026-09-30): fixed text, never the composer. Its
    // prompt knows nothing about a carried-over squad and would tell
    // players who are already in to "say IN". Using the static copy is
    // how slice 1 avoids a prompt change, and it removes up to four
    // model calls a week for the club. Clubs without the setting (Sutton
    // FC) keep the composer exactly as before.
    if (features.rollingSquad) return staticFallback();
    // MONTHLY SQUAD (slice 5): the same argument. The composer's prompt
    // knows nothing about a month's regulars, and no prompt is changed for
    // them, so a monthly match's scheduled chases use the fixed text.
    if (monthly) return staticFallback();
    try {
      const llm = await composeChaseText({ groupId, kind });
      if (llm && llm.trim().length > 0) return llm;
      // Degrade LOUDLY. composeChaseText swallows its own failures and
      // returns null, so for months this branch was the ONLY trace of a
      // permanently-dead composer — and it logged nothing at all. Every
      // scheduled chase quietly went out as plain static text.
      console.error(
        `[scheduler] DEGRADED: composeChaseText returned no text for ` +
          `kind=${kind} group=${groupId} — sending the STATIC chase copy ` +
          `instead of the composed roster/tentative/dropped summary.`,
      );
    } catch (err) {
      console.error(
        `[scheduler] DEGRADED: compose ${kind} threw for group=${groupId} — ` +
          `sending the STATIC chase copy instead of the composed ` +
          `roster/tentative/dropped summary.`,
        err,
      );
    }
    return staticFallback();
  }
  const matchId = m.id;
  const activity = m.activity;
  const sport = activity.sport;
  // THE GROUP'S LANGUAGE (`Organisation.language`), once per match. Read
  // defensively: the unit-test fixtures build `activity.org` by hand and
  // some omit it; Prisma always selects it. Unknown or missing is English,
  // and the English bytes are pinned by the golden snapshot.
  const lang: Lang = normaliseLang(activity.org?.language);
  const hoursUntilMatch = hoursBetween(now, m.date);
  const hoursSinceMatch = -hoursUntilMatch;

  // Cancelled matches never trigger anything further. Short-circuit.
  if (m.status === "CANCELLED") return;

  const confirmed = m.attendances
    .filter((a) => a.status === "CONFIRMED")
    .sort((a, b) => a.position - b.position);
  const bench = m.attendances
    .filter((a) => a.status === "BENCH")
    .sort((a, b) => a.position - b.position);
  const maxPlayers = m.maxPlayers;
  const need = Math.max(0, maxPlayers - confirmed.length);

  // ── THE SAME SQUAD IS NOT LISTED TWICE (2026-10-06) ──────────────────
  //   Sutton FC, Tue 6 Oct: the analyze reply posted the squad at 07:28
  //   and the morning chase posted the same thirteen names at 08:00. See
  //   `roster-shown.ts` for the markers. Read lazily and at most once per
  //   match per poll, and only by a post that is actually due.
  //   FAILS OPEN: if the read throws, nothing was "shown" and every post
  //   goes out with its roster, exactly as before this existed.
  const squadKey = squadFingerprint({
    confirmedUserIds: confirmed.map((a) => a.userId),
    benchUserIds: bench.map((a) => a.userId),
    maxPlayers,
  });
  /** What a post that DOES carry the roster hands to the dispatcher. */
  const rosterMark = { fingerprint: squadKey };
  let quietRows: Promise<QuietMarkerRow[]> | undefined;
  const loadQuietRows = (): Promise<QuietMarkerRow[]> =>
    (quietRows ??= db.sentNotification
      .findMany({
        where: {
          matchId: m.id,
          kind: { in: [ROSTER_SHOWN_KIND, RECRUIT_ACK_KIND] },
          createdAt: { gte: new Date(now.getTime() - ROSTER_QUIET_MS) },
        },
        select: { key: true, kind: true, createdAt: true },
      })
      .catch((err) => {
        console.error(`[scheduler] could not read the roster-shown markers for match ${m.id}:`, err);
        return [];
      }));
  /** Was this exact squad posted to the group in the last three hours? */
  const rosterJustShown = async (): Promise<boolean> =>
    rosterShownRecently(await loadQuietRows(), { matchId: m.id, fingerprint: squadKey, now });
  /**
   * A composed chase, minus its roster when the group has just seen it.
   * The composer always ends on the roster (its prompt says so, and no
   * prompt is changed for this), so the block is cut from the text it
   * returns: the need, the kickoff and the format-switch line stay.
   */
  async function chaseText(
    kind: ChaseKind,
    staticFallback: () => string,
  ): Promise<{ text: string; rosterShown?: { fingerprint: string } }> {
    const text = await composeOrFallback(kind, staticFallback);
    if (!hasRosterBlock(text)) return { text };
    if (!(await rosterJustShown())) return { text, rosterShown: rosterMark };
    // A text that was nothing but a roster: the fixed copy's lead instead.
    return { text: stripRosterBlock(text) || stripRosterBlock(staticFallback()) };
  }

  // ── 1. Announce the match ─────────────────────────────────────────────
  //     Two gates beyond "this match exists":
  //
  //     (a) Time-of-day window — only fire 09:00–12:59 London. The
  //         generate-matches cron now runs daily at 00:00 UTC = 01:00 BST,
  //         so without this gate the announcement landed at ~01:20 BST
  //         the moment the new match row was created. Middle-of-night
  //         posts wake people up.
  //     (b) "Is this actually the next match in this recurring fixture?" — when
  //         today's match is still UPCOMING/TEAMS_GENERATED/TEAMS_PUBLISHED
  //         and next week's match has just been created, only the
  //         current week's announcement should ever be live. Once
  //         today's match flips to COMPLETED the next morning's tick
  //         picks up the future one. Effect: the announcement always
  //         reads "next match" from the group's perspective, never
  //         "next-but-one".
  //     (c) Empty squad — this post is a cold open, so it must never land
  //         on a fixture people have already signed up for. Incident
  //         2026-09-06 (Sutton FC, live group): at 09:00 the bot
  //         announced the Tue 8 Sept match — "Say IN to join. First 14
  //         confirmed play", no roster, no count — when SIX players were
  //         already confirmed. To the group it read as though the squad
  //         had been wiped and everyone had to sign up again. No gate had
  //         misfired: the match was created 27 Aug, gate (b) correctly
  //         held the post while the 1 Sept match was still next, the bot
  //         was muted 1-5 Sept, and this was the first 09:00-13:00 window
  //         with the bot live. The post was simply the wrong message for
  //         the state. Kemal's call: "it shouldn't fire if the squad is
  //         non-empty as we already announce at 5pm" — the 17:00 evening
  //         update (§2) covers a fixture the moment anyone is in, and
  //         unlike this template it carries the roster and the real
  //         count. Suppression, not rewording.
  {
    const key = `${matchId}:announce-match`;
    const lh = londonHour(now);
    const inAnnounceWindow = lh >= 9 && lh < 13;
    // "Is this the next match in this recurring fixture?" — suppressed
    // when an earlier unplayed match in the same fixture (org/venue/
    // weekday — NOT activityId, which a format switch re-points) exists
    // (next-week rollover), OR when a co-timed duplicate/ghost with a
    // lower id exists anywhere in the org (format-switch defense).
    // Pure, unit-tested.
    const isNextUpcoming =
      m.status === "UPCOMING" && hoursUntilMatch > 24
        ? isNextUpcomingForPosting(siblingMatches, m)
        : false;

    // "Non-empty" means CONFIRMED, deliberately — not "confirmed or
    // bench". The announcement's only ask is "Say IN to join. First N
    // confirmed play", so the thing it invites people to become is a
    // confirmed player; while nobody holds a playing spot the ask is
    // still literally true and the group has been told nothing yet.
    // The odd case that separates the two definitions is a populated
    // bench with ZERO confirmed. That is degenerate — the bench only
    // fills once the squad is past maxPlayers, so it needs every
    // confirmed player to drop with no bench promotion behind them — and
    // in it announcing is still correct: the squad really is empty, N
    // players really are needed, and the bench players are not being
    // told their spot vanished (they keep it, and the 17:00 roster shows
    // it). Requiring an empty bench too would suppress the announcement
    // permanently on a fixture nobody is actually playing in.
    const squadEmpty = confirmed.length === 0;

    // ── 1-rolling. The rolling squad's announcement (2026-09-30, R1 of
    //    MDs/friday-group-features-plan-2026-09-30.md). Same window, same
    //    next-upcoming gate, its own key. Only when the squad was carried
    //    over onto this match AND at least one player was carried; with
    //    nobody carried the cold announcement below fires as today. When
    //    this one is due the cold one is not, so the group never gets both.
    //    A separate block with no `return`: nothing below is skipped.
    let rollingAnnounceDue = false;
    {
      const rollingKey = `${matchId}:rolling-announce`;
      if (
        features.rollingSquad &&
        m.rollingSeededAt != null &&
        !sentKeys.has(rollingKey) &&
        m.status === "UPCOMING" &&
        hoursUntilMatch > 24 &&
        inAnnounceWindow &&
        isNextUpcoming
      ) {
        const carried = await db.attendanceEvent.count({
          where: { matchId, cause: "rolling-squad" },
        });
        if (carried > 0) {
          rollingAnnounceDue = true;
          out.push({
            kind: "group-message",
            key: rollingKey,
            matchId,
            text: buildRollingAnnouncePost({
              activityName: activity.name,
              dateLabel: longDayTimeLabel(lang, m.date),
              venue: activity.venue,
              deadline: weekdayTimeLabel(lang, dropOutDeadlineFor(m, activity.org)),
              confirmed: confirmed.map((a) => a.user),
              bench: bench.map((a) => a.user),
              maxPlayers,
              // Slice 2b: an organiser-pick club says IN puts you on the
              // waiting list, and the organisers pick.
              organiserPicks: features.benchPickMode === "organiser",
              lang,
            }),
          });
        }
      }
    }

    if (
      !sentKeys.has(key) &&
      !rollingAnnounceDue &&
      m.status === "UPCOMING" &&
      hoursUntilMatch > 24 &&
      inAnnounceWindow &&
      isNextUpcoming &&
      squadEmpty &&
      // MONTHLY SQUAD (slice 3): not for a match of a month in sign-up.
      // "Say IN to join, first 14 play" beside the month's list would ask
      // the regulars to sign up twice. Undefined for every weekly club.
      !monthly?.signup
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: buildAnnounceMatchPost({
          activityName: activity.name,
          dateLabel: longDayTimeLabel(lang, m.date),
          venue: activity.venue,
          maxPlayers,
          lang,
        }),
      });
    }
  }

  // ── 2. Daily 17:00 evening update ────────────────────────────────────
  //     One post per day at 17:00, content varies by state:
  //       2-pre.     Match day, teams generated: the two line-ups
  //       2-pre-alt. Match day, squad full, no teams: roster + nudge
  //       2a.        Squad short (need > 0): chase + unpaid tail
  //       2b.        Squad full: the roster, the bench, an ask for more
  //                  benchers while the bench is under
  //                  `BENCH_THIN_BELOW`, + unpaid tail
  //     Exclusive branches via if/else-if so we never fire two 17:00
  //     group posts in the same day.
  {
    const dayKey = londonDateKey(now);
    const isEvening = londonHour(now) >= 17 && londonHour(now) < 18;
    const beforeDeadline = now < m.attendanceDeadline;
    // Pre-match: any state where the match still needs people in the
    // group thinking about it — covers UPCOMING (squad still forming),
    // TEAMS_GENERATED, and TEAMS_PUBLISHED (lineup is locked but match
    // hasn't kicked off yet). Completed/cancelled matches don't fire
    // 5pm posts even though they're still in the scheduler window for
    // MoM and rating-reminder purposes.
    const isPrematch =
      m.status === "UPCOMING" ||
      m.status === "TEAMS_GENERATED" ||
      m.status === "TEAMS_PUBLISHED";

    // "Is this the soonest unplayed match in the fixture?" — same gate
    // as announce-match. When today's match is still unplayed and next
    // week's match has been auto-created, only the current week's
    // 5pm post is relevant. Without this, both matches fire their own
    // evening-update and the group sees a "next week is empty, need
    // 14" chase at 17:00 the same day as today's actual match.
    const isNextUpcoming = isPrematch
      ? isNextUpcomingForPosting(siblingMatches, m)
      : false;

    // Single shared key for the entire 17:00 evening slot. Whichever
    // branch fires first claims today; subsequent ticks see this key in
    // sentKeys and skip the whole block. Prevents the previous bug where
    // bench-thin firing at 17:04 didn't block unpaid-only firing at 17:09
    // five minutes later.
    const eveningKey = `${matchId}:evening-update:${dayKey}`;

    // WEEKLY DEADLINES, D4 (2026-09-30, plan 3.3): a club with both a
    // drop-out deadline and a list publish time has its week told by the
    // announcement, the reminder, the summary and the list, so the daily
    // 17:00 post is off on every day except match day (where the line-up
    // and the full-squad nudge still matter). False for a club without
    // both settings, so Sutton FC's 17:00 post is untouched.
    const weeklyRhythmQuietDay = hasWeeklyRhythm(activity.org) && dayKey !== londonDateKey(m.date);

    if (isEvening && isPrematch && isNextUpcoming && !weeklyRhythmQuietDay && !sentKeys.has(eveningKey)) {
      // Stop the unpaid-chase tail once we're in the final day before
      // kickoff. Whoever has paid has paid; ~5 reminders (Wed → Sun for
      // a Tue match) is enough. From the day-before-match onward, drop
      // the tail entirely so the focus shifts to "tonight's match".
      const matchDayKey = londonDateKey(m.date);
      const dayBeforeMatchKey = londonDateKey(
        new Date(m.date.getTime() - 24 * 60 * 60 * 1000),
      );
      const skipUnpaidChase =
        dayKey === matchDayKey || dayKey === dayBeforeMatchKey;
      const unpaidTail = skipUnpaidChase ? null : await buildUnpaidTail(activity.id, lang);

      // Roster block listed under every branch — daily reminder so each
      // player sees their own name without scrolling up. Bench gets its
      // own numbered list when populated.
      const rosterBlock = buildSquadRosterBlock({
        confirmed: confirmed.map((a) => a.user),
        bench: bench.map((a) => a.user),
        maxPlayers: m.maxPlayers,
        lang,
      });

      const isMatchDay = dayKey === matchDayKey;
      const teamsReady = m.teamAssignments.length > 0;

      // Rolling squad (R2, 2026-09-30): branches 2a and 2b add one line
      // with the drop-out deadline while it is still ahead. Null for a
      // club without the setting, so Sutton's bytes are unchanged.
      const rollingDropOutDeadline = features.rollingSquad ? dropOutDeadlineFor(m, activity.org) : null;
      const rollingDeadlineLine =
        rollingDropOutDeadline && now < rollingDropOutDeadline
          ? buildRollingDeadlineLine({ deadline: weekdayTimeLabel(lang, rollingDropOutDeadline), lang })
          : null;

      let text: string | null = null;
      let mentions: string[] | undefined;
      /** Set by a branch whose text carries the roster. */
      let showsRoster = false;

      if (isMatchDay && teamsReady) {
        // 2-pre. Match day with teams generated → SHOW THE TEAM
        // LINEUPS instead of the squad roster. By 17:00 on match day
        // people already know the squad is locked; what they actually
        // want is "am I Red or Yellow tonight?". Bench is omitted on
        // purpose — they're not playing unless someone drops, and
        // naming them on the lineup post is unnecessary noise.
        const [redLabel, yellowLabel] = resolveTeamLabels(m, activity.org ?? null, sport, lang);
        text = buildMatchDayTeamsBlock({
          activityName: activity.name,
          venue: activity.venue,
          timeLabel: format(m.date, "HH:mm"),
          redLabel,
          yellowLabel,
          // A holder who is out is an open slot, never a name
          // (2026-09-29). See `teamSheetNames`.
          ...(() => {
            const sh = teamSheetNames(
              m.teamAssignments.map((t) => ({ userId: t.userId, team: t.team, name: t.user.name })),
              new Set(m.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.userId)),
              lang,
            );
            return {
              red: sh.red.map((name) => ({ name })),
              yellow: sh.yellow.map((name) => ({ name })),
            };
          })(),
          lang,
        });
      } else if (monthly) {
        // MONTHLY SQUAD (slice 5): the squad is the month's list, posted
        // in the group's own format when it changes and on match morning
        // (block 2-monthly below). The daily 17:00 roster, chase and
        // full-squad post would be a second, differently shaped list, so
        // none of them fires. The match-day line-ups above still do.
      } else if (isMatchDay && need === 0 && !teamsReady) {
        // 2-pre-alt. Match day, full squad, but teams haven't been
        // generated yet (LLM @-mention or admin button hasn't fired).
        // Show the roster AND nudge somebody to trigger team
        // generation so the next 17:00-window tick can show the
        // lineup. Most ticks happen every 5 min so nudge is acted on
        // quickly.
        showsRoster = !(await rosterJustShown());
        text = buildMatchDayLockedPost({
          activityName: activity.name,
          venue: activity.venue,
          timeLabel: format(m.date, "HH:mm"),
          rosterBlock: showsRoster ? rosterBlock : null,
          lang,
        });
      } else if (beforeDeadline && need > 0) {
        // ⚠️ THE ONE ROSTER THAT STILL GOES OUT WITH A SHEET ON THE
        // TABLE, and it is a deliberate exception to the 2026-09-15
        // rule ("no point listing all the 14 players after the teams
        // were announced"). Stated rather than left to be discovered.
        //
        // Reachable only OFF match day (branch 2-pre above takes every
        // match-day tick that has a sheet) and only while the squad is
        // SHORT. The roster is not the announcement there; it is the
        // shape of the ask — "here is who we have, here is the gap" —
        // and the recruiting chase is the only thing this branch is
        // for. Replacing it with a line-up would show seven against six
        // and say nothing about the slot that needs filling.
        //
        // 2a. Short squad — chase + unpaid tail. Chase template (LLM
        // or fallback) produces its own numbered list, so we leave it
        // untouched here rather than appending a duplicate roster
        // block. NB this is the SCHEDULED path: it composes its own
        // text and never went through the analyze route's
        // post-processors, whatever the note that used to be here
        // claimed. The reply path composes its roster from the rows
        // (§10 step 4); this one still asks the model for it.
        const chase = await chaseText("daily-in-list", () => {
          // Static fallback mirrors the LLM template — count + roster
          // INCLUDING the bench (bench shows in every squad display,
          // all orgs — Kemal 2026-06-12). buildSquadRosterBlock already
          // renders the "*Bench (N):*" sub-list when populated.
          return buildDailyInListFallback({
            activityName: activity.name,
            need,
            rosterBlock: buildSquadRosterBlock({
              confirmed: confirmed.map((a) => a.user),
              bench: bench.map((a) => a.user),
              maxPlayers: m.maxPlayers,
              lang,
            }),
            lang,
          });
        });
        showsRoster = chase.rosterShown != null;
        // Rolling squad (R2): the drop-out deadline, while it is ahead.
        const body = rollingDeadlineLine ? `${chase.text}\n\n${rollingDeadlineLine}` : chase.text;
        text = unpaidTail ? `${body}\n\n${unpaidTail.text}` : body;
        mentions = unpaidTail?.mentions;
      } else if (beforeDeadline && need === 0) {
        // 2b. SQUAD FULL — list it anyway, and keep the INs flowing
        // onto the bench.
        //
        // This branch used to post the unpaid tail ALONE when the org
        // tracked payments, and NOTHING at all otherwise: "anyone who
        // needs to know who's playing can scroll up". Sutton FC does
        // not track payments, so a squad that filled on a Wednesday
        // heard nothing from the bot until match day. Kemal, 2026-09-17:
        // "it is better to still list the squad even though it is full,
        // listing the benchers and asking for more bench people if
        // there are less than 3 players on the bench".
        //
        // ⚠️ THIS REVERSES A 2026-05-03 DECISION, deliberately. A daily
        // "🗓 full squad, ready to go ⚽" plus roster used to fire here
        // and Kemal called it spam, so it was deleted and the branch
        // went quiet. What he asked for on 2026-09-17 is not that post
        // back: that one only restated a fact the group already had,
        // while this one lists the bench and asks for cover, which is
        // the thing he had been typing into the group by hand. If it
        // ever reads as noise again, the fix is the same as last time:
        // delete the branch, do not water down the ask.
        //
        // This is the SCHEDULED post and nothing else. It is not the
        // per-IN roster spam PR #63 removed (the roster is demand-driven
        // on the reply path) and it is not #78's "a drop opened a slot"
        // message. It fires at most once a day, on the shared
        // `eveningKey`, like every other branch here.
        //
        // WHY THE `squad-locked` CHECK: `announceSquadFullIfJustFilled`
        // (squad-announce.ts) posts the "Squad complete" line-up the
        // moment the last IN lands, from the attendance write path, on
        // its own `<matchId>:squad-locked` claim and its own BotJob.
        // `eveningKey` cannot see that, so a squad that filled at 16:50
        // would read the same roster and the same bench invite twice
        // inside the hour. Almost always it fired days ago and this post
        // is the daily reminder the owner asked for; when it fired
        // TODAY, the squad half is skipped and only the unpaid tail (if
        // any) goes out, which is exactly what this branch did before.
        // The claim is cleared on a confirmed drop, so a squad that
        // empties and refills re-announces and this stays in step.
        const squadLocked = await db.sentNotification.findFirst({
          where: { key: `${matchId}:squad-locked` },
          select: { createdAt: true },
        });
        const announcedToday =
          squadLocked != null && londonDateKey(squadLocked.createdAt) === dayKey;

        if (!announcedToday) {
          showsRoster = !(await rosterJustShown());
          const squadPost = buildSquadFullEveningPost({
            activityName: activity.name,
            confirmedCount: confirmed.length,
            maxPlayers,
            rosterBlock: showsRoster ? rosterBlock : null,
            benchCount: bench.length,
            // The approved words, shared with the squad-complete post so
            // the promise cannot drift. Only with the bench feature on:
            // without it the bench-slot offer never fires, so "I tag the
            // bench here" would be false.
            benchInvite: features.bench
              ? buildSquadCompleteBenchInvite({ lang, organiser: features.benchPickMode === "organiser" })
              : null,
            lang,
          });
          const body = rollingDeadlineLine ? `${squadPost}\n\n${rollingDeadlineLine}` : squadPost;
          text = unpaidTail ? `${body}\n\n${unpaidTail.text}` : body;
          mentions = unpaidTail?.mentions;
        } else if (unpaidTail) {
          text = unpaidTail.text;
          mentions = unpaidTail.mentions;
        }
      }
      // else: the deadline has passed and the match has not happened
      // yet — leave the key un-sent so a later tick in the same window
      // can still fire if state changes (e.g. someone drops out).

      if (text) {
        out.push({
          kind: "group-message",
          key: eveningKey,
          matchId,
          text,
          mentions,
          ...(showsRoster ? { rosterShown: rosterMark } : {}),
        });
      }
    }
  }

  // ── 2-weekly. Weekly deadlines (2026-09-30, slice 3 of
  //    MDs/friday-group-features-plan-2026-09-30.md, section 3.2) ───────
  //    Two group posts for a club that has set them, each its own block
  //    with its own key and no `return`, so nothing below is skipped:
  //      D1 `<matchId>:dropout-reminder`  3 hours before the club's
  //         drop-out deadline (not before 09:00), with the squad;
  //      D3 `<matchId>:list-published`    at the club's publish time,
  //         the final list.
  //    D2, the organisers' summary once the deadline has passed, is not
  //    here: it goes through `sendAdminNotice` from the due-posts route
  //    (`deadline-summary.ts`), because computing posts must stay free
  //    of side effects (preview mode relies on it).
  //    Both use the next-upcoming gate, so next week's match never posts
  //    while this week's is still live. A club without the settings
  //    (Sutton FC) resolves both to null and gets neither.
  {
    const isLive = m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED";
    const weekly = weeklyDeadlinesFor(m.date, activity.org);
    const reminderKey = `${matchId}:dropout-reminder`;
    const listKey = `${matchId}:list-published`;
    const reminderDue =
      weekly.dropOut !== null && !sentKeys.has(reminderKey) && dropOutReminderDue(now, weekly.dropOut);
    // Once the teams are out the team sheet is the announcement; a
    // fourteen-name list after it would be the roster the group was
    // told not to get again (2026-09-15).
    const listDue =
      weekly.listPublish !== null &&
      !sentKeys.has(listKey) &&
      m.teamAssignments.length === 0 &&
      listPublishDue(now, weekly.listPublish, m.date);
    if (isLive && (reminderDue || listDue) && isNextUpcomingForPosting(siblingMatches, m)) {
      if (reminderDue) {
        const showsRoster = !(await rosterJustShown());
        out.push({
          kind: "group-message",
          key: reminderKey,
          matchId,
          text: buildDropOutReminderPost({
            activityName: activity.name,
            whenLabel: dayTimeLabel(lang, m.date),
            time: format(weekly.dropOut!, "HH:mm"),
            rosterBlock: showsRoster
              ? buildSquadRosterBlock({
                  confirmed: confirmed.map((a) => a.user),
                  bench: bench.map((a) => a.user),
                  maxPlayers,
                  lang,
                })
              : null,
            lang,
          }),
          ...(showsRoster ? { rosterShown: rosterMark } : {}),
        });
      }
      if (listDue) {
        out.push({
          kind: "group-message",
          key: listKey,
          matchId,
          text: buildListPublishedPost({
            activityName: activity.name,
            dateLabel: longDayTimeLabel(lang, m.date),
            venue: activity.venue,
            confirmed: confirmed.map((a) => a.user),
            bench: bench.map((a) => a.user),
            maxPlayers,
            lang,
          }),
          // The final list is the whole post, so it always goes out in
          // full; it counts as a roster shown for whatever follows it.
          rosterShown: rosterMark,
        });
      }
    }
  }

  // ── 2-monthly. The month's list (2026-10-06, slice 5 of
  //    MDs/monthly-squad-plan-2026-10-05.md, section 5.4) ──────────────
  //    For a monthly club's match in a running month, once the regulars
  //    are on it: ONE message in the group's own format ("List for
  //    October", numbered slots, paid marks, "Paid but can't play"),
  //    posted when the list differs from the one the group last saw, and
  //    once on match morning. `decideListPost` holds the limits: never
  //    within 30 minutes of the last list post, never 22:00 to 07:59
  //    London, never once the teams are out, only for the fixture's next
  //    match. "The one the group last saw" is the newest
  //    `<matchId>:month-list:` row: a post of ours, or a member's paste
  //    that showed the same list (`monthly-paste.ts` writes that row, so
  //    MatchTime does not echo a list straight back). The key carries a
  //    running number so a list that returns to an earlier state (a drop,
  //    then back in) is posted again. Nothing here runs for a weekly club.
  /** For the PAYG pool's group line (section 3): the list going out on
   *  this poll already says "N places open, say IN"; when MatchTime last
   *  posted a list for this match; and how many places are open now. */
  let listGoesOutWithOpenLine = false;
  let lastListPostAt: Date | null = null;
  let openPlaces = 0;
  const monthlyListLive =
    (m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED") &&
    now.getTime() < m.date.getTime();
  if (monthly?.seeded && monthlyListLive) {
    const rows = m.attendances.map((a) => ({
      userId: a.userId,
      name: a.user.name ?? "",
      status: a.status as WeekStatus,
      position: a.position,
    }));
    const weekList = buildWeekList({ members: monthly.members, rows, maxPlayers });
    const text = buildWeekListPost({
      list: weekList,
      matchDate: m.date,
      paygPricePence: monthly.paygPricePence,
      organiserPicks: features.benchPickMode === "organiser",
      lang,
    });
    const hash = weekListHash(text);
    const prefix = weekListKeyPrefix(matchId);
    const shown = await db.sentNotification.findMany({
      where: { matchId, key: { startsWith: prefix } },
      select: { key: true, kind: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const lastShownHash = shown[0] ? shown[0].key.slice(prefix.length).split(":")[0] : null;
    const due = decideListPost({
      now,
      matchDate: m.date,
      hash,
      lastShownHash,
      lastPostAt: shown.find((r) => r.kind === "group-message")?.createdAt ?? null,
      live: true,
      nextUpcoming: isNextUpcomingForPosting(siblingMatches, m),
      teamsOut: m.teamAssignments.length > 0,
    });
    if (due) {
      out.push({ kind: "group-message", key: `${prefix}${hash}:${shown.length}`, matchId, text });
    }
    openPlaces = weekList.open;
    listGoesOutWithOpenLine = weekList.open > 0 && due !== null;
    lastListPostAt = shown.find((r) => r.kind === "group-message")?.createdAt ?? null;
  }

  // ── 2-bis. Recruit chase-up DMs (2026-08-31) ────────────────────────
  //   `inviteRecentPlayers` DMs recent players when the squad is short.
  //   Plenty never reply at all. The owner asked for exactly ONE nudge to
  //   those who stayed completely silent, ~3h after their OWN invite, and
  //   never a second one. All the timing/state judgement lives in the pure
  //   `shouldChaseRecruit` (src/lib/recruit-chase.ts); this block only
  //   loads the rows and derives its booleans.
  //
  //   WHAT COUNTS AS A RESPONSE (deliberately generous — the bias is HARD
  //   toward staying silent, because chasing someone who already said no
  //   is the exact failure the owner asked us to avoid):
  //     1. an Attendance row for this match in ANY status (CONFIRMED /
  //        BENCH / DROPPED). This is the workhorse: it covers an IN or OUT
  //        said in the group, said by DM (PR #18), tapped as a 👍 on the
  //        invite, registered in the app, or entered by an admin.
  //     2. a TentativeAvailability row for this match — they said maybe.
  //     3. an AnalyzedMessage they authored in this org SINCE their invite
  //        that the analyzer read as attendance-ish (in / out / conditional
  //        / replacement request). Catches the case where the analyzer
  //        understood them but wrote no Attendance row.
  //     4. any outbound DM BotJob to their number created strictly AFTER
  //        their invite. There is no inbound-DM log table and no migration
  //        was on the table, so this outbound reply is the durable
  //        fingerprint of an inbound DM: every handler in
  //        /api/whatsapp/dm-reply answers with a BotJob DM (self-attendance
  //        ack, "you weren't down anyway", Q&A answer, subscription ack,
  //        clarification). It closes the gaps the first three leave — an
  //        OUT from someone who was never registered writes no Attendance
  //        row, and a question or a 👍 the model called `unclear` writes
  //        nothing at all. It fails safe in the other direction too: if we
  //        have DM'd them since for ANY reason, another DM is nagging.
  //        The invite's own BotJob is created just BEFORE its
  //        SentNotification row, so a strict `>` never counts it.
  //
  //   The chase itself is emitted as an instruction (not a BotJob), so it
  //   can never trip signal 4 for a later match.
  {
    const matchLive = isMatchChaseable({
      status: m.status,
      attendanceDeadline: m.attendanceDeadline,
      now,
    });
    const squadShort = need > 0;
    // Cheap pre-filter: the three cheap booleans and the clock gate all
    // have to hold before we spend a query. This block therefore costs
    // nothing on the overwhelmingly common tick.
    if (matchLive && squadShort && isSociableChaseHour(now)) {
      const invites = await db.sentNotification.findMany({
        where: { matchId, kind: "recruit-dm", targetUser: { not: null } },
        select: { targetUser: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      // Only the ones whose 3h is up and whose chase hasn't been claimed.
      const ripe = invites.filter(
        (i) =>
          i.targetUser !== null &&
          !sentKeys.has(recruitChaseKey(matchId, i.targetUser)) &&
          now.getTime() - i.createdAt.getTime() >= RECRUIT_CHASE_AFTER_MS,
      ) as { targetUser: string; createdAt: Date }[];

      if (ripe.length > 0) {
        const userIds = [...new Set(ripe.map((i) => i.targetUser))];
        const invitedAtByUser = new Map<string, Date>();
        for (const i of ripe) {
          // Earliest invite wins if a user somehow has two rows.
          const prev = invitedAtByUser.get(i.targetUser);
          if (!prev || i.createdAt < prev) invitedAtByUser.set(i.targetUser, i.createdAt);
        }
        const earliestInvite = new Date(
          Math.min(...[...invitedAtByUser.values()].map((d) => d.getTime())),
        );

        const [users, optedOutRows, attendanceRows, tentativeRows, analyzed] =
          await Promise.all([
            db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, phoneNumber: true },
            }),
            db.membership.findMany({
              where: { orgId: activity.orgId, userId: { in: userIds }, subMatchInviteDm: false },
              select: { userId: true },
            }),
            // Signal 1 — any attendance row at all for this match.
            db.attendance.findMany({
              where: { matchId, userId: { in: userIds } },
              select: { userId: true },
            }),
            // Signal 2 — they said maybe.
            db.tentativeAvailability.findMany({
              where: { matchId, userId: { in: userIds } },
              select: { userId: true },
            }),
            // Signal 3 — an attendance-ish group message since the invite.
            db.analyzedMessage.findMany({
              where: {
                orgId: activity.orgId,
                authorUserId: { in: userIds },
                createdAt: { gt: earliestInvite },
                intent: { in: [...ATTENDANCE_ISH_INTENTS] },
              },
              select: { authorUserId: true, createdAt: true },
            }),
          ]);

        const optedOut = new Set(optedOutRows.map((r) => r.userId));
        const responded = new Set<string>([
          ...attendanceRows.map((r) => r.userId),
          ...tentativeRows.map((r) => r.userId),
        ]);
        for (const a of analyzed) {
          const invitedAt = a.authorUserId ? invitedAtByUser.get(a.authorUserId) : undefined;
          if (a.authorUserId && invitedAt && a.createdAt > invitedAt) {
            responded.add(a.authorUserId);
          }
        }

        // Signal 4 — we have DM'd them since their invite, which means the
        // DM path answered something they sent us (or we have already
        // messaged them enough).
        const phoneToUser = new Map<string, string>();
        for (const u of users) {
          if (u.phoneNumber) phoneToUser.set(u.phoneNumber.replace(/^\+/, ""), u.id);
        }
        if (phoneToUser.size > 0) {
          const outboundDms = await db.botJob.findMany({
            where: {
              orgId: activity.orgId,
              kind: "dm",
              phone: { in: [...phoneToUser.keys()] },
              createdAt: { gt: earliestInvite },
            },
            select: { phone: true, createdAt: true },
          });
          for (const j of outboundDms) {
            const uid = j.phone ? phoneToUser.get(j.phone) : undefined;
            if (!uid) continue;
            const invitedAt = invitedAtByUser.get(uid);
            if (invitedAt && j.createdAt > invitedAt) responded.add(uid);
          }
        }

        const when = dayCommaTimeLabel(lang, m.date);
        // Hard cap per tick. The Pi rate-limits DMs to 1/min anyway, and
        // after the duplicate-send incident a bounded batch is cheap
        // insurance; the remainder simply chases on the next poll.
        let emitted = 0;
        for (const u of users) {
          if (emitted >= 20) break;
          if (!u.phoneNumber) continue; // can't DM without a number
          const key = recruitChaseKey(matchId, u.id);
          const decision = shouldChaseRecruit({
            invitedAt: invitedAtByUser.get(u.id) ?? null,
            now,
            hasResponded: responded.has(u.id),
            squadShort,
            matchLive,
            subscribed: !optedOut.has(u.id),
            alreadyChased: sentKeys.has(key),
          });
          if (!decision) continue;
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: u.id,
            phone: u.phoneNumber.replace(/^\+/, ""),
            text: buildRecruitChaseText({
              playerName: u.name,
              activityName: activity.name,
              matchWhen: when,
              need,
              lang,
              organiser: features.benchPickMode === "organiser",
            }),
          });
          emitted++;
        }
      }
    }
  }

  // ── 3. Bench slot offers — broadcast to the WHOLE bench ─────────────
  //   Redesign 2026-05-19 (Kemal): a drop opens ONE BenchSlotOffer
  //   that goes to EVERY current bencher at once. First to confirm
  //   (👍 on the group post / reply IN there / YES to the DM) wins it
  //   — see resolveBenchSlotClaim. NOBODY is ever eliminated, no
  //   per-person timers, nothing fires overnight. One group post +
  //   one DM per bencher per offer, both offer-keyed so they send
  //   exactly once.
  if (m.benchSlotOffers.length > 0) {
    // Daytime gate: never ping anyone about a slot overnight. A drop
    // at 00:24 just waits — the offer stays open (no waMessageId yet)
    // and posts when people are awake. London 08:00–21:59.
    const lh = londonHour(now);
    if (lh >= 8 && lh < 22) {
      // Per-category opt-out: benchers with subBenchOfferDm=false asked not
      // to be offered slots. Exclude them from BOTH the group @-tag and the
      // personal DM below (default is subscribed, so only explicit opt-outs
      // are filtered). If everyone benched opted out, benchAtt is empty and
      // the offer just waits — the short-squad chase covers the group.
      const benchOptedOut = new Set(
        (
          await db.membership.findMany({
            where: { orgId: activity.orgId, subBenchOfferDm: false },
            select: { userId: true },
          })
        ).map((mem) => mem.userId),
      );
      const benchAtt = m.attendances.filter(
        (a) => a.status === "BENCH" && a.user.phoneNumber && !benchOptedOut.has(a.userId),
      );
      // MONTHLY SQUAD (slice 5, plan 5.3): bench first, THEN the PAYG
      // pool. With nobody waiting, a monthly match's open places are
      // offered to its pay-as-you-go players. A weekly club skips this
      // block: for it the chase covers a drop with no bench, as before.
      const nobodyWaiting = !m.attendances.some((a) => a.status === "BENCH");
      if (monthly?.seeded && nobodyWaiting && benchAtt.length === 0 && features.benchPickMode !== "organiser") {
        const paygPool = await loadPaygPool(
          {
            orgId: activity.orgId,
            members: monthly.members,
            rows: m.attendances.map((a) => ({
              userId: a.userId,
              name: a.user.name ?? "",
              status: a.status as WeekStatus,
              position: a.position,
            })),
          },
          now,
        );
        if (paygPool.length > 0) {
          // AT MOST ONE GROUP LINE PER MATCH PER POLL, covering every open
          // place ("2 places open"), and only for places the group has not
          // been told about: an offer opened AFTER the last list post and
          // the last pool line. Told by time, not by a per-offer key, so
          // offers the list announced never post later, and several offers
          // held back by the list's 30-minute floor post as one line.
          // Nothing when the list goes out on this poll with its own
          // "places open" line. The key carries the open count and a
          // running number, like the list's.
          const linePrefix = `${matchId}:payg-pool-line:`;
          const lines = await db.sentNotification.findMany({
            where: { matchId, key: { startsWith: linePrefix } },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
          });
          const toldAt = Math.max(lastListPostAt?.getTime() ?? 0, lines[0]?.createdAt.getTime() ?? 0);
          const untold = m.benchSlotOffers.some((o) => o.createdAt.getTime() > toldAt);
          const open = Math.max(openPlaces, 1);
          if (untold && !listGoesOutWithOpenLine) {
            out.push({
              kind: "group-message",
              key: `${linePrefix}${open}:${lines.length}`,
              matchId,
              text: buildPaygPoolGroupPost({ open, matchDate: m.date, paygPricePence: monthly.paygPricePence, lang }),
            });
          }
          // One DM per pool player per MATCH, however many places open
          // (the group line and the list tell them the rest).
          for (const p of paygPool) {
            const dmKey = `${matchId}:payg-pool-dm:${p.userId}`;
            if (sentKeys.has(dmKey)) continue;
            out.push({
              kind: "dm",
              key: dmKey,
              matchId,
              phone: p.phoneNumber!.replace(/^\+/, ""),
              targetUser: p.userId,
              text: buildPaygPoolDm({
                name: p.name,
                activityName: activity.name,
                matchDate: m.date,
                paygPricePence: monthly.paygPricePence,
                lang,
              }),
            });
          }
        }
      }
      for (const offer of m.benchSlotOffers) {
        if (benchAtt.length === 0) continue; // no bench — chase covers it

        // Context: which team / who they'd replace, if teams exist.
        let team: { teamLabel: string; replacingName: string | null } | null = null;
        if (offer.replacingUserId) {
          const repl = m.attendances.find((a) => a.userId === offer.replacingUserId)?.user;
          const ta = m.teamAssignments.find((t) => t.userId === offer.replacingUserId);
          if (repl && ta) {
            const labels = resolveTeamLabels(m, activity.org, sport, lang);
            team = { teamLabel: ta.team === "RED" ? labels[0] : labels[1], replacingName: repl.name };
          }
        }
        // "tonight" only when the match is today in London; the match day
        // otherwise (2026-10-03: a Saturday offer for a Tuesday match said
        // "tonight").
        const { group: ctx, plain: ctxPlain } = buildBenchOfferContext({
          activityName: activity.name,
          team,
          matchDate: m.date,
          now,
          lang,
        });

        const mentions = benchAtt.map((a) => a.user.phoneNumber!.replace(/^\+/, ""));
        const tagList = mentions.map((p) => `@${p}`).join(" ");

        // One group post to the whole bench, offer-keyed (ack maps the
        // waMessageId onto the BenchSlotOffer so a 👍 reaction finds
        // it). kind:"bench-prompt" so the bot ACKs with waMessageId.
        // The post itself no longer ASKS for a 👍 while
        // BENCH_PROMPT_MENTION_REACTIONS is false (inbound reactions are
        // dead on the Pi) — the mapping stays wired so an unprompted one
        // still lands the moment forwarding is repaired.
        const groupKey = `offer-${offer.id}`;
        if (!sentKeys.has(groupKey)) {
          out.push({
            kind: "bench-prompt",
            key: groupKey,
            matchId,
            // userId unused by the offer model but the union requires
            // it; pass the first bencher purely to satisfy the type.
            userId: benchAtt[0].userId,
            phone: mentions[0],
            text: buildBenchOfferGroupPost({ context: ctx, tagList, lang }),
          });
        }

        // Personal DM to each bencher (they often mute the group
        // thinking they're not playing). Per-(offer,user) key.
        for (const a of benchAtt) {
          const dmKey = `offer-${offer.id}:dm:${a.userId}`;
          if (sentKeys.has(dmKey)) continue;
          const first = a.user.name ? a.user.name.split(" ")[0] : "";
          out.push({
            kind: "dm",
            key: dmKey,
            matchId,
            phone: a.user.phoneNumber!.replace(/^\+/, ""),
            targetUser: a.userId,
            // `ctxPlain` is already in `lang` (buildBenchOfferContext).
            text: buildBenchOfferDm({ firstName: first, context: ctxPlain, lang }),
          });
        }
      }
    }
  }

  // ── 4. Teams post ────────────────────────────────────────────────────
  //     The old match-day-morning teams post was removed on 2026-04-21.
  //     Teams are now generated + posted on demand when someone in the
  //     group asks ("@M Time generate teams"). The LLM classifies the
  //     request as `generate_teams_request` and the analyze route runs
  //     the balancer and posts the lineup. This removes the 8-11am time
  //     gate so admins can trigger whenever it's right for the day.

  // ── 4b. Day-before DM nudges to the org OWNER ────────────────────────
  //       Two triggers, both on the day before the match in London time:
  //         10:00 — switch-format nudge if squad is short
  //         18:00 — cancel nudge if numbers are below min-viable
  //       Both produce DMs (not group messages). Admin clicks the link
  //       and confirms on the portal. If admin misses both, the match
  //       still plays out with whatever numbers we have — these are
  //       nudges, not gates.
  {
    const hour = londonHour(now);
    const isDayBefore = hoursUntilMatch >= 12 && hoursUntilMatch <= 36;

    // 10:00 — switch-to-smaller-format nudge
    //         One DM per admin so each has their own magic link. Idempotency
    //         is keyed per-admin (":userId" suffix) — first admin to act
    //         resolves the situation; other admins can ignore their DM.
    if (
      isDayBefore &&
      hour >= 10 &&
      hour < 11 &&
      m.status === "UPCOMING" &&
      confirmed.length < maxPlayers
    ) {
      const candidate = await findSmallerSameSportActivity(
        activity.orgId,
        activity.sportId,
        sport.playersPerTeam,
      );
      const channel = candidate ? await admin.getChannel() : null;
      if (candidate && channel) {
        // Through the admin channel (slice 2a). Each admin's DM is today's,
        // keyed `…:switch-nudge:<adminId>`, with their own signed-in link
        // (2026-09-30: it had no destination and landed on the dashboard).
        out.push(
          ...(await adminNoticeInstructions({
            channel,
            piCaps: admin.piCaps,
            sentKeys,
            now,
            matchId,
            key: (who) => `${matchId}:switch-nudge:${who}`,
            notice: {
              nextPath: `/admin/matches/${matchId}/switch-format`,
              text: (signInUrl, audience) =>
                audience === "dm"
                  ? `⚠️ *Low numbers*: ${confirmed.length}/${maxPlayers} confirmed for *${activity.name}* tomorrow.\n\n` +
                    `Switch to *${candidate.sport.name}* (${candidate.sport.playersPerTeam * 2} players) before the deadline?\n\n` +
                    `Tap to open the admin panel (auto signs you in):\n${signInUrl}\n\n` +
                    `Or open: ${appUrl(`/admin/matches/${matchId}/switch-format`)}`
                  : `⚠️ *Low numbers*: ${confirmed.length}/${maxPlayers} confirmed for *${activity.name}* tomorrow.\n\n` +
                    `Switch to *${candidate.sport.name}* (${candidate.sport.playersPerTeam * 2} players) before the deadline?\n\n` +
                    `Open the switch page:\n${signInUrl}`,
            },
          })),
        );
      }
    }

    // 18:00 — cancel nudge if even the smallest format can't fill.
    //         Again one DM per admin.
    if (
      isDayBefore &&
      hour >= 18 &&
      hour < 19 &&
      m.status === "UPCOMING"
    ) {
      const smallestPpt = await findSmallestSameSportPpt(
        activity.orgId,
        activity.sportId,
        sport.playersPerTeam,
      );
      const minViable = smallestPpt * 2;
      const channel = confirmed.length < minViable ? await admin.getChannel() : null;
      if (channel) {
        // Same door, same keys (`…:cancel-nudge:<adminId>`), and "Tap to
        // open the cancel page" opens it.
        out.push(
          ...(await adminNoticeInstructions({
            channel,
            piCaps: admin.piCaps,
            sentKeys,
            now,
            matchId,
            key: (who) => `${matchId}:cancel-nudge:${who}`,
            notice: {
              nextPath: `/admin/matches/${matchId}/cancel`,
              text: (signInUrl, audience) =>
                audience === "dm"
                  ? `🚨 *Match in trouble*: only *${confirmed.length}* confirmed for *${activity.name}* tomorrow, below the minimum to play (${minViable}).\n\n` +
                    `Cancel and refund the booking?\n\n` +
                    `Tap to open the cancel page:\n${signInUrl}\n\n` +
                    `Or open: ${appUrl(`/admin/matches/${matchId}/cancel`)}`
                  : `🚨 *Match in trouble*: only *${confirmed.length}* confirmed for *${activity.name}* tomorrow, below the minimum to play (${minViable}).\n\n` +
                    `Cancel and refund the booking?\n\n` +
                    `Open the cancel page:\n${signInUrl}`,
            },
          })),
        );
      }
    }
  }

  // ── 4c. Replacement chase cadence ─────────────────────────────────────
  //       When the squad is short and kickoff is approaching, post a
  //       fresh chase message at two more points so the "step in?"
  //       ask doesn't go stale. Each chase has its own idempotency key.
  //       Chases run on UPCOMING matches only; once the squad is full
  //       again they naturally stop firing.
  {
    const short = confirmed.length < maxPlayers;
    const need = maxPlayers - confirmed.length;
    const inLive = m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED";

    // Chase A: morning of match day, 8-9am London.
    {
      const dayKey = londonDateKey(now);
      const matchDayKey = londonDateKey(m.date);
      const isMatchDay = dayKey === matchDayKey;
      const hour = londonHour(now);
      const inMorningWindow = hour >= 8 && hour < 9;
      const key = `${matchId}:chase-match-day-morning:${dayKey}`;
      if (
        !sentKeys.has(key) &&
        short &&
        inLive &&
        isMatchDay &&
        inMorningWindow &&
        // 2026-10-06: the group was told "On it, DM'd N recent players"
        // for this same need in the last three hours, so a second ask
        // for the same place says nothing new. The key is NOT claimed:
        // every later poll in this window asks again, and the chase goes
        // out if the need has changed by then (a different need is a
        // different marker).
        !recruitAckRecently(await loadQuietRows(), { matchId, need, now })
      ) {
        const chase = await chaseText(
          "match-day-morning",
          // No "Morning all": the slot is 8-9am but the post can land
          // late (see buildMatchDayChaseFallback's docblock).
          () => buildMatchDayChaseFallback({ need, activityName: activity.name, lang }),
        );
        out.push({ kind: "group-message", key, matchId, ...chase });
      }
    }

    // Chase B: 3-4h before kickoff.
    {
      const key = `${matchId}:chase-pre-kickoff`;
      if (
        !sentKeys.has(key) &&
        short &&
        inLive &&
        hoursUntilMatch <= 4 &&
        hoursUntilMatch >= 3
      ) {
        const chase = await chaseText("chase-pre-kickoff", () =>
          buildChasePreKickoffFallback({
            need,
            activityName: activity.name,
            timeLabel: format(m.date, "HH:mm"),
            lang,
          }),
        );
        out.push({ kind: "group-message", key, matchId, ...chase });
      }
    }
  }

  // ── 5. 2h before kickoff: squad-short last-chance plea ONLY ──────────
  //       When squad is FULL we used to post a "see you there" — removed
  //       on 2026-04-21 because it duplicated info everyone already knew
  //       and added noise. Now this block ONLY fires when we're still
  //       short 2h before kickoff, as a last call.
  {
    const key = `${matchId}:pre-kickoff`;
    const need = maxPlayers - confirmed.length;
    if (
      !sentKeys.has(key) &&
      need > 0 &&
      hoursUntilMatch <= 2 &&
      hoursUntilMatch > 0.5 &&
      (m.status === "TEAMS_PUBLISHED" || m.status === "TEAMS_GENERATED" || m.status === "UPCOMING")
    ) {
      const chase = await chaseText("pre-kickoff-short", () =>
        buildPreKickoffShortFallback({
          timeLabel: format(m.date, "HH:mm"),
          venue: activity.venue,
          confirmed: confirmed.length,
          maxPlayers,
          need,
          lang,
        }),
      );
      out.push({ kind: "group-message", key, matchId, ...chase });
    }
  }

  // ── 5a. Football gear reminder ────────────────────────────────────────
  //       Football-only. 2h before kickoff, post a one-off reminder to
  //       bring goalie gloves + a ball so nobody shows up empty-handed.
  //       Detection: we match on the sport name starting with "football"
  //       so this covers 5-a-side, 7-a-side, 11-a-side etc. — but not
  //       Basketball / other sports.
  {
    const key = `${matchId}:football-gear-reminder`;
    const isFootball = sport.name.trim().toLowerCase().startsWith("football");
    if (
      !sentKeys.has(key) &&
      isFootball &&
      hoursUntilMatch <= 2 &&
      hoursUntilMatch >= 1.5 &&
      (m.status === "UPCOMING" || m.status === "TEAMS_GENERATED" || m.status === "TEAMS_PUBLISHED")
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: buildGearReminder({ timeLabel: format(m.date, "HH:mm"), venue: activity.venue, lang }),
      });
    }
  }

  // ── 5b. Ask for the score 1h after the match ends ────────────────────
  //       Fires whether status is already COMPLETED (auto-completed by
  //       cron) or still TEAMS_PUBLISHED. We rely on Match.maxPlayers and
  //       activity.matchDurationMins to compute the "ended" timestamp.
  {
    const key = `${matchId}:ask-score`;
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const askAt = new Date(endedAt.getTime() + 60 * 60 * 1000); // +1h
    const alreadyScored = m.redScore !== null && m.yellowScore !== null;
    if (
      !sentKeys.has(key) &&
      !alreadyScored &&
      now >= askAt &&
      now.getTime() < askAt.getTime() + 24 * 60 * 60 * 1000 // only within 24h window
    ) {
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: buildAskScorePost({ activityName: activity.name, lang }),
      });
    }
  }

  // ── 6a. Payment poll — fires as soon as the match ENDS (kickoff +
  //        duration), regardless of whether the score is recorded yet.
  //        Players pay right after the final whistle on the pitch, so
  //        the poll needs to be waiting in the group by the time they
  //        check their phones — not hours later when the score trickles
  //        in. Gated by postMatchEndFlow so first-match-after-launch
  //        can opt out while things stabilise.
  //        MONTHLY SQUAD (slice 5, plan 5.6): not for a match of a
  //        running month. The poll asks everybody who played to pay, and
  //        the regulars have paid for the month.
  if (m.postMatchEndFlow !== false && !monthly) {
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const key = `${matchId}:payment-poll`;
    if (
      !sentKeys.has(key) &&
      now >= endedAt &&
      // Explicit deadline. This block had no upper bound of its own and
      // relied on the scheduler's lookback dropping the match; see
      // POST_MATCH_END_FLOW_MAX_AGE_DAYS.
      hoursSinceMatch <= POST_MATCH_END_FLOW_MAX_AGE_DAYS * 24 &&
      (m.status === "UPCOMING" ||
        m.status === "TEAMS_GENERATED" ||
        m.status === "TEAMS_PUBLISHED" ||
        m.status === "COMPLETED")
    ) {
      const [redLabel, yellowLabel] = resolveTeamLabels(m, activity.org, sport, lang);
      out.push({
        kind: "group-poll",
        key,
        matchId,
        question: buildPaymentPollQuestion(activity.name, lang),
        options: [redLabel, yellowLabel],
      });
    }
  }

  // ── 6a-unpaid. The unpaid reminder on its own, for a weekly-rhythm
  //    club (2026-10-01, decided by Kemal). D4 switched such a club's
  //    17:00 post off except on match day, and the unpaid tail only ever
  //    rode on that post (and never on match day or the day before), so
  //    the group lost its "please pay" nudge. This posts its own reminder
  //    (row UNP2: names the match by day, points at "the payment poll"
  //    rather than row 73's "last week's match" and "the poll above"),
  //    once, at 10:00 London two days after the COMPLETED
  //    match (`unpaidFollowUpDue`), counted by the same rule
  //    (`summariseUnpaid`), keyed `<matchId>:unpaid-group`. The organisers'
  //    named list (U1) is a separate notice, `unpaid-list.ts`.
  //    `hasWeeklyRhythm` is false for a club without both deadlines, so
  //    Sutton FC gets nothing new: its tail stays on the 17:00 post.
  {
    const key = `${matchId}:unpaid-group`;
    if (
      m.status === "COMPLETED" &&
      m.postMatchEndFlow !== false &&
      activity.org?.paymentTrackingEnabled &&
      hasWeeklyRhythm(activity.org) &&
      !sentKeys.has(key) &&
      unpaidFollowUpDue(now, m.date)
    ) {
      const summary = summariseUnpaid({
        // A regular's row is paid for by the month (slice 5): never unpaid.
        confirmed: confirmed.filter((a) => !isMonthlyRow(a)).map((a) => ({ userId: a.userId, paidAt: a.paidAt })),
        payerId: activity.org.paymentHolderId ?? null,
        creditCount: (m.paymentCredits ?? []).reduce((s, c) => s + c.count, 0),
      });
      if (summary) {
        out.push({
          kind: "group-message",
          key,
          matchId,
          text: buildUnpaidGroupReminder({ unpaid: summary.unpaid, dayName: weekdayLabel(lang, m.date), lang }),
        });
      }
    }
  }

  // ── 6a-bis. Ask the money collector for the per-player fee ──────────
  //    When the org collects fees (Stripe) and no fee is set yet, DM the
  //    money collector (Organisation.paymentHolderId) once at match-end:
  //    "how much per player?". Their reply (handled in dm-reply →
  //    handleCollectorFeeReply) sets the fee + releases the pay links.
  //    Gated inline on paymentCollectionEnabled so non-paying orgs never
  //    see it; the post-compute filter also classifies `fee-ask` →
  //    paymentCollection for defence in depth.
  //    MONTHLY SQUAD (slice 5, plan 5.6): on a match of a running month
  //    only the per-game players owe a fee, so they are the headcount, and
  //    with none of them nobody is asked. When the club has a PAYG price
  //    the question is "£8 each for N players, yes?" (the existing confirm
  //    prompt) instead of "how much?". NOTHING IS STAGED HERE: the amount
  //    becomes `feePendingConfirm` only when the Pi acks this DM
  //    (`stagePaygFeeOnAsk`, from /api/whatsapp/ack), because a pending
  //    amount must mean "the collector has been shown this number", as it
  //    does in the weekly flow (`stage` in payment-flow.ts runs on the
  //    collector's own reply). `monthlyPayers` is null for a weekly club,
  //    which leaves the condition and the message exactly as they were.
  const monthlyPayers = monthly
    ? confirmed.filter((a) => !isMonthlyRow(a) && a.userId !== activity.org?.paymentHolderId).length
    : null;
  const paygFeeToConfirm = monthly && monthly.paygPricePence != null ? monthly.paygPricePence / 100 : null;
  if (
    m.postMatchEndFlow !== false &&
    activity.org?.paymentCollectionEnabled &&
    activity.org.paymentHolderId &&
    m.feePerPlayer == null &&
    m.feePendingConfirm == null &&
    monthlyPayers !== 0
  ) {
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    // MONTHLY SQUAD: the PAYG fee question is asked ONCE MORE when its
    // first send never reported a message id (the DM failed, or the ack
    // was lost) and half an hour has passed: until one is sent, the amount
    // is not staged and the collector's yes would have nothing to confirm.
    // A weekly club always uses the first key, as before.
    let key = `${matchId}:fee-ask`;
    if (paygFeeToConfirm !== null && sentKeys.has(key)) {
      const { again, declined } = feeAskKeys(matchId);
      // Never after the collector said no: the fee is theirs to type.
      const first = sentKeys.has(again) || sentKeys.has(declined)
        ? null
        : await db.sentNotification.findUnique({ where: { key }, select: { waMessageId: true, createdAt: true } });
      if (first && !first.waMessageId && now.getTime() - first.createdAt.getTime() >= FEE_REASK_AFTER_MS) key = again;
    }
    // The age bound is the same explicit deadline the payment poll now
    // carries: asking a collector for a fee is only useful while the
    // match is recent (POST_MATCH_END_FLOW_MAX_AGE_DAYS).
    if (
      !sentKeys.has(key) &&
      now >= endedAt &&
      hoursSinceMatch <= POST_MATCH_END_FLOW_MAX_AGE_DAYS * 24
    ) {
      const collectorId = activity.org.paymentHolderId;
      // Prefer a phone already loaded on the squad; else look it up.
      let collectorPhone =
        m.attendances.find((a) => a.userId === collectorId)?.user.phoneNumber ?? null;
      let collectorName =
        m.attendances.find((a) => a.userId === collectorId)?.user.name ?? null;
      if (!collectorPhone) {
        const c = await db.user.findUnique({
          where: { id: collectorId },
          select: { name: true, phoneNumber: true },
        });
        collectorPhone = c?.phoneNumber ?? null;
        collectorName = c?.name ?? collectorName;
      }
      if (collectorPhone) {
        out.push({
          kind: "dm",
          key,
          matchId,
          targetUser: collectorId,
          phone: collectorPhone.replace(/^\+/, ""),
          text:
            paygFeeToConfirm !== null
              ? buildFeeConfirmPrompt({
                  perPlayer: paygFeeToConfirm,
                  headcount: monthlyPayers ?? 0,
                  matchName: activity.name,
                  wasTotal: false,
                  lang,
                })
              : buildFeeAskDm({
                  collectorName,
                  activityName: activity.name,
                  headcount: monthlyPayers ?? confirmed.length,
                  lang,
                }),
        });
      }
    }
  }

  // ── 6a-ter. Daily payment chaser (method-aware) ────────────────────
  //    Once links are released, chase the unpaid daily at 18:00 London,
  //    capped at 10 days so we never nag forever.
  //      • Card / Pay-by-Bank (or no method yet) → DM the player their
  //        pay link again.
  //      • Chose "pay directly" (directPendingAt) → don't pester the
  //        player (they've committed); instead nudge the COLLECTOR once
  //        a day to confirm receipt.
  if (
    activity.org?.paymentCollectionEnabled &&
    m.paymentLinksReleasedAt != null &&
    m.feePerPlayer != null
  ) {
    const daysSinceRelease =
      (now.getTime() - m.paymentLinksReleasedAt.getTime()) / (24 * 60 * 60 * 1000);
    const hourNow = londonHour(now);
    // Two caps, and the kickoff one is the binding one. "capped at 10
    // days" above has never been reachable: the scheduler stopped
    // loading the match at 6 days, so the chase always died there. That
    // deadline is now stated (POST_MATCH_END_FLOW_MAX_AGE_DAYS) instead
    // of being a side effect of the lookback, so widening the lookback
    // for the MoM announcement does not quietly add four more days of
    // chasing people for money.
    if (
      daysSinceRelease <= 10 &&
      hoursSinceMatch <= POST_MATCH_END_FLOW_MAX_AGE_DAYS * 24 &&
      hourNow >= 18 &&
      hourNow < 19
    ) {
      const dayKey = londonDateKey(now);
      const dayNum = Math.max(1, Math.ceil(daysSinceRelease));

      // Players paying electronically (or undecided) — re-send the link.
      for (const a of confirmed) {
        if (a.userId === activity.org.paymentHolderId) continue; // collector doesn't pay
        if (isMonthlyRow(a)) continue; // a regular: the month paid for it (slice 5)
        if (a.paidAt) continue;
        if (a.directPendingAt) continue; // handled via collector nudge below
        if (!a.user.phoneNumber) continue;
        const key = `${matchId}:pay-chase:${a.userId}:${dayKey}`;
        if (sentKeys.has(key)) continue;
        const token = signMagicLinkToken({
          userId: a.userId,
          purpose: "sign-in",
          nextPath: `/pay/${matchId}`,
          ttlSeconds: MAGIC_LINK_TTL.bookmark,
        });
        out.push({
          kind: "dm",
          key,
          matchId,
          targetUser: a.userId,
          phone: a.user.phoneNumber.replace(/^\+/, ""),
          text: buildPayChaseDm({
            playerName: a.user.name,
            dayNum,
            fee: m.feePerPlayer,
            activityName: activity.name,
            url: await buildShortMagicLinkUrl(token),
            lang,
          }),
        });
      }

      // Direct-pending → one daily nudge to the collector to confirm.
      const pendingDirect = confirmed.filter((a) => !a.paidAt && a.directPendingAt && !isMonthlyRow(a));
      if (pendingDirect.length > 0 && activity.org.paymentHolderId) {
        const ckey = `${matchId}:pay-chase-collector:${dayKey}`;
        if (!sentKeys.has(ckey)) {
          const collectorId = activity.org.paymentHolderId;
          let collectorPhone =
            m.attendances.find((a) => a.userId === collectorId)?.user.phoneNumber ?? null;
          if (!collectorPhone) {
            const c = await db.user.findUnique({
              where: { id: collectorId },
              select: { phoneNumber: true },
            });
            collectorPhone = c?.phoneNumber ?? null;
          }
          if (collectorPhone) {
            const token = signMagicLinkToken({
              userId: collectorId,
              purpose: "sign-in",
              nextPath: `/collect/${matchId}`,
              ttlSeconds: MAGIC_LINK_TTL.actionNudge,
            });
            out.push({
              kind: "dm",
              key: ckey,
              matchId,
              targetUser: collectorId,
              phone: collectorPhone.replace(/^\+/, ""),
              text: buildDirectPayCollectorNudge({
                count: pendingDirect.length,
                activityName: activity.name,
                url: await buildShortMagicLinkUrl(token),
                lang,
              }),
            });
          }
        }
      }
    }
  }

  // ── 6b/c/d/e below are gated on COMPLETED because they concern the
  //    outcome of the match (rating DMs, MoM announcement). Payment
  //    above is gated on *ended*, which is earlier.
  if (m.status === "COMPLETED" && m.postMatchEndFlow !== false) {

    // Per-category opt-out: players who texted "stop messaging me about
    // ratings" (or a broad "only payment" request) have subRatingDm=false
    // on their Membership. Build the set once for this match's org and skip
    // them in BOTH personal DM loops below (rate-dm + rate-reminder).
    // Group-wide messages (rate-promo, MoM announcement) are intentionally
    // NOT gated — they aren't personal DMs. (subRatingDm supersedes the
    // deprecated ratingDmOptOut column.)
    const optedOut = new Set(
      (
        await db.membership.findMany({
          where: { orgId: activity.orgId, subRatingDm: false },
          select: { userId: true },
        })
      ).map((mem) => mem.userId),
    );

    // Who has already done the thing the rating DM asks for.
    //
    // ENGAGED = at least one Rating row for this match, OR a MoMVote.
    // Either half counts, deliberately: 6d has always stopped reminding
    // on that test and 6e has always counted a player as engaged on it,
    // so a third, stricter definition here would mean the first DM
    // nagging someone the reminder has already written off and the MoM
    // announcement has already counted. One definition, three readers.
    //
    // A player who did exactly half is therefore left alone. The DM asks
    // for both in one breath, so there is no message that asks only for
    // the missing half, and re-sending the whole ask to someone who has
    // rated all 13 teammates is precisely the 2026-09-22 complaint.
    //
    // COST: one pair of indexed reads per match per tick, and only when
    // a section below actually needs the answer. Memoised here rather
    // than queried per player, and never touched at all once the rating
    // DMs and the promo are done for this match.
    let engagementCache: { engaged: Set<string>; momVoteCount: number } | null = null;
    const loadRatingEngagement = async () => {
      if (engagementCache) return engagementCache;
      const [momVoters, ratingVoters] = await Promise.all([
        db.moMVote.findMany({ where: { matchId }, select: { voterId: true } }),
        db.rating.findMany({
          where: { matchId },
          select: { raterId: true },
          distinct: ["raterId"],
        }),
      ]);
      engagementCache = {
        engaged: new Set<string>([
          ...momVoters.map((v) => v.voterId),
          ...ratingVoters.map((r) => r.raterId),
        ]),
        momVoteCount: momVoters.length,
      };
      return engagementCache;
    };

    // 6b + 6c. Rating DMs + group promo — HOLD until 08:00 London, then
    //          fire any time from 08:00 onward the morning/day AFTER match
    //          day (no upper bound). Previously these
    //          fired the moment the match flipped to COMPLETED, which for
    //          a 21:30 kickoff meant midnight DMs — players asleep, worst
    //          possible time to ask for a rating. Now we wait for a
    //          civilised hour the next morning. Idempotency keys unchanged
    //          so this is a one-time shift, not a retroactive resend.
    {
      const matchDayKey = londonDateKey(m.date);
      const todayKey = londonDateKey(now);
      const hourNow = londonHour(now);
      // No upper bound on the hour: the DMs (and the promo, which can
      // only fire AFTER all rate DMs have landed — see below) fire at any
      // time from 08:00 London onward the morning/day after the match.
      // We previously capped this at 10:00, but on a slow squad (Pi DM
      // rate-limit = 1/min, so 14 players = 14min) or a bot that started
      // mid-morning the window could expire before the promo got runway.
      // Dropping the cap removes that race. The per-user idempotency key
      // (`${matchId}:rate-dm:${userId}`, persisted in SentNotification)
      // prevents any resend across the wider window AND across subsequent
      // mornings still inside the 36h band, so widening is safe.
      const isMorningAfter =
        todayKey !== matchDayKey &&
        hoursSinceMatch >= 6 &&
        hoursSinceMatch <= 36 &&
        hourNow >= 8;

      // Everyone this match could DM about ratings, before asking the
      // database anything. The engagement lookup below is skipped
      // entirely once every one of them has a breadcrumb and the promo
      // has gone out, so a match sitting out the rest of its 36h window
      // costs no queries at all.
      const promoKey = `${matchId}:rate-promo`;
      const rateDmCandidates = confirmed.filter(
        (a) => a.user.phoneNumber && !optedOut.has(a.userId),
      );
      const anyRateDmOutstanding = rateDmCandidates.some(
        (a) => !sentKeys.has(`${matchId}:rate-dm:${a.userId}`),
      );

      if (isMorningAfter && (anyRateDmOutstanding || !sentKeys.has(promoKey))) {
        // One lookup for the whole match, in the style of `optedOut`
        // above. Players rate through the web app at any hour, so by
        // 08:00 some of the squad is typically already done: on
        // 2026-09-22 Kemal finished at 23:42 and Sait at 23:10, and both
        // were DMed at 08:06 anyway.
        const { engaged } = await loadRatingEngagement();

        for (const a of confirmed) {
          if (!a.user.phoneNumber) continue;
          if (optedOut.has(a.userId)) continue;
          // Already rated, or already voted: nothing left to ask them for.
          if (engaged.has(a.userId)) continue;
          const key = `${matchId}:rate-dm:${a.userId}`;
          if (sentKeys.has(key)) continue;
          const token = signMagicLinkToken({
            userId: a.userId,
            purpose: "rate-match",
            matchId,
            ttlSeconds: MAGIC_LINK_TTL.rateMatch,
          });
          // Permanent personal-stats link rides along on the rating DM
          // every player already gets — so they can open their season
          // stats any time without asking in the group (Kemal 2026-06-01).
          const statsToken = signMagicLinkToken({
            userId: a.userId,
            purpose: "sign-in",
            nextPath: "/profile/stats",
            ttlSeconds: MAGIC_LINK_TTL.bookmark,
          });
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: a.userId,
            phone: a.user.phoneNumber.replace(/^\+/, ""),
            text: buildRatingDm({
              activityName: activity.name,
              dateLabel: dayLabel(lang, m.date),
              lang,
              mvpLabel: sport.mvpLabel,
              rateUrl: await buildShortMagicLinkUrl(token),
              statsUrl: await buildShortMagicLinkUrl(statsToken),
            }),
          });
        }

        // Promo gating: the Pi rate-limits DMs to 1/min so a 14-player
        // squad takes ~14min to finish. The promo says "I just DM'd
        // every player" — when it posted at 08:00 alongside the first
        // DM (old behaviour), 13 players would check their chats, see
        // nothing, and conclude the bot lied. Now hold the promo until
        // every CONFIRMED-with-phone player has a rate-dm SentNotification
        // breadcrumb. The promo then fires on the NEXT tick after the
        // last DM lands — typically 08:13-08:14 for a 14-player squad
        // — by which point all DMs really are in players' chats.
        //
        // Players who had already rated are excluded from the wait as
        // well as from the DM: they never get a breadcrumb, so counting
        // them would hold the promo back for ever. If that leaves nobody
        // (the whole squad rated overnight) the promo does not post at
        // all, which is right: it announces DMs that in that case nobody
        // received.
        const expectedRateDmKeys = rateDmCandidates
          .filter((a) => !engaged.has(a.userId))
          .map((a) => `${matchId}:rate-dm:${a.userId}`);
        const allRateDmsSent =
          expectedRateDmKeys.length > 0 &&
          expectedRateDmKeys.every((k) => sentKeys.has(k));
        if (allRateDmsSent && !sentKeys.has(promoKey)) {
          out.push({
            kind: "group-message",
            key: promoKey,
            matchId,
            // Neither "Morning" nor "last night" is safe here: the promo
            // waits for the last rating DM to land, so it fires at any
            // hour from 08:00 onward, 6-36h after kickoff. It said
            // "Morning all" at 16:05 on 2026-09-16 after an outage.
            // Copy lives in group-copy.ts so it can be tested without
            // Prisma.
            text: buildRatePromoPost({
              activityName: activity.name,
              matchDateLabel: dayLabel(lang, m.date),
              lang,
            }),
          });
        }
      }
    }

    // 6d. Daily 18:00 rating reminder DM for any confirmed player who hasn't
    //     voted yet (stops when they vote or after the 5-day window).
    {
      const hourNow = londonHour(now);
      const isReminderHour = hourNow >= 18 && hourNow < 19;
      const withinWindow = hoursSinceMatch <= 5 * 24;
      if (isReminderHour && withinWindow) {
        // Who has already rated (MoMVote OR at least 1 Rating). Shared
        // with the first DM in 6b and the early trigger in 6e, so the
        // three paths cannot disagree about the same player.
        const { engaged: rated } = await loadRatingEngagement();
        const dayKey = londonDateKey(now);
        for (const a of confirmed) {
          if (!a.user.phoneNumber) continue;
          if (optedOut.has(a.userId)) continue;
          if (rated.has(a.userId)) continue;
          const key = `${matchId}:rate-reminder:${a.userId}:${dayKey}`;
          if (sentKeys.has(key)) continue;
          // Also skip unless we've already sent the initial DM.
          const initialKey = `${matchId}:rate-dm:${a.userId}`;
          if (!sentKeys.has(initialKey)) continue;
          const token = signMagicLinkToken({
            userId: a.userId,
            purpose: "rate-match",
            matchId,
            ttlSeconds: MAGIC_LINK_TTL.rateMatch,
          });
          // Vary tone by day so repeats don't feel like spam.
          const dayNum = Math.min(5, Math.max(1, Math.ceil(hoursSinceMatch / 24)));
          const text = buildRatingReminderDm({
            dayNum,
            playerName: a.user.name,
            activityName: activity.name,
            mvpLabel: sport.mvpLabel,
            url: await buildShortMagicLinkUrl(token),
            lang,
          });
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: a.userId,
            phone: a.user.phoneNumber.replace(/^\+/, ""),
            text,
          });
        }
      }
    }

    // 6e. MoM announcement. Two triggers and two stops.
    //
    //   TRIGGERS (whichever comes first)
    //   • EARLY — as soon as every confirmed player with a phone has
    //     engaged (cast a MoM vote OR submitted ratings). No point making
    //     the group wait 5 days once everyone's voted (Kemal 2026-06-02).
    //     Civil hours only (09:00–21:00 London) so we never announce
    //     overnight.
    //   • BACKSTOP: from MOM_BACKSTOP_DAYS after the match, on ANY tick
    //     between 15:00 and 21:00 London, every day until a stop below
    //     bites. This used to be the single hour 15:00 to 16:00, which
    //     gave a match one or two chances in its whole life; the bot was
    //     down across the only one on 2026-09-21 and Sutton FC never
    //     heard who won. A recovery now catches the same afternoon or
    //     the next one, and 15:00 is still the earliest it will speak.
    //
    //   STOPS (after either, we stop carrying it, deliberately and for
    //   good; a result nobody can place is worse than silence)
    //   • the result is older than MOM_ANNOUNCE_MAX_AGE_DAYS;
    //   • the club's NEXT fixture has already been played, so this would
    //     read as that match's result.
    {
      const key = `${matchId}:mom-announcement`;
      const lh = londonHour(now);
      const ageDays = hoursSinceMatch / 24;

      // Too old to be news. See MOM_ANNOUNCE_MAX_AGE_DAYS for the number
      // and why it sits where it does relative to the lookback.
      const tooStale = ageDays > MOM_ANNOUNCE_MAX_AGE_DAYS;

      // The club plays weekly, so once the next fixture has kicked off
      // "here is your Man of the Match" reads as tonight's result. A
      // sibling only counts when it starts at least a day later: a format
      // switch can leave a co-timed ghost match under the other format's
      // activity (the 2026-06-27 ghost bug), and a ghost must never
      // silence a real announcement. Fixture identity is the same one the
      // announce/evening rollover guard uses, so a format-switched
      // successor still counts.
      const supersededByNextFixture = siblingMatches.some(
        (s) =>
          s.id !== m.id &&
          s.status !== "CANCELLED" &&
          (s.activityId === m.activityId ||
            isSameRecurringFixture(s.activity, m.activity)) &&
          s.date.getTime() >= m.date.getTime() + 24 * 60 * 60 * 1000 &&
          s.date.getTime() <= now.getTime(),
      );

      const canAnnounce =
        !sentKeys.has(key) && !tooStale && !supersededByNextFixture;

      const backstopWindow =
        canAnnounce &&
        ageDays >= MOM_BACKSTOP_DAYS &&
        lh >= MOM_BACKSTOP_FROM_HOUR &&
        lh < MOM_BACKSTOP_TO_HOUR;

      let earlyReady = false;
      if (canAnnounce && !backstopWindow && lh >= MOM_EARLY_FROM_HOUR && lh < MOM_EARLY_TO_HOUR) {
        const expected = confirmed.filter((a) => a.user.phoneNumber);
        if (expected.length > 0) {
          // Same engagement set the rating DM in 6b and the reminder in
          // 6d read, loaded once per match per tick.
          const { engaged, momVoteCount } = await loadRatingEngagement();
          // Everyone we asked has engaged, AND at least one real MoM vote
          // exists (players can rate without picking MoM).
          earlyReady =
            momVoteCount > 0 && expected.every((a) => engaged.has(a.userId));
        }
      }

      if (canAnnounce && (backstopWindow || earlyReady)) {
        const votes = await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
        });
        if (votes.length > 0) {
          const allUsers = await db.user.findMany({
            where: { id: { in: votes.map((v) => v.playerId) } },
            select: { id: true, name: true },
          });
          const nameById = new Map(allUsers.map((u) => [u.id, u.name ?? "?"]));
          const tally = votes
            .map((v) => ({
              name: nameById.get(v.playerId) ?? "?",
              votes: v._count.playerId,
            }))
            .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
          out.push({
            kind: "group-message",
            key,
            matchId,
            text: buildMomAnnouncement({
              mvpLabel: sport.mvpLabel,
              activityName: activity.name,
              tally,
              lang,
            }),
          });
        }
        // If 0 votes, skip silently.
      }
    }
  }
}

// ─────────────────────── Bench-confirmation sweeper ───────────────────────

/**
 * CLOSE any BenchSlotOffer whose match has already kicked off — nobody
 * can claim a slot for a game that has started. Called at the top of
 * /due-posts so a stale offer never outlives its match.
 *
 * NOBODY IS EVER DROPPED OR ELIMINATED HERE, and there is no expiry of
 * people. The bench redesign (2026-05-19) replaced the sequential
 * `PendingBenchConfirmation` chain — one named bencher at a time, on a
 * timer, dropped when it ran out — with ONE offer broadcast to the whole
 * bench until somebody claims it. The export name was kept so
 * /due-posts's call site did not have to change, and the doc comment
 * that used to stand here still described the deleted chain ("mark the
 * user as DROPPED and create a new PendingBenchConfirmation"). Corrected
 * 2026-09-14: a comment that contradicts the function underneath it is
 * how a live feature comes to read as demolished.
 */
export async function sweepExpiredBenchConfirmations(orgId: string): Promise<void> {
  const now = new Date();
  await db.benchSlotOffer.updateMany({
    where: {
      resolvedAt: null,
      match: { activity: { orgId }, date: { lte: now } },
    },
    data: { resolvedAt: now, outcome: "closed-at-kickoff" },
  });
}

/*
 * ⚰️ REMOVED 2026-09-14: a doc comment reading "Create a
 * PendingBenchConfirmation when someone drops AND the match is already
 * full … Call this from the dropout flow (lib/attendance.ts)" stood
 * here, dangling above `slotEmoji`, which is not that function and never
 * was. The function it described was replaced by
 * `requestBenchConfirmationOnDrop` (further down this file, correctly
 * documented) in the 2026-05-19 bench redesign, and the comment outlived
 * it by four months attached to an unrelated helper.
 *
 * It is deleted rather than corrected because there is nothing here to
 * correct: `slotEmoji` has its own doc comment below. It is called out
 * because it did real damage — reading this file, the bench system looks
 * demolished, when in fact the whole path (auto-bench on a full squad,
 * BenchSlotOffer broadcast, group tag, per-bencher DM, first claim wins)
 * is live and `featureBench` is on for Sutton FC.
 */

/**
 * Slot-emoji helper. Used to be a 1️⃣–🔟 keycap map but Kemal flagged
 * those as confusing (read as reaction counts, go stale on drops,
 * required this whole RetroReaction queue just to keep them current).
 * Now: every CONFIRMED player gets ✅ regardless of slot. The
 * queueSlotEmojiRefresh callers still call us for compat — they're
 * effectively no-ops now since the emoji never changes after a
 * shuffle (everyone's already on ✅).
 */
function slotEmoji(_slot: number): string {
  return "✅";
}

/**
 * Walk the current squad and queue retroactive reacts for any player
 * whose IN message in this match should now show a different slot
 * emoji. Used after a drop to reflect the shift-up; cheap to call
 * eagerly because it's idempotent (the bot just calls msg.react()
 * with the new emoji, replacing any prior reaction it set).
 *
 * Lower bound for "messages in this match": match.createdAt — the
 * scheduler creates the next match in the same week, so this captures
 * everyone's IN messages between attendance opening and the drop.
 */
export async function queueSlotEmojiRefresh(matchId: string): Promise<void> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { select: { orgId: true } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!match) return;

  const orgId = match.activity.orgId;
  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = match.attendances.filter((a) => a.status === "BENCH");

  const userSlotEmoji = new Map<string, string>();
  confirmed.forEach((a, i) => userSlotEmoji.set(a.userId, slotEmoji(i + 1)));
  // Bench players keep the chair emoji regardless of their bench rank.
  bench.forEach((a) => userSlotEmoji.set(a.userId, "🪑"));

  for (const [userId, emoji] of userSlotEmoji) {
    const lastIn = await db.analyzedMessage.findFirst({
      where: {
        orgId,
        authorUserId: userId,
        intent: "in",
        createdAt: { gte: match.createdAt },
      },
      orderBy: { createdAt: "desc" },
      select: { waMessageId: true },
    });
    if (!lastIn) continue;

    // Skip if there's already an unsent retro for this exact
    // (message, emoji) combination — no point queueing the same
    // refresh twice if the bot hasn't picked it up yet.
    const dup = await db.retroReaction.findFirst({
      where: {
        waMessageId: lastIn.waMessageId,
        emoji,
        sentAt: null,
      },
      select: { id: true },
    });
    if (dup) continue;

    await db.retroReaction.create({
      data: {
        orgId,
        waMessageId: lastIn.waMessageId,
        emoji,
        reason: `slot refresh for match ${matchId}`,
      },
    });
  }
}

/**
 * Bench redesign 2026-05-19: a confirmed player dropping opens ONE
 * BenchSlotOffer broadcast to EVERY current bencher. First to confirm
 * (group 👍/IN or DM yes) wins it; nobody is ever eliminated. No
 * per-person timers. Kept the old export name so cancelAttendance's
 * call site is unchanged.
 */
export async function requestBenchConfirmationOnDrop(
  matchId: string,
  replacingUserId?: string | null,
): Promise<void> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { attendances: true, activity: { select: { org: { select: { benchPickMode: true, squadMode: true } } } } },
  });
  if (!match) return;

  // An organiser-pick club (slice 2b) opens no offer on a drop: the admins
  // pick (`organiser-pick.ts`), and only their fallback, when nobody picks
  // in time, offers the place to the waiting list.
  if (match.activity?.org?.benchPickMode === "organiser") return;

  const hasBench = match.attendances.some((a) => a.status === "BENCH");
  if (!hasBench) {
    // MONTHLY SQUAD (slice 5, 2026-10-06): bench first, then the PAYG
    // pool. With nobody waiting, a monthly club's open place is offered
    // to its pay-as-you-go players through the same BenchSlotOffer (one
    // per open slot). A weekly club returns here exactly as before: the
    // chase handles it.
    if (match.activity?.org?.squadMode === "monthly") {
      try {
        const { ensureOpenPlaceOffers } = await import("./monthly-week");
        await ensureOpenPlaceOffers(matchId);
      } catch (err) {
        console.error(`[scheduler] PAYG pool offer for ${matchId} failed:`, err);
      }
    }
    return; // nobody on the bench — chase handles it
  }

  // One offer PER open slot. If two confirmed players drop there are
  // two distinct offers (each carries its own replacingUserId for the
  // TA swap). Don't duplicate an offer that's already open for THIS
  // dropped player.
  const existing = await db.benchSlotOffer.findFirst({
    where: {
      matchId,
      resolvedAt: null,
      replacingUserId: replacingUserId ?? null,
    },
  });
  if (existing) return;

  await db.benchSlotOffer.create({
    data: { matchId, replacingUserId: replacingUserId ?? null },
  });
}
