/**
 * One-off: queue a sign-in magic-link DM to Shaz. Triggered by Kemal
 * after registering Shaz's phone number on /admin/players. Bot picks
 * up the queued BotJob on its next 30-second poll and sends the DM
 * via WhatsApp.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import {
  signMagicLinkToken,
  buildMagicLinkUrl,
  MAGIC_LINK_TTL,
} from "../src/lib/magic-link.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const candidates = await db.user.findMany({
    where: {
      memberships: { some: { leftAt: null } },
      OR: [
        { name: { equals: "Shaz", mode: "insensitive" } },
        { name: { startsWith: "Shaz", mode: "insensitive" } },
      ],
    },
    include: {
      memberships: {
        where: { leftAt: null },
        include: { org: { select: { id: true, name: true, slug: true } } },
      },
    },
  });
  if (candidates.length === 0) {
    console.error("No user matching 'Shaz' found.");
    return;
  }
  if (candidates.length > 1) {
    console.error(`Multiple matches for 'Shaz' — disambiguate manually:`);
    for (const u of candidates) console.error(`  ${u.id} ${u.name} ${u.phoneNumber}`);
    return;
  }
  const user = candidates[0];
  if (!user.phoneNumber) {
    console.error(`Shaz has no phoneNumber on record — register one on /admin/players first.`);
    return;
  }
  const membership = user.memberships[0];
  if (!membership) {
    console.error("Shaz has no active membership.");
    return;
  }

  const token = signMagicLinkToken({
    userId: user.id,
    purpose: "sign-in",
    ttlSeconds: MAGIC_LINK_TTL.rateMatch, // 5 days
  });
  const link = buildMagicLinkUrl(token);

  const firstName = user.name?.split(/\s+/)[0] ?? "there";
  const text = [
    `👋 Hey ${firstName} — welcome to MatchTime!`,
    ``,
    `Tap the link below to sign in to your dashboard. You'll see your rating, matches played, and Man of the Match count.`,
    ``,
    link,
    ``,
    `Link's good for 5 days. From the dashboard you can also rate teammates after each match — the more people vote, the more accurate everyone's rating gets.`,
  ].join("\n");

  const phone = user.phoneNumber.replace(/^\+/, "");
  const job = await db.botJob.create({
    data: { orgId: membership.orgId, kind: "dm", phone, text },
  });

  console.log(`Queued BotJob ${job.id}`);
  console.log(`  to:   ${user.name} (${user.phoneNumber})`);
  console.log(`  org:  ${membership.org.name}`);
  console.log(`  link: ${link}`);
  console.log("Bot will deliver on the next ~30s scheduler tick.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
