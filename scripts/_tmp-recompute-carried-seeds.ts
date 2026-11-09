/**
 * RE-COMPUTE SEEDS CARRIED BEFORE 2026-11-09, UNROUNDED (Kemal, 2026-11-09:
 * "keep the ratings as they are, never round them").
 *
 *   node --env-file=.env --import tsx scripts/_tmp-recompute-carried-seeds.ts            (dry run)
 *   node --env-file=.env --import tsx scripts/_tmp-recompute-carried-seeds.ts --apply    (writes)
 *
 * DRY RUN IS THE DEFAULT and only reads. Any other argument is refused.
 * No model calls, no messages sent.
 *
 * ── WHICH SEEDS WERE CARRIED ─────────────────────────────────────────
 *
 * `Membership` has no audit of who wrote `seedRating` and no updatedAt,
 * and before this change EVERY seed was a whole number (the admin boxes
 * parsed integers, the onboarding analyser rounded, carrying rounded), so
 * the value alone cannot say where a seed came from. Two facts can:
 *
 *   1. THE BACKFILL. `scripts/_tmp-backfill-carried-seeds.ts --apply` ran
 *      once, at 2026-11-03T12:02:36Z, and wrote "16 of 16". Its dry run
 *      eleven minutes earlier listed those 16 memberships by id (same
 *      per-club counts as the apply: 1, 2, 2, 10, 1); they are BACKFILLED
 *      below.
 *   2. THE JOIN HOOK. From the merge of #503 (2026-11-03T11:42:39Z) every
 *      membership CREATED with no seed got its carried seed in the same
 *      write, so a membership created since then whose seed is still its
 *      carried value rounded was, as far as the data can tell, carried.
 *
 * For each, the carried value is recomputed AS OF the moment it was
 * written (ratings given after that do not count: a carried seed is a
 * starting point, not a live number), unrounded, by the same rule
 * (`carriedSeed`), and `classifyCarriedSeedRecompute` decides:
 *
 *   recompute       the stored seed is still exactly that value rounded:
 *                   it is replaced by the exact value
 *   differs         any other whole number: an admin's own seed, or never
 *                   carried. Never touched.
 *   already-exact   a decimal (set by hand or typed since), or the exact
 *                   value was whole anyway. Never touched.
 *   no-carry / no-seed   nothing to do.
 *
 * The one case the data cannot rule out: an admin who, after the carry,
 * typed the very same whole number back in. That seed would be replaced
 * by the exact carried value (at most half a point away). The dry run
 * lists every row, so this can be checked by eye before --apply.
 *
 * --apply writes only where the seed is STILL the stored value read here
 * (`updateMany where seedRating = from`), so a seed an admin changes
 * between the dry run and the apply is never overwritten.
 */
import { db } from "../src/lib/db";
import { carriedSeed } from "../src/lib/carried-seed";
import { classifyCarriedSeedRecompute, type CarriedSeedRecompute } from "../src/lib/carried-seed-recompute";
import { loadClubRatingsByClub, otherClubs, type CarriedSeedClient } from "../src/lib/carried-seed-loader";

