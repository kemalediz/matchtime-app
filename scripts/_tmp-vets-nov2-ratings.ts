/**
 * ONE-OFF (2026-11-03): record the Vets' Mon 2 Nov game and queue its
 * rating DMs.
 *
 * "Monday night vets" went live on MatchTime late on Mon 2 Nov, after that
 * evening's game, so no Match row exists for it. Kemal (owner) asked for it
 * to be recorded and for the players to get MatchTime's normal post-game
 * rating DM. Bibs 3, No bibs 4.
 *
 * DRY RUN BY DEFAULT: SELECTs only (every write sits after the `APPLY`
 * gate, and the dry run creates no short links). It never issues a SET.
 * It prints every row it would write and the full text of every DM it
 * would queue. (A read-only startup option was tried: the Supabase pooler
 * behind DIRECT_URL drops it, so the guarantee is the code path itself.)
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/_tmp-vets-nov2-ratings.ts \
 *     --map /path/to/mapping.json [--no-post-match-flow] [--apply]
 *
 * The mapping (never guessed here): team-sheet name -> phone, userId,
 * null (not known yet), or { phone | userId | create: "phoneless", seed }.
 * --apply refuses while any player is unresolved or unknown.
 *
 * Every write goes through the app's own path where one exists:
 *   match        the shape generate-upcoming-matches writes (maxPlayers =
 *                playersPerTeam x 2, deadline = kickoff - deadlineHours),
 *                created COMPLETED (see below), `teamLabels` the club's words;
 *   attendances  `registerAttendance` (CONFIRMED, its own AttendanceEvent),
 *                cause "admin-squad-edit", actorKind "script";
 *   teams        TeamAssignment rows (RED = Bibs, YELLOW = No bibs);
 *   score        `applyScoreWrites` + `buildScoreApplyDeps` (setMatchScore:
 *                the scores and COMPLETED in one update, then the Elo
 *                reconcile), as scripts/set-match-result.ts;
 *   names        the `ensureOrgPlayer` rule: only a nameless user the club
 *                owns (`isClubOwnedUser`), never an existing name;
 *   phoneless    the "add a player by name" shape of `ensureOrgPlayer`;
 *   guest        `recordPlayedPartnerGuest` (partner-guest.ts, the one guest
 *                writer): a guest Membership (guestVia partner, his home
 *                club, this match), his place via `registerAttendance`, a
 *                partner GuestPlace with no ask; then `retirePastGuests` makes
 *                him a past guest (his game is over), as the next poll would;
 *   seeds        `Membership.seedRating`, the column `seedPlayerRating` (the
 *                Players page's starting rating) writes; only where empty;
 *   rating DMs   the late rating-link path of `addPlayerToMatch`: a BotJob
 *                with `buildRatingDm` text plus the scheduler's own
 *                `<matchId>:rate-dm:<userId>` SentNotification, so the
 *                scheduler never sends a second one and its reminders (6d)
 *                and promo (6c) follow from it.
 *
 * WHY CREATED COMPLETED: a past match created UPCOMING would be completed by
 * the 15-minute cron, which also sends rating EMAILS (`sendRatingEmails`)
 * to the players' @matchtime.local addresses. Created COMPLETED, the cron
 * never selects it; the score write then sets COMPLETED again with the score.
 *
 * Nothing is SENT by this script: BotJobs are only delivered by the Pi's
 * due-posts poll, which returns 404 for a club with whatsappBotEnabled=false.
 */
import { readFileSync } from "node:fs";
import {
  GUEST_LIST_NAMES,
  NOV2_GAME,
  allListNames,
  parseMapping,
  planNaming,
  planSeed,
  rateDmDecision,
  teamOfListName,
  type MappingEntry,
} from "./_tmp-vets-nov2-plan.ts";

