/**
 * Recruit recent players to the next match (2026-06-05).
 *
 * Admin-triggered DM blast: nudges everyone who played in the last few
 * completed matches but hasn't yet responded to the upcoming one, asking
 * them to grab a spot. Born from a real gap — the analyzer's LLM was
 * *claiming* "I'll DM the recent players" with no action behind it
 * (Kemal 2026-06-05). This is the real action so the claim becomes true.
 *
 * Authorisation is the CALLER's job (org admin/owner). This lib just does
 * the work for a given orgId.
 */
import { db } from "./db";
import { recruitNoMatchRefusal, buildRecruitFullSquadRefusal } from "./group-copy";
import { buildFullSquadBenchInvite } from "./bench-offer-copy";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";
import { formatLondon } from "./london-time";
import { getOrgFeatures } from "./org-features";
import { recruitDmLinkKey, RECRUIT_DM_LINK_KIND } from "./recruit-reaction";
import { resolveLookbackMatches } from "./recruit-lookback";

/**
 * The lookback window, its ceiling and the clamp now live in
 * `recruit-lookback.ts` and are re-exported here so every existing
 * caller is unchanged.
 *
 * They moved because the decision engine needs the clamp — §10 step 7
 * gives `admin_ops` a recruit branch, and "message everyone from the
 * last 5 matches" puts a MODEL-READ NUMBER in front of a mass DM. This
 * module imports `db`, and nothing the pipeline imports may reach Prisma
 * (see `recruit-lookback.ts`'s header for what happens when it does).
 * One ceiling, in one file, reachable from both.
 */
export {
  LOOKBACK_MATCHES,
  RECRUIT_LOOKBACK_MAX,
  resolveLookbackMatches,
} from "./recruit-lookback";

