/**
 * The bot polls this endpoint every ~30s per group. We compute every
 * WhatsApp message that's due right now, CLAIM each one atomically, and
 * return only the claimed instructions for the bot to execute.
 *
 * ── Claim-on-dispatch (2026-07-19 duplicate-send incident) ────────────
 * This endpoint used to just return the due list; the SentNotification
 * row was written later, when the bot ACKed — i.e. AFTER it had composed
 * the text via an LLM and sent it over WhatsApp. When duplicate bot
 * processes existed on the Pi (orphans outside systemd's cgroup, all
 * logged into the same WhatsApp account, all polling), every one of them
 * received the SAME instruction inside that window and every one sent it.
 * A group got 30+ copies of one roster post; all the ACKs upserted into a
 * single row, so the database looked perfectly healthy.
 *
 * Now the row is created HERE, at hand-off, using the existing @unique
 * constraint on SentNotification.key as the arbiter: the first writer
 * wins, concurrent claimants get P2002 and skip the instruction. ACK is
 * demoted to an idempotent update.
 *
 * TRADE-OFF — delivery is now AT-MOST-ONCE. If a bot claims a message and
 * dies before sending it, that message is lost; nothing re-emits it. That
 * is deliberate: a missed roster post is dramatically better than 30
 * duplicates, and the next cycle's post covers the gap. The one exception
 * is DMs the bot's rate limiter deliberately holds back — the bot
 * RELEASES those claims (POST /api/whatsapp/ack with `release: true`) so
 * they are re-emitted next tick, preserving the existing pacing
 * behaviour. Full reasoning in src/lib/dispatch-claim.ts.
 *
 * ── Outbound guards (2026-08-31) ──────────────────────────────────────
 * The blunt "10 group messages per hour" cap added the day after the
 * incident was the wrong shape: it gagged the bot exactly when a match
 * day got busy and every suppressed message was legitimate. It is
 * replaced by a REPETITION guard (the same text to the same group more
 * than MAX_IDENTICAL_GROUP_MESSAGES times inside REPETITION_WINDOW_MS is
 * always a bug) plus a raised sanity ceiling of 40/hour. DMs are gated by
 * neither. Both are best-effort: if the guard's own queries fail we allow
 * the send, because a broken guard must never silence a customer's group.
 *
 * ── Platform DM bridge (self-join slice 3, 2026-09-29) ────────────────
 * Sign-up codes moved off BotJob onto PlatformJob, which a Pi built with
 * slice 3 polls at /api/whatsapp/platform-jobs. A Pi built before it does
 * not, and the server ships on merge while the Pi is deployed by hand. So
 * when a poll arrives WITHOUT the `x-mt-platform-jobs: 1` header, a couple
 * of due platform DMs ride along here as ordinary `dm` instructions keyed
 * `platform-<id>`, claimed on the PlatformJob row (not SentNotification),
 * first in the list so the Pi's DM pacing serves a waiting sign-up first.
 * A new Pi sends the header and gets none. See src/lib/platform-jobs.ts.
 *
 * ── Cap 8: DMs from a new self-join club (slice 7, 2026-09-29) ─────────
 * A club approved through self-join sends its members at most
 * NEW_CLUB_MEMBER_DMS_PER_DAY (20) DMs per London day for its first 28
 * days from approval. DMs over the allowance are simply not claimed, so
 * they come back on a later poll (tomorrow, once today's are spent). Group
 * posts are untouched. A club that predates self-join (Sutton FC) has a
 * NULL `approvedAt` and is never capped. Fails open, like the guards above.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeDuePosts, sweepExpiredBenchConfirmations } from "@/lib/bot-scheduler";
import { bridgePlatformDmsForLegacyPi } from "@/lib/platform-jobs";
import { sendDueDeadlineSummaries } from "@/lib/deadline-summary";
import { sendDueUnpaidLists } from "@/lib/unpaid-list";
import { sweepOrganiserPicks } from "@/lib/organiser-pick";
import { holdDmsOverAllowance, newClubDmCap } from "@/lib/club-decision-rules";
import { londonMidnight } from "@/lib/club-connect-rules";
import { countOrgDmsSince } from "@/lib/org-dm-count";
import { PI_CAPS_HEADER, parsePiCaps } from "@/lib/admin-channel-rules";
import {
  CIRCUIT_BREAKER_WINDOW_MS,
  GROUP_DIRECTED_KINDS,
  MAX_IDENTICAL_GROUP_MESSAGES,
  OUTBOUND_TEXT_LOG_KIND,
  REPETITION_WINDOW_MS,
  outboundTextLogKey,
  outboundTextLogPrefix,
  parseOutboundTextLogKey,
  selectDispatchable,
  type Claimable,
  type RecentOutboundText,
} from "@/lib/dispatch-claim";

/**
 * How many group-directed messages this org has already sent inside the
 * circuit-breaker window.
 *
 * Attribution has to cover every key class this org can emit:
 *   - `<matchId>:…`  → joined via match.activity.orgId
 *   - `org-<orgId>:…` → key prefix
 *   - `botjob-<id>`   → BotJob rows carry orgId; resolve ids then match
 *                       by key (these rows are written with matchId NULL
 *                       and a non-`org-` key, so neither of the other two
 *                       predicates would ever see them).
 * `retro-react-<id>` is an update-reaction (not group-directed) so it
 * never counts against the group budget. Neither do `outbound-text-log`
 * ledger rows — that kind is deliberately absent from
 * GROUP_DIRECTED_KINDS.
 */
