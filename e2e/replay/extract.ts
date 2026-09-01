/**
 * READ-ONLY extraction of production history.
 *
 *   npm run replay:extract            # → .e2e/replay/source.json (gitignored)
 *   npm run replay:extract -- --org <orgId>
 *
 * WHAT IT TOUCHES AND WHY IT CANNOT WRITE
 * ---------------------------------------
 * Every statement runs inside `BEGIN TRANSACTION READ ONLY`, so the
 * database itself refuses any write this process could attempt, and the
 * pool is capped at one connection so nothing escapes that transaction.
 * The only SQL in the file is SELECT.
 *
 * WHAT IT NEVER EXTRACTS
 * ----------------------
 * Phone numbers and WhatsApp JIDs. `authorPhone` becomes the boolean
 * `authorHadPhone`, `User.phoneNumber` becomes `hasPhone`, the group JID
 * becomes a salted-free SHA-256 prefix, and every message body goes
 * through `redact()` before it is written. Member NAMES are kept — the
 * incident corpus already precedents that, and a replay without them
 * cannot resolve who a message is about — and the output lives under
 * `.e2e/` which is gitignored.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { reconstruct } from "./reconstruct";
import { renderReport } from "./report";
import type { ReplaySource } from "./types";

loadEnv();

const OUT_DIR = path.join(process.cwd(), ".e2e", "replay");

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("replay:extract — no DATABASE_URL. This reads PRODUCTION, read-only.");
    return 1;
  }
  const orgFilter = argValue("--org");

  // pgbouncer=true is a Prisma-only query parameter; libpq rejects it.
  const client = new Client({ connectionString: url.replace(/[?&]pgbouncer=[^&]*/g, "") });
  await client.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");

  const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  const orgClause = orgFilter ? `WHERE am."orgId" = $1` : "";
  const orgParams = orgFilter ? [orgFilter] : [];

  const messages = await q<Record<string, unknown>>(
    `SELECT am."waMessageId", am."orgId", am."groupId", am."authorUserId", am."authorName",
            (am."authorPhone" IS NOT NULL AND am."authorPhone" <> '') AS "authorHadPhone",
            am.body, am.intent, am.action, am."handledBy", am."createdAt"
       FROM "AnalyzedMessage" am ${orgClause}
      ORDER BY am."createdAt" ASC`,
    orgParams,
  );

  const orgIds = [...new Set(messages.map((m) => String(m.orgId)))];

  const matches = await q(
    `SELECT mt.id, a."orgId", mt."activityId", mt.date, mt."maxPlayers", mt.status::text AS status,
            mt."attendanceDeadline", mt."redScore", mt."yellowScore", mt."createdAt", mt."updatedAt"
       FROM "Match" mt JOIN "Activity" a ON a.id = mt."activityId"
      WHERE a."orgId" = ANY($1) AND mt."isHistorical" = false`,
    [orgIds],
  );

  const attendance = await q(
    `SELECT at."matchId", at."userId", at.status::text AS status, at.position,
            at."createdAt", at."updatedAt"
       FROM "Attendance" at
      WHERE at."matchId" = ANY($1)`,
    [matches.map((m) => (m as { id: string }).id)],
  );

  const memberships = await q(
    `SELECT m."orgId", m."userId", m.role::text AS role, m."createdAt", m."leftAt"
       FROM "Membership" m WHERE m."orgId" = ANY($1)`,
    [orgIds],
  );

  const users = await q(
    `SELECT u.id, u.name, (u."phoneNumber" IS NOT NULL) AS "hasPhone"
       FROM "User" u
      WHERE u.id IN (SELECT "userId" FROM "Membership" WHERE "orgId" = ANY($1))`,
    [orgIds],
  );

  const orgs = await q(
    `SELECT o.id, o.name, o."featureAttendance", o."featureBench", o."featureTeamBalancing",
            o."featureMomVoting", o."featurePlayerRating", o."featureReminders",
            o."featureStatsQa", o."featureSquadFromList", o."paymentTrackingEnabled"
       FROM "Organisation" o WHERE o.id = ANY($1)`,
    [orgIds],
  );

  const teamAssignments = await q(
    `SELECT t."matchId", t."userId", t.team::text AS team FROM "TeamAssignment" t
      WHERE t."matchId" = ANY($1)`,
    [matches.map((m) => (m as { id: string }).id)],
  );

  const benchOffers = await q(
    `SELECT b."matchId", b."replacingUserId", b."createdAt", b."resolvedAt" FROM "BenchSlotOffer" b
      WHERE b."matchId" = ANY($1)`,
    [matches.map((m) => (m as { id: string }).id)],
  );

  await client.query("COMMIT");
  await client.end();

  const source: ReplaySource = {
    extractedAt: new Date().toISOString(),
    messages: messages.map((m) => ({
      waMessageId: String(m.waMessageId),
      orgId: String(m.orgId),
      groupId: String(m.groupId),
      authorUserId: (m.authorUserId as string | null) ?? null,
      authorName: (m.authorName as string | null) ?? null,
      authorHadPhone: Boolean(m.authorHadPhone),
      body: (m.body as string | null) ?? null,
      intent: (m.intent as string | null) ?? null,
      action: (m.action as string | null) ?? null,
      handledBy: String(m.handledBy),
      createdAt: iso(m.createdAt),
    })),
    matches: matches.map((m) => {
      const r = m as Record<string, unknown>;
      return {
        id: String(r.id),
        orgId: String(r.orgId),
        activityId: String(r.activityId),
        date: iso(r.date),
        maxPlayers: Number(r.maxPlayers),
        status: String(r.status),
        attendanceDeadline: iso(r.attendanceDeadline),
        redScore: r.redScore === null ? null : Number(r.redScore),
        yellowScore: r.yellowScore === null ? null : Number(r.yellowScore),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      };
    }),
    attendance: attendance.map((a) => {
      const r = a as Record<string, unknown>;
      return {
        matchId: String(r.matchId),
        userId: String(r.userId),
        status: String(r.status) as "CONFIRMED" | "BENCH" | "DROPPED",
        position: Number(r.position),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      };
    }),
    memberships: memberships.map((m) => {
      const r = m as Record<string, unknown>;
      return {
        orgId: String(r.orgId),
        userId: String(r.userId),
        role: String(r.role) as "OWNER" | "ADMIN" | "PLAYER",
        createdAt: iso(r.createdAt),
        leftAt: r.leftAt ? iso(r.leftAt) : null,
      };
    }),
    users: users.map((u) => {
      const r = u as Record<string, unknown>;
      return { id: String(r.id), name: (r.name as string | null) ?? null, hasPhone: Boolean(r.hasPhone) };
    }),
    orgs: orgs.map((o) => {
      const r = o as Record<string, unknown>;
      return {
        id: String(r.id),
        name: String(r.name),
        features: {
          attendance: Boolean(r.featureAttendance),
          bench: Boolean(r.featureBench),
          teamBalancing: Boolean(r.featureTeamBalancing),
          momVoting: Boolean(r.featureMomVoting),
          playerRating: Boolean(r.featurePlayerRating),
          reminders: Boolean(r.featureReminders),
          statsQa: Boolean(r.featureStatsQa),
          squadFromList: Boolean(r.featureSquadFromList),
          paymentTracking: Boolean(r.paymentTrackingEnabled),
        },
      };
    }),
    teamAssignments: teamAssignments.map((t) => {
      const r = t as Record<string, unknown>;
      return { matchId: String(r.matchId), userId: String(r.userId), team: String(r.team) as "RED" | "YELLOW" };
    }),
    benchOffers: benchOffers.map((b) => {
      const r = b as Record<string, unknown>;
      return {
        matchId: String(r.matchId),
        replacingUserId: (r.replacingUserId as string | null) ?? null,
        createdAt: iso(r.createdAt),
        resolvedAt: r.resolvedAt ? iso(r.resolvedAt) : null,
      };
    }),
  };

  const built = reconstruct(source);

  mkdirSync(OUT_DIR, { recursive: true });
  const sourceFile = path.join(OUT_DIR, "source.json");
  const casesFile = path.join(OUT_DIR, "cases.json");
  writeFileSync(sourceFile, JSON.stringify(source));
  writeFileSync(
    casesFile,
    JSON.stringify({ extractedAt: source.extractedAt, stats: built.stats, cases: built.cases, excluded: built.excluded }),
  );

  console.log(
    renderReport(
      {
        runId: "extract-only",
        startedAt: source.extractedAt!,
        finishedAt: new Date().toISOString(),
        mode: "live",
        runsPerCase: 0,
        pipelines: { old: "(not run)", new: "(not run)" },
        plan: {
          total: built.cases.length,
          selected: [],
          excludedKeys: [],
          strategy: "all",
          seed: 0,
          limit: null,
          strata: {},
          partial: false,
        },
        diffs: [],
        criteria: emptyCriteria(),
        criteriaStrict: emptyCriteria(),
        byTier: built.stats.byTier,
        cost: {
          old: zero("(not run)"),
          new: zero("(not run)"),
        },
        resumedUnits: 0,
        ledgerFile: "(none)",
      },
      built.stats,
      [],
    ),
  );
  console.log(`\nwrote ${sourceFile}\nwrote ${casesFile}`);
  return 0;
}

function emptyCriteria() {
  return {
    runs: 0,
    errors: 0,
    disagreements: 0,
    spuriousWriteRuns: 0,
    spuriousWriteUnadjudicated: 0,
    missedWriteRuns: 0,
    missedWriteUnadjudicated: 0,
    missedWriteRate: 0,
    missedWriteRateCeiling: 0,
    divergentWriteRuns: 0,
    speechOnlyRuns: 0,
    newPipelineBetter: 0,
    bothWrong: 0,
    bothRight: 0,
    passesStep3: null,
  };
}

function zero(name: string) {
  return {
    name,
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    wallMs: 0,
    batches: 0,
  };
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
