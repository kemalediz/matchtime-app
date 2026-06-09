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
import { buildShortMagicLinkUrl } from "./short-link";
import { findOrgAdminsWithPhone } from "./org";
import { getOrgFeatures, type OrgFeatures } from "./org-features";
import { formatLondon } from "./london-time";
import { composeChaseText, type ChaseKind } from "./message-analyzer";
import { gbp } from "./payments";

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
    };

export interface DuePostsResult {
  instructions: DueInstruction[];
  waGroupId: string;
  orgId: string;
}

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
 * Copy for the daily 17:00 rating-reminder DM. Varies tone by day so five
 * nudges in a row don't all read the same. Each message:
 *   - Opens warmly (first name if we have it).
 *   - Names the match so they remember which one.
 *   - Reminds them why ratings matter (better-balanced teams next week).
 *   - Signs off with the personal magic link.
 * Never guilty or whiny — the goal is to make it feel like a teammate
 * tapping them on the shoulder, not a debt collector.
 */
function buildReminderText(args: {
  dayNum: number;
  playerName: string | null;
  activityName: string;
  mvpLabel: string;
  url: string;
}): string {
  const { dayNum, playerName, activityName, mvpLabel, url } = args;
  const first = playerName?.split(/\s+/)[0] ?? "mate";
  const sig = `\n${url}`;
  switch (dayNum) {
    case 1:
      return (
        `Hey ${first} 👋 — hope last night's *${activityName}* was a good one.\n\n` +
        `When you have a sec, tap here to rate your teammates and pick ${mvpLabel}. ` +
        `The more of us vote, the better the teams balance next week 🙌${sig}`
      );
    case 2:
      return (
        `${first}, friendly nudge 🙂 — still waiting on your ratings for *${activityName}*.\n\n` +
        `Literally 30 seconds, promise. Helps everyone get fairer teams next week ⚽${sig}`
      );
    case 3:
      return (
        `Halfway through the rating window, ${first} ⏳\n\n` +
        `Your vote for *${activityName}* actually moves ratings a lot when half the squad has voted ` +
        `and you haven't. Quick tap:${sig}`
      );
    case 4:
      return (
        `${first} — two days left to rate *${activityName}* and lock in ${mvpLabel} 🏆\n\n` +
        `30 seconds, then you're done:${sig}`
      );
    default: // day 5 — last chance
      return (
        `Last call ${first} 🔔 — the rating window for *${activityName}* closes tomorrow.\n\n` +
        `Drop a rating + ${mvpLabel} pick before it shuts. Your voice counts:${sig}`
      );
  }
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

  // Exclude the payment holder — they're the one collecting fees from
  // others, including them in the unpaid chase would be embarrassing.
  // If the org hasn't set one (null), we don't exclude anyone and let
  // the admin configure it in /admin/settings or during onboarding.
  const payerId = lastCompleted.activity.org.paymentHolderId ?? null;

  const confirmed = payerId
    ? lastCompleted.attendances.filter((a) => a.userId !== payerId)
    : lastCompleted.attendances;
  const paid = confirmed.filter((a) => a.paidAt != null);
  // Subtract aggregate bulk-payment credits ("Amir paid for 4 players")
  // from the unpaid count. These cover players whose specific Attendance
  // rows aren't marked individually (the named-player path updates
  // Attendance.paidAt directly and skips creating a credit row).
  const creditCount = lastCompleted.paymentCredits.reduce(
    (s, c) => s + c.count,
    0,
  );
  const unpaidPeople = confirmed.filter((a) => a.paidAt == null).length;
  const unpaid = Math.max(0, unpaidPeople - creditCount);
  // Don't chase when we have no signal — false precision is worse than silence.
  if (paid.length === 0 && creditCount === 0) return null;
  if (unpaid === 0) return null;

  // Poll-only format per Sait's suggestion (2026-04-25). No naming,
  // no shaming — point everyone at the original payment poll. Anyone
  // who's already paid clears themselves by ticking their team. The
  // poll-vote → paidAt wiring takes care of the rest.
  const text =
    unpaid === 1
      ? `💳 1 payment still pending for last week's match — if you've already paid, tick your team in the poll above to clear it 🙏`
      : `💳 *${unpaid}* payments still pending for last week's match — if you've already paid, just tick your team in the poll above to clear it 🙏`;
  // No mentions needed — we don't tag anyone in the poll-only style.
  const mentions: string[] = [];
  return { text, mentions };
}

/**
 * Render a numbered "Confirmed (N/M):" + "Bench (N):" block for the
 * daily 17:00 announcement. Goal: every day at 5pm, every player can
 * scan the message and see their own name on the list — confirms
 * they're playing without anyone needing to scroll up. Bench gets its
 * own numbered sub-list so the gap to the squad is obvious.
 */
