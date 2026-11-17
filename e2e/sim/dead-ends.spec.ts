/**
 * Group-simulator scenario: A DEAD END GOES TO THE UNIFIED ANSWER (stubbed).
 *
 * THE INCIDENT (Vets, 16 Nov 2026). The organiser tagged MatchTime with
 * something it has no action for; the admin extractor said "other" and
 * MatchTime posted "Sorry, I can't do that one yet." He deleted it, twice.
 * The other dead ends had the same shape: the not-understood line for a
 * tagged message nothing came of, and HQ's "I can't do that from this
 * group".
 *
 * Now, with UNIFIED_ANSWERS on, each tagged dead end is handed to the
 * unified answer (`dead-end-answer.ts`), told NOT DONE and shown the
 * group's help menu: it answers what was asked, says what MatchTime can do
 * instead, or asks one short question. The canned line is only the fallback
 * when that answer fails. Untagged messages stay silent; handled actions are
 * untouched.
 *
 * The router, every extractor and the unified answer are STUBBED (no model
 * call, $0). The people are made up; their numbers are in Ofcom's drama
 * range, 07700 900xxx.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup, type SimPlayerSpec } from "./group";
import { clearExtractorStub, clearRouterStub, setExtractorStub, setRouterStub } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const UNIFIED = { "x-mt-test-unified-answers": "1" };
const UNIFIED_OFF = { "x-mt-test-unified-answers": "0" };

let phoneSeq = 0;
const drama = () => `+447700900${String(400 + phoneSeq++).padStart(3, "0")}`;

// Made-up members: Ava runs the club; the rest play.
const ROSTER = (): SimPlayerSpec[] =>
  [
    { key: "ava", name: "Ava Organiser", role: "OWNER" as const },
    { key: "noor", name: "Noor Nash" },
    { key: "olly", name: "Olly Oak" },
    { key: "pip", name: "Pip Pine" },
  ].map((p) => ({ ...p, phone: drama() }));

const BOOK = "@Match Time book the pitch for Friday";
const VAGUE = "@Match Time do the thing";
const BOOK_ANSWER = "I can't book pitches. I can tell you the squad, the teams or the results: tag me and ask.";
const VAGUE_ANSWER = "What would you like me to do?";
const OTHER = { action: "other", payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, clubRef: "", toMatchTime: true };

/** Router, extractors and the unified answer, by body. `failAnswer`: the
 *  unified answer's call fails for these bodies, like an overloaded API. */
function arm(opts: { routes: Record<string, string>; admin?: Record<string, Record<string, unknown>>; answers?: Record<string, string>; failAnswer?: string[] }) {
  setRouterStub({ floor: false, bodies: opts.routes });
  setExtractorStub({
    byExtractor: {
      admin: opts.admin ?? {},
      "unified-answer": Object.fromEntries(Object.entries(opts.answers ?? {}).map(([b, a]) => [b, { answer: a }])),
    },
    ...(opts.failAnswer ? { failByExtractor: { "unified-answer": opts.failAnswer } } : {}),
  });
}

/** The stubbed model calls so far: label and the user turn. */
function turns(): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}
const calls = (): string[] => turns().map((c) => c.label);

async function club(request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1]): Promise<SimGroup> {
  return createGroup(request, db, {
    players: ROSTER(),
    maxPlayers: 10,
    attendance: [{ key: "ava", status: "CONFIRMED" as const }, { key: "noor", status: "CONFIRMED" as const }],
    upcomingMatch: { hoursFromNow: 48 },
  });
}

