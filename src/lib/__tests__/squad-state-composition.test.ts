/**
 * §10 step 4 — COMPOSITION FIRST.
 *
 * "Route every squad-state reply through `composeSquadStatusPost()` on
 * the existing analyzer. Delete `enforceCanonicalRoster`,
 * `rewriteOverconfidentPromotion`, both promotion strips,
 * `enforceProximity`, the squad-status collapse."
 *
 * Every one of those was a regex applied AFTER the model wrote the wrong
 * words. These tests pin the replacement rule: a reply that shows squad
 * state, or that claims a move the database does not support, is not
 * patched — it is REPLACED by text composed from the database. What the
 * model may keep is the human half (why someone dropped, the ask, the
 * server-computed format-switch line), and only while it makes no claim
 * of its own about the squad.
 *
 * The incidents each case reproduces are named in its title. They are
 * the reason the deleted regexes existed, and the proof that deleting
 * them loses nothing.
 */
import { describe, it, expect } from "vitest";
import {
  SQUAD_POST_MARKER,
  composeSquadStatusPost,
  composeSquadStateReply,
  contradictsSquadState,
  displaysSquadState,
  stripSquadPostMarker,
  type SquadTruth,
} from "@/lib/group-copy";
// The corpus grader's own vocabulary of "a move was announced". Imported
// rather than re-written so the S7 property cannot pass here by using a
// narrower definition than the one that judges it.
import { claimedMoves } from "../../../e2e/corpus/grade";

const truth: SquadTruth = {
  confirmed: ["Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Mustafa Kaya"],
  bench: ["Greg Gale"],
  maxPlayers: 5,
  knownNames: [
    "Kemal Ediz",
    "Elvin Aliyev",
    "Sait Demir",
    "Mustafa Kaya",
    "Greg Gale",
    "Erdal Ozkan",
    "Zair Malik",
    "Wasim Akhtar",
  ],
};

const composed = composeSquadStatusPost({
  confirmed: truth.confirmed,
  bench: truth.bench,
  maxPlayers: truth.maxPlayers,
});

describe("a reply that says nothing about squad state is left alone", () => {
  it("passes an ack through byte-for-byte", () => {
    const r = composeSquadStateReply("Nice one 👍", truth);
    expect(r.composed).toBe(false);
    expect(r.text).toBe("Nice one 👍");
  });

  it("passes a stats leaderboard through (Kemal 2026-05-14: 'top 3 most consistent' came back as the squad)", () => {
    const leaderboard = "Most consistent:\n1. Kemal Ediz — 4/4 (100%)\n2. Elvin Aliyev — 3/4 (75%)";
    const r = composeSquadStateReply(leaderboard, truth);
    expect(r.composed).toBe(false);
    expect(r.text).toBe(leaderboard);
  });

  it("passes a move claim the database DOES support (no reason to overwrite the truth)", () => {
    const r = composeSquadStateReply("Kemal is in ✅", truth);
    expect(r.composed).toBe(false);
    expect(r.text).toBe("Kemal is in ✅");
  });

  it("does not read an attendance ratio in a stats answer as a squad count", () => {
    // "3/5" here is Sait's record, not the squad. Judging it as a count
    // would replace the leaderboard with a squad post — a worse version
    // of the 2026-05-14 bug the leaderboard exclusion exists for.
    const stats = "Most consistent:\n1. Kemal Ediz — 5/5 (100%)\n2. Sait Demir — 3/5 (60%)";
    expect(contradictsSquadState(stats, truth)).toBe(false);
    expect(composeSquadStateReply(stats, truth).composed).toBe(false);
  });
});

