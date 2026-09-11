/**
 * Group-simulator scenario matrix — THE RATING-PROGRESS ANSWER.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `looksLikeRatingProgressRequest` — (a rating word) AND (a progress
 * word), scattered anywhere in a body — in a clause-peeled fast path
 * that `analyze/route.ts` itself called "the WIDEST trigger of the six
 * peels". It is the conjunction shape that matched half a sentence on
 * 2026-09-01 and that queued 69 mass DMs on 2026-09-10, sitting in front
 * of a group post rather than a DM blast.
 *
 * It is deleted (2026-09-11). The ask is now `QuestionFacts.topic =
 * "rating_progress"` on the `question` route — where the live router
 * puts these phrasings 60 of 60 — gated in the engine on admin plus the
 * route's ordinary @Match Time tag, and answered from a targeted
 * database read.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT EACH TEST PINS
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   the ask            "@Match Time who hasn't rated yet?" is answered,
 *                      with real numbers off the last completed match.
 *   the incident       the 2026-09-10 sentence, verbatim, says nothing
 *                      when it is classified as it really is. Asserted
 *                      twice, and the SECOND assertion is the honest
 *                      one: with the extractor stubbed to the worst
 *                      case, MatchTime answers — the tag gate does not
 *                      stop this sentence, because it contains the bare
 *                      word "Matchtime". That is argued rather than
 *                      overlooked; read that test's comment.
 *   untagged           refused. A real behaviour change from the fast
 *                      path, which was not tag-gated at all.
 *   non-admin          refused, silently. The answer NAMES the players
 *                      who have not rated.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

/** The exact sentence Kemal posted at 18:38 on 2026-09-10. It satisfies
 *  BOTH halves of the deleted predicate: "rate"/"ratings" and "not". */
const INCIDENT =
  "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
  "the more accurate ratings, the more balanced teams next time";

/** The real ask, which must keep working. */
const ASK = "@Match Time who hasn't rated yet?";

/** What the question extractor returns for the genuine ask. */
const RATING_Q = {
  route: "question",
  facts: { topic: "rating_progress", personRef: "", statedCount: -1 },
};

/** What it returns for a message that instructs the PLAYERS. */
const NOT_A_QUESTION = {
  route: "question",
  facts: { topic: "other", personRef: "", statedCount: -1 },
};

/** The rating-progress ANSWER inside one request's outbound batch.
 *
 *  An operator note is a DM too — the deduped ⚠️ message to admins when
 *  nobody owned a message — and it is not what this file is about. It is
 *  the documented treatment for an unowned message and the thin
 *  difference between this and a silent shrug: a human is told, once an
 *  hour, that a message went unanswered. */
const answerDmsIn = (dms: Array<{ phone: string | null; text: string }>) =>
  dms.filter((d) => d.text.includes("rating progress"));

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
    // The answer is about the match that was PLAYED, so there has to be
    // one. Without it every assertion below would pass on "there's no
    // recent completed match to check yet", which is not the feature.
    completedMatch: { daysAgo: 2, confirmedKeys: ["owner", "alice", "pete"] },
  })).attach(request);

test("the genuine ask is answered, with real numbers", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", ASK, { ...RATING_Q, tag: true });
  expect(r.reply ?? "", JSON.stringify(r)).toContain("rating progress");
  // Nobody has rated in this world, so all three confirmed players are
  // still to rate. The numbers come from the DATABASE, never the body.
  expect(r.reply ?? "").toContain("Rated: 0/3");
  expect(answerDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
});

test("THE INCIDENT — the 18:38 sentence says nothing at all", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", INCIDENT, NOT_A_QUESTION);
  expect(r.reply ?? "").toBe("");
  expect(answerDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
});

test("THE INCIDENT, WORST CASE — the MODEL is the only thing refusing it", async ({
  request,
  db,
}) => {
  // ⚠️ THIS TEST ASSERTS THE UNCOMFORTABLE TRUTH RATHER THAN THE
  // COMFORTABLE ONE, and it is the most important comment in this file.
  //
  // The incident sentence contains the bare word "Matchtime", so
  // `messageTagsBot` — and therefore the question route's tag gate — is
  // TRUE for it. If the extractor calls it `rating_progress`, MatchTime
  // ANSWERS, in the group, naming the players who have not rated. The
  // tag is not a backstop here.
  //
  // That is a deliberate, argued position and not an oversight. The two
  // BULK-DM doors (`STATS_BLAST_TAG_MUST_BE_EXPLICIT`,
  // `RECRUIT_BLAST_REQUIRES_TAG`) demand an explicit @ because their
  // costs are wildly asymmetric: a blast that fires wrongly costs 69 DMs
  // from an unofficial WhatsApp client and possibly the account. THIS
  // path sends no DM. A wrong answer is one sentence in a group
  // MatchTime posts in several times a week, and the next message
  // corrects it. `payments`, `count`, `squad` and `fixture` all rest on
  // the model in exactly the same way, and singling this topic out would
  // be stricter than every other answer for no difference in
  // consequence. See `RATING_PROGRESS_TAG_MUST_BE_EXPLICIT`.
  //
  // So the defence here is the MODEL reading the sentence right, and
  // that is measured rather than asserted: case M3 of `scripts/dryrun-
  // pipeline.ts`, 15 live runs against the real Sutton state. Flip
  // `RATING_PROGRESS_TAG_MUST_BE_EXPLICIT` to `true` the moment this
  // topic gains a side effect, and this test flips with it.
  const grp = await group(request, db);
  const r = await grp.post("owner", INCIDENT, RATING_Q);
  expect(r.reply ?? "").toContain("rating progress");
  // And even in the worst case it stays a SENTENCE. Nobody is DM'd.
  expect(answerDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
});

test("the same ask UNTAGGED is refused", async ({ request, db }) => {
  // A REAL BEHAVIOUR CHANGE, and it is the one this file exists to
  // record: the deleted fast path was not tag-gated at all.
  const grp = await group(request, db);
  const r = await grp.post("owner", "who hasn't rated yet?", RATING_Q);
  expect(r.reply ?? "").not.toContain("rating progress");
});

test("a non-admin's tagged ask is refused, and silently", async ({ request, db }) => {
  // The answer names the players who have not rated, which is exactly
  // the case `payment-answer.ts` predicted would need an admin gate.
  const grp = await group(request, db);
  const r = await grp.post("pete", `${ASK} please`, { ...RATING_Q, tag: true });
  expect(r.reply ?? "").not.toContain("rating progress");
  expect(answerDmsIn(r.dms), JSON.stringify(r.dms)).toHaveLength(0);
});
