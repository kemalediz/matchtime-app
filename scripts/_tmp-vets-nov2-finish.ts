/**
 * ONE-OFF (2026-11-03): finish saving the Vets' Mon 2 Nov game, with NO
 * messages of any kind.
 *
 * `_tmp-vets-nov2-ratings.ts --apply` was interrupted on 3 Nov ~11:22 after
 * it had written the match (cmw0llsje0004wv9kazlsvdls, COMPLETED, teams,
 * 13 attendances), the phoneless Nabz and Luca and Ibrahim Sahin's guest
 * membership. It did not write the score, the names, the seeds, any BotJob
 * or SentNotification. Kemal approved finishing it WITHOUT any DMs:
 *
 *   score   No bibs 4, Bibs 3, through `applyScoreWrites` +
 *           `buildScoreApplyDeps` (setMatchScore, then the Elo reconcile),
 *           exactly as scripts/set-match-result.ts. Refused if the match
 *           already has a score that is not this one; a no-op when it has
 *           this one and its Elo record says it is applied.
 *   names   only where User.name is null/empty, the team-sheet name from
 *           the mapping; never an existing name.
 *   seeds   only where the Vets Membership.seedRating is null (admin-set
 *           ones stay).
 *   NEVER   a BotJob, a SentNotification, a group post, or a change to
 *           Match.postMatchEndFlow (must already be false, else refused).
 *
 * DRY RUN BY DEFAULT: SELECTs only, no SET. --apply writes names and seeds
 * in one transaction, then the score through the app's own writer (which
 * runs its own two transactions). Re-running is a no-op.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/_tmp-vets-nov2-finish.ts \
 *     --map /path/to/vets-nov2-map.json [--apply]
 */
import { readFileSync } from "node:fs";
import { NOV2_GAME, allListNames, parseMapping, planSeed, teamOfListName } from "./_tmp-vets-nov2-plan.ts";