async function countRecentGroupSends(orgId: string, since: Date): Promise<number> {
  const orgBotJobs = await db.botJob.findMany({
    where: { orgId, createdAt: { gte: new Date(since.getTime() - CIRCUIT_BREAKER_WINDOW_MS) } },
    select: { id: true },
    take: 500,
  });
  const botJobKeys = orgBotJobs.map((j) => `botjob-${j.id}`);

  return db.sentNotification.count({
    where: {
      createdAt: { gte: since },
      kind: { in: [...GROUP_DIRECTED_KINDS] },
      OR: [
        { match: { activity: { orgId } } },
        { key: { startsWith: `org-${orgId}:` } },
        ...(botJobKeys.length ? [{ key: { in: botJobKeys } }] : []),
      ],
    },
  });
}

/**
 * The group texts this org has sent inside the repetition window.
 *
 * Sourced from the `outbound-text-log` ledger rows this route writes
 * itself (see src/lib/dispatch-claim.ts for why the hash lives in the
 * SentNotification key rather than a new column — no migration). Filtered
 * on the indexed `kind` first, so this is a handful of rows even on a
 * busy day.
 *
 * FAILS OPEN. If this query throws we return no history, the repetition
 * guard sees only within-batch repeats, and the message still goes out.
 * A guard that can silence a customer's group when the database hiccups
 * would be worse than the bug it is guarding against.
 */
