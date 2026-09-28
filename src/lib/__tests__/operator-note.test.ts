/**
 * §10 STEP 8 — WHAT REPLACES "FALL BACK TO THE ANALYZER".
 *
 * Every owner in the pipeline used to end its failure table with the
 * same line: "→ the analyzer decides this message". Step 8 deletes the
 * analyzer, so every one of those arrows points at nothing, and the
 * question this module answers is what a message nobody owns is now
 * worth telling a human about.
 *
 * The answer has to thread between two failures that are BOTH real:
 *
 *   • §9 names "message understood, action silently not taken" this
 *     product's SIGNATURE failure. Silence with no signal is how Baki's
 *     drop went unnoticed for thirteen days.
 *   • An admin DM for every message nobody owned would fire on the 69.3%
 *     of real traffic that is banter (measured over 1,723 production
 *     messages, PR #35). A nagging operator surface is an ignored one,
 *     which is the same silence with extra steps.
 *
 * So the rule is a ROUTE test and never a content test: a message the
 * router called `none` is banter and is never noted; a message it routed
 * to something actionable and nobody then acted on IS noted. That keeps
 * this module on the right side of the line `gate.ts` draws between a
 * classifier and a seatbelt — it reads a route, not a sentence.
 */
import { describe, expect, it } from "vitest";
import {
  composeOperatorNote,
  OPERATOR_NOTE_MARKER,
  type OwnedMessage,
  type UnownedMessage,
} from "../operator-note";

function m(over: Partial<UnownedMessage> = {}): UnownedMessage {
  return {
    waMessageId: "wa-1",
    body: "in",
    authorName: "Pete Power",
    route: "self_att",
    ...over,
  };
}

describe("what gets an operator note", () => {
  it("says nothing at all when every message was owned", () => {
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: [], degradations: [] });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("never notes a `none` route — that is banter, and step 5's whole saving", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [
        m({ waMessageId: "a", route: "none", body: "😂😂😂" }),
        m({ waMessageId: "b", route: "none", body: "anyone watching the derby" }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("notes an actionable route nobody owned", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "question", body: "@Match Time who's been most consistent?" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["a"]);
    expect(note.text).toContain("Sutton FC");
    expect(note.text).toContain("most consistent");
    expect(note.text).toContain("Pete Power");
  });

  it("notes every actionable route, `unsure` included", () => {
    // `unsure` reaching here at all means the attendance engine did not
    // own it — the org has attendance off, there is no match, or the
    // extractor failed. All three are worth a human seeing, because
    // `unsure` is attendance-SHAPED by the router's own definition.
    const routes = [
      "self_att",
      "other_att",
      "offer",
      "question",
      "balancer",
      "score",
      "admin_ops",
      "unsure",
    ] as const;
    for (const route of routes) {
      const note = composeOperatorNote({
        orgName: "Sutton FC",
        messages: [m({ route })],
        degradations: [],
      });
      expect(note.noteIds, `route ${route} was not noted`).toEqual(["wa-1"]);
    }
  });

  it("notes an id with NO route at all — that is §3.2 S1's coverage hole", () => {
    // The 2026-05-25 Ibrahim + Baki incident: two clear drop messages
    // omitted from the verdicts array entirely, and the bot silently
    // no-op'd both. A missing route must never read as a decision.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: undefined })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["a"]);
    expect(note.text).toContain("no route");
  });

  it("mixes: notes only the actionable ones out of a mostly-banter batch", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [
        m({ waMessageId: "a", route: "none", body: "😂" }),
        m({ waMessageId: "b", route: "other_att", body: "@Match Time drop Erdal" }),
        m({ waMessageId: "c", route: "none", body: "https://youtu.be/x" }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["b"]);
  });
});

describe("what the note says", () => {
  it("carries the operator reason when a runner explained itself", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "balancer", body: "@Match Time rename the teams" })],
      degradations: [
        'answer-batch: degraded — a: team action "rename" still belongs to the balancer',
      ],
    });
    expect(note.text).toContain("rename");
  });

  it("reads in house style on the owner's health page: no em or en dashes, even from a runner's reason", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "balancer", body: "@Match Time rename the teams" })],
      degradations: [
        'answer-batch: degraded — a: team action "rename" — still belongs to the balancer',
      ],
    });
    expect(note.text).not.toMatch(/[—–]/);
    expect(note.text).toContain("still belongs to the balancer");
  });

  it("truncates a long body rather than pasting an essay into a DM", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "question", body: "x".repeat(400) })],
      degradations: [],
    });
    expect(note.text!.length).toBeLessThan(1200);
    expect(note.text).toContain("…");
  });

  it("names the club, so an admin of two orgs knows which group to look at", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m()],
      degradations: [],
    });
    expect(note.text).toContain("Sutton FC");
  });

  it("always contains the marker the 1-hour dedupe query searches for", () => {
    // The coupling made explicit. `route.ts` suppresses a repeat by
    // `BotJob.text contains OPERATOR_NOTE_MARKER`; if the copy is
    // reworded without the constant, one DM per hour silently becomes
    // one DM per batch, which is how an operator surface becomes noise.
    for (const n of [1, 2, 9]) {
      const note = composeOperatorNote({
        orgName: "Sutton FC",
        messages: Array.from({ length: n }, (_, i) => m({ waMessageId: `wa-${i}` })),
        degradations: [],
      });
      expect(note.text).toContain(OPERATOR_NOTE_MARKER);
    }
  });

  it("says plainly that MatchTime did not reply, which is the whole point of sending it", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m()],
      degradations: [],
    });
    expect(note.text!.toLowerCase()).toContain("didn't respond");
  });

  it("agrees singular and plural", () => {
    const one = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    expect(one.text).toContain("1 message");
    const two = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" }), m({ waMessageId: "b" })],
      degradations: [],
    });
    expect(two.text).toContain("2 messages");
  });

  it("caps how many messages it lists, so a broken batch cannot send a wall of text", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      m({ waMessageId: `wa-${i}`, body: `message number ${i}` }),
    );
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: many, degradations: [] });
    // Every id is still REPORTED (the caller records them); only the DM
    // text is capped.
    expect(note.noteIds).toHaveLength(40);
    expect(note.text).toContain("40 messages");
    expect(note.text).toContain("more");
    expect(note.text!.length).toBeLessThan(2000);
  });
});