const BACKFILL_AT = new Date("2026-11-03T12:02:36Z");
const HOOK_FROM = new Date("2026-11-03T11:42:39Z");
const BACKFILLED = [
  "cmuel3x24000004i6q6fmm3bq",
  "cmv76zxzm000906l6o7zhnrx3",
  "cmv76zyrv000b06l6czfyw1tv",
  "cmva266jr000b06l9qwljc6rc",
  "cmva26dsr001306l9lb3didu8",
  "cmvhr10f60002oe9khkgy58vb",
  "cmvhtyp0x000207i4oja4kuuz",
  "cmvhtypf7000307i4m186hlgi",
  "cmvhtypt6000407i4tthy33c6",
  "cmvhtyq77000507i4taxk6vzr",
  "cmvhtyql9000607i4pqp3a4tj",
  "cmvhtyrd8000907i47bmsl2fp",
  "cmvhtythm000g07i4khpm75po",
  "cmvhtytvk000h07i4qfec8bwf",
  "cmvvqff98000107jkrq8kgs9t",
  "cmw0lm0vh000ywv9kzgg2y9x4",
];

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}`);
  const apply = args.includes("--apply");

  const select = { id: true, orgId: true, userId: true, seedRating: true, createdAt: true, leftAt: true, guestMatchId: true } as const;
  const backfilled = await db.membership.findMany({ where: { id: { in: BACKFILLED } }, select });
  const joined = await db.membership.findMany({
    where: { createdAt: { gte: HOOK_FROM }, seedRating: { not: null }, id: { notIn: BACKFILLED } },
    select,
    orderBy: { createdAt: "asc" },
  });
  const orgs = await db.organisation.findMany({
    where: { id: { in: [...new Set([...backfilled, ...joined].map((m) => m.orgId))] } },
    select: { id: true, name: true },
  });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const client = db as unknown as CarriedSeedClient;

  type Row = { m: (typeof backfilled)[number]; source: "backfill" | "join"; at: Date; exact: number | null; now: number | null; verdict: CarriedSeedRecompute };
  const rows: Row[] = [];
  for (const [source, list] of [["backfill", backfilled], ["join", joined]] as const) {
    for (const m of list) {
      const at = source === "backfill" ? BACKFILL_AT : m.createdAt;
      const then = await loadClubRatingsByClub(client, [m.userId], at);
      const exact = carriedSeed(otherClubs(then.get(m.userId), m.orgId))?.seed ?? null;
      const current = await loadClubRatingsByClub(client, [m.userId]);
      const now = carriedSeed(otherClubs(current.get(m.userId), m.orgId))?.seed ?? null;
      rows.push({ m, source, at, exact, now, verdict: classifyCarriedSeedRecompute(m.seedRating, exact) });
    }
  }
  const missing = BACKFILLED.filter((id) => !backfilled.some((m) => m.id === id));

  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${backfilled.length} backfilled memberships (of ${BACKFILLED.length} listed), ${joined.length} seeded memberships created since the join hook.`);
  if (missing.length) console.log(`  not found (deleted or merged since): ${missing.join(" ")}`);
  console.log("");
  const fmt = (x: number | null) => (x == null ? "-" : String(x));
  for (const r of rows) {
    const state = [r.m.leftAt ? "left" : null, r.m.guestMatchId ? "guest" : null].filter(Boolean).join(",") || "member";
    const what = r.verdict.action === "recompute" ? `RECOMPUTE ${r.verdict.from} -> ${r.verdict.to}` : `skip (${r.verdict.reason})`;
    console.log(
      `  [${r.source}] ${r.m.id}  club ${orgName.get(r.m.orgId) ?? r.m.orgId}  user ${r.m.userId}  (${state})  stored ${fmt(r.m.seedRating)}  carried then ${fmt(r.exact)}  carried now ${fmt(r.now)}  => ${what}`,
    );
  }

  const todo = rows.filter((r) => r.verdict.action === "recompute");
  const perClub = new Map<string, number>();
  for (const r of todo) perClub.set(r.m.orgId, (perClub.get(r.m.orgId) ?? 0) + 1);
  const reasons = new Map<string, number>();
  for (const r of rows) if (r.verdict.action === "skip") reasons.set(r.verdict.reason, (reasons.get(r.verdict.reason) ?? 0) + 1);
  console.log(`\nwould recompute ${todo.length} of ${rows.length}; per club:`);
  for (const [orgId, n] of perClub) console.log(`  ${orgName.get(orgId) ?? orgId}  ${n}`);
  console.log(`skipped: ${[...reasons].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to write.");
    return;
  }
  let written = 0;
  for (const r of todo) {
    if (r.verdict.action !== "recompute") continue;
    const { count } = await db.membership.updateMany({ where: { id: r.m.id, seedRating: r.verdict.from }, data: { seedRating: r.verdict.to } });
    written += count;
  }
  console.log(`\nWrote ${written} of ${todo.length} (the rest had changed meanwhile).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