const VETS_ORG = "cmvzlm8km000707iihou1ut9h";
const MATCH_ID = "cmw0llsje0004wv9kazlsvdls";
const SOURCE_REF = "script:_tmp-vets-nov2-finish";
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
  console.log(APPLY ? "APPLY: writing.\n" : "DRY RUN: reads only, nothing written.\n");

  const mapPath = arg("map");
  if (!mapPath) fail("usage: --map <mapping.json> [--apply]");
  const parsed = parseMapping(JSON.parse(readFileSync(mapPath, "utf8")), normalisePhone);
  if (parsed.errors.length) fail(`the mapping has errors:\n  ${parsed.errors.join("\n  ")}`);

  const match = await db.match.findUnique({
    where: { id: MATCH_ID },
    select: {
      id: true, date: true, status: true, redScore: true, yellowScore: true, eloApplied: true, teamLabels: true, postMatchEndFlow: true,
      activity: { select: { orgId: true, name: true, org: { select: { name: true, whatsappBotEnabled: true } } } },
      teamAssignments: { select: { userId: true, team: true, user: { select: { name: true, phoneNumber: true } } } },
    },
  });
  if (!match) fail(`match ${MATCH_ID} not found`);
  if (match.activity.orgId !== VETS_ORG) fail("the match is not the Vets'");
  console.log(`${match.activity.org.name}: ${match.activity.name}, ${match.date.toISOString()} ${match.status}`);
  console.log(`  bot ${match.activity.org.whatsappBotEnabled ? "ON" : "MUTED"}; postMatchEndFlow=${match.postMatchEndFlow}`);
  console.log(`  teamLabels ${JSON.stringify(match.teamLabels)}; score now ${match.redScore ?? "?"}-${match.yellowScore ?? "?"}; eloApplied ${JSON.stringify(match.eloApplied)}`);
  if (match.postMatchEndFlow !== false) fail("postMatchEndFlow is not false on the match");
  if (match.status === "CANCELLED") fail("the match is cancelled");
  // RED slot = Bibs, YELLOW slot = No bibs: check the match says the same.
  if (match.teamLabels[0] !== NOV2_GAME.red.label || match.teamLabels[1] !== NOV2_GAME.yellow.label) {
    fail(`teamLabels are not ["${NOV2_GAME.red.label}", "${NOV2_GAME.yellow.label}"]`);
  }

  // ── Resolve the 13 list names to the match's team sheet ──
  const vets = await db.membership.findMany({
    where: { orgId: VETS_ORG, userId: { in: match.teamAssignments.map((t) => t.userId) } },
    select: { userId: true, seedRating: true, leftAt: true, guestMatchId: true },
  });
  const memOf = new Map(vets.map((m) => [m.userId, m]));
  const used = new Set<string>();
  type Row = { listName: string; userId: string; team: string; name: string | null; phone: string | null; seed: number | null; wantSeed: number | null };
  const rows: Row[] = [];
  for (const listName of allListNames()) {
    const e = parsed.entries.get(listName.toLowerCase());
    if (!e) fail(`${listName} is not in the mapping`);
    const ta = match.teamAssignments.filter((t) =>
      e.userId ? t.userId === e.userId : e.phone ? t.user.phoneNumber === e.phone : e.create ? !t.user.phoneNumber && t.user.name?.trim().toLowerCase() === listName.toLowerCase() : false,
    );
    if (ta.length !== 1) fail(`${listName}: ${ta.length} team-sheet rows match (want exactly 1)`);
    const t = ta[0];
    if (used.has(t.userId)) fail(`${listName}: user ${t.userId} already taken by another name`);
    used.add(t.userId);
    if (t.team !== teamOfListName(listName)) fail(`${listName}: on ${t.team}, expected ${teamOfListName(listName)}`);
    const m = memOf.get(t.userId);
    if (!m) fail(`${listName}: no Vets membership`);
    rows.push({ listName, userId: t.userId, team: t.team, name: t.user.name, phone: t.user.phoneNumber, seed: m.seedRating, wantSeed: e.seed });
  }
  if (used.size !== match.teamAssignments.length) fail(`the team sheet has ${match.teamAssignments.length} rows, the list ${used.size}`);

  // ── Plan ──
  const names: Array<{ userId: string; to: string; listName: string }> = [];
  const seeds: Array<{ userId: string; to: number; listName: string }> = [];
  console.log("\nPLAYERS (team, user, name, Vets seed) -> plan");
  for (const r of rows) {
    const label = r.team === "RED" ? NOV2_GAME.red.label : NOV2_GAME.yellow.label;
    const nameless = !r.name?.trim();
    if (nameless) names.push({ userId: r.userId, to: r.listName, listName: r.listName });
    const sp = planSeed(r.seed, r.wantSeed);
    if (sp.action === "write") seeds.push({ userId: r.userId, to: sp.to, listName: r.listName });
    const seedTxt = sp.action === "write" ? `seed -> ${sp.to}` : sp.action === "same" ? `seed ${r.seed} kept (same)` : sp.action === "differs" ? `seed ${sp.current} KEPT (mapping says ${sp.wanted})` : "no seed given";
    console.log(`  ${label.padEnd(7)} ${r.listName.padEnd(14)} ${r.userId} ${(r.phone ?? "(no phone)").padEnd(14)} name=${JSON.stringify(r.name)} seed=${r.seed ?? "null"} | ${nameless ? `name -> "${r.listName}"` : "name kept"}; ${seedTxt}`);
  }

  // ── Score ──
  const want = { red: NOV2_GAME.red.score, yellow: NOV2_GAME.yellow.score };
  const scored = match.redScore !== null && match.yellowScore !== null;
  const rec = match.eloApplied as { target?: { red: number; yellow: number }; applied?: { red: number; yellow: number } | null } | null;
  let scoreAction: "write" | "noop";
  if (!scored) {
    if (rec) fail(`no score but an Elo record exists (${JSON.stringify(rec)})`);
    scoreAction = "write";
  } else if (match.redScore === want.red && match.yellowScore === want.yellow) {
    if (!rec?.applied || rec.applied.red !== want.red || rec.applied.yellow !== want.yellow) fail(`scored ${want.red}-${want.yellow} but its Elo record is not applied (${JSON.stringify(rec)}); check by hand`);
    scoreAction = "noop";
  } else {
    fail(`the match is already scored ${match.redScore}-${match.yellowScore}; refusing to re-score`);
  }

  const botJobsBefore = await db.botJob.count({ where: { orgId: VETS_ORG } });
  const sentBefore = await db.sentNotification.count({ where: { matchId: MATCH_ID } });
  console.log(`\nSCORE: ${scoreAction === "write" ? `write ${NOV2_GAME.red.label} ${want.red} (red), ${NOV2_GAME.yellow.label} ${want.yellow} (yellow), then Elo reconcile` : "already recorded and Elo applied: NO-OP"}`);
  console.log(`NAMES: ${names.length} (${names.map((n) => n.to).join(", ") || "none"})`);
  console.log(`SEEDS: ${seeds.length} (${seeds.map((s) => `${s.listName} ${s.to}`).join(", ") || "none"})`);
  console.log(`BotJobs this script writes: 0. SentNotifications: 0. Group posts: 0. postMatchEndFlow: unchanged (false).`);
  console.log(`  (now: ${botJobsBefore} BotJob row(s) for the org, ${sentBefore} SentNotification row(s) for the match)`);
  const noop = scoreAction === "noop" && names.length === 0 && seeds.length === 0;
  if (noop) console.log("\nNO-OP: everything is already saved.");

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing written. Pass --apply to write.");
    return;
  }
  if (noop) return;

  // ════════ APPLY ════════
  const { applyScoreWrites } = await import("../src/lib/score-engine.ts");
  const { buildScoreApplyDeps } = await import("../src/lib/owner-deps.ts");

  // 1. Names and seeds: one transaction, each guarded so it never overwrites.
  await db.$transaction(async (tx) => {
    for (const n of names) {
      const r = await tx.user.updateMany({ where: { id: n.userId, OR: [{ name: null }, { name: "" }] }, data: { name: n.to } });
      console.log(`  name ${n.listName}: ${r.count ? "written" : "skipped (named meanwhile)"}`);
    }
    for (const s of seeds) {
      const r = await tx.membership.updateMany({ where: { userId: s.userId, orgId: VETS_ORG, seedRating: null }, data: { seedRating: s.to } });
      console.log(`  seed ${s.listName} ${s.to}: ${r.count ? "written" : "skipped (set meanwhile)"}`);
    }
  });

  // 2. The score, through the app's own writer (setMatchScore + Elo reconcile).
  if (scoreAction === "write") {
    const [res] = await applyScoreWrites({
      writes: [{ kind: "score", matchId: MATCH_ID, red: want.red, yellow: want.yellow, sourceMessageId: SOURCE_REF, reason: "2 Nov game recorded by hand" }],
      deps: buildScoreApplyDeps(),
    });
    if (!res.ok) fail(`the score write failed (${res.error})`);
    console.log(`  score written; ${res.eloApplied} rating(s) moved${res.eloError ? `; Elo: ${res.eloError}` : ""}`);
  }

  const botJobsAfter = await db.botJob.count({ where: { orgId: VETS_ORG } });
  const sentAfter = await db.sentNotification.count({ where: { matchId: MATCH_ID } });
  console.log(`\nBotJobs for the org: ${botJobsBefore} -> ${botJobsAfter}; SentNotifications for the match: ${sentBefore} -> ${sentAfter}`);
  if (botJobsAfter !== botJobsBefore || sentAfter !== sentBefore) console.error("WARNING: a BotJob or SentNotification count changed; check it.");
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