(LIVE ? test.describe.skip : test.describe)("a tagged dead end gets the unified answer, not a canned line (2026-11-17)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("a tagged admin request MatchTime has no action for: the unified answer", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    arm({ routes: { [BOOK]: "admin_ops" }, admin: { [BOOK]: OTHER }, answers: { [BOOK]: BOOK_ANSWER } });

    const res = await grp.postBatch([{ player: "noor", body: BOOK, tag: true }], { headers: UNIFIED });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].reply).toBe(BOOK_ANSWER);
    expect(res.results[0].intent).toBe("unified_answer");
    expect(res.results[0].reply).not.toMatch(/can't do that one yet/);
    expect(res.groupPosts).toEqual([]);
    expect(res.dms).toEqual([]);
    // The context it was given said nothing was done, and what MatchTime can do.
    const turn = turns().filter((c) => c.label === "unified-answer").pop()!.user;
    expect(turn).toContain("NOT DONE:");
    expect(turn).toContain("WHAT MATCHTIME CAN DO");
    expect(turn.trimEnd().endsWith(BOOK)).toBe(true);
  });

  test("a tagged message MatchTime could not make anything of: the unified answer, not 'I didn't catch'", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    arm({ routes: { [VAGUE]: "unsure" }, answers: { [VAGUE]: VAGUE_ANSWER } });

    const res = await grp.postBatch([{ player: "olly", body: VAGUE, tag: true }], { headers: UNIFIED });

    expect(res.results[0].reply).toBe(VAGUE_ANSWER);
    expect(res.results[0].intent).toBe("unified_answer");
    expect(res.groupPosts).toEqual([]);
  });

  test("the unified answer fails: the canned line, as before", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    arm({ routes: { [BOOK]: "admin_ops", [VAGUE]: "unsure" }, admin: { [BOOK]: OTHER }, failAnswer: [BOOK, VAGUE] });

    const res = await grp.postBatch(
      [
        { player: "noor", body: BOOK, tag: true },
        { player: "olly", body: VAGUE, tag: true },
      ],
      { headers: UNIFIED },
    );

    expect(res.results[0].reply).toBe("Sorry, I can't do that one yet.");
    expect(res.results[1].reply).toBe("I didn't catch what you'd like me to do. Type *@Match Time help* to see what I can do.");
    expect(res.results[1].intent).toBe("not_understood");
  });

  test("untagged: silent, and the unified answer is never asked", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    const body = "book the pitch for Friday";
    arm({ routes: { [body]: "admin_ops" }, admin: { [body]: OTHER }, answers: { [body]: BOOK_ANSWER } });
    const before = calls().filter((l) => l === "unified-answer").length;

    const res = await grp.postBatch([{ player: "noor", body, tag: false }], { headers: UNIFIED });

    expect(res.results[0].reply ?? null).toBeNull();
    expect(res.groupPosts).toEqual([]);
    expect(calls().filter((l) => l === "unified-answer").length).toBe(before);
  });

  test("a handled action is unchanged: a tagged IN is registered, and no unified answer is asked", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    const body = "@Match Time IN";
    setRouterStub({ floor: false, bodies: { [body]: "self_att" } });
    setExtractorStub({
      bodies: {
        [body]: {
          claims: [{ subject: "self", personRef: "", personNamed: false, polarity: "in", tense: "present", contingent: false, conditionOn: "none", confidence: 0.95, replaces: "" }],
          affirmation: "none",
          sideRequests: [],
        },
      },
    });
    const before = calls().filter((l) => l === "unified-answer").length;

    const res = await grp.postBatch([{ player: "pip", body, tag: true }], { headers: UNIFIED });

    expect(res.results[0].intent).toBe("in");
    const row = await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [grp.matchId!, grp.player("pip").userId]);
    expect(row?.status).toBe("CONFIRMED");
    expect(calls().filter((l) => l === "unified-answer").length).toBe(before);
  });

  test("with UNIFIED_ANSWERS off nothing changes: the canned line", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    arm({ routes: { [BOOK]: "admin_ops" }, admin: { [BOOK]: OTHER }, answers: { [BOOK]: BOOK_ANSWER } });

    const res = await grp.postBatch([{ player: "noor", body: BOOK, tag: true }], { headers: UNIFIED_OFF });

    expect(res.results[0].reply).toBe("Sorry, I can't do that one yet.");
  });

  test("HQ: a tagged admin request with no action gets the unified answer; failing, the one line", async ({ request, db }) => {
    const grp = (await club(request, db)).attach(request);
    const hq = `120363777${String(Date.now()).slice(-6)}@g.us`;
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [grp.orgId, hq]);
    const ava = grp.player("ava").phone!.replace(/^\+/, "");
    let seq = 0;
    const say = async (text: string) => {
      const res = await request.post("/api/whatsapp/admin-group", {
        headers: { "x-api-key": E2E.WHATSAPP_API_KEY, ...UNIFIED },
        data: { channel: "admin-group", botMentioned: true, groupId: hq, messageId: `sim-dead-end-hq-${Date.now()}-${++seq}`, text, senderPhone: ava, timestamp: String(Math.floor(Date.now() / 1000)) },
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };

    arm({ routes: { [BOOK]: "admin_ops" }, admin: { [BOOK]: OTHER }, answers: { [BOOK]: BOOK_ANSWER } });
    expect(await say(BOOK)).toMatchObject({ handled: true, outcome: "hq-dead-end-answered", replyText: BOOK_ANSWER });

    arm({ routes: { [BOOK]: "admin_ops" }, admin: { [BOOK]: OTHER }, failAnswer: [BOOK] });
    expect(await say(BOOK)).toMatchObject({ handled: true, outcome: "hq-not-here", replyText: "I can't do that from this group." });
  });
});