describe("a model-authored roster is replaced, never patched (Wasim's drop, ef8d801, 2026-04-26)", () => {
  // The incident: the reply reordered the roster, omitted Zair and
  // claimed 12/14 when the truth was 13/14. `enforceCanonicalRoster`
  // existed to overwrite it afterwards.
  it("drops the model's roster, count and ordering entirely", () => {
    const modelReply = [
      "Wasim's out — we're 3/5, need 2 more 🙏",
      "",
      "*Playing tonight:*",
      "1. Mustafa Kaya",
      "2. Kemal Ediz",
      "3. Sait Demir",
      "4. 🥁",
      "5. 🥁",
    ].join("\n");
    const r = composeSquadStateReply(modelReply, truth);
    expect(r.composed).toBe(true);
    // Composed from the database: everyone present, in DB order.
    expect(r.text).toBe(composed);
    expect(r.text).toContain("*4/5*");
    expect(r.text).toContain("1. Kemal Ediz");
    expect(r.text).toContain("2. Elvin Aliyev");
    expect(r.text).not.toContain("3/5");
    expect(r.text).not.toContain("*Playing tonight:*");
  });

  it("nobody in the database can be omitted from it, because the model does not write it", () => {
    const r = composeSquadStateReply("*Squad:*\n1. Kemal\n2. Elvin", truth);
    for (const name of truth.confirmed) expect(r.text).toContain(name);
    expect(r.text).toContain("*Bench (1):*");
    expect(r.text).toContain("Greg Gale");
  });
});

describe("stale counts and slot prose cannot survive (RC3 of Sutton Lads 2026-06-12)", () => {
  it("replaces '2/5 — three slots open, need 3 more' with the truth", () => {
    const r = composeSquadStateReply("We're 2/5 — three slots open, need *3 more* lads!", truth);
    expect(r.composed).toBe(true);
    expect(r.text).toContain("*4/5*");
    expect(r.text).toContain("need *1 more*");
    expect(r.text).not.toContain("2/5");
    expect(r.text).not.toMatch(/slots? open/i);
  });

  it("replaces a full-squad claim made while a slot is open", () => {
    const r = composeSquadStateReply("We're full ✅ no more spots.", truth);
    expect(r.composed).toBe(true);
    expect(r.text).toContain("need *1 more*");
  });

  it("replaces an impossible total (never '9 players' on a 5-player match)", () => {
    const r = composeSquadStateReply("We've got 9 players for Tuesday — squad looks strong.", truth);
    expect(r.composed).toBe(true);
    expect(r.text).not.toContain("9 players");
  });

  it("replaces a wrong bench claim", () => {
    const r = composeSquadStateReply("Bench is empty — nobody on standby right now.", truth);
    expect(r.composed).toBe(true);
    expect(r.text).toContain("*Bench (1):*");
    expect(r.text).not.toContain("Bench is empty");
  });
});

describe("an announced move that the database does not back is replaced (S7, Erdal, bef5252)", () => {
  // The incident: "Erdal goes on the bench. 👍" with intent question and
  // NO registerFor. The group saw the announcement; the database had no
  // row. The corpus records this as unfixed — it passes live only when
  // the model happens not to reproduce it.
  it("cannot announce a bench move that never happened", () => {
    const r = composeSquadStateReply("Erdal goes on the bench. 👍", truth);
    expect(r.composed).toBe(true);
    expect(r.text).not.toMatch(/Erdal/);
    // Judged by the corpus grader's own definition of "a move was claimed".
    expect(claimedMoves(r.text)).toEqual([]);
  });

  it("cannot announce a promotion while the player is still benched (2026-05-18, Aydın/Greg)", () => {
    const r = composeSquadStateReply("Greg Gale moves up from the bench — all sorted.", truth);
    expect(r.composed).toBe(true);
    expect(r.text).not.toMatch(/moves up/i);
    // …and the composed post shows where he actually is.
    expect(r.text).toContain("*Bench (1):*");
    expect(r.text).toContain("Greg Gale");
  });

  it("catches every move shape the corpus grader can detect", () => {
    // Each of these claims something the `truth` above contradicts, and
    // each is a shape `claimedMoves` recognises — so the corpus cannot
    // catch a lie this composer would let through.
    const claims = [
      "Erdal goes on the bench",
      "Erdal is now on the bench",
      "we're putting Erdal on the bench",
      "Zair is now confirmed",
      "I'm adding Zair for Tuesday",
      "Kemal is now out",
      "dropping Kemal as out",
      "registering Wasim for Tuesday",
    ];
    for (const claim of claims) {
      expect(claimedMoves(claim).length, `grader sees a claim in: ${claim}`).toBeGreaterThan(0);
      expect(contradictsSquadState(claim, truth), `composer sees it too: ${claim}`).toBe(true);
      expect(claimedMoves(composeSquadStateReply(claim, truth).text)).toEqual([]);
    }
  });

  it("catches shapes the grader misses — sentence-initial verbs and promotions", () => {
    // The grader's verbs are lower-case-only and its bench pattern does
    // not span "moves up FROM the bench", so these pass a corpus run
    // today while still being announcements of a move that never
    // happened. The composer must not inherit that blind spot.
    const claims = [
      "Putting Erdal on the bench",
      "Moving Erdal to the bench",
      "Dropping Kemal as out",
      "Greg Gale moves up from the bench",
      "Greg steps in for the missing player",
      "Greg is replacing him tonight",
    ];
    for (const claim of claims) {
      expect(contradictsSquadState(claim, truth), `composer sees: ${claim}`).toBe(true);
      expect(composeSquadStateReply(claim, truth).composed).toBe(true);
    }
  });

  it("ignores claims about people the group has never heard of", () => {
    // The grader only judges claims about known players; so does this,
    // or an ordinary sentence starting with a capitalised word would
    // trigger a squad post.
    expect(contradictsSquadState("Adding Tuesday to the calendar", truth)).toBe(false);
  });
});

