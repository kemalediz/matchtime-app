/**
 * Group-simulator scenario matrix — Q&A + privacy.
 *
 * - "who's on the bench?" → whatever the LLM claimed, the server rewrites
 *   the bench section from the database (bench always shown, correctly).
 * - Leaderboard/standings replies are NOT squad-state — they pass through
 *   the collapse/canonicalisation machinery untouched.
 * - DM Q&A (scoped, no-leak): the context the model sees NEVER contains a
 *   raw phone number; the 📵 "no number on record" flags appear ONLY for
 *   admins (so "who's missing a number?" is admin-only in DMs). Asserted
 *   structurally via the test-only stub in dm-qa.ts, which returns the
 *   scoped context itself instead of calling Anthropic.
 * - Group → DM ("dm me …") answers privately with 📩.
 * - "my stats" fast-path DMs a personal magic link with 📊.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// Every sim phone starts with this — if these digits show up in any DM
// answer/context, a number leaked.
const PHONE_MARKER = "4477009";

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 14,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
      { key: "pete", status: "CONFIRMED" },
      { key: "dan", status: "CONFIRMED" },
      { key: "gary", status: "CONFIRMED" }, // no phone on record
      { key: "larry", status: "CONFIRMED" }, // @lid, no phone on record
      { key: "greg", status: "BENCH" },
    ],
  })).attach(request);

test('"who\'s on the bench?" → bench section rewritten from the DB, never the LLM\'s claim', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("alice", "who's on the bench?", {
    verdict: {
      intent: "question",
      reply: "Bench is empty — nobody on standby.",
      react: null,
      confidence: 0.95,
      reasoning: "stub: wrong bench claim",
    },
  });
  expect(r.reply).toContain("*Bench (1):*");
  expect(r.reply).toContain("Greg Gale");
  expect(r.reply).not.toContain("Bench is empty");
});

test("leaderboard replies pass through verbatim — never collapsed or canonicalised", async ({ request, db }) => {
  const grp = await group(request, db);
  const leaderboard =
    "🏆 Season leaderboard:\n1. Pete Power — 8.4 avg\n2. Dan Drummer — 8.1 avg\n3. Alice Admin — 7.9 avg";
  const batch = await grp.postBatch([
    { player: "felix", body: "in" }, // state changes in the same batch
    {
      player: "owner",
      body: "who's top of the standings?",
      verdict: { intent: "question", reply: leaderboard, react: null, confidence: 0.95, reasoning: "stub" },
    },
  ]);
  expect(batch.results[1].reply).toBe(leaderboard);
});

test('DM "what\'s X\'s number?" — context physically contains NO phone digits and no 📵 flags for a non-admin', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "what's Gary's phone number?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  expect(answer!.text).toContain("Confirmed players:");
  // The no-leak guarantee, structurally: nothing to extract.
  expect(answer!.text).not.toContain(PHONE_MARKER);
  expect(answer!.text).not.toContain("📵");
});

test('DM "who\'s missing a number?" — 📵 flags present for an ADMIN, still zero raw digits', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("alice", "who's missing a number on record?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  // Exactly the phone-less squad members are flagged.
  expect(answer!.text).toMatch(/Gary Guest 📵 no number on record/);
  expect(answer!.text).toMatch(/Larry Lid 📵 no number on record/);
  expect(answer!.text).not.toMatch(/Pete Power 📵/);
  expect(answer!.text).not.toContain(PHONE_MARKER);
});

test('group "dm me …" → answered PRIVATELY via scoped Q&A, 📩 react, no group reply', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("dan", "@MatchTime dm me when's the next game?");
  expect(r.handledBy).toBe("fast-path");
  expect(r.react).toBe("📩");
  expect(r.reply).toBeNull();
  const danPhone = grp.player("dan").phone!.replace(/^\+/, "");
  const dm = r.dms.find((d) => d.phone === danPhone);
  expect(dm).toBeTruthy();
  expect(dm!.text).toContain("UPCOMING MATCH:");
  expect(dm!.text).not.toContain(PHONE_MARKER); // group→DM context is flag-free too
});

test('"my stats" fast-path → 📊 react + personal magic-link DM, no LLM involved', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", "can I see my stats?");
  expect(r.handledBy).toBe("fast-path");
  expect(r.intent).toBe("stats_link");
  expect(r.react).toBe("📊");
  const petePhone = grp.player("pete").phone!.replace(/^\+/, "");
  const dm = r.dms.find((d) => d.phone === petePhone);
  expect(dm).toBeTruthy();
  expect(dm!.text).toContain("stats");
  expect(dm!.text).toMatch(/https?:\/\//);
});