/* ────────────────────────────────────────────────────────────────────
 * ⚰️ DELETED 2026-09-11: `looksLikeRecruitRequest`
 *
 * It was:
 *
 *   an explicit recruit verb (find / get / invite / recruit / grab /
 *   round up / dm / message / text / nudge) sitting ADJACENT to a
 *   people / recency / spots noun,
 *     OR
 *   an explicit shortage phrase ("we're short", "need N more players",
 *   "anyone free", "spots left", …),
 *
 *   minus a "hard exclusion" for list/show/who's-playing questions.
 *
 * ── WHY IT IS GONE, IN TWO ACTS ──────────────────────────────────────
 *
 * 2026-09-01, the GROUP path. The owner posted "Najib is out. We need
 * one more player.\n\nCan someone pls come forward". The pattern matched
 * the SECOND sentence and the fast path peeled the whole message off the
 * LLM batch, so the third-party OUT was never analysed by anything.
 * Najib stayed in, the blast saw a 10/10 squad, and MatchTime replied
 * "The squad for *Tuesday 5-a-side* is already full — no open spots to
 * recruit for." one line after the owner said a player was out.
 * `recruit-request.ts` carries that argument in full, including the part
 * that names the real defect: the "hard exclusions" were an attempt to
 * tell "list the players" from "get more players" with a pattern, which
 * is language understanding done in regex, inside a system already
 * paying a language model to do exactly that.
 *
 * 2026-09-11, the DM path. The comment that stood here said the
 * remaining caller — `api/whatsapp/dm-reply/route.ts` — "is the next
 * conversion, not this PR's; deleting the function outright would
 * silently kill recruit-by-DM". This is that conversion. The DM surface
 * now asks ONE model call what a message is (`lib/dm-intent.ts`, a
 * closed enum of `recruit_blast` / `rating_progress` / `other`) and the
 * code keeps every gate: the admin/superadmin lookup runs BEFORE the
 * model is asked at all, the upcoming-match lookup runs after it, and a
 * classifier that fails for any reason yields `other`, which DMs nobody.
 *
 * Between the two, on 2026-09-10, the third member of the family — the
 * stats blast's three ANDed keyword tests — read an owner's reminder to
 * his players as a bulk-DM command and queued 69 personal stats-link
 * DMs (`lib/stats-blast.ts`). Four deletions of this shape now:
 * 2026-04-21 `handlers.ts:7-10`, 2026-09-01, 2026-09-10, 2026-09-11.
 *
 * ── WHAT IS LOST, SAID OUT LOUD ──────────────────────────────────────
 *
 * A DM that asks for a blast now costs one Haiku call (about £0.001) on
 * the small fraction of DMs that come from an admin, where before it
 * cost nothing. And a model can decline an ask a regex would have
 * matched — measured, not assumed: see the live counts in the PR body
 * and `DMS=1` in `scripts/dryrun-pipeline.ts`. Against that, the regex
 * could FIRE on a message that asked for nothing, and the thing behind
 * it DMs up to 27 people from an unofficial WhatsApp client.
 *
 * DO NOT ADD IT BACK.
 * ──────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────
 * THE INVITE COPY
 *
 * Rewritten 2026-08-31 at the owner's instruction. The old invite led
 * with a magic link:
 *
 *   "👋 Abid — we're putting the squad together for *Tuesday 7-a-side*
 *    on Tue 1 Sept, 21:30 — 4 spots left. Fancy it?
 *
 *    Tap to grab a spot:
 *    <link>"
 *
 * Half of this club is older and not technical. They do not tap links;
 * they reply, or they tap the emoji their thumb is already near. So the
 * ASK now leads and the link is demoted to a trailing option.
 *
 * SAYING NO IS AS EASY AS SAYING YES (owner, same day). A chase-up DM
 * for silent players is being built alongside this; a player who cannot
 * make it but never answers gets chased for no reason. Offering *OUT* as
 * plainly as *IN* is what keeps the club considerate rather than naggy —
 * hence "I'll stop asking".
 *
 * WHY THE DM DOES NOT MENTION 👍 (2026-08-31, and this is the important
 * one): see RECRUIT_DM_MENTION_REACTIONS below. The bot can HANDLE a
 * reaction; it currently cannot RECEIVE one. Instructing a player to do
 * something that silently does nothing is the exact failure this club
 * just lost a week to, so the instruction is gated even though the
 * capability behind it is live.
 *
 * The link is KEPT rather than dropped: some players do use the app, and
 * it doubles as their sign-in path (it is a magic link, so tapping it is
 * how a player gets an authenticated session at all).
 *
 * House style: no em dashes, no en dashes, no slashes in prose. Only the
 * URL contains a slash.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Does the invite TELL players they can answer with a 👍 or a 👎?
 *
 * ⚠️ FALSE, deliberately, and it is not a style choice.
 *
 * The handling is built, tested and live (src/lib/recruit-reaction.ts):
 * an unprompted 👍 on an invite DM registers the player, a 👎 drops them.
 * What is NOT working is the bot's ability to RECEIVE a reaction at all.
 * whatsapp-web.js's injected page code is out of step with the live
 * WhatsApp Web build, so `msgId._serialized` is unreadable on the inbound
 * `message_reaction` event and the bot discards it before the server is
 * ever called. Evidence, on the Pi, 2026-08-31:
 *
 *   $ grep -c "reaction-forwarding is unavailable" ~/matchtime-bot/bot.err.log
 *   8                      # and zero successful reaction forwards, ever
 *
 * The outbound half is broken too: `sendMessage` returns a Message whose
 * id we cannot read, so `SentNotification.waMessageId` is NULL on 0 of
 * the last 17 dispatches. Bench-offer 👍 is already dead for the same
 * reason.
 *
 * So an invite saying "tap 👍" would ask a player to do something that
 * does absolutely nothing, and they would believe they had answered.
 * That is precisely the silent-failure class behind the duplicate-send
 * incident and the 3-day inbound outage: the system looks fine, the human
 * gets the wrong outcome. We do not ship it, however good the code
 * behind it is.
 *
 * ── FLIP THIS BACK TO `true` WHEN ────────────────────────────────────
 * inbound reaction forwarding works again. The fix is in the bot, not
 * here: `whatsapp-bot/src/message-id.ts` (see §1b of
 * MDs/whatsapp-layer-independent-audit-2026-08-30.md — `msg.id` most
 * likely arrives as a STRING rather than the `{_serialized}` object and
 * `read()` throws it away). Verify BEFORE flipping: no new
 * `reaction-forwarding is unavailable` lines in bot.err.log, and recent
 * `SentNotification` rows carrying a non-null `waMessageId`. Then this
 * one line restores the 👍 instruction; nothing else needs to change.
 */
export const RECRUIT_DM_MENTION_REACTIONS = false;