describe("the model keeps the human half of the message, and only that", () => {
  it("keeps a claim-free lead above the composed post", () => {
    const r = composeSquadStateReply(
      `Sorry to hear that Ibrahim — can anyone step in? 🙏\n\n${SQUAD_POST_MARKER}`,
      truth,
    );
    expect(r.composed).toBe(true);
    expect(r.text).toContain("Sorry to hear that Ibrahim");
    expect(r.text).not.toContain(SQUAD_POST_MARKER);
    expect(r.text.endsWith(composed)).toBe(true);
  });

  it("keeps the server-computed format-switch line (S34: the server did the arithmetic)", () => {
    const line = "Worth switching to 5-a-side — nobody misses out.";
    const r = composeSquadStateReply(`${line}\n${SQUAD_POST_MARKER}`, truth);
    expect(r.text).toContain(line);
  });

  it("drops a lead that makes its own count claim rather than printing two counts", () => {
    const r = composeSquadStateReply(`We're 2/5 — need 3 more.\n${SQUAD_POST_MARKER}`, truth);
    expect(r.text).toBe(composed);
    expect(r.text).not.toContain("2/5");
  });

  it("drops a lead that announces an unbacked move", () => {
    const r = composeSquadStateReply(`Erdal goes on the bench.\n${SQUAD_POST_MARKER}`, truth);
    expect(r.text).toBe(composed);
  });

  it("composes on the marker even when the model wrote nothing else", () => {
    const r = composeSquadStateReply(SQUAD_POST_MARKER, truth);
    expect(r.text).toBe(composed);
  });
});

describe("the marker never reaches a group", () => {
  // The composer strips it on every path — but it only runs when there
  // IS a match to compose from. "Who's playing?" in a group with no
  // upcoming match still gets a marker out of the model.
  it("is removed from a reply the composer never saw", () => {
    expect(stripSquadPostMarker(`No match on the calendar yet.\n\n${SQUAD_POST_MARKER}`)).toBe(
      "No match on the calendar yet.",
    );
  });

  it("leaves a reply without one exactly as it was", () => {
    expect(stripSquadPostMarker("Nice one 👍")).toBe("Nice one 👍");
  });

  it("returns empty when the marker was the whole reply, so the caller can stay silent", () => {
    expect(stripSquadPostMarker(SQUAD_POST_MARKER)).toBe("");
  });
});

describe("displaysSquadState — the trigger, kept from looksLikeSquadStateReply", () => {
  it("sees a numbered roster run", () => {
    expect(displaysSquadState("1. Kemal\n2. Elvin")).toBe(true);
  });
  it("sees squad and bench headers", () => {
    expect(displaysSquadState("*Playing tonight:*")).toBe(true);
    expect(displaysSquadState("*Bench (2):*")).toBe(true);
  });
  it("sees a count claim alongside squad vocabulary", () => {
    expect(displaysSquadState("we're 12/14, need more players")).toBe(true);
  });
  it("does not see a leaderboard", () => {
    expect(displaysSquadState("1. Kemal — 4/4 (100%)\n2. Elvin — 3/4 (75%)")).toBe(false);
  });
  it("does not see an ordinary line", () => {
    expect(displaysSquadState("nice one 👍")).toBe(false);
  });
});
