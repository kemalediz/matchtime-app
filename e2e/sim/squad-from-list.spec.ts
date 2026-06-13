/**
 * Group-simulator scenario matrix — SQUAD-FROM-LIST orgs.
 *
 * Paste-list groups (Amir's-Thursday shape: MoM/ratings only, attendance
 * off) never say IN/OUT — the squad is read from pasted numbered lists.
 *
 * 1. The analyze route must ARCHIVE every inbound message for such orgs
 *    (idempotently) without running the per-batch analyzer.
 * 2. The post-extraction chain (diff attribution → alias learning →
 *    finaliseSquadForMatch) is deterministic: exercised under tsx with
 *    hand-built ParsedLists, covering dedup reuse vs ambiguous→new.
 *    (The LLM extraction call itself is the one non-deterministic link
 *    and stays uncovered by design.)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    features: {
      attendance: false,
      bench: false,
      teamBalancing: false,
      reminders: false,
      statsQa: false,
      momVoting: true,
      playerRating: true,
      squadFromList: true,
    },
  })).attach(request);

const PASTE = "Thursday footy:\n1. Pete\n2. Dan\n3. Felix\n\nReserves:\n1. Greg";

test("squad-from-list org: pasted lists are archived, analyzer stays out of the loop", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", PASTE);
  // No message-driven feature on → no analyzer verdicts, no bot reaction.
  expect((r.raw as { ignored?: string }).ignored).toBe("no-message-driven-features");
  // …but the message IS archived for the extraction cron.
  const rows = await grp.db.all<{ body: string; senderPushname: string | null }>(
    `SELECT body, "senderPushname" FROM "GroupMessage" WHERE "orgId" = $1`,
    [grp.orgId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].body).toBe(PASTE);
  expect(rows[0].senderPushname).toBe("Pete Power");
});

test("attendance verdicts can never register players when attendance is OFF (stats-Q&A still on)", async ({ request, db }) => {
  // Sutton-Lads shape: statsQa keeps the analyzer running, but the org
  // doesn't track the squad — an IN/OUT verdict must be dropped silently
  // (the "0/14 — need 14 players" regression, 2026-06-08).
  const grp2 = await createGroup(request, db, {
    features: { attendance: false, bench: false, squadFromList: true },
  });
  const r = await grp2.post("dan", "in", {
    verdict: { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "stub" },
  });
  expect(r.handledBy).toBe("ignored");
  expect(r.react).toBeNull();
  expect(r.reply).toBeNull();
  expect(
    await grp2.db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [grp2.matchId]),
  ).toBe(0);
});

test("paste → squad built: diff attribution, alias learning, dedup reuse vs ambiguous→new (tsx)", async () => {
  test.setTimeout(120_000);
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["tsx", "e2e/sim/squad-from-list-lib.ts"],
    { cwd: REPO_ROOT, env: process.env, timeout: 110_000 },
  ).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`squad-from-list lib-tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  console.log(stdout);
  expect(stdout, stderr).toContain("OK");
});
