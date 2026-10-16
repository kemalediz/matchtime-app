/**
 * BACKFILL: a ✅ on every recorded "Paid" DM since a given instant
 * (Kemal, 2026-10-16). The live path (`src/lib/payment-claim.ts`) reacts
 * from now on; this covers the claims recorded before it shipped.
 *
 * WHERE THE DM'S ID COMES FROM. Every claim the DM path acts on writes a
 * replay guard, `SentNotification` key `paid-claim:<waMessageId>`, with
 * the match and the player (`targetUser`). That key IS the original DM's
 * WhatsApp id. The guard is written before the write is attempted, so the
 * script keeps only the claims that were RECORDED (the player's
 * Attendance row is on direct payment, pending or confirmed no earlier
 * than the claim): see `selectPaidClaimReactionTargets`.
 *
 * HOW IT REACTS. One `RetroReaction` row per DM (emoji ✅), the queue the
 * Pi already drains: due-posts emits it as `update-reaction`, the Pi
 * places it with the same code as the group reactions and ACKs it. No Pi
 * change, nothing posted, nothing said. Idempotent: a DM that already has
 * a ✅ row (sent or not) is skipped, so the live path and this script
 * never double up.
 *
 *   npx tsx scripts/react-paid-claims.ts --org <orgId> --since <ISO>           # dry run
 *   npx tsx scripts/react-paid-claims.ts --org <orgId> --since <ISO> --apply
 *
 * Needs DIRECT_URL (or DATABASE_URL) in the environment, e.g.
 * `npx tsx --env-file=.env scripts/react-paid-claims.ts ...`. The dry run
 * only reads.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import {
  PAID_CLAIM_KEY_PREFIX,
  PAID_CLAIM_REACTION,
  queuePaidClaimReaction,
  selectPaidClaimReactionTargets,
  type RetroReactionClient,
} from "../src/lib/paid-claim-reaction.ts";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const orgId = argValue("--org");
  const sinceArg = argValue("--since");
  const since = sinceArg ? new Date(sinceArg) : null;
  if (!orgId || !since || Number.isNaN(since.getTime())) {
    console.error("usage: npx tsx scripts/react-paid-claims.ts --org <orgId> --since <ISO> [--apply]");
    process.exit(2);
  }
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL (or DATABASE_URL) is not set");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as never);

  try {
    const ledger = await db.sentNotification.findMany({
      where: {
        kind: "paid-claim",
        key: { startsWith: PAID_CLAIM_KEY_PREFIX },
        createdAt: { gte: since },
        match: { activity: { orgId } },
      },
      select: { key: true, createdAt: true, matchId: true, targetUser: true },
      orderBy: { createdAt: "asc" },
    });

    const rows = [];
    for (const l of ledger) {
      if (!l.matchId || !l.targetUser) continue;
      const a = await db.attendance.findFirst({
        where: { matchId: l.matchId, userId: l.targetUser },
        select: { paymentMethod: true, directPendingAt: true, paidAt: true, user: { select: { name: true } } },
      });
      rows.push({
        key: l.key,
        createdAt: l.createdAt,
        matchId: l.matchId,
        userId: l.targetUser,
        paymentMethod: a?.paymentMethod ?? null,
        directPendingAt: a?.directPendingAt ?? null,
        paidAt: a?.paidAt ?? null,
        name: a?.user?.name ?? "?",
      });
    }
    const targets = selectPaidClaimReactionTargets(rows);
    const nameOf = new Map(rows.map((r) => [r.key, r.name]));

    console.log(
      `${apply ? "APPLY" : "DRY RUN"}: org ${orgId}, since ${since.toISOString()}: ` +
        `${ledger.length} claim(s) in the ledger, ${targets.length} recorded with a real DM id`,
    );
    const skipped = rows.filter((r) => !targets.some((t) => `${PAID_CLAIM_KEY_PREFIX}${t.waMessageId}` === r.key));
    for (const s of skipped) console.log(`  skip (not recorded or no real id)  ${s.name}  ${s.key}`);

    let queued = 0;
    let already = 0;
    for (const t of targets) {
      const who = nameOf.get(`${PAID_CLAIM_KEY_PREFIX}${t.waMessageId}`) ?? "?";
      const label = `${t.claimedAt.toISOString()}  ${who}  match ${t.matchId}  ${t.waMessageId}`;
      if (!apply) {
        const existing = await db.retroReaction.findFirst({
          where: { waMessageId: t.waMessageId, emoji: PAID_CLAIM_REACTION },
          select: { id: true },
        });
        console.log(`  ${existing ? "already has ✅" : "would queue ✅"}  ${label}`);
        if (existing) already++;
        else queued++;
        continue;
      }
      const outcome = await queuePaidClaimReaction(db as unknown as RetroReactionClient, {
        orgId,
        waMessageId: t.waMessageId,
        reason: "paid claim backfill 2026-10-16",
      });
      console.log(`  ${outcome}  ${label}`);
      if (outcome === "queued") queued++;
      else if (outcome === "already-queued") already++;
    }
    console.log(
      `${apply ? "queued" : "would queue"} ${queued}, already had ✅ ${already}. ` +
        (apply ? "The Pi places them on its next due-posts poll." : "Re-run with --apply to queue."),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
