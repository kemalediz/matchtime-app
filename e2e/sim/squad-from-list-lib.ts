/**
 * Squad-from-list deterministic chain — runs under tsx (imports Prisma).
 * Invoked by e2e/sim/squad-from-list.spec.ts via execFile.
 *
 * Builds its OWN org world, then exercises the post-LLM pipeline with
 * hand-built ParsedLists (what the extraction model WOULD return):
 *   attributeDiffs → learnAliasesFromAttribution → finaliseSquadForMatch
 * plus the resolver's reuse / ambiguous→new semantics.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "../helpers/env";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { attributeDiffs, learnAliasesFromAttribution, finaliseSquadForMatch, resolveOrProvisionSquadName } =
    await import("@/lib/squad-from-list");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  // ── World: a squad-from-list org (attendance off, MoM/ratings on) ──
  const nonce = Date.now().toString(36);
  const orgId = `sfl-org-${nonce}`;
  const org = await db.organisation.create({
    data: {
      id: orgId,
      name: "SFL Thursday",
      slug: `sfl-${nonce}`,
      inviteCode: `sfl-invite-${nonce}`,
      whatsappGroupId: `sfl-${nonce}@g.us`,
      whatsappBotEnabled: true,
      featureAttendance: false,
      featureBench: false,
      featureTeamBalancing: false,
      featureReminders: false,
      featureSquadFromList: true,
    },
  });
  const sport = await db.sport.create({
    data: {
      id: `sfl-sport-${nonce}`,
      orgId: org.id,
      name: "Football",
      playersPerTeam: 7,
      positions: ["GK", "DEF", "MID", "FWD"],
      teamLabels: ["Red", "Yellow"],
    },
  });
  const activity = await db.activity.create({
    data: {
      id: `sfl-act-${nonce}`,
      orgId: org.id,
      sportId: sport.id,
      name: "SFL Thursday",
      dayOfWeek: 4,
      time: "21:00",
      venue: "SFL Arena",
    },
  });
  const match = await db.match.create({
    data: {
      id: `sfl-match-${nonce}`,
      activityId: activity.id,
      date: new Date(Date.now() + 24 * 60 * 60 * 1000),
      maxPlayers: 14,
      status: "UPCOMING",
      attendanceDeadline: new Date(Date.now() + 19 * 60 * 60 * 1000),
    },
  });

  const mkUser = async (key: string, name: string, phone: string | null) => {
    const u = await db.user.create({
      data: { id: `sfl-u-${nonce}-${key}`, name, email: `sfl-${key}-${nonce}@e2e-test.invalid`, phoneNumber: phone },
    });
    await db.membership.create({ data: { userId: u.id, orgId: org.id, role: "PLAYER" } });
    return u;
  };
  const amir = await mkUser("amir", "Amir Aslan", "+447700919001");
  const bilal = await mkUser("bilal", "Bilal Khan", "+447700919002");
  const tharan = await mkUser("tharan", "Tharan Raj", "+447700919003");
  await mkUser("omar1", "Omar East", null);
  await mkUser("omar2", "Omar West", null);

  // ── attributeDiffs: pasted-list ritual, diff-based attribution ──────
  const t0 = new Date(Date.now() - 60 * 60 * 1000);
  const lists = [
    {
      waMessageId: "sfl-list-1",
      senderPhone: "447700919001", // Amir
      senderPushname: "Amir Aslan",
      timestamp: t0,
      names: ["Amir", "Bilal"],
      reserves: [],
    },
    {
      // "~T" pastes the list back with himself appended — the alias case.
      waMessageId: "sfl-list-2",
      senderPhone: "447700919003", // Tharan's phone
      senderPushname: "~T",
      timestamp: new Date(t0.getTime() + 10 * 60 * 1000),
      names: ["Amir", "Bilal", "Tharan"],
      reserves: ["Guest Gus"], // a signed-in guest
    },
  ];
  const attributions = attributeDiffs(lists);
  assert.equal(attributions[1].selfAddition, "Tharan", "lone playing-squad addition attributed to the sender");
  assert.deepEqual(attributions[1].guestAdditions, ["Guest Gus"], "reserve additions are guests");
  ok("attributeDiffs: self-addition + guest attribution from consecutive pastes");

  // ── learnAliases: ground-truth alias from the diff ──────────────────
  const learned = await learnAliasesFromAttribution(org.id, attributions);
  assert.ok(learned.aliasesLearned >= 1, "at least one alias learned");
  const alias = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId: org.id, alias: "tharan" } },
  });
  assert.equal(alias?.userId, tharan.id, '"Tharan" alias points at the sender resolved by phone');
  ok("learnAliasesFromAttribution: ~T's self-addition becomes a UserAlias for Tharan");

  // ── finaliseSquadForMatch: paste → squad built ──────────────────────
  const usersBefore = await db.user.count();
  const result = await finaliseSquadForMatch(org.id, match.id, {
    waMessageId: "sfl-list-2",
    senderPhone: "447700919003",
    senderPushname: "~T",
    timestamp: new Date(),
    names: ["Amir", "Bilal", "Tharan", "Brandnew Bloke", "Omar"],
    reserves: ["Reggie Reserve"],
  });
  assert.equal(result.unresolved.length, 0, "every name resolved or provisioned");

  const att = await db.attendance.findMany({
    where: { matchId: match.id },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { position: "asc" },
  });
  const confirmed = att.filter((a) => a.status === "CONFIRMED").map((a) => a.user.name);
  const bench = att.filter((a) => a.status === "BENCH").map((a) => a.user.name);

  // Existing members reused (Amir/Bilal by name, Tharan via the alias).
  assert.ok(confirmed.includes("Amir Aslan"));
  assert.ok(confirmed.includes("Bilal Khan"));
  assert.ok(confirmed.includes("Tharan Raj"));
  ok("finaliseSquadForMatch: existing members + alias hit reused, no ghosts for them");

  // Unknown name → NEW provisional member.
  const brandnew = att.find((a) => a.user.name === "Brandnew Bloke");
  assert.ok(brandnew && brandnew.status === "CONFIRMED");
  const bnMem = await db.membership.findUnique({
    where: { userId_orgId: { userId: brandnew!.user.id, orgId: org.id } },
  });
  assert.ok(bnMem?.provisionallyAddedAt, "unknown squad name provisioned as a provisional member");
  ok("finaliseSquadForMatch: unknown name → new provisional member");

  // Ambiguous "Omar" (two Omars) → never guesses: a fresh provisional.
  const omar = att.find((a) => a.user.name === "Omar");
  assert.ok(omar, 'ambiguous "Omar" got its own fresh row');
  assert.notEqual(omar!.user.id, "sfl-u-" + nonce + "-omar1");
  assert.notEqual(omar!.user.id, "sfl-u-" + nonce + "-omar2");
  ok('finaliseSquadForMatch: ambiguous name → NEW provisional, never a guess');

  // Reserves land on the BENCH (visible, but no MoM/rating DMs).
  assert.ok(bench.includes("Reggie Reserve"), "reserves written as BENCH");
  ok("finaliseSquadForMatch: reserves → BENCH rows");

  // 3 new users total: Brandnew, Omar(ambiguous), Reggie.
  assert.equal(await db.user.count(), usersBefore + 3, "exactly the 3 unknowns were minted");
  ok("user-minting bounded to genuinely new names");

  // ── resolver semantics directly ─────────────────────────────────────
  const viaAlias = await resolveOrProvisionSquadName(org.id, "tharan");
  assert.equal(viaAlias?.userId, tharan.id);
  assert.equal(viaAlias?.provisional, false);
  ok("resolveOrProvisionSquadName: alias is the strongest signal");

  const fuzzy = await resolveOrProvisionSquadName(org.id, "Bilal");
  assert.equal(fuzzy?.userId, bilal.id);
  ok("resolveOrProvisionSquadName: unique first-name reuses the member");

  const again = await resolveOrProvisionSquadName(org.id, "Amir Aslan");
  assert.equal(again?.userId, amir.id);
  ok("resolveOrProvisionSquadName: exact name reuses the member");

  console.log(`OK ${n} squad-from-list assertions`);
  process.exit(0);
}

main().catch((err) => {
  console.error("SQUAD-FROM-LIST LIB-TESTS FAILED:", err);
  process.exit(1);
});
