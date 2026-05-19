/**
 * One-off: queue rate-match magic-link DMs to a hand-picked list of
 * players for the Apr 28 Sutton FC match. Bot picks up the queued
 * BotJobs on its next 30-second poll.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/send-rate-match-links.ts
 *
 * Pass --apply to actually queue (default is dry-run).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import {
  signMagicLinkToken,
  buildMagicLinkUrl,
  MAGIC_LINK_TTL,
} from "../src/lib/magic-link.ts";
import { format } from "date-fns";

const ORG_SLUG = "sutton-fc";
const MATCH_DATE = new Date("2026-04-28T00:00:00Z");
const TARGET_NAMES = [
  "Efat",
  "Faris",
  "Shaz",
  "Elnur Mammadov",
  "Enayem",
  "Abid Kazmi",
];

async function main() {
  const apply = process.argv.includes("--apply");

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: ORG_SLUG },
    select: { id: true, name: true },
  });
  if (!org) {
    console.error(`No org with slug "${ORG_SLUG}"`);
    process.exit(1);
  }

  // Apr 28 is a Tuesday — find Sutton's match on that calendar day
  // (London-local). Match.date is stored UTC, so window the day in
  // UTC ±12h to be safe regardless of DST.
  const dayStart = new Date("2026-04-28T00:00:00+01:00");
  const dayEnd = new Date("2026-04-28T23:59:59+01:00");
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      date: { gte: dayStart, lte: dayEnd },
    },
    include: { activity: { select: { name: true, orgId: true } } },
  });
  if (!match) {
    console.error("No Apr 28 match found for Sutton.");
    process.exit(1);
  }
  console.log(`Match: ${match.activity.name} on ${format(match.date, "EEE d MMM yyyy HH:mm")}`);
  console.log(`Match ID: ${match.id}`);
  console.log("");

  // Pull confirmed/attended set for the match — we'll warn if a target
  // is missing (rating UI wants attendees).
  const attendances = await db.attendance.findMany({
    where: { matchId: match.id },
    select: { userId: true, status: true },
  });
  const attendedUserIds = new Set(
    attendances.filter((a) => a.status === "CONFIRMED" || a.status === "PLAYED").map((a) => a.userId),
  );

  for (const targetName of TARGET_NAMES) {
    const candidates = await db.user.findMany({
      where: {
        memberships: { some: { orgId: org.id, leftAt: null } },
        OR: [
          { name: { equals: targetName, mode: "insensitive" } },
          { name: { startsWith: targetName, mode: "insensitive" } },
          { name: { contains: targetName, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, phoneNumber: true },
    });

    if (candidates.length === 0) {
      console.warn(`  ✘ "${targetName}" — no matching user in ${org.name}.`);
      continue;
    }
    // Prefer an exact-case-insensitive match if there are multiples.
    const user =
      candidates.find((c) => c.name?.toLowerCase() === targetName.toLowerCase()) ??
      candidates[0];
    if (candidates.length > 1) {
      console.warn(
        `  ⚠ "${targetName}" matched ${candidates.length} users — picking ${user.name} (${user.id}). Others: ${candidates
          .filter((c) => c.id !== user.id)
          .map((c) => `${c.name} ${c.phoneNumber ?? "(no phone)"}`)
          .join(", ")}`,
      );
    }
    if (!user.phoneNumber) {
      console.warn(`  ✘ ${user.name} has no phoneNumber — can't DM. Skipping.`);
      continue;
    }
    if (!attendedUserIds.has(user.id)) {
      console.warn(`  ✘ ${user.name} has no CONFIRMED/PLAYED attendance for Apr 28 — skipping.`);
      continue;
    }

    const token = signMagicLinkToken({
      userId: user.id,
      purpose: "rate-match",
      matchId: match.id,
      ttlSeconds: MAGIC_LINK_TTL.rateMatch,
    });
    const link = buildMagicLinkUrl(token);
    const firstName = user.name?.split(/\s+/)[0] ?? "there";
    const text = [
      `🏆 *${match.activity.name}* — ${format(match.date, "EEE d MMM")}`,
      ``,
      `Hey ${firstName} — sorry, this got missed at the time. Could you rate your teammates and pick MVP for Tuesday's match? Takes ~1 minute.`,
      ``,
      `Your personal link:`,
      link,
      ``,
      `Link's good for 5 days.`,
    ].join("\n");

    if (!apply) {
      console.log(`  → would DM ${user.name} (${user.phoneNumber})`);
      console.log(`     link: ${link}`);
      continue;
    }

    const phone = user.phoneNumber.replace(/^\+/, "");
    const job = await db.botJob.create({
      data: { orgId: org.id, kind: "dm", phone, text },
    });
    console.log(`  ✓ queued BotJob ${job.id} → ${user.name} (${user.phoneNumber})`);
  }

  if (!apply) {
    console.log("\nDry run. Pass --apply to actually queue DMs.");
  } else {
    console.log("\nDone. Bot will deliver on the next ~30s scheduler tick.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
