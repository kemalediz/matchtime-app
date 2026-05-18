/**
 * 2026-05-18: Baki asked to drop at 07:24 ("I need to drop out of
 * tomorrow's game"). The LLM classified it correctly (replacement_request,
 * action=OUT) but the sender resolved to null — Baki posts via WhatsApp
 * @lid privacy (authorPhone always null), pushname is "ba", which fuzzy-
 * matches BOTH Baki and Başar → ambiguous → resolver bailed. The
 * UserAlias "ba" → Baki that used to rescue this was wiped when Başar
 * was merged/recreated.
 *
 * Two fixes:
 *  1. Re-create UserAlias "ba" → Baki as source=manual (admin intent;
 *     visible + editable in the alias UI; future "ba" messages resolve).
 *  2. Drop Baki via cancelAttendance so the squad reflects reality and
 *     the bench-confirmation DM chain triggers (exactly what should
 *     have happened at 07:24).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { cancelAttendance } from "../src/lib/attendance.ts";

const APPLY = process.argv.includes("--apply");
const BAKI = "cmo4wnnkt0005mvr8vrxko4ck";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true },
  });
  if (!org) { console.error("no Sutton"); process.exit(1); }

  const match = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
  });
  if (!match) { console.error("no match"); process.exit(1); }

  const existingAlias = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId: org.id, alias: "ba" } },
  });
  const att = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: match.id, userId: BAKI } },
  });

  console.log("Plan:");
  console.log(`  1. UserAlias "ba" → Baki: ${existingAlias ? `exists (${existingAlias.userId}, ${existingAlias.source})` : "MISSING → create source=manual"}`);
  console.log(`  2. Baki attendance: ${att ? att.status : "none"} → DROPPED via cancelAttendance (triggers bench DM chain)`);

  if (!APPLY) { console.log("\n(dry-run — pass --apply)"); await db.$disconnect(); return; }

  if (!existingAlias) {
    await db.userAlias.create({
      data: { orgId: org.id, userId: BAKI, alias: "ba", source: "manual" },
    });
    console.log('Created UserAlias "ba" → Baki (manual).');
  } else if (existingAlias.userId !== BAKI) {
    await db.userAlias.update({
      where: { id: existingAlias.id },
      data: { userId: BAKI, source: "manual" },
    });
    console.log('Re-pointed UserAlias "ba" → Baki (manual).');
  }

  if (att && (att.status === "CONFIRMED" || att.status === "BENCH")) {
    const res = await cancelAttendance(BAKI, match.id);
    console.log("cancelAttendance:", res);
  } else {
    console.log(`Baki not CONFIRMED/BENCH (status=${att?.status ?? "none"}) — no drop needed.`);
  }

  // Resulting state
  const after = await db.match.findUnique({
    where: { id: match.id },
    include: { attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } } },
  });
  const c = after!.attendances.filter((a) => a.status === "CONFIRMED");
  const b = after!.attendances.filter((a) => a.status === "BENCH");
  const d = after!.attendances.filter((a) => a.status === "DROPPED");
  console.log(`\nAfter — CONFIRMED ${c.length}: ${c.map((a) => a.user.name).join(", ")}`);
  console.log(`BENCH ${b.length}: ${b.map((a) => a.user.name).join(", ")}`);
  console.log(`DROPPED: ${d.map((a) => a.user.name).join(", ")}`);
  const pbc = await db.pendingBenchConfirmation.findMany({ where: { matchId: match.id, resolvedAt: null } });
  for (const p of pbc) {
    const bu = await db.user.findUnique({ where: { id: p.userId }, select: { name: true } });
    const ru = p.replacingUserId ? await db.user.findUnique({ where: { id: p.replacingUserId }, select: { name: true } }) : null;
    console.log(`OPEN PBC: ask ${bu?.name} to replace ${ru?.name ?? "?"} (exp ${p.expiresAt.toISOString()})`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
