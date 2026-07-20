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
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeDuePosts, sweepExpiredBenchConfirmations } from "@/lib/bot-scheduler";
import {
  CIRCUIT_BREAKER_WINDOW_MS,
  GROUP_DIRECTED_KINDS,
  selectDispatchable,
  type Claimable,
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
 * never counts against the group budget.
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
    select: { id: true },
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

  const result = await computeDuePosts(groupId, nowOverride);
  if (!result) {
    return NextResponse.json({ instructions: [] });
  }

  // TEST-ONLY preview mode (e2e suite): return the computed list WITHOUT
  // claiming, so specs that assert scheduler *selection* can poll the
  // same window repeatedly. Gated on MT_TEST_MODE exactly like x-test-now
  // — never set in prod. Claim behaviour itself is covered by its own
  // spec (which does not send this header) and by the unit tests.
  if (process.env.MT_TEST_MODE === "1" && request.headers.get("x-no-claim") === "1") {
    return NextResponse.json(result);
  }

  const now = nowOverride ?? new Date();
  const recentGroupSends = await countRecentGroupSends(
    org.id,
    new Date(now.getTime() - CIRCUIT_BREAKER_WINDOW_MS),
  );

  const selection = await selectDispatchable(result.instructions, {
    recentGroupSends,
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
        `CRITICAL: outbound circuit breaker TRIPPED for org ${org.id} (group ${groupId}) — ` +
          `${count} group message(s) in the last hour, cap is ${cap}. ` +
          `Suppressing all further group dispatch for this org until the window clears. ` +
          `Normal traffic is 1-2 posts/day: check for duplicate bot processes on the Pi ` +
          `(scripts/deploy-pi.sh) and for a re-emitting scheduler key.`,
      );
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
  if (selection.errored.length > 0) {
    console.error(
      `[due-posts] org ${org.id}: claim FAILED (not dispatched) for: ${selection.errored.join(", ")}`,
    );
  }

  return NextResponse.json({ ...result, instructions: selection.dispatch });
}