function buildSquadRosterBlock(args: {
  confirmed: { user: { name: string | null } }[];
  bench: { user: { name: string | null } }[];
  maxPlayers: number;
}): string {
  const { confirmed, bench, maxPlayers } = args;
  const lines: string[] = [];
  lines.push(`*Confirmed (${confirmed.length}/${maxPlayers}):*`);
  if (confirmed.length === 0) {
    lines.push("_nobody yet_");
  } else {
    confirmed.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.user.name ?? "(unnamed)"}`);
    });
  }
  if (bench.length > 0) {
    lines.push("");
    lines.push(`*Bench (${bench.length}):*`);
    bench.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.user.name ?? "(unnamed)"}`);
    });
  }
  return lines.join("\n");
}

/**
 * Match-day 17:00 view when teams have been generated. Replaces the
 * flat squad roster with a Red vs Yellow lineup so each player can
 * scan and confirm what side they're on tonight. Bench is
 * intentionally NOT listed — by match day the bench player isn't
 * playing unless someone drops in the next few hours, and naming
 * them on the lineup post is just noise. No "objections / swap X Y"
 * footer here — that's already in the team-publish post that fired
 * when teams were generated; this is a daily reminder, not a fresh
 * announcement.
 */
function buildMatchDayTeamsBlock(args: {
  activity: { name: string; venue: string };
  sport: { teamLabels: string[] };
  matchDate: Date;
  teamAssignments: { team: "RED" | "YELLOW"; user: { name: string | null } }[];
}): string {
  const { activity, sport, matchDate, teamAssignments } = args;
  const [redLabel, yellowLabel] = sport.teamLabels as [string, string];
  const red = teamAssignments.filter((t) => t.team === "RED");
  const yellow = teamAssignments.filter((t) => t.team === "YELLOW");
  const numbered = (arr: typeof red) =>
    arr.map((t, i) => `${i + 1}. ${t.user.name ?? "(unnamed)"}`).join("\n");
  return [
    `⚽ *Tonight at ${format(matchDate, "HH:mm")}* — *${activity.name}* at ${activity.venue}`,
    ``,
    `*${redLabel}:*`,
    numbered(red),
    ``,
    `*${yellowLabel}:*`,
    numbered(yellow),
    ``,
    `See you tonight 🙌`,
  ].join("\n");
}

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
  const lines: string[] = [
    `👋 Hi all — MatchTime bot is live for this group.`,
    ``,
    `Here's what I do:`,
  ];
  if (f.attendance) {
    lines.push(
      ``,
      `🗓  *Attendance* — Say "IN" / "OUT" here (or on the app) and I log you in/out. I react with 👍 to confirm — no extra messages from me.`,
      ``,
      `🗒  *Daily reminders* — Every day at 5pm while the squad isn't full, I'll repost the IN list so we all see how many we need.`,
    );
  }
  if (f.bench) {
    lines.push(
      ``,
      `🔁  *Bench promotion* — If someone drops, I tag the first bencher and ask them to 👍 confirm. 2h window; if no answer, I move to the next.`,
    );
  }
  if (f.teamBalancing) {
    lines.push(
      ``,
      `⚽  *Teams* — Ask me to "generate teams" and I post auto-balanced sides. Objections? Reply \`swap X Y\` — admin will apply it.`,
    );
  }
  if (f.momVoting || f.playerRating) {
    const bits: string[] = [];
    if (f.playerRating)
      bits.push(`I DM everyone a rating link after each match (no sign-up, just tap)`);
    if (f.momVoting)
      bits.push(`vote MoM in-app or in the poll I post — winner announced once everyone's voted (or 5 days after the match at the latest)`);
    lines.push(``, `🏆  *Ratings & MoM* — ${bits.join("; ")}.`);
  }
  if (f.reminders) {
    lines.push(
      ``,
      `⏰  *Reminders* — Say "@MatchTime remind me Monday" and I'll DM you then.`,
    );
  }
  if (f.statsQa) {
    lines.push(
      ``,
      `📊  *Stats* — Ask me things like "who got MoM last week?" or "who's our most consistent player?"`,
    );
  }
  if (f.paymentTracking) {
    lines.push(``, `💳  *Payments* — I auto-post "paid?" polls right after each match.`);
  }
  lines.push(``, `Questions? Just ask here. Let's go.`);
  return lines.join("\n");
}

// ─────────────────────────── Main entry point ─────────────────────────────

