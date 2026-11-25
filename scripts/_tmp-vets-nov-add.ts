/**
 * ONE-OFF (2026-11-03): add the five names of Davide's 09:14 list that the
 * month's start could not place (Dan, Ben, Steve, Andrew, Oumesh) to the
 * Vets' running November month, as regulars.
 *
 * Through the app's own paths, in /admin/months' order:
 *   1. `applySignup({ choice: "in", source: "admin", byOrganiser: true })`,
 *      the call behind "Add a player -> Regular" (`setMonthMember`). It
 *      writes the SquadMonthMember (kind regular, the lowest free number,
 *      gamesCovered = the games still to play, joinedAt now) and, the month's
 *      sign-up being over and the 9 Nov match already seeded, puts him on the
 *      9 Nov match through `registerAttendance` (`placeOnWeek`). An
 *      organiser's change DMs nobody (`tell` returns for source "admin").
 *      Then `reconcileLeavers(..., { notify: false })`, as the action does.
 *   2. "says paid": `claimMonthPaid({ source: "list" })`, the claim the
 *      month's start gave the other seven (paidClaimSource "list").
 *   3. "4 only": `setMonthMemberGames({ by: "organiser" })` (setMemberGames).
 *   4. The list's name as an alias: `saveListAliases` (squad-month.ts), the
 *      start's own writer (skipped when it is his own name).
 *
 * DRY RUN BY DEFAULT: SELECTs only, every write after the `APPLY` gate.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/_tmp-vets-nov-add.ts \
 *     --list /path/to/adds.json [--apply]
 *
 * adds.json: [{ "name": "Dan", "phone": "+44...", "paid": false, "games": null }, ...]
 */
import { readFileSync } from "node:fs";
import { parseMonthAdds } from "./_tmp-vets-nov2-plan.ts";

const VETS_ORG = "cmvzlm8km000707iihou1ut9h";
const NOV_MONTH = "cmw0i3foq00005p9ka08zj4h1";
const KEMAL_USER = "cmn5vhtp2000004ifh4dqbsym";
const APPLY = process.argv.includes("--apply");
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
function fail(msg: string): never {
  console.error(`REFUSED: ${msg}. Nothing written.`);
  process.exit(1);
}

