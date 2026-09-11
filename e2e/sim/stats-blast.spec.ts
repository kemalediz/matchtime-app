/**
 * Group-simulator scenario matrix — THE ADMIN STATS BLAST.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE 2026-09-10 NEAR-MISS, WHICH IS THE FIRST TEST IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * At 18:38 Kemal posted an ordinary reminder to his players in the live
 * Sutton FC group:
 *
 *   "please do not forget to rate the players via the link from
 *    Matchtime DM'ed to you. the more accurate ratings, the more
 *    balanced teams next time"
 *
 * MatchTime recorded `by=fast-path intent=stats_blast
 * action=dm-stats-blast:69` and queued 69 personal stats-link DMs. One
 * was delivered before the queue was killed; 68 were deleted unsent. The
 * trigger was a conjunction of three keyword tests in `analyze/route.ts`
 * — a send word, a stats word and an everyone word — satisfied by three
 * unrelated fragments of one sentence that was addressed to the PLAYERS
 * and meant roughly the opposite of what fired.
 *
 * The blast is the most dangerous action in the product:
 * `recruit-lookback.ts` states the stake plainly — "the bot runs on an
 * UNOFFICIAL WhatsApp client; a mass DM risks the account being banned,
 * which takes the whole product down."
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT REPLACED IT, AND WHAT EACH TEST BELOW PINS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The recruit blast's shape, exactly (`recruit-request.ts`, PR #33 and
 * 2026-09-06): the extractor reports the ask as a typed FACT
 * (`AdminFacts.action = "stats_blast"`), the ENGINE decides who may fire
 * one, and the ROUTE performs it deterministically. No regex classifies
 * anything, so nothing can assemble a bot command out of scattered words.
 *
 *   incident            the sentence verbatim, and NOT ONE DM. Asserted
 *                       TWICE: once as it would really be classified
 *                       (`other`), and once with the extractor stubbed to
 *                       the WORST CASE — `stats_blast` — because the fix
 *                       must not depend on the model being right.
 *   tagged command      "@Match Time send everyone their stats" still
 *                       DMs the club. The feature is not deleted.
 *   untagged command    the same words with no @-mention: refused.
 *   non-admin           refused, and silently.
 *   personal stats      the single-recipient path above it is untouched.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

/** The exact sentence Kemal posted at 18:38 on 2026-09-10. */
const INCIDENT =
  "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
  "the more accurate ratings, the more balanced teams next time";

/** The real bulk-DM command, which must keep working. */
const COMMAND = "@Match Time send everyone their stats";

/** What the admin extractor returns for a genuine bulk-DM command. */
const STATS_BLAST = {
  route: "admin_ops",
  facts: {
    action: "stats_blast",
    payerRef: "",
    count: 0,
    coveredRefs: [],
    phrase: "",
    note: "",
    lookbackMatches: 0,
  },
};

/** What it returns for a message that instructs the PLAYERS, not the bot. */
const NOT_A_COMMAND = {
  route: "admin_ops",
  facts: {
    action: "other",
    payerRef: "",
    count: 0,
    coveredRefs: [],
    phrase: "",
    note: "",
    lookbackMatches: 0,
  },
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 8,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
  })).attach(request);

/** The stats-link DMs inside ONE request's outbound batch. The blast is
 *  the only thing in the product that sends these; an operator note (the
 *  deduped ⚠️ DM to admins when nobody owned a message) is a DM too, and
 *  is not what this file is about. */
const statsDmsIn = (dms: Array<{ phone: string | null; text: string }>) =>
  dms.filter((d) => d.text.includes("MatchTime stats"));

/** Every stats-link DM queued for this org, whoever it is addressed to. */
const statsDms = (grp: SimGroup) =>
  grp.db.all<{ phone: string | null; text: string }>(
    `SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%MatchTime stats%'`,
    [grp.orgId],
  );

test("THE INCIDENT — the 18:38 sentence queues NOT ONE DM", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", INCIDENT, NOT_A_COMMAND);
  expect(statsDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
  expect(await statsDms(grp)).toHaveLength(0);
  // What DOES happen: nobody owns the message, so it is silence in the
  // group plus one line on the deduped operator note. That is the
  // documented treatment for an `admin_ops` message with no handler, and
  // it is a DM to the ADMINS about a message, not 69 DMs to the club.
  expect(r.reply ?? "").toBe("");
});

test("THE INCIDENT, WORST CASE — refused even if the model calls it a blast", async ({
  request,
  db,
}) => {
  // The fix must not rest on the extractor being right about this
  // sentence. It contains the bare word "Matchtime", so `messageTagsBot`
  // already calls it TAGGED — the loose tag test is not a gate here.
  // What refuses it is `messageMentionsBotExplicitly`: nobody addressed
  // the bot with an @, so no mass DM may leave, whatever the model said.
  const grp = await group(request, db);
  const r = await grp.post("owner", INCIDENT, STATS_BLAST);
  expect(statsDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
  expect(await statsDms(grp)).toHaveLength(0);
  expect(r.reply ?? "").toBe("");
});

test("the real command, tagged, still DMs the club", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", COMMAND, { ...STATS_BLAST, tag: true });
  const queued = await statsDms(grp);
  expect(queued.length).toBeGreaterThan(1);
  expect(queued[0].text).toContain("MatchTime stats");
  expect(r.reply).toContain("personal stats link");
});

test("the same command UNTAGGED is refused, and silently", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await statsDms(grp)).length;
  const r = await grp.post("owner", "send everyone their stats", STATS_BLAST);
  expect((await statsDms(grp)).length).toBe(before);
  expect(r.reply ?? "").toBe("");
});

test("a non-admin's tagged command is refused", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await statsDms(grp)).length;
  const r = await grp.post("pete", `${COMMAND} please`, { ...STATS_BLAST, tag: true });
  expect((await statsDms(grp)).length).toBe(before);
  expect(r.reply ?? "").toBe("");
});

test("the PERSONAL stats request is untouched — one DM, to the asker", async ({
  request,
  db,
}) => {
  // The single-recipient path directly above the deleted blast. It is
  // anchored on a possessive ("my stats"), tag-gated, and it DMs exactly
  // one person: the sender. Low stakes, and it works.
  const grp = await group(request, db);
  const before = (await statsDms(grp)).length;
  const r = await grp.post("pete", "@Match Time my stats", { tag: true });
  expect((await statsDms(grp)).length).toBe(before + 1);
  expect(r.react).toBe("📊");
});