const VETS_ORG = "cmvzlm8km000707iihou1ut9h";
const VETS_ACTIVITY = "cmvzlm8u6000b07ii5sw20o3i";
const SUTTON_ORG = "cmnnwhdx30000zfr85q18lyy9";
/** The person who asked for this (actorUserId on the events). */
const KEMAL_USER = "cmn5vhtp2000004ifh4dqbsym";
const SOURCE_REF = "script:_tmp-vets-nov2-ratings";

const APPLY = process.argv.includes("--apply");
/** The designed per-match switch (`Match.postMatchEndFlow`): off, the
 *  scheduler sends nothing after the game for this match (no promo, no
 *  reminders, no MoM result, no badges post). The queued rating DMs are
 *  BotJobs and still go. Default: on, the normal flow. */
const QUIET_AFTER = process.argv.includes("--no-post-match-flow");
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
function fail(msg: string): never {
  console.error(`REFUSED: ${msg}. Nothing written.`);
  process.exit(1);
}

interface Player {
  listName: string;
  team: "RED" | "YELLOW";
  entry: MappingEntry | null;
  userId: string | null;
  name: string | null;
  phone: string | null;
  /** Vets membership as it is now. */
  membership: { id: string; leftAt: Date | null; guestMatchId: string | null; seedRating: number | null; subRatingDm: boolean } | null;
  guest: boolean;
  problem: string | null;
}