async function fetchRecentGroupTexts(orgId: string, now: Date): Promise<RecentOutboundText[]> {
  try {
    const rows = await db.sentNotification.findMany({
      where: {
        kind: OUTBOUND_TEXT_LOG_KIND,
        createdAt: { gte: new Date(now.getTime() - REPETITION_WINDOW_MS) },
        key: { startsWith: outboundTextLogPrefix(orgId) },
      },
      select: { key: true, createdAt: true },
      take: 500,
    });
    const out: RecentOutboundText[] = [];
    for (const row of rows) {
      const parsed = parseOutboundTextLogKey(row.key);
      if (parsed && parsed.orgId === orgId) out.push({ hash: parsed.hash, at: row.createdAt });
    }
    return out;
  } catch (err) {
    console.error(
      `[due-posts] org ${orgId}: could not read the outbound text log — repetition guard ` +
        `degraded to within-batch only for this poll.`,
      err,
    );
    return [];
  }
}

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");
  if (!groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }

  // Find the org first so we can run the bench-confirmation sweep scoped to
  // it. This has to happen before compute so the new prompt that replaces
  // the expired one gets posted in this same cycle.
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true, approvedAt: true },
  });
  if (!org) {
    return NextResponse.json({ error: "Organisation not found / bot disabled" }, { status: 404 });
  }

  await sweepExpiredBenchConfirmations(org.id);

  // TEST-ONLY clock override (e2e suite): honour x-test-now only when the
  // server was booted with MT_TEST_MODE=1 (never set in prod). Lets tests
  // exercise time-of-day windows (rate-dm from 08:00 London onward,
  // rate-reminder 18-19) deterministically.
  let nowOverride: Date | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    const header = request.headers.get("x-test-now");
    if (header) {
      const d = new Date(header);
      if (!Number.isNaN(d.getTime())) nowOverride = d;
    }
  }

  // TEST-ONLY preview mode, see below. Read here too, so a preview never
  // claims a platform job through the bridge.
  const previewOnly = process.env.MT_TEST_MODE === "1" && request.headers.get("x-no-claim") === "1";

  // WEEKLY DEADLINES, D2 (2026-09-30): the organisers' summary once the
  // club's drop-out deadline has passed. Queued as a BotJob through
  // `sendAdminNotice` BEFORE compute, so it goes out in this same poll.
  // A side effect, so never in preview mode; its own try/catch, so a
  // failure here can never cost the group its posts.
  // ORGANISER PICK (slice 2b, 2026-10-01): open, supersede, close and fall
  // back the club's pick rounds, and queue the pick message through the
  // admin channel. BEFORE the deadline summary: the first round after the
  // drop-out deadline IS that summary and claims its key. A first-come
  // club (Sutton FC) returns at once. Its own try/catch, like the summary.
  if (!previewOnly) {
    try {
      await sweepOrganiserPicks(org.id, nowOverride ?? new Date());
    } catch (err) {
      console.error(`[due-posts] org ${org.id}: organiser pick sweep failed:`, err);
    }
  }

  if (!previewOnly) {
    try {
      await sendDueDeadlineSummaries(org.id, nowOverride ?? new Date());
    } catch (err) {
      console.error(`[due-posts] org ${org.id}: deadline summary failed:`, err);
    }
  }

  // U1 (2026-10-01): the organisers' unpaid list, 10:00 London two days
  // after a completed match, for clubs on "one-person" or "admin-group"
  // only (Sutton FC, on "each-admin", returns at once). Queued through
  // `sendAdminNotice` like the summary above; never in preview mode; its
  // own try/catch so it can never cost the group its posts.
  if (!previewOnly) {
    try {
      await sendDueUnpaidLists(org.id, nowOverride ?? new Date());
    } catch (err) {
      console.error(`[due-posts] org ${org.id}: unpaid list failed:`, err);
    }
  }

  // Slice 2a: what this Pi can do. Only a Pi that says "admin-group" is
  // ever handed an admin-group post; for any other, admin notices fall
  // back to the owner by DM (src/lib/admin-channel.ts).
  const piCaps = parsePiCaps(request.headers.get(PI_CAPS_HEADER));

  const result = await computeDuePosts(groupId, nowOverride, piCaps);
  if (!result) {
    return NextResponse.json({ instructions: previewOnly ? [] : await bridgePlatformDmsForLegacyPi(request) });
  }

  // TEST-ONLY preview mode (e2e suite): return the computed list WITHOUT
  // claiming, so specs that assert scheduler *selection* can poll the
  // same window repeatedly. Gated on MT_TEST_MODE exactly like x-test-now
  // — never set in prod. Claim behaviour itself is covered by its own
  // spec (which does not send this header) and by the unit tests.
  if (previewOnly) {
    return NextResponse.json(result);
  }

  const now = nowOverride ?? new Date();
  const recentGroupSends = await countRecentGroupSends(
    org.id,
    new Date(now.getTime() - CIRCUIT_BREAKER_WINDOW_MS),
  );

  const recentTexts = await fetchRecentGroupTexts(org.id, now);

  // Cap 8 (see the header). Only a club approved through self-join, in
  // its first 28 days.
  let instructions = result.instructions;
  const dmCap = newClubDmCap(org, now);
  if (dmCap !== null && instructions.some((i) => i.kind === "dm")) {
    try {
      const sentToday = await countOrgDmsSince(org.id, londonMidnight(now));
      const { keep, held } = holdDmsOverAllowance(instructions, dmCap - sentToday);
      if (held.length > 0) {
        console.warn(
          `[due-posts] org ${org.id}: new-club DM cap (${dmCap} a day) reached with ${sentToday} sent today; ` +
            `${held.length} DM(s) held for a later poll: ${held.map((i) => i.key).join(", ")}`,
        );
      }
      instructions = keep;
    } catch (err) {
      console.error(`[due-posts] org ${org.id}: new-club DM cap could not be read; allowing the DMs:`, err);
    }
  }

  const selection = await selectDispatchable(instructions, {
    recentGroupSends,
    recentTexts,
    now,
    // The atomic claim. `create` on a @unique column is the whole guard:
    // the loser gets P2002 and skips. A findFirst-then-create check here
    // would reintroduce exactly the race this fixes.
    claim: async (instr: Claimable) => {
      await db.sentNotification.create({
        data: {
          key: instr.key,
          kind: instr.kind,
          matchId: instr.matchId,
          targetUser: instr.targetUser,
        },
      });
    },
    onBreak: ({ count, cap }) => {
      console.error(
        `CRITICAL: outbound volume ceiling TRIPPED for org ${org.id} (group ${groupId}) — ` +
          `${count} group message(s) in the last hour, ceiling is ${cap}. ` +
          `Suppressing all further group dispatch for this org until the window clears. ` +
          `This ceiling is set far above any legitimate match day, so it firing is an ` +
          `INCIDENT, not a tuning problem: check for duplicate bot processes on the Pi ` +
          `(scripts/deploy-pi.sh) and for a re-emitting scheduler key.`,
      );
    },
    onRepeat: ({ key, repeats, limit, windowMs, text }) => {
      console.error(
        `CRITICAL: outbound repetition guard BLOCKED a group message for org ${org.id} ` +
          `(group ${groupId}, key ${key}) — the same text has already gone out ${repeats} ` +
          `time(s) in the last ${Math.round(windowMs / 60000)} minute(s), limit is ${limit}. ` +
          `Identical repeats at this rate are always a bug: look for a loop emitting new ` +
          `keys for one message, or duplicate bot processes on the Pi (scripts/deploy-pi.sh). ` +
          `Text: ${JSON.stringify(text.slice(0, 160))}`,
      );
    },
    // Best-effort ledger write so the NEXT poll can see this send. Any
    // failure is swallowed by selectDispatchable — the message is already
    // claimed and must still go out.
    recordText: async ({ hash, key }) => {
      await db.sentNotification.create({
        data: {
          key: outboundTextLogKey(org.id, hash, key),
          kind: OUTBOUND_TEXT_LOG_KIND,
          // matchId deliberately left null: that keeps these rows out of
          // the scheduler's dedupe query entirely (it only loads rows
          // joined to this org's matches, or keyed `org-<id>:`).
        },
      });
    },
  });

  if (selection.alreadyClaimed.length > 0) {
    // Expected and harmless when it's a lost race; a persistent stream of
    // these means multiple pollers are live — i.e. the Pi has duplicate
    // processes again.
    console.warn(
      `[due-posts] org ${org.id}: ${selection.alreadyClaimed.length} instruction(s) already ` +
        `claimed by another poller — skipped: ${selection.alreadyClaimed.join(", ")}`,
    );
  }
  if (selection.repetitionBlocked.length > 0) {
    console.error(
      `[due-posts] org ${org.id}: ${selection.repetitionBlocked.length} instruction(s) blocked by ` +
        `the repetition guard (max ${MAX_IDENTICAL_GROUP_MESSAGES} identical group posts per ` +
        `${Math.round(REPETITION_WINDOW_MS / 60000)} min) — not claimed, keys left free: ` +
        `${selection.repetitionBlocked.join(", ")}`,
    );
  }
  if (selection.errored.length > 0) {
    console.error(
      `[due-posts] org ${org.id}: claim FAILED (not dispatched) for: ${selection.errored.join(", ")}`,
    );
  }

  const bridged = await bridgePlatformDmsForLegacyPi(request);
  return NextResponse.json({ ...result, instructions: [...bridged, ...selection.dispatch] });
}