export interface RecruitInviteCopy {
  firstName: string;
  matchName: string;
  /** "EEE d MMM, HH:mm" London. */
  matchWhen: string;
  /** Open slots. 0 means "suppressed or full" and the phrase is omitted. */
  spotsLeft: number;
  /** Short magic link, or null to omit the optional last line entirely. */
  link: string | null;
  /** Override the 👍/👎 instruction gate. Tests only — production must
   *  read RECRUIT_DM_MENTION_REACTIONS so the copy cannot drift from
   *  what the bot can actually receive. */
  mentionReactions?: boolean;
}

/** The invite for an org that tracks attendance in-app. */
export function buildRecruitInviteDm(c: RecruitInviteCopy): string {
  const spots =
    c.spotsLeft > 0 ? ` ${c.spotsLeft} ${c.spotsLeft === 1 ? "spot" : "spots"} left.` : "";
  const reactions = c.mentionReactions ?? RECRUIT_DM_MENTION_REACTIONS;
  const lines = [
    `👋 ${c.firstName}, we're putting the squad together for *${c.matchName}* on ${c.matchWhen}.${spots}`,
    "",
    reactions ? "Playing? Reply *IN* or tap 👍 on this message." : "Playing? Just reply *IN*.",
    reactions
      ? "Can't make it? Reply *OUT* or tap 👎 and I'll stop asking 🙌"
      : "Can't make it? Reply *OUT* and I'll stop asking 🙌",
  ];
  if (c.link) lines.push("", `Prefer the app? ${c.link}`);
  return lines.join("\n");
}

/**
 * The invite for a MoM/ratings-only org. There is no in-app squad, so an
 * RSVP link would do nothing and the group is where they join.
 */
export function buildRecruitGroupInviteDm(c: {
  firstName: string;
  matchName: string;
  matchWhen: string;
}): string {
  return (
    `👋 ${c.firstName}, we're putting the squad together for *${c.matchName}* on ${c.matchWhen}. ` +
    `Fancy it? Just reply *IN* in the group and you're sorted 🙌`
  );
}

export interface RecruitResult {
  ok: boolean;
  /** Set when ok=false — why nothing happened (for an admin-facing reply). */
  reason?: string;
  matchId?: string;
  matchName?: string;
  /** "EEE d MMM, HH:mm" London. */
  matchWhen?: string;
  /** Open slots on the upcoming match (maxPlayers − confirmed). */
  need?: number;
  /** How many invite DMs were newly queued this call. */
  invited?: number;
  /** Names invited (for the admin confirmation). */
  invitedNames?: string[];
  /** Candidates that existed but were SKIPPED this call purely because they
   *  were already invited for this match (idempotency). Lets the caller tell
   *  "already pinged everyone, awaiting replies" apart from "no candidates at
   *  all" — the two otherwise return identical (invited:0) shapes. */
  alreadyInvited?: number;
}