export async function computeDuePosts(groupId: string): Promise<DuePostsResult | null> {
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
  });
  if (!org) return null;

  const now = new Date();
  const out: DueInstruction[] = [];

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
    if (provisional.length > 0) {
      const admins = await findOrgAdminsWithPhone(org.id);
      const todayKey = formatLondon(now, "yyyy-MM-dd");
      for (const admin of admins) {
        const key = `org-${org.id}:provisional-review:${admin.id}:${todayKey}`;
        if (sentKeys.has(key)) continue;
        const token = signMagicLinkToken({
          userId: admin.id,
          purpose: "sign-in",
          nextPath: "/admin/players",
          ttlSeconds: MAGIC_LINK_TTL.actionNudge,
        });
        const signInUrl = await buildShortMagicLinkUrl(token);
        const names = provisional
          .map((p) => p.user.name)
          .filter(Boolean)
          .slice(0, 5)
          .join(", ");
        const more = provisional.length > 5 ? ` (+${provisional.length - 5} more)` : "";
        out.push({
          kind: "dm",
          key,
          targetUser: admin.id,
          phone: admin.phoneNumber.replace(/^\+/, ""),
          text:
            `✨ *New players to review* — ${provisional.length} ${provisional.length === 1 ? "person was" : "people were"} auto-added after posting in the group:\n\n` +
            `${names}${more}\n\n` +
            `Tap to review and set phone/position/rating, or remove:\n${signInUrl}\n\n` +
            `Or navigate manually: /admin/players`,
        });
      }
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

  // Load all matches we care about: upcoming + anything still within 5 days
  // of completion (MoM announcement window).
  const windowStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const matches = await getMatchesForScheduler(org.id, windowStart);

  for (const m of matches) {
    await computeForMatch(m, now, sentKeys, out, groupId);
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
  const features = await getOrgFeatures(org.id);
  const featureForKey = (key: string): keyof typeof features | null => {
    const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    if (
      seg.startsWith("announce-match") ||
      seg.startsWith("evening-update") ||
      seg.startsWith("chase-") ||
      seg.startsWith("pre-kickoff") ||
      seg.startsWith("cancel-nudge") ||
      seg.startsWith("switch-nudge") ||
      seg.startsWith("football-gear-reminder")
    )
      return "attendance";
    if (seg.startsWith("bench-prompt")) return "bench";
    if (seg.startsWith("mom-")) return "momVoting";
    if (seg.startsWith("rate-")) return "playerRating";
    if (seg.startsWith("payment-")) return "paymentTracking";
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
            },
          },
        },
      },
      attendances: { include: { user: { select: { id: true, name: true, phoneNumber: true } } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
      benchConfirmations: { where: { resolvedAt: null } },
      benchSlotOffers: { where: { resolvedAt: null } },
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
    try {
      const llm = await composeChaseText({ groupId, kind });
      if (llm && llm.trim().length > 0) return llm;
    } catch (err) {
      console.error(`[scheduler] compose ${kind} failed:`, err);
    }
    return staticFallback();
  }
  const matchId = m.id;
  const activity = m.activity;
  const sport = activity.sport;
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

  // ── 1. Announce the match ─────────────────────────────────────────────
  //     Two gates beyond "this match exists":
  //
  //     (a) Time-of-day window — only fire 09:00–12:59 London. The
  //         generate-matches cron now runs daily at 00:00 UTC = 01:00 BST,
  //         so without this gate the announcement landed at ~01:20 BST
  //         the moment the new match row was created. Middle-of-night
  //         posts wake people up.
  //     (b) "Is this actually the next match in this activity?" — when
  //         today's match is still UPCOMING/TEAMS_GENERATED/TEAMS_PUBLISHED
  //         and next week's match has just been created, only the
  //         current week's announcement should ever be live. Once
  //         today's match flips to COMPLETED the next morning's tick
  //         picks up the future one. Effect: the announcement always
  //         reads "next match" from the group's perspective, never
  //         "next-but-one".
  {
    const key = `${matchId}:announce-match`;
    const lh = londonHour(now);
    const inAnnounceWindow = lh >= 9 && lh < 13;
    const earlierUnplayedCount =
      m.status === "UPCOMING" && hoursUntilMatch > 24
        ? await db.match.count({
            where: {
              activityId: activity.id,
              isHistorical: false,
              status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
              date: { lt: m.date },
            },
          })
        : 1; // any non-zero short-circuits the gate below
    const isNextUpcoming = earlierUnplayedCount === 0;

    if (
      !sentKeys.has(key) &&
      m.status === "UPCOMING" &&
      hoursUntilMatch > 24 &&
      inAnnounceWindow &&
      isNextUpcoming
    ) {
      const dateStr = format(m.date, "EEEE d MMMM 'at' HH:mm");
      out.push({
        kind: "group-message",
        key,
        matchId,
        text: `📅 *${activity.name}* — *${dateStr}* at ${activity.venue}.\n\nSay *IN* to join. First ${maxPlayers} confirmed play.`,
      });
    }
  }

  // ── 2. Daily 17:00 evening update ────────────────────────────────────
  //     One post per day at 17:00, content varies by state:
  //       2a. Squad short (need > 0): chase + unpaid tail appended
  //       2b. Squad full but bench thin (bench < 3): bench chase +
  //           unpaid tail appended
  //       2c. Squad full, bench ≥ 3, but some players unpaid: standalone
  //           unpaid reminder
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

    // "Is this the soonest unplayed match in the activity?" — same gate
    // as announce-match. When today's match is still unplayed and next
    // week's match has been auto-created, only the current week's
    // 5pm post is relevant. Without this, both matches fire their own
    // evening-update and the group sees a "next week is empty, need
    // 14" chase at 17:00 the same day as today's actual match.
    const earlierUnplayedCount = isPrematch
      ? await db.match.count({
          where: {
            activityId: activity.id,
            isHistorical: false,
            status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
            date: { lt: m.date },
          },
        })
      : 1;
    const isNextUpcoming = earlierUnplayedCount === 0;

    // Single shared key for the entire 17:00 evening slot. Whichever
    // branch fires first claims today; subsequent ticks see this key in
    // sentKeys and skip the whole block. Prevents the previous bug where
    // bench-thin firing at 17:04 didn't block unpaid-only firing at 17:09
    // five minutes later.
    const eveningKey = `${matchId}:evening-update:${dayKey}`;

    if (isEvening && isPrematch && isNextUpcoming && !sentKeys.has(eveningKey)) {
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
      const unpaidTail = skipUnpaidChase ? null : await buildUnpaidTail(activity.id);

      // Roster block listed under every branch — daily reminder so each
      // player sees their own name without scrolling up. Bench gets its
      // own numbered list when populated.
      const rosterBlock = buildSquadRosterBlock({
        confirmed,
        bench,
        maxPlayers: m.maxPlayers,
      });

      const isMatchDay = dayKey === matchDayKey;
      const teamsReady = m.teamAssignments.length > 0;

      let text: string | null = null;
      let mentions: string[] | undefined;

      if (isMatchDay && teamsReady) {
        // 2-pre. Match day with teams generated → SHOW THE TEAM
        // LINEUPS instead of the squad roster. By 17:00 on match day
        // people already know the squad is locked; what they actually
        // want is "am I Red or Yellow tonight?". Bench is omitted on
        // purpose — they're not playing unless someone drops, and
        // naming them on the lineup post is unnecessary noise.
        text = buildMatchDayTeamsBlock({
          activity,
          sport,
          matchDate: m.date,
          teamAssignments: m.teamAssignments,
        });
      } else if (isMatchDay && need === 0 && !teamsReady) {
        // 2-pre-alt. Match day, full squad, but teams haven't been
        // generated yet (LLM @-mention or admin button hasn't fired).
        // Show the roster AND nudge somebody to trigger team
        // generation so the next 17:00-window tick can show the
        // lineup. Most ticks happen every 5 min so nudge is acted on
        // quickly.
        const intro =
          `⚽ *Tonight at ${format(m.date, "HH:mm")}* — *${activity.name}* at ${activity.venue}\n\n` +
          `Squad is locked. Say *@MatchTime generate teams* in the chat to lock in tonight's lineup 👇`;
        text = `${intro}\n\n${rosterBlock}`;
      } else if (beforeDeadline && need > 0) {
        // 2a. Short squad — chase + unpaid tail. Chase template (LLM
        // or fallback) produces its own numbered list; the
        // enforceCanonicalRoster post-processor on the analyze path
        // already keeps that list in sync, so we leave it untouched
        // here rather than appending a duplicate roster block.
        const chaseText = await composeOrFallback("daily-in-list", () => {
          const list = confirmed
            .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
            .join("\n");
          return (
            `🗓 *${activity.name}* — need *${need} more*.\n\n` +
            (confirmed.length > 0 ? list : "_nobody yet_")
          );
        });
        text = unpaidTail ? `${chaseText}\n\n${unpaidTail.text}` : chaseText;
        mentions = unpaidTail?.mentions;
      } else if (beforeDeadline && need === 0 && unpaidTail) {
        // 2b. Squad full but the org tracks payments AND we still have
        // unpaid players in the chase window — post the unpaid tail
        // ALONE (no "full squad, ready to go" preamble, no bench
        // chase, no roster block). Anyone who needs to know who's
        // playing can scroll up; the only legitimate reason to post
        // daily once the squad's locked is to chase money.
        text = unpaidTail.text;
        mentions = unpaidTail.mentions;
      }
      // Squad full + no unpaid tail (org doesn't track payments OR
      // everyone has paid OR we're in the day-before/day-of window
      // where the chase is suppressed) → stay silent. Previously we
      // posted "🗓 full squad, ready to go ⚽" + roster every day at
      // 5pm; Kemal flagged this as spam (2026-05-03). The squad-just-
      // filled announcement is fired by the analyze route at the
      // moment the 14th IN lands, which is enough confirmation.
      // Same for the bench-thin nudge: it was firing every single
      // 5pm tick once the squad locked, which is more annoying than
      // useful — bench fills up organically over the week.
      // else: deadline passed but match not yet happened — leave the
      // key un-sent so a later tick in the same window can still fire
      // if state changes (e.g. someone drops out making bench thin).

      if (text) {
        out.push({
          kind: "group-message",
          key: eveningKey,
          matchId,
          text,
          mentions,
        });
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
      const benchAtt = m.attendances.filter(
        (a) => a.status === "BENCH" && a.user.phoneNumber,
      );
      for (const offer of m.benchSlotOffers) {
        if (benchAtt.length === 0) continue; // no bench — chase covers it

        // Context: which team / who they'd replace, if teams exist.
        let ctx = `for *${activity.name}* tonight`;
        let ctxPlain = `for ${activity.name} tonight`;
        if (offer.replacingUserId) {
          const repl = m.attendances.find((a) => a.userId === offer.replacingUserId)?.user;
          const ta = m.teamAssignments.find((t) => t.userId === offer.replacingUserId);
          if (repl && ta) {
            const labels = sport.teamLabels as [string, string];
            const tl = ta.team === "RED" ? labels[0] : labels[1];
            ctx = `on *${tl}* (replacing ${repl.name ?? "—"}) for *${activity.name}* tonight`;
            ctxPlain = `on ${tl} (replacing ${repl.name ?? "—"}) for ${activity.name} tonight`;
          }
        }

        const mentions = benchAtt.map((a) => a.user.phoneNumber!.replace(/^\+/, ""));
        const tagList = mentions.map((p) => `@${p}`).join(" ");

        // One group post to the whole bench, offer-keyed (ack maps the
        // waMessageId onto the BenchSlotOffer so a 👍 reaction finds
        // it). kind:"bench-prompt" so the bot ACKs with waMessageId.
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
            text:
              `🎟 A slot just opened ${ctx} — *first to claim it plays*.\n\n` +
              `${tagList}\n\n` +
              `React 👍 here (or reply *IN*) to take it. No rush, no timeout — ` +
              `whoever's free first gets it; everyone else stays on the bench. 🙏`,
          });
        }

        // Personal DM to each bencher (they often mute the group
        // thinking they're not playing). Per-(offer,user) key.
        for (const a of benchAtt) {
          const dmKey = `offer-${offer.id}:dm:${a.userId}`;
          if (sentKeys.has(dmKey)) continue;
          const first = a.user.name ? ` ${a.user.name.split(" ")[0]}` : "";
          out.push({
            kind: "dm",
            key: dmKey,
            matchId,
            phone: a.user.phoneNumber!.replace(/^\+/, ""),
            targetUser: a.userId,
            text:
              `👋 Hi${first} — a slot just opened ${ctxPlain} and you're on the bench.\n\n` +
              `Want it? Reply *YES* here (or 👍 / *IN* on the message I tagged you in, in the group). ` +
              `First to claim plays — no timeout, and if you're not free no worries, you stay on the bench. 🙏`,
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
      if (candidate) {
        const admins = await findOrgAdminsWithPhone(activity.orgId);
        for (const admin of admins) {
          const key = `${matchId}:switch-nudge:${admin.id}`;
          if (sentKeys.has(key)) continue;
          const token = signMagicLinkToken({
            userId: admin.id,
            purpose: "sign-in",
            ttlSeconds: MAGIC_LINK_TTL.actionNudge,
          });
          const signInUrl = await buildShortMagicLinkUrl(token);
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: admin.id,
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text:
              `⚠️ *Low numbers* — ${confirmed.length}/${maxPlayers} confirmed for *${activity.name}* tomorrow.\n\n` +
              `Switch to *${candidate.sport.name}* (${candidate.sport.playersPerTeam * 2} players) before the deadline?\n\n` +
              `Tap to open the admin panel (auto signs you in):\n${signInUrl}\n\n` +
              `Or navigate manually: /admin/matches/${matchId}/switch-format`,
          });
        }
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
      if (confirmed.length < minViable) {
        const admins = await findOrgAdminsWithPhone(activity.orgId);
        for (const admin of admins) {
          const key = `${matchId}:cancel-nudge:${admin.id}`;
          if (sentKeys.has(key)) continue;
          const token = signMagicLinkToken({
            userId: admin.id,
            purpose: "sign-in",
            ttlSeconds: MAGIC_LINK_TTL.actionNudge,
          });
          const signInUrl = await buildShortMagicLinkUrl(token);
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: admin.id,
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text:
              `🚨 *Match in trouble* — only *${confirmed.length}* confirmed for *${activity.name}* tomorrow, below the minimum to play (${minViable}).\n\n` +
              `Cancel and refund the booking?\n\n` +
              `Tap to open the cancel page:\n${signInUrl}\n\n` +
              `Or navigate manually: /admin/matches/${matchId}/cancel`,
          });
        }
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
        inMorningWindow
      ) {
        const text = await composeOrFallback(
          "match-day-morning",
          () =>
            `☀️ Morning all — still *${need} short* for tonight's *${activity.name}*. Any takers? 👀`,
        );
        out.push({ kind: "group-message", key, matchId, text });
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
        const text = await composeOrFallback(
          "chase-pre-kickoff",
          () =>
            `⏳ Still *${need} short* for *${activity.name}* at ${format(m.date, "HH:mm")}. Anyone free tonight?`,
        );
        out.push({ kind: "group-message", key, matchId, text });
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
      const base = `⏰ Tonight *${format(m.date, "HH:mm")}* at *${activity.venue}* · ${confirmed.length}/${maxPlayers}`;
      const text = await composeOrFallback(
        "pre-kickoff-short",
        () => `${base} — *still need ${need}*, last chance to jump in. 🙏`,
      );
      out.push({ kind: "group-message", key, matchId, text });
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
        text:
          `⚽ *${format(m.date, "HH:mm")} at ${activity.venue}* — see you there!\n\n` +
          `Quick reminder: if you've got them, please bring your *goalie gloves*, a *ball*, and *spare bibs*.`,
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
        text:
          `🏁 *${activity.name}* — hope it was a good one. What was the final score? ` +
          `I'll use it to keep next week's teams balanced.`,
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
  if (m.postMatchEndFlow !== false) {
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const key = `${matchId}:payment-poll`;
    if (
      !sentKeys.has(key) &&
      now >= endedAt &&
      (m.status === "UPCOMING" ||
        m.status === "TEAMS_GENERATED" ||
        m.status === "TEAMS_PUBLISHED" ||
        m.status === "COMPLETED")
    ) {
      const [redLabel, yellowLabel] = sport.teamLabels as [string, string];
      out.push({
        kind: "group-poll",
        key,
        matchId,
        question: `💳 Payments for *${activity.name}* — tick when you've paid`,
        options: [redLabel, yellowLabel],
      });
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
  if (
    m.postMatchEndFlow !== false &&
    activity.org?.paymentCollectionEnabled &&
    activity.org.paymentHolderId &&
    m.feePerPlayer == null &&
    m.feePendingConfirm == null
  ) {
    const endedAt = new Date(m.date.getTime() + activity.matchDurationMins * 60 * 1000);
    const key = `${matchId}:fee-ask`;
    if (!sentKeys.has(key) && now >= endedAt) {
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
        const first = collectorName?.split(" ")[0] ?? "there";
        const headcount = confirmed.length;
        out.push({
          kind: "dm",
          key,
          matchId,
          targetUser: collectorId,
          phone: collectorPhone.replace(/^\+/, ""),
          text:
            `💷 ${first} — how much should each player pay for *${activity.name}*` +
            (headcount > 0 ? ` (${headcount} played)` : "") +
            `?\n\n` +
            `Just reply with the amount — e.g. "£8 each" or "£80 total to split". ` +
            `I'll confirm, then send everyone their pay link.`,
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
    if (daysSinceRelease <= 10 && hourNow >= 18 && hourNow < 19) {
      const dayKey = londonDateKey(now);
      const dayNum = Math.max(1, Math.ceil(daysSinceRelease));

      // Players paying electronically (or undecided) — re-send the link.
      for (const a of confirmed) {
        if (a.paidAt) continue;
        if (a.directPendingAt) continue; // handled via collector nudge below
        if (!a.user.phoneNumber) continue;
        const key = `${matchId}:pay-chase:${a.userId}:${dayKey}`;
        if (sentKeys.has(key)) continue;
        const token = signMagicLinkToken({
          userId: a.userId,
          purpose: "sign-in",
          nextPath: `/pay/${matchId}`,
          ttlSeconds: MAGIC_LINK_TTL.permanent,
        });
        const first = a.user.name?.split(" ")[0] ?? "there";
        const opener =
          dayNum <= 1
            ? `Quick one ${first}`
            : dayNum === 2
              ? `${first}, gentle nudge`
              : `${first}, still owed`;
        out.push({
          kind: "dm",
          key,
          matchId,
          targetUser: a.userId,
          phone: a.user.phoneNumber.replace(/^\+/, ""),
          text:
            `💷 ${opener} — your *${gbp(m.feePerPlayer)}* for *${activity.name}* is still outstanding.\n\n` +
            `Pay by card / Apple Pay, or settle directly:\n${await buildShortMagicLinkUrl(token)}`,
        });
      }

      // Direct-pending → one daily nudge to the collector to confirm.
      const pendingDirect = confirmed.filter((a) => !a.paidAt && a.directPendingAt);
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
            const n = pendingDirect.length;
            out.push({
              kind: "dm",
              key: ckey,
              matchId,
              targetUser: collectorId,
              phone: collectorPhone.replace(/^\+/, ""),
              text:
                `🤝 ${n} player${n === 1 ? "" : "s"} said they'd pay you directly for *${activity.name}*. ` +
                `Tick off whoever's settled up:\n${await buildShortMagicLinkUrl(token)}`,
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

    // 6b + 6c. Rating DMs + group promo — HOLD until 08:00–09:00 London
    //          the morning AFTER match day. Previously these fired the
    //          moment the match flipped to COMPLETED, which for a
    //          21:30 kickoff meant midnight DMs — players asleep, worst
    //          possible time to ask for a rating. Now we wait for a
    //          civilised hour the next morning. Idempotency keys unchanged
    //          so this is a one-time shift, not a retroactive resend.
    {
      const matchDayKey = londonDateKey(m.date);
      const todayKey = londonDateKey(now);
      const hourNow = londonHour(now);
      // Widened from 08-09 to 08-10 so the promo (which can only fire
      // AFTER all rate DMs have landed — see below) still has runway
      // when there are many players or the bot started mid-window.
      // Pi DM rate-limit = 1/min, so 14 players = 14min; widening gives
      // the promo room to land even at the upper edge.
      const isMorningAfter =
        todayKey !== matchDayKey &&
        hoursSinceMatch >= 6 &&
        hoursSinceMatch <= 36 &&
        hourNow >= 8 &&
        hourNow < 10;

      if (isMorningAfter) {
        for (const a of confirmed) {
          if (!a.user.phoneNumber) continue;
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
            ttlSeconds: MAGIC_LINK_TTL.permanent,
          });
          out.push({
            kind: "dm",
            key,
            matchId,
            targetUser: a.userId,
            phone: a.user.phoneNumber.replace(/^\+/, ""),
            text:
              `🏆 *${activity.name}* — ${format(m.date, "EEE d MMM")}\n\n` +
              `Rate your teammates and pick ${sport.mvpLabel}. Takes ~1 minute.\n\n` +
              `Your personal link:\n${await buildShortMagicLinkUrl(token)}\n\n` +
              `Link expires in 5 days.\n\n` +
              `📊 Your season stats (ratings, MoM, badges, share card) — any time:\n${await buildShortMagicLinkUrl(statsToken)}`,
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
        const promoKey = `${matchId}:rate-promo`;
        const expectedRateDmKeys = confirmed
          .filter((a) => a.user.phoneNumber)
          .map((a) => `${matchId}:rate-dm:${a.userId}`);
        const allRateDmsSent =
          expectedRateDmKeys.length > 0 &&
          expectedRateDmKeys.every((k) => sentKeys.has(k));
        if (allRateDmsSent && !sentKeys.has(promoKey)) {
          out.push({
            kind: "group-message",
            key: promoKey,
            matchId,
            text:
              `🎯 Morning all — just DM'd every player from last night's *${activity.name}* ` +
              `a personal rating link. The more ratings we get, the better-balanced the ` +
              `teams get next week. Check your DMs from me 👇`,
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
        // Figure out who has already rated (MoMVote OR at least 1 Rating).
        const ratersMom = await db.moMVote.findMany({
          where: { matchId },
          select: { voterId: true },
        });
        const ratersRating = await db.rating.findMany({
          where: { matchId },
          select: { raterId: true },
          distinct: ["raterId"],
        });
        const rated = new Set<string>([
          ...ratersMom.map((r) => r.voterId),
          ...ratersRating.map((r) => r.raterId),
        ]);
        const dayKey = londonDateKey(now);
        for (const a of confirmed) {
          if (!a.user.phoneNumber) continue;
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
          const text = buildReminderText({
            dayNum,
            playerName: a.user.name,
            activityName: activity.name,
            mvpLabel: sport.mvpLabel,
            url: await buildShortMagicLinkUrl(token),
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

    // 6e. MoM announcement. Two triggers (whichever comes first):
    //   • EARLY — as soon as every confirmed player with a phone has
    //     engaged (cast a MoM vote OR submitted ratings). No point making
    //     the group wait 5 days once everyone's voted (Kemal 2026-06-02).
    //     Civil hours only (09:00–21:00 London) so we never announce
    //     overnight.
    //   • BACKSTOP — 5 days after the match at 15:00 London, for matches
    //     where some players never vote.
    {
      const key = `${matchId}:mom-announcement`;
      const fiveDaysLater = new Date(m.date.getTime() + 5 * 24 * 60 * 60 * 1000);
      const lh = londonHour(now);
      const backstopWindow = now >= fiveDaysLater && lh >= 15 && lh < 16;

      let earlyReady = false;
      if (!sentKeys.has(key) && !backstopWindow && lh >= 9 && lh < 21) {
        const expected = confirmed.filter((a) => a.user.phoneNumber);
        if (expected.length > 0) {
          const [momVoters, ratingVoters] = await Promise.all([
            db.moMVote.findMany({ where: { matchId }, select: { voterId: true } }),
            db.rating.findMany({
              where: { matchId },
              select: { raterId: true },
              distinct: ["raterId"],
            }),
          ]);
          const engaged = new Set<string>([
            ...momVoters.map((v) => v.voterId),
            ...ratingVoters.map((r) => r.raterId),
          ]);
          // Everyone we asked has engaged, AND at least one real MoM vote
          // exists (players can rate without picking MoM).
          earlyReady =
            momVoters.length > 0 && expected.every((a) => engaged.has(a.userId));
        }
      }

      if (!sentKeys.has(key) && (backstopWindow || earlyReady)) {
        const votes = await db.moMVote.groupBy({
          by: ["playerId"],
          where: { matchId },
          _count: { playerId: true },
        });
        if (votes.length > 0) {
          const totalVotes = votes.reduce((sum, v) => sum + v._count.playerId, 0);
          const allUsers = await db.user.findMany({
            where: { id: { in: votes.map((v) => v.playerId) } },
            select: { id: true, name: true },
          });
          const nameById = new Map(allUsers.map((u) => [u.id, u.name ?? "—"]));
          const tally = votes
            .map((v) => ({
              name: nameById.get(v.playerId) ?? "—",
              votes: v._count.playerId,
            }))
            .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
          const topCount = tally[0].votes;
          const topNames = tally.filter((t) => t.votes === topCount).map((t) => t.name);
          const sharedHeader = topNames.length > 1;
          const namesText = sharedHeader
            ? topNames.length === 2
              ? `${topNames[0]} & ${topNames[1]}`
              : `${topNames.slice(0, -1).join(", ")} & ${topNames.slice(-1)[0]}`
            : topNames[0];
          const breakdown = tally.map((t) => `• ${t.name} — ${t.votes}`).join("\n");
          out.push({
            kind: "group-message",
            key,
            matchId,
            text:
              `🏆 *${sport.mvpLabel} — ${activity.name}*\n\n` +
              (sharedHeader
                ? `Shared between *${namesText}* (${topCount} vote${topCount === 1 ? "" : "s"} each, ${totalVotes} total) 🎉\n\n`
                : `Congrats *${namesText}* (${topCount}/${totalVotes} vote${totalVotes === 1 ? "" : "s"}) 🎉\n\n`) +
              `Votes:\n${breakdown}\n\n` +
              `Your trophy & drink awaits next match.`,
          });
        }
        // If 0 votes, skip silently.
      }
    }
  }
}

// ─────────────────────── Bench-confirmation sweeper ───────────────────────

/**
 * Move forward any PendingBenchConfirmation whose window has expired. For
 * each expired unresolved row, mark the user as DROPPED and create a new
 * PendingBenchConfirmation for the next bench player. Call this right at
 * the top of /due-posts so the resulting new prompt gets posted in the
 * same poll cycle.
 */
// Bench redesign 2026-05-19: there is NO elimination/expiry of
// people any more — an offer is open to the whole bench until
// someone claims it. This sweep now only does cleanup: close any
// offer whose match has already kicked off (nobody can claim a slot
// for a game that's started). Same export name so /due-posts is
// unchanged. Nobody is ever dropped here.
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

/**
 * Create a PendingBenchConfirmation when someone drops AND the match is
 * already full (status UPCOMING with confirmed === maxPlayers). Call this
 * from the dropout flow (lib/attendance.ts).
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
    include: { attendances: true },
  });
  if (!match) return;

  const hasBench = match.attendances.some((a) => a.status === "BENCH");
  if (!hasBench) return; // nobody on the bench — chase handles it

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
