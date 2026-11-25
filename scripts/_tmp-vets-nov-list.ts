// One-off (2026-11-03): start the Vets (Monday night vets) NOVEMBER month from
// Davide's 09:14 list in the players' group, through the app's own path.
//
//   npx tsx scripts/_tmp-vets-nov-list.ts                      dry run (default): reads only, prints the draft
//   npx tsx scripts/_tmp-vets-nov-list.ts --map Nabz=+4479...  map a list name to a NAMELESS member by phone
//   npx tsx scripts/_tmp-vets-nov-list.ts --apply [--map ...]  writes: startMonth + seedDueMonthlySquads
//
// The path is the one /admin/months "Start November from your list" takes:
//   readListForSeed (match the list's names to the club's players, no model call
//   because the list is passed in already read) -> startMonth(source "seed-list")
//   -> seedDueMonthlySquads (regulars onto the 9 Nov match, as startCurrentMonth does).
// The list below is written out by hand as the monthly reader would have read it, so
// this script makes NO model call. Paid marks are recorded as "says paid" (D3): only
// the collector confirms. A --map row's list name is saved as an alias by startMonth
// (saveListAliases), so the group's later pastes of the same list match that player.
//
// Facts the run depends on (checked 2026-11-03): no SquadMonth for the club; the
// 9 Nov match has no Attendance rows (the 5 CONFIRMED rows from this morning's INs
// were deleted by hand; their 5 AttendanceEvent rows stay, append-only, and nothing
// in the monthly seed reads CONFIRMED events). November has 5 Mondays; 2 Nov was
// before the club joined, so gamesPlayed = 1.
import { db } from "../src/lib/db.ts";
import type { MonthlyList, MonthlyListEntry } from "../src/lib/monthly-list.ts";
import { readListForSeed } from "../src/lib/month-seed-read.ts";
import { startMonth } from "../src/lib/squad-month.ts";
import { seedDueMonthlySquads } from "../src/lib/monthly-week.ts";
import type { SeedRowInput } from "../src/lib/squad-month-rules.ts";

const ORG = "cmvzlm8km000707iihou1ut9h";
const MATCH = "cmvzw1o9a000208l6pb9xe31n";
const MONTH_START = "2026-11-01";
const DAVIDE = "cmvzll43z000607iiszrhkjlj"; // OWNER, collector, posted the list
const GAMES_SCHEDULED = 5; // Mondays 2, 9, 16, 23, 30 Nov
const GAMES_PLAYED = 1; // 2 Nov, before the club joined MatchTime

// "MNF November", as posted at 09:14. games = "4 only" / "paid 4" (of the month's 5).
// "full" / "full fat" with no "paid": read as paid, because the list was posted as
// "the squad that made the payment" (Kemal's ask at 09:1x). Flagged in the output.
const LINES: Array<{ slot: number; raw: string; name: string; paid: boolean; games: number | null }> = [
  { slot: 1, raw: "Davide (paid)", name: "Davide", paid: true, games: null },
  { slot: 2, raw: "Nabz ( paid 4 only )", name: "Nabz", paid: true, games: 4 },
  { slot: 3, raw: "steff ( paid full )", name: "steff", paid: true, games: null },
  { slot: 4, raw: "Craig (paid 4)", name: "Craig", paid: true, games: 4 },
  { slot: 5, raw: "Dan (full)", name: "Dan", paid: true, games: null },
  { slot: 6, raw: "Ben (full fat)", name: "Ben", paid: true, games: null },
  { slot: 7, raw: "Kemal (paid)", name: "Kemal", paid: true, games: null },
  { slot: 8, raw: "Steve (paid)", name: "Steve", paid: true, games: null },
  { slot: 9, raw: "Andrew (paid)", name: "Andrew", paid: true, games: null },
  { slot: 10, raw: "Jon (paid)", name: "Jon", paid: true, games: null },
  { slot: 11, raw: "Shane (Paid)", name: "Shane", paid: true, games: null },
  { slot: 12, raw: "CJ (Paid)", name: "CJ", paid: true, games: null },
  { slot: 13, raw: "Oumesh (paid 4)", name: "Oumesh", paid: true, games: 4 },
];

function entry(l: (typeof LINES)[number]): MonthlyListEntry {
  return {
    slot: l.slot,
    raw: l.raw,
    name: l.name,
    marks: { paid: l.paid, paidAmountPence: null, tier: null, payg: false, paygDates: [], gamesCommitted: l.games },
    facts: { memberId: null, guest: false, hostUserId: null, games: l.games, newbie: false },
  };
}