export async function inviteRecentPlayers(
  orgId: string,
  /** Override the number of recent completed matches to draw candidates
   *  from. Defaults to LOOKBACK_MATCHES; clamped to RECRUIT_LOOKBACK_MAX. */
  lookbackMatches?: number,
): Promise<RecruitResult> {
  const lookback = resolveLookbackMatches(lookbackMatches);
  // One features read, three consumers: the refusals' language, and the
  // two below. Read first because the no-match refusal needs the
  // language before there is a match to speak about.
  const features = await getOrgFeatures(orgId);
  // 1. The next upcoming match.
  const startToday = new Date();
  startToday.setUTCHours(0, 0, 0, 0);
  const next = await db.match.findFirst({
    where: {
      activity: { orgId },
      isHistorical: false,
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      date: { gte: startToday },
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      maxPlayers: true,
      activity: { select: { name: true } },
      attendances: { select: { userId: true, status: true } },
    },
  });
  if (!next) return { ok: false, reason: recruitNoMatchRefusal(features.language) };

  // Anyone with ANY attendance row has already responded (in / bench /
  // explicitly out) — don't pester them. We only invite recent players
  // who haven't engaged with this match at all.
  const responded = new Set(next.attendances.map((a) => a.userId));
  const confirmedCount = next.attendances.filter((a) => a.status === "CONFIRMED").length;
  // Only meaningful when the org actually tracks attendance. For MoM/
  // ratings-only orgs (e.g. Sutton Lads) confirmed is always 0, so the
  // count would falsely read "14 spots left" in every invite — suppress it.
  // `attendance` suppresses the "N spots left" phrase for ratings-only
  // orgs; `bench` decides what a recruit ask into a FULL squad is
  // answered with (the capacity guard below). Both off the one read
  // above, so the query count is unchanged.
  const attendanceOn = features.attendance;
  // Real capacity, independent of the attendance feature flag. CONFIRMED
  // fills the squad, so open slots = maxPlayers − confirmed. `need` is kept
  // for DISPLAY copy (suppressed for ratings-only orgs) so the visible
  // "N spots left" behaviour is unchanged.
  const openSlots = Math.max(0, next.maxPlayers - confirmedCount);
  const need = attendanceOn ? openSlots : 0;

  // formatLondon needed both by the capacity-guard early return and the
  // normal return paths — compute it once, up front.
  const matchWhen = formatLondon(next.date, "EEE d MMM, HH:mm");

  // ── CAPACITY GUARD ──────────────────────────────────────────────────
  //
  // A full confirmed squad has no open spot to DM anyone into, so the
  // blast is skipped: bail before the candidate map and the DM loop.
  // Only applies when the org tracks capacity (maxPlayers > 0); for
  // attendance-off orgs confirmedCount is always 0 so openSlots stays
  // > 0 and this never blocks them (they recruit via the group, capacity
  // isn't really tracked) — desired behaviour.
  //
  // ── WHAT IS ANSWERED IS NOT "NOTHING" (2026-09-14) ──────────────────
  //
  // Skipping the blast is right. The SENTENCE that went with it was not.
  // Live, in the Sutton group, the owner asked untagged:
  //
  //   "it would be great to have some benchers in case someone drops
  //    tomorrow? Anybody else interested"
  //
  // and MatchTime answered "The squad for *Tuesday 7-a-side* is already
  // full — no open spots to recruit for." Backwards: benchers are wanted
  // BECAUSE the squad is full. The match kicked off 14 of 14 with an
  // empty bench, because the reply talked the volunteers out of
  // volunteering.
  //
  // With `featureBench` on, a full squad is the one state where MatchTime
  // has something genuinely useful to offer a volunteer, and it needs no
  // admin and no new code: a late IN is written BENCH by the capacity
  // rule, a drop opens a BenchSlotOffer, the first bencher to reply IN
  // takes the slot. So the branch is on the FEATURE, not on the phrasing.
  //
  // ── WHY THE DECISION IS HERE AND THE WORDS ARE NOT ──────────────────
  //
  // Here, because this is the only place that holds all three facts at
  // once (the squad is full, the org's features, which match it is) and
  // because ONE branch then fixes BOTH surfaces. The group blast in
  // `analyze/route.ts` printed this `reason` verbatim; the admin-by-DM
  // path in `dm-reply/route.ts` dropped it and said "everyone has
  // already responded", which for a full squad was never true either.
  // Both now render this decision, so they cannot disagree about the
  // state of the squad. Deciding it at a call site would have fixed one.
  //
  // The words live in `bench-offer-copy.ts` with every other sentence
  // that promises a bench promotion, so they cannot drift from what the
  // platform can actually receive — today that means no 👍, because
  // inbound reaction forwarding is dead on the Pi.
  //
  // ── AND NOTHING IS DM'd, EITHER WAY ─────────────────────────────────
  //
  // The obvious next step is a DM blast inviting recent players onto the
  // bench. Deliberately not built, and not because it is hard:
  // `recruit-lookback.ts` records that the bot runs on an UNOFFICIAL
  // WhatsApp client where a mass DM risks the account, which takes the
  // whole product down, and this week's work has been spent deleting
  // things that can mass-DM. A group reply reaches the same people, in
  // the thread where they asked, at no risk. Both branches below return
  // `invited: 0` and queue nothing.
  if (next.maxPlayers > 0 && openSlots <= 0) {
    return {
      ok: true,
      matchId: next.id,
      matchName: next.activity.name,
      matchWhen,
      need,
      invited: 0,
      invitedNames: [],
      reason: features.bench
        ? buildFullSquadBenchInvite({
            matchName: next.activity.name,
            confirmedCount,
            maxPlayers: next.maxPlayers,
            lang: features.language,
          })
        : // Bench OFF: the old sentence, unchanged, because for that org
          // it is the truth. `bot-scheduler.ts` refuses to post a bench
          // prompt without the feature (`instr.kind === "bench-prompt" &&
          // !features.bench`), so promising one would be the silent
          // failure this codebase keeps paying for: a player does as they
          // are told and nothing happens.
          buildRecruitFullSquadRefusal({ matchName: next.activity.name, lang: features.language }),
    };
  }

  // 2. Distinct CONFIRMED attendees from the last few completed matches.
  const recent = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, status: "COMPLETED" },
    orderBy: { date: "desc" },
    take: lookback,
    select: {
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });

  // Respect per-category DM subscriptions: anyone who opted OUT of match
  // invites (subMatchInviteDm=false on their membership for this org) is
  // excluded from the recruit blast. Default is subscribed, so only
  // explicit opt-outs are filtered.
  const inviteOptedOut = new Set(
    (
      await db.membership.findMany({
        where: { orgId, subMatchInviteDm: false },
        select: { userId: true },
      })
    ).map((mem) => mem.userId),
  );

  const candidates = new Map<string, { id: string; name: string | null; phone: string }>();
  for (const m of recent) {
    for (const a of m.attendances) {
      if (responded.has(a.userId)) continue; // already responded to next match
      if (inviteOptedOut.has(a.userId)) continue; // opted out of match-invite DMs
      if (!a.user.phoneNumber) continue; // can't DM without a number
      candidates.set(a.user.id, { id: a.user.id, name: a.user.name, phone: a.user.phoneNumber });
    }
  }

  if (candidates.size === 0) {
    return {
      ok: true,
      matchId: next.id,
      matchName: next.activity.name,
      matchWhen,
      need,
      invited: 0,
      invitedNames: [],
    };
  }

  // 3. Queue an invite DM per candidate, idempotent per match.
  const invitedNames: string[] = [];
  let alreadyInvited = 0;
  for (const c of candidates.values()) {
    const key = `${next.id}:recruit-dm:${c.id}`;
    const exists = await db.sentNotification.findUnique({ where: { key }, select: { id: true } });
    if (exists) {
      alreadyInvited++; // candidate existed but was pinged on an earlier call
      continue;
    }
    const first = c.name?.split(" ")[0] ?? "there";
    let text: string;
    if (attendanceOn) {
      // Org tracks attendance in-app → the magic link is worth offering,
      // as a trailing option and as this player's sign-in path.
      const token = signMagicLinkToken({
        userId: c.id,
        purpose: "sign-in",
        nextPath: `/matches/${next.id}`,
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      text = buildRecruitInviteDm({
        firstName: first,
        matchName: next.activity.name,
        matchWhen,
        spotsLeft: need,
        link: await buildShortMagicLinkUrl(token),
      });
    } else {
      // MoM/ratings-only org (no in-app squad) → an RSVP link does nothing.
      // Players join by posting in the group, so nudge them there.
      text = buildRecruitGroupInviteDm({
        firstName: first,
        matchName: next.activity.name,
        matchWhen,
      });
    }
    const job = await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: c.phone.replace(/^\+/, ""),
        text,
      },
    });
    await db.sentNotification.create({
      data: { key, kind: "recruit-dm", matchId: next.id, targetUser: c.id },
    });
    // LINK ROW — how a 👍/👎 on this very DM finds its way back to this
    // player and this match. The reaction event carries only the WhatsApp
    // message id; /ack stamps that onto the `botjob-<id>` claim row, and
    // this row turns that BotJob id into (matchId, userId). Without it we
    // would be guessing from a phone number and a timestamp, and a 👍 on
    // a payment chase would silently sign someone up. See
    // src/lib/recruit-reaction.ts. Best-effort: a failure here loses the
    // reaction shortcut, never the invite itself.
    await db.sentNotification
      .create({
        data: {
          key: recruitDmLinkKey(job.id),
          kind: RECRUIT_DM_LINK_KIND,
          matchId: next.id,
          targetUser: c.id,
        },
      })
      .catch((err) => {
        console.error(
          `[recruit] could not link BotJob ${job.id} to the invite for ${c.id} — ` +
            `a 👍 on that DM will not be mappable. The reply path is unaffected.`,
          err,
        );
      });
    invitedNames.push(c.name ?? "Player");
  }

  return {
    ok: true,
    matchId: next.id,
    matchName: next.activity.name,
    matchWhen,
    need,
    invited: invitedNames.length,
    invitedNames,
    alreadyInvited,
  };
}