describe("the dedupe key", () => {
  it("is stable for the same batch and different for a different one", () => {
    const a = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    const again = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    const other = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "b" })],
      degradations: [],
    });
    expect(a.dedupeKey).toBe(again.dedupeKey);
    expect(a.dedupeKey).not.toBe(other.dedupeKey);
  });

  it("is null when there is nothing to send", () => {
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: [], degradations: [] });
    expect(note.dedupeKey).toBeNull();
  });
});

describe("a feature the club switched OFF is not an incident", () => {
  // ── FOUND BY REVIEWING THIS FILE'S OWN HEADER, 2026-09-06 ─────────
  //
  // The header claimed: "A message the ORG's features exclude —
  // attendance off, team balancing off, reminders off … The caller
  // filters these out before composing." The caller did no such thing.
  //
  // `route.ts`'s unowned branch had no feature test at all, and
  // `attendance-engine-batch.ts` returns `empty()` — i.e. UNOWNED —
  // when `features.attendance` is false. So a MoM-and-ratings-only org
  // with `statsQa` on (which keeps `needsAnalyzer` true, so the pipeline
  // still runs) would page its admin about every "in" and every "can't
  // make it" in the group. That is the precise nagging this module's
  // route test exists to prevent, arriving through a different door.
  //
  // `teamBalancing` was already fine, and stays fine for a different
  // reason: `team-ops-engine-batch.ts` OWNS the message and emits a
  // `noise` outcome rather than disowning it, so it never reaches here.
  // The rule below is therefore about the routes that genuinely disown.
  //
  // The filtering went INTO this module rather than into the caller, so
  // the header is now true by construction instead of by promise.
  const ATT = ["self_att", "other_att", "offer", "unsure"] as const;

  it.each(ATT)("does not note a %s message when the org has attendance OFF", (route) => {
    const note = composeOperatorNote({
      orgName: "Sutton Lads",
      messages: [m({ route })],
      degradations: [],
      features: { attendance: false },
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it.each(ATT)("DOES note a %s message when attendance is ON", (route) => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ route })],
      degradations: [],
      features: { attendance: true },
    });
    expect(note.noteIds).toEqual(["wa-1"]);
  });

  it("still notes a NON-attendance route when attendance is off", () => {
    // The org turned attendance off. It did not turn questions off, and
    // a tagged question nobody answered is still worth a human seeing.
    const note = composeOperatorNote({
      orgName: "Sutton Lads",
      messages: [m({ waMessageId: "q", route: "question" })],
      degradations: [],
      features: { attendance: false },
    });
    expect(note.noteIds).toEqual(["q"]);
  });

  it("notes everything when the caller passes no features at all", () => {
    // Absent features must mean "no suppression", never "suppress
    // everything". A caller that forgets to pass them gets a noisier
    // note, which is recoverable; the other direction is silence.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ route: "self_att" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["wa-1"]);
  });

  it("mixes correctly: suppresses the attendance one, keeps the question", () => {
    const note = composeOperatorNote({
      orgName: "Sutton Lads",
      messages: [
        m({ waMessageId: "a", route: "self_att" }),
        m({ waMessageId: "b", route: "question" }),
        m({ waMessageId: "c", route: "none" }),
      ],
      degradations: [],
      features: { attendance: false },
    });
    expect(note.noteIds).toEqual(["b"]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────
 * OWNED, AND STILL SILENT — 2026-09-09
 * ─────────────────────────────────────────────────────────────────────
 *
 * THE INCIDENT, verbatim from `AnalyzedMessage`:
 *
 *   18:47  Abid Kazmi    "In"  self_att  action=none
 *          "attendance-engine (self_att): short confirmation with no
 *           pending set in the bot's last post"
 *   18:57  Mojib Jalali  "In"  self_att  action=none
 *          (same reason)
 *
 * Two resolved members typed "In" for Tuesday's match. The attendance
 * engine CLAIMED both messages, wrote nothing, said nothing, and neither
 * player was registered. Kemal spotted it in the group. Nothing told
 * him, and the reason is structural: `route.ts`'s operator note takes
 * "messages nobody owned" as its input, and a message an owner claimed
 * and then did nothing with is not in that set. The note was answering
 * "did anything CLAIM this?" when the question that matters is "did
 * anything HAPPEN?".
 *
 * ── THE PREDICATE IS STRUCTURAL, NOT A LIST OF REASON STRINGS ────────
 *
 * Every no-op below carries a reason string, and matching on those is
 * how this codebase has been burned twice (`recruit-request.ts` records
 * both deletions). A hand-maintained deny-list of prose drifts the
 * moment somebody adds a rule — which is precisely the failure this is
 * meant to catch. So the test is over typed facts the engine already
 * produces: the route, the disposition, whether anything was said, and
 * how many facts the extractor came away with.
 *
 * THE WHOLE PRODUCTION TABLE (45 engine-visible messages, 30 no-ops)
 * with this predicate's verdict on each row:
 *
 *   22x  no owner: route=none                            SILENT (banter)
 *    3x  requires an @Match Time tag                     SILENT (other_att)
 *    2x  short confirmation with no pending set          NOTED  ← the defect
 *    1x  no change for Mojib                             SILENT (a claim resolved)
 *    1x  contingent drop for X: holding, no write        SILENT (a claim resolved)
 *    1x  claim about "Najib" below the confidence floor  SILENT (other_att)
 *
 * Each row is a test below, in both directions.
 */
describe("a message an owner CLAIMED and then did nothing with", () => {
  function o(over: Partial<OwnedMessage> = {}): OwnedMessage {
    return {
      waMessageId: "wa-owned",
      body: "In",
      authorName: "Mojib Jalali",
      route: "self_att",
      disposition: "noop",
      spoke: false,
      senderResolved: true,
      claimCount: 0,
      sideRequestCount: 0,
      ...over,
    };
  }

  it("THE INCIDENT: a resolved member's `In` on self_att that wrote nothing and said nothing is noted", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [
        o({ waMessageId: "abid", authorName: "Abid Kazmi" }),
        o({ waMessageId: "mojib", authorName: "Mojib Jalali" }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["abid", "mojib"]);
    expect(note.text).toContain("Abid Kazmi");
    expect(note.text).toContain("Mojib Jalali");
    expect(note.text).toContain("In");
    expect(note.text).toContain(OPERATOR_NOTE_MARKER);
  });

  it("prints the owner's own reason line on the bullet", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [
        o({
          why: "attendance-engine (self_att): short confirmation with no pending set in the bot's last post",
        }),
      ],
      degradations: [],
    });
    expect(note.text).toContain("short confirmation with no pending set");
  });

  it("DECIDES on the typed facts even when the reason line says something reassuring", () => {
    // The point of the whole exercise: `why` is display, never a test.
    // A reason string that reads like a deliberate decision must not buy
    // silence, and one that reads like a failure must not buy a page.
    const noted = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ why: "attendance-engine (self_att): everything is completely fine" })],
      degradations: [],
    });
    expect(noted.noteIds).toEqual(["wa-owned"]);

    const silent = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [
        o({ claimCount: 1, why: "attendance-engine (self_att): CATASTROPHIC FAILURE, dropped" }),
      ],
      degradations: [],
    });
    expect(silent.noteIds).toEqual([]);
  });

  it("falls back to a plain sentence when the owner reported no reason", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ why: null })],
      degradations: [],
    });
    expect(note.text).toContain("recorded nothing");
  });

  it("carries the engine's own reason when one was reported for the id", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "abid" })],
      degradations: [
        "attendance-engine: abid — short confirmation with no pending set in the bot's last post",
      ],
    });
    expect(note.text).toContain("short confirmation with no pending set");
  });

  // ── ROW: the engine acted. Never noted. ────────────────────────────
  it("stays silent when the engine ACTED (the 8 `no rule fired` → IN rows)", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ disposition: "acted", spoke: true, claimCount: 1 })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("stays silent when the engine wrote nothing but SPOKE (an ack is not silence)", () => {
    // "Confirmed" against a pending set everybody had already answered:
    // zero writes, but `pending_confirmed_ack` answers the player. The
    // player was told; there is nothing for an admin to chase.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ spoke: true })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  // ── ROW: `no change for Mojib` — idempotent. Never noted. ──────────
  it('stays silent on an idempotent no-op ("Il go bench" from a player already on the bench)', () => {
    // The engine RESOLVED a claim to a real person and found the world
    // already matched. That is a decision with a reason and it has an
    // `AnalyzedMessage` row; paging on it pages the system working.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "bench", body: "Il go bench", claimCount: 1 })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  // ── ROW: contingent drop, holding. Never noted. ────────────────────
  it('stays silent on a deliberate hold ("If its going to be 9 I will drop out")', () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [
        o({
          waMessageId: "abid-cond",
          authorName: "Abid Kazmi",
          body: "If its going to be 9 I will drop out",
          claimCount: 1,
        }),
      ],
      degradations: [
        "attendance-engine: abid-cond — contingent drop for Abid Kazmi: holding, no write",
      ],
    });
    expect(note.noteIds).toEqual([]);
  });

  // ── ROW: the interaction contract. Never noted. ────────────────────
  it.each([
    ["Najib can drop out", "Wasimp"],
    ["David is OUT voluntarily to switch to 5aide.", "Kemal Ediz"],
    ["@DÇ  is out due to unforeseen issue at work", "Kemal Ediz"],
  ])("stays silent when the interaction contract refused it (%s)", (body, who) => {
    // All three production rows are `other_att`: a sender's OWN
    // attendance never needs a tag (`claimNeedsTag` returns false for
    // `subject === "sender"`), so this refusal cannot reach a self
    // route. The contract working is not an incident.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ route: "other_att", body, authorName: who, claimCount: 1 })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  // ── ROW: the confidence floor. Never noted. See the report. ────────
  it('stays silent on the confidence floor ("@Wasim can Najib come please?")', () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [
        o({
          waMessageId: "najib",
          route: "other_att",
          body: "@Wasim can Najib come please?",
          authorName: "Kemal Ediz",
          claimCount: 1,
        }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  it("stays silent on a below-floor claim about the SENDER too — the engine understood, it just did not trust it", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ body: "maybe in?", claimCount: 1 })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  // ── ROW: banter the router sent to an attendance route. Silent. ────
  it("stays silent on `other_att` and `unsure` with nothing extracted", () => {
    // `unsure` MEANS "attendance-shaped but I cannot tell", so an empty
    // extraction is that route's expected outcome, not a defect. Paging
    // there pages the router's uncertainty on every near-miss.
    for (const route of ["other_att", "unsure"] as const) {
      const note = composeOperatorNote({
        orgName: "Sutton FC",
        messages: [],
        owned: [o({ route })],
        degradations: [],
      });
      expect(note.noteIds, `route ${route}`).toEqual([]);
    }
  });

  it("DOES note an `offer` that came away with nothing — it asserts a commitment was made", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "off", route: "offer" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["off"]);
  });

  // ── A side request IS something extracted. Silent. ─────────────────
  it('stays silent on a chase nudge ("@all we need more players pls")', () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ body: "@all we need more players pls", claimCount: 0, sideRequestCount: 1 })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  it("stays silent when the sender never resolved to a member", () => {
    // An unresolved sender is a different failure with a different
    // remedy (link the pushname to a player), and the admin console's
    // unresolved queue already lists them. Own less.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ senderResolved: false })],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
  });

  it("notes a DEGRADED owner that came away with nothing and said nothing", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "deg", disposition: "degraded" })],
      degradations: ["attendance-engine: deg — extractor returned no facts twice"],
    });
    expect(note.noteIds).toEqual(["deg"]);
  });

  it("obeys the same attendance-OFF suppression the unowned list obeys", () => {
    const note = composeOperatorNote({
      orgName: "Sutton Lads",
      messages: [],
      owned: [o()],
      degradations: [],
      features: { attendance: false },
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("merges with the unowned list into ONE note, unowned first", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [
        m({ waMessageId: "unowned-q", route: "question", body: "@Match Time who is in?" }),
        m({ waMessageId: "banter", route: "none", body: "😂" }),
      ],
      owned: [o({ waMessageId: "mojib" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["unowned-q", "mojib"]);
    expect(note.text).toContain("2 messages");
  });

  it("leaves the unowned path exactly as it was when no owned list is passed", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "self_att" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["a"]);
  });

  it("keeps the dedupe key sensitive to the owned ids too", () => {
    const withOwned = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "x" })],
      degradations: [],
    });
    const other = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [],
      owned: [o({ waMessageId: "y" })],
      degradations: [],
    });
    expect(withOwned.dedupeKey).not.toBe(other.dedupeKey);
    expect(withOwned.dedupeKey).not.toBeNull();
  });
});