function parseMaps(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  argv.forEach((a, i) => {
    if (a !== "--map") return;
    const v = argv[i + 1] ?? "";
    const [name, phone] = v.split("=");
    if (!name || !phone) throw new Error(`bad --map ${v} (want Name=+447...)`);
    out.set(name.trim().toLowerCase(), phone.trim().replace(/\s+/g, ""));
  });
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const maps = parseMaps(process.argv);
  const now = new Date();

  const [org, activity, existingMonth, attendance, events, members] = await Promise.all([
    db.organisation.findUnique({ where: { id: ORG }, select: { name: true, squadMode: true } }),
    db.activity.findFirst({ where: { orgId: ORG, isActive: true }, select: { id: true, name: true } }),
    db.squadMonth.findFirst({ where: { orgId: ORG, monthStart: new Date(`${MONTH_START}T00:00:00.000Z`) }, select: { id: true } }),
    db.attendance.findMany({ where: { matchId: MATCH }, select: { userId: true, status: true } }),
    db.attendanceEvent.count({ where: { matchId: MATCH } }),
    db.membership.findMany({
      where: { orgId: ORG, leftAt: null, user: { isActive: true } },
      select: { role: true, user: { select: { id: true, name: true, phoneNumber: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  console.log(`club: ${org?.name} (${org?.squadMode}); fixture ${activity?.name} ${activity?.id}`);
  console.log(`November SquadMonth already: ${existingMonth ? existingMonth.id : "none"}`);
  console.log(`9 Nov match: ${attendance.length} Attendance rows, ${events} AttendanceEvent rows (append-only, left alone)`);
  if (!org || org.squadMode !== "monthly" || !activity) throw new Error("not a monthly club with one fixture");

  const list: MonthlyList = {
    month: { month: 11, year: null },
    slots: LINES.map(entry),
    sections: { cantPlay: [], reserves: [], other: [] },
  };
  const read = await readListForSeed(ORG, "", now, MONTH_START, { list, senderUserId: DAVIDE });
  if (!read.ok) throw new Error(`readListForSeed: ${read.error}`);

  const rows: SeedRowInput[] = read.rows.map((r) => ({
    userId: r.userId,
    kind: r.kind,
    tier: r.tier,
    slot: r.slot,
    paid: r.paid,
    paidAmountPence: r.paidAmountPence,
    gamesCommitted: r.gamesCommitted,
    listName: r.listName,
  }));

  console.log(`\nMATCHED by the app's own name matching (${read.rows.length}):`);
  for (const r of read.rows) {
    console.log(`  ${String(r.slot).padStart(2)}. "${r.listName}" -> ${r.name} (${r.userId}) ${r.kind}, paid=${r.paid}, games=${r.gamesCommitted ?? `all ${GAMES_SCHEDULED}`}`);
  }

  const byPhone = new Map(members.map((m) => [m.user.phoneNumber, m.user]));
  const drafted = new Set(rows.map((r) => r.userId));
  const stillUnmatched: string[] = [];
  console.log(`\nNOT MATCHED by name (${read.unmatched.length}):`);
  for (const u of read.unmatched) {
    const line = LINES.find((l) => l.name === u.name);
    const phone = maps.get(u.name.toLowerCase());
    const user = phone ? byPhone.get(phone) : undefined;
    if (!phone) {
      console.log(`  ${String(u.slot).padStart(2)}. "${u.name}": ${u.reason}${u.candidates.length ? ` (candidates ${u.candidates.join(", ")})` : ""}; no --map given`);
      stillUnmatched.push(u.name);
      continue;
    }
    if (!user) throw new Error(`--map ${u.name}=${phone}: no current member of the club has that phone`);
    if (user.name) throw new Error(`--map ${u.name}=${phone}: that member is "${user.name}", not a nameless one; fix the list name instead`);
    if (drafted.has(user.id)) throw new Error(`--map ${u.name}=${phone}: that member is already on the draft`);
    drafted.add(user.id);
    rows.push({
      userId: user.id,
      kind: "regular",
      tier: "standard",
      slot: u.slot,
      paid: line?.paid ? "claimed" : "none",
      paidAmountPence: null,
      gamesCommitted: line?.games ?? null,
      listName: u.name, // saved as an alias by startMonth
    });
    console.log(`  ${String(u.slot).padStart(2)}. "${u.name}" -> MAPPED by phone to nameless member ${user.id} (${phone}); "${u.name}" becomes their alias`);
  }

  const nameless = members.filter((m) => !m.user.name && !drafted.has(m.user.id));
  console.log(`\nNameless members not on the draft (${nameless.length}): ${nameless.map((m) => m.user.phoneNumber).join(", ")}`);
  console.log(`Named members not on the list: ${members.filter((m) => m.user.name && !drafted.has(m.user.id)).map((m) => m.user.name).join(", ") || "none"}`);
  console.log(`\nWould write: SquadMonth ${MONTH_START} (running, started mid-month, gamesScheduled=${GAMES_SCHEDULED}, gamesPlayed=${GAMES_PLAYED}, no price yet)`);
  console.log(`  ${rows.length} regulars, paid = "says paid" (not confirmed), "4 only" on ${rows.filter((r) => r.gamesCommitted === 4).length}`);
  console.log(`  then seed the 9 Nov match with those regulars (seedDueMonthlySquads).`);
  if (stillUnmatched.length > 0) console.log(`  LEFT OFF (no member to attach): ${stillUnmatched.join(", ")}. Add them later on /admin/months, or rerun with --map before applying.`);
  console.log(`  FLAGS: "full"/"full fat" read as paid; "4 only" counted against 5 games (is "full" 5 or 4?).`);

  if (!apply) return console.log("\ndry run: nothing written");
  if (existingMonth) throw new Error("November already started: nothing written");
  const res = await startMonth(
    ORG,
    DAVIDE,
    { activityId: activity.id, gamesScheduled: GAMES_SCHEDULED, gamesPlayed: GAMES_PLAYED, source: "seed-list", rows },
    now,
    { monthStart: MONTH_START },
  );
  console.log("startMonth:", res);
  if (!res.ok) return;
  console.log("seedDueMonthlySquads:", await seedDueMonthlySquads(new Date(), ORG));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