async function main() {
  const { db } = await import("../src/lib/db.ts");
  const { normalisePhone } = await import("../src/lib/phone.ts");
  const { londonDateTimeToUtc } = await import("../src/lib/london-time.ts");
  const { hasMatchForSlot } = await import("../src/lib/match-slot.ts");
  const { isClubOwnedUser } = await import("../src/lib/player-account-guard.ts");
  const { getOrgFeatures } = await import("../src/lib/org-features.ts");
  const { organisersPickMom } = await import("../src/lib/mom-chooser.ts");
  const { buildRatingDm } = await import("../src/lib/dm-copy.ts");
  const { dayLabel } = await import("../src/lib/i18n/dates.ts");
  const { signMagicLinkToken, MAGIC_LINK_TTL, buildMagicLinkUrl } = await import("../src/lib/magic-link.ts");

  console.log(APPLY ? "APPLY: writing.\n" : "DRY RUN: reads only, nothing written.\n");

  const mapPath = arg("map");
  if (!mapPath) fail("usage: --map <mapping.json> [--apply]");
  const parsed = parseMapping(JSON.parse(readFileSync(mapPath, "utf8")), normalisePhone);
  if (parsed.errors.length) fail(`the mapping has errors:\n  ${parsed.errors.join("\n  ")}`);

  const [org, activity] = await Promise.all([
    db.organisation.findUnique({ where: { id: VETS_ORG }, select: { id: true, name: true, whatsappBotEnabled: true, language: true, momChosenBy: true } }),
    db.activity.findUnique({
      where: { id: VETS_ACTIVITY },
      select: { id: true, orgId: true, name: true, venue: true, dayOfWeek: true, time: true, deadlineHours: true, matchDurationMins: true, ratingWindowHours: true, sport: { select: { playersPerTeam: true, mvpLabel: true } } },
    }),
  ]);
  if (!org || !activity || activity.orgId !== VETS_ORG) fail("the Vets club or its fixture was not found");
  const features = await getOrgFeatures(VETS_ORG);
  const lang = features.language;
  const kickoff = londonDateTimeToUtc(NOV2_GAME.londonDate, activity.time);
  const windowEnd = new Date(kickoff.getTime() + activity.ratingWindowHours * 3600_000);
  console.log(`${org.name}: ${activity.name}, ${kickoff.toISOString()} (London ${NOV2_GAME.londonDate} ${activity.time})`);
  console.log(`  bot ${org.whatsappBotEnabled ? "ON" : "MUTED (whatsappBotEnabled=false): queued DMs wait until it is switched on"}`);
  console.log(`  after-game scheduler flow for this match: ${QUIET_AFTER ? "OFF (postMatchEndFlow=false)" : "ON (normal)"}`);
  console.log(`  ratings close ${windowEnd.toISOString()} (kickoff + ${activity.ratingWindowHours}h)`);
  if (Date.now() > windowEnd.getTime()) fail("the rating window for 2 Nov has closed");

  // ── Is the game already recorded? ──
  const near = await db.match.findMany({
    where: { activity: { orgId: VETS_ORG }, date: { gte: new Date(kickoff.getTime() - 12 * 3600_000), lte: new Date(kickoff.getTime() + 12 * 3600_000) } },
    select: { id: true, date: true, status: true, redScore: true, yellowScore: true, teamLabels: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
  });
  const existing = near.find((m) => hasMatchForSlot({ orgId: VETS_ORG, venue: activity.venue, dayOfWeek: activity.dayOfWeek, instant: kickoff }, [{ ...m.activity, instant: m.date }])) ?? null;
  if (existing) console.log(`  a match already sits in this slot: ${existing.id} (${existing.status}, ${existing.redScore ?? "?"}-${existing.yellowScore ?? "?"}); it is reused and only missing rows are added`);

  // ── Resolve the 13 players ──
  const players: Player[] = [];
  for (const listName of allListNames()) {
    const entry = parsed.entries.get(listName.toLowerCase()) ?? null;
    if (entry?.skip) {
      console.log(`  ${listName}: SKIPPED by the mapping (not recorded as playing)`);
      continue;
    }
    const team = teamOfListName(listName)!;
    const guest = GUEST_LIST_NAMES.has(listName.toLowerCase());
    const p: Player = { listName, team, entry, userId: null, name: null, phone: null, membership: null, guest, problem: null };
    if (!entry) p.problem = "not in the mapping";
    else if (entry.unknown) p.problem = "not known yet (null in the mapping)";
    else if (entry.create) p.problem = null;
    else {
      const u = await db.user.findFirst({
        where: entry.userId ? { id: entry.userId } : { phoneNumber: entry.phone! },
        select: { id: true, name: true, phoneNumber: true, isActive: true, memberships: { select: { id: true, orgId: true, leftAt: true, guestMatchId: true, seedRating: true, subRatingDm: true } } },
      });
      if (!u) p.problem = `no user with ${entry.userId ? `id ${entry.userId}` : `phone ${entry.phone}`}`;
      else {
        p.userId = u.id;
        p.name = u.name;
        p.phone = u.phoneNumber;
        const vets = u.memberships.find((m) => m.orgId === VETS_ORG) ?? null;
        p.membership = vets;
        if (!u.isActive) p.problem = "the user is not active";
        else if (guest) {
          if (!u.memberships.some((m) => m.orgId === SUTTON_ORG && !m.guestMatchId)) p.problem = "expected a Sutton FC member";
          if (vets && !vets.guestMatchId) p.guest = false; // already an ordinary Vets member: plays as one
        } else if (!vets || vets.leftAt || vets.guestMatchId) p.problem = "not a current ordinary member of the Vets";
      }
    }
    players.push(p);
  }
  const ids = players.map((p) => p.userId).filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length) fail("two team-sheet names map to the same user");

  // ── Print the plan ──
  console.log("\nTEAMS");
  for (const side of ["RED", "YELLOW"] as const) {
    const t = side === "RED" ? NOV2_GAME.red : NOV2_GAME.yellow;
    console.log(`  ${side} slot, label "${t.label}", score ${t.score}`);
    for (const p of players.filter((x) => x.team === side)) {
      const who = p.entry?.create ? "NEW phoneless player" : p.userId ? `${p.userId} ${p.phone ?? "(no phone)"} name=${JSON.stringify(p.name)}` : "?";
      console.log(`    - ${p.listName}${p.guest ? " [guest from Sutton FC]" : ""}: ${who}${p.problem ? `  <<< ${p.problem}` : ""}`);
    }
  }

  console.log("\nNAMES (only where the user has none; never overwritten)");
  const namings: Array<{ userId: string; to: string }> = [];
  for (const p of players) {
    if (!p.userId) continue;
    const plan = planNaming({ current: p.name, listName: p.listName, clubOwned: p.name?.trim() ? true : await isClubOwnedUser(p.userId, VETS_ORG) });
    if (plan.action === "name") namings.push({ userId: p.userId, to: plan.to });
    console.log(`  ${p.listName}: ${plan.action === "name" ? `name -> "${plan.to}"` : plan.action === "keep" ? `keep "${plan.current}"` : "nameless but not the club's to name: left"}`);
  }

  console.log("\nSEEDS (club-scoped Membership.seedRating; only where empty)");
  const seedWrites: Array<{ userId: string | null; listName: string; to: number }> = [];
  for (const p of players) {
    const wanted = p.entry?.seed ?? null;
    if (wanted == null) {
      console.log(`  ${p.listName}: no seed given`);
      continue;
    }
    if (p.guest) {
      console.log(`  ${p.listName}: guest, seed ${wanted} given; written on his guest membership only if empty (${p.membership?.seedRating ?? "none"} now)`);
    }
    const plan = planSeed(p.membership?.seedRating ?? null, wanted);
    if (plan.action === "write") seedWrites.push({ userId: p.userId, listName: p.listName, to: plan.to });
    console.log(`  ${p.listName}: ${plan.action === "write" ? `write ${plan.to}` : plan.action === "same" ? "already that" : plan.action === "differs" ? `LEFT: already ${plan.current} (wanted ${plan.wanted})` : "-"}`);
  }

  // ── The DMs ──
  const momAnnounced = existing
    ? !!(await db.sentNotification.findUnique({ where: { key: `${existing.id}:mom-announcement` }, select: { id: true } }))
    : false;
  const engaged = new Set<string>(
    existing
      ? [
          ...(await db.rating.findMany({ where: { matchId: existing.id }, select: { raterId: true }, distinct: ["raterId"] })).map((r) => r.raterId),
          ...(organisersPickMom(features) ? [] : (await db.moMVote.findMany({ where: { matchId: existing.id }, select: { voterId: true } })).map((v) => v.voterId)),
        ]
      : [],
  );
  const keyed = new Set(
    existing ? (await db.sentNotification.findMany({ where: { matchId: existing.id, key: { startsWith: `${existing.id}:rate-dm:` } }, select: { key: true } })).map((r) => r.key) : [],
  );
  const matchIdForKey = existing?.id ?? "<new match id>";
  const dateLabel = dayLabel(lang, kickoff);
  const momVote = organisersPickMom(features) ? { momVote: false as const } : {};
  console.log(`\nRATING DMs (${dateLabel}; links are short links created on --apply, previewed long here)`);
  const dms: Array<{ p: Player }> = [];
  for (const p of players) {
    const d = rateDmDecision({
      hasPhone: !!p.phone,
      optedOut: p.membership ? !p.membership.subRatingDm : false,
      engaged: !!p.userId && engaged.has(p.userId),
      alreadyKeyed: !!p.userId && keyed.has(`${matchIdForKey}:rate-dm:${p.userId}`),
      playerRating: features.playerRating,
      momAnnounced,
    });
    if (!d.send) {
      console.log(`  ${p.listName}: NO DM (${d.reason}${p.entry?.create ? ", phoneless player: others rate him" : ""})`);
      continue;
    }
    if (p.problem || !p.userId) {
      console.log(`  ${p.listName}: NO DM yet (${p.problem ?? "unresolved"})`);
      continue;
    }
    dms.push({ p });
    if (!APPLY) {
      const token = signMagicLinkToken({ userId: p.userId, purpose: "rate-match", matchId: matchIdForKey, ttlSeconds: MAGIC_LINK_TTL.rateMatch });
      const stats = signMagicLinkToken({ userId: p.userId, purpose: "sign-in", nextPath: "/profile/stats", ttlSeconds: MAGIC_LINK_TTL.bookmark });
      const text = buildRatingDm({ activityName: activity.name, dateLabel, lang, mvpLabel: activity.sport.mvpLabel, rateUrl: buildMagicLinkUrl(token).slice(0, 60) + "...", statsUrl: buildMagicLinkUrl(stats).slice(0, 60) + "...", ...momVote });
      console.log(`  ${p.listName} -> ${p.phone} (BotJob kind dm, key ${matchIdForKey}:rate-dm:${p.userId})\n${text.split("\n").map((l) => `      | ${l}`).join("\n")}`);
    }
  }

  const blocking = players.filter((p) => p.problem);
  console.log(`\nSUMMARY: ${players.length} players, ${dms.length} rating DM(s) to queue, ${namings.length} name(s), ${seedWrites.length} seed(s), ${players.filter((p) => p.entry?.create).length} phoneless player(s) to create.`);
  if (blocking.length) console.log(`BLOCKING for --apply: ${blocking.map((p) => `${p.listName} (${p.problem})`).join("; ")}`);

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing written. Pass --apply to write.");
    return;
  }
  if (blocking.length) fail("some players are not resolved");

  // ════════════════════════ APPLY ════════════════════════
  const { registerAttendance } = await import("../src/lib/attendance.ts");
  const { recordPlayedPartnerGuest } = await import("../src/lib/partner-guest.ts");
  const { applyScoreWrites } = await import("../src/lib/score-engine.ts");
  const { buildScoreApplyDeps } = await import("../src/lib/owner-deps.ts");
  const { retirePastGuests } = await import("../src/lib/partner-guest.ts");
  const { buildShortMagicLinkUrl } = await import("../src/lib/short-link.ts");

  // 1. Phoneless players (the "add by name" shape of ensureOrgPlayer).
  for (const p of players.filter((x) => x.entry?.create)) {
    const same = await db.membership.findFirst({ where: { orgId: VETS_ORG, leftAt: null, guestMatchId: null, user: { name: { equals: p.listName, mode: "insensitive" }, phoneNumber: null } }, select: { userId: true } });
    if (same) p.userId = same.userId;
    else {
      const email = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@placeholder.matchtime`;
      const u = await db.user.create({ data: { name: p.listName, email, onboarded: false, isActive: true }, select: { id: true } });
      await db.membership.create({ data: { userId: u.id, orgId: VETS_ORG, role: "PLAYER" } });
      p.userId = u.id;
    }
    p.membership = await db.membership.findUnique({ where: { userId_orgId: { userId: p.userId!, orgId: VETS_ORG } }, select: { id: true, leftAt: true, guestMatchId: true, seedRating: true, subRatingDm: true } });
    seedWrites.forEach((s) => s.listName === p.listName && (s.userId = p.userId));
    console.log(`  created phoneless ${p.listName}: ${p.userId}`);
  }

  // 2. Names.
  for (const n of namings) {
    const done = await db.user.updateMany({ where: { id: n.userId, OR: [{ name: null }, { name: "" }] }, data: { name: n.to } });
    console.log(`  named ${n.userId} "${n.to}"${done.count ? "" : " (skipped: has a name now)"}`);
  }

  // 3. The match and its teams (one transaction), then every player's place
  //    through the app's own writers: `registerAttendance` for the club's
  //    members, `recordPlayedPartnerGuest` (partner-guest.ts, the one guest
  //    writer) for the guest. Re-runnable: each step skips what exists.
  const matchId = await db.$transaction(async (tx) => {
    const id =
      existing?.id ??
      (
        await tx.match.create({
          data: {
            activityId: VETS_ACTIVITY,
            date: kickoff,
            maxPlayers: activity.sport.playersPerTeam * 2,
            attendanceDeadline: new Date(kickoff.getTime() - activity.deadlineHours * 3600_000),
            status: "COMPLETED",
            ...(QUIET_AFTER ? { postMatchEndFlow: false } : {}),
            teamLabels: [NOV2_GAME.red.label, NOV2_GAME.yellow.label],
          },
          select: { id: true },
        })
      ).id;
    if (existing && existing.teamLabels.length === 0) await tx.match.update({ where: { id }, data: { teamLabels: [NOV2_GAME.red.label, NOV2_GAME.yellow.label] } });
    await tx.teamAssignment.createMany({ data: players.map((p) => ({ matchId: id, userId: p.userId!, team: p.team })), skipDuplicates: true });
    return id;
  });
  const event = { actorKind: "script" as const, actorUserId: KEMAL_USER, sourceRef: SOURCE_REF, note: "Mon 2 Nov game recorded after the club went live" };
  for (const p of players) {
    if (p.guest) {
      const r = await recordPlayedPartnerGuest({ orgId: VETS_ORG, matchId, userId: p.userId!, fromOrgId: SUTTON_ORG, event });
      console.log(`  ${p.listName}: ${r.status} (${r.kind})`);
    } else {
      const r = await registerAttendance(p.userId!, matchId, { event: { ...event, cause: "admin-squad-edit" }, actorIsAdmin: true });
      console.log(`  ${p.listName}: ${r.status}`);
    }
  }
  console.log(`  match ${matchId}: teams written`);

  // 4. The score, through the bot's own writer (+ Elo reconcile).
  const now = await db.match.findUnique({ where: { id: matchId }, select: { redScore: true, yellowScore: true } });
  if (now?.redScore !== NOV2_GAME.red.score || now?.yellowScore !== NOV2_GAME.yellow.score) {
    const previous = now && now.redScore !== null && now.yellowScore !== null ? { red: now.redScore, yellow: now.yellowScore } : null;
    const [res] = await applyScoreWrites({
      writes: [{ kind: "score", matchId, red: NOV2_GAME.red.score, yellow: NOV2_GAME.yellow.score, ...(previous ? { previous } : {}), sourceMessageId: SOURCE_REF, reason: "2 Nov game recorded by hand" }],
      deps: buildScoreApplyDeps(),
    });
    if (!res.ok) fail(`the score write failed (${res.error})`);
    console.log(`  score ${NOV2_GAME.red.label} ${NOV2_GAME.red.score}, ${NOV2_GAME.yellow.label} ${NOV2_GAME.yellow.score}; ${res.eloApplied} rating(s) moved${res.eloError ? `; Elo: ${res.eloError}` : ""}`);
  }

  // 5. The guest's game is over: past guest now, as the next poll would.
  console.log(`  past guests retired: ${await retirePastGuests(VETS_ORG)}`);

  // 6. Seeds, only where still empty.
  for (const s of seedWrites) {
    if (!s.userId) continue;
    const done = await db.membership.updateMany({ where: { userId: s.userId, orgId: VETS_ORG, seedRating: null }, data: { seedRating: s.to } });
    console.log(`  seed ${s.listName} ${s.to}${done.count ? "" : " (skipped: set meanwhile)"}`);
  }

  // 7. Rating DMs: the late rating-link path (BotJob + the rate-dm key).
  for (const { p } of dms) {
    const key = `${matchId}:rate-dm:${p.userId}`;
    if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) continue;
    const token = signMagicLinkToken({ userId: p.userId!, purpose: "rate-match", matchId, ttlSeconds: MAGIC_LINK_TTL.rateMatch });
    const stats = signMagicLinkToken({ userId: p.userId!, purpose: "sign-in", nextPath: "/profile/stats", ttlSeconds: MAGIC_LINK_TTL.bookmark });
    const text = buildRatingDm({ activityName: activity.name, dateLabel, lang, mvpLabel: activity.sport.mvpLabel, rateUrl: await buildShortMagicLinkUrl(token), statsUrl: await buildShortMagicLinkUrl(stats), ...momVote });
    await db.sentNotification.create({ data: { key, kind: "rate-dm", matchId, targetUser: p.userId, text } });
    await db.botJob.create({ data: { orgId: VETS_ORG, kind: "dm", phone: p.phone!.replace(/^\+/, ""), text, matchId, aboutKey: key } });
    console.log(`  queued rating DM -> ${p.listName} ${p.phone}`);
  }
  console.log("\nDone. Nothing has been sent: the DMs go out on the first poll after the club is unmuted.");
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