async function main() {
  const { db } = await import("../src/lib/db.ts");
  const { normalisePhone } = await import("../src/lib/phone.ts");
  const { loadSignupMonth } = await import("../src/lib/month-signup.ts");
  const { checkGamesCommitted } = await import("../src/lib/squad-month-rules.ts");
  const { loadMonthlyWeek } = await import("../src/lib/monthly-week.ts");

  const listPath = arg("list");
  if (!listPath) fail("usage: --list <adds.json> [--apply]");
  const parsed = parseMonthAdds(JSON.parse(readFileSync(listPath, "utf8")), normalisePhone);
  if (parsed.errors.length) fail(`the list has errors:\n  ${parsed.errors.join("\n  ")}`);

  const month = await loadSignupMonth(NOV_MONTH);
  if (!month || month.orgId !== VETS_ORG) fail("the November month was not found");
  if (month.status !== "running") fail(`the month is ${month.status}, not running`);
  const now = new Date();
  const gamesLeft = month.kickoffs.filter((k) => k.getTime() > now.getTime()).length;
  const live = month.matches.filter((m) => ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(m.status) && m.date.getTime() > now.getTime());
  const nextWeek = live[0] ? await loadMonthlyWeek(live[0].matchId) : null;
  const rows = await db.squadMonthMember.findMany({ where: { monthId: NOV_MONTH }, select: { userId: true, kind: true, slot: true, leftAt: true } });
  const taken = new Set(rows.filter((r) => r.kind === "regular" && !r.leftAt && r.slot != null).map((r) => r.slot as number));
  console.log(`${APPLY ? "APPLY" : "DRY RUN (reads only)"}: November month ${NOV_MONTH}, ${month.status}, open=${month.open}`);
  console.log(`  games left from now: ${gamesLeft} (what a regular added now covers and pays for); regulars now ${rows.filter((r) => r.kind === "regular" && !r.leftAt).length}/${month.maxRegulars}`);
  console.log(`  next match: ${live[0] ? `${live[0].matchId} ${live[0].date.toISOString()}, seeded=${nextWeek?.seeded}` : "none"}\n`);

  const plan: Array<{ listName: string; userId: string; paid: boolean; games: number | null }> = [];
  let nextSlot = 1;
  for (const r of parsed.rows) {
    const u = await db.user.findFirst({
      where: r.userId ? { id: r.userId } : { phoneNumber: r.phone! },
      select: { id: true, name: true, phoneNumber: true, memberships: { where: { orgId: VETS_ORG }, select: { leftAt: true, guestMatchId: true } } },
    });
    const mem = u?.memberships[0];
    const problem = !u ? "no such user" : !mem || mem.leftAt || mem.guestMatchId ? "not a current ordinary member of the Vets" : rows.some((x) => x.userId === u.id && !x.leftAt) ? "already on the month" : null;
    while (taken.has(nextSlot)) nextSlot++;
    const games = r.games == null ? { ok: true as const, value: null } : checkGamesCommitted(r.games, gamesLeft);
    console.log(`  ${r.listName}: ${u ? `${u.id} ${u.phoneNumber} name=${JSON.stringify(u.name)}` : "?"}${problem ? `  <<< ${problem}` : ""}`);
    if (problem || !u) continue;
    console.log(`      -> regular, number ${nextSlot}, covers ${gamesLeft} game(s), joinedAt now, source "admin"`);
    console.log(`      -> onto ${live[0] ? `the ${live[0].date.toISOString().slice(0, 10)} match as CONFIRMED (registerAttendance, admin-squad-edit)` : "no match"}${nextWeek?.seeded ? "" : " (NOT: that match is not seeded yet; the month's seed puts him on)"}`);
    console.log(`      -> ${r.paid ? 'says paid (claimMonthPaid source "list")' : "not paid"}`);
    if (r.games != null) console.log(`      -> games: ${games.ok ? (games.value === null ? `${r.games} = every game left, stored as all (NULL)` : `${games.value} only`) : `REFUSED (${games.error})`}`);
    console.log(`      -> alias "${r.listName}" ${u.name && u.name.trim().toLowerCase() === r.listName.toLowerCase() ? "(skipped: his own name)" : "saved if free"}`);
    taken.add(nextSlot);
    plan.push({ listName: r.listName, userId: u.id, paid: r.paid, games: r.games });
  }

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing written. Pass --apply to write.");
    return;
  }
  if (plan.length !== parsed.rows.length) fail("some rows are not resolved");

  const { applySignup } = await import("../src/lib/month-signup.ts");
  const { reconcileLeavers } = await import("../src/lib/month-close.ts");
  const { claimMonthPaid } = await import("../src/lib/month-payment.ts");
  const { setMonthMemberGames } = await import("../src/lib/month-member-games.ts");
  const { saveListAliases } = await import("../src/lib/squad-month.ts");
  for (const p of plan) {
    const res = await applySignup({ monthId: NOV_MONTH, userId: p.userId, choice: "in", source: "admin", actorUserId: KEMAL_USER, byOrganiser: true });
    console.log(`  ${p.listName}: ${JSON.stringify(res)}`);
    if (!res.ok) continue;
    if (res.changed) await reconcileLeavers(VETS_ORG, new Date(), undefined, { notify: false });
    if (p.paid) console.log(`    says paid: ${await claimMonthPaid({ monthId: NOV_MONTH, userId: p.userId, source: "list" })}`);
    if (p.games != null) console.log(`    games: ${JSON.stringify(await setMonthMemberGames({ squadMonthId: NOV_MONTH, userId: p.userId, games: p.games, by: "organiser" }))}`);
  }
  await saveListAliases(VETS_ORG, plan.map((p) => ({ userId: p.userId, alias: p.listName })));
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { db } = await import("../src/lib/db.ts");
    await db.$disconnect();
  });
