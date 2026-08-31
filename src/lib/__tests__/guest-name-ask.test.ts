/**
 * Unit tests for the UNNAMED-GUEST NAME ASK (src/lib/guest-name-ask.ts).
 *
 * Pure logic — no DB, no LLM, no network.
 *
 * WHY THIS EXISTS (production, 2026-08-31)
 * ----------------------------------------
 * Amir posted "@Kemal Ediz my brother can play if needed" in the club
 * group. PR #26 stopped MatchTime registering AMIR for that message —
 * correct — but the result was total silence, so the owner had to type
 * "yes pls, can you share the name?" himself before the guest could be
 * added. He asked for MatchTime to do the asking.
 *
 * The three pure pieces under test:
 *
 *  1. isPlaceholderGuestName  — "my brother" / "Amir's brother" /
 *     "someone" are NOT names. The analyzer has been observed emitting
 *     registerFor:[{name:"Amir's brother"}] six times out of six
 *     (MDs/analyzer-redesign-2026-08-31.md §4.1), which provisions a
 *     ghost User literally called "Amir's brother" into a paid squad.
 *  2. looksLikeUnnamedGuestOffer — a deterministic corroboration that
 *     the message really IS an offer, so a misclassification cannot
 *     make MatchTime pipe up on banter that merely mentions a mate.
 *  3. shouldAskForGuestName — the gate. READ-ONLY by construction: the
 *     ask can never carry an attendance write, and it fires at most
 *     once per player per match.
 */
import { describe, it, expect } from "vitest";
import {
  isPlaceholderGuestName,
  looksLikeUnnamedGuestOffer,
  isVagueGuestOfferVerdict,
  stripPlaceholderGuests,
  shouldAskForGuestName,
  renderGuestNameAsk,
  type GuestAskInput,
  type GuestOfferVerdict,
} from "@/lib/guest-name-ask";

// ── 1. isPlaceholderGuestName ──────────────────────────────────────────

describe("isPlaceholderGuestName — a relationship is not a name", () => {
  it("flags the exact strings the model has been seen emitting", () => {
    expect(isPlaceholderGuestName("my brother")).toBe(true);
    expect(isPlaceholderGuestName("Amir's brother")).toBe(true);
    expect(isPlaceholderGuestName("Amir’s brother")).toBe(true); // curly apostrophe
    expect(isPlaceholderGuestName("his mate")).toBe(true);
    expect(isPlaceholderGuestName("a friend")).toBe(true);
    expect(isPlaceholderGuestName("2 of my guys")).toBe(true);
    expect(isPlaceholderGuestName("two of my guys")).toBe(true);
    expect(isPlaceholderGuestName("a couple of mates")).toBe(true);
  });

  it("flags bare indefinites", () => {
    expect(isPlaceholderGuestName("someone")).toBe(true);
    expect(isPlaceholderGuestName("somebody")).toBe(true);
    expect(isPlaceholderGuestName("anyone")).toBe(true);
    expect(isPlaceholderGuestName("another")).toBe(true);
    expect(isPlaceholderGuestName("+1")).toBe(true);
    expect(isPlaceholderGuestName("guest")).toBe(true);
  });

  it("is case and whitespace insensitive", () => {
    expect(isPlaceholderGuestName("  My Brother  ")).toBe(true);
    expect(isPlaceholderGuestName("SOMEONE")).toBe(true);
  });

  it("NEVER flags a real name — dropping a real add is the worse error", () => {
    expect(isPlaceholderGuestName("Shahrokh")).toBe(false);
    expect(isPlaceholderGuestName("Amir")).toBe(false);
    expect(isPlaceholderGuestName("Kieran Baker")).toBe(false);
    expect(isPlaceholderGuestName("Rashad")).toBe(false);
    // "Guy" and "Kid" are real first names; only the DETERMINED forms
    // ("my guy", "a kid") are placeholders.
    expect(isPlaceholderGuestName("Guy")).toBe(false);
    expect(isPlaceholderGuestName("Kid")).toBe(false);
    expect(isPlaceholderGuestName("my guy")).toBe(true);
  });

  it("NEVER flags a relationship that is followed by a real name", () => {
    // "my brother Shahrokh" carries the name we need — it must go down
    // the normal registerFor path, not the ask path.
    expect(isPlaceholderGuestName("my brother Shahrokh")).toBe(false);
    expect(isPlaceholderGuestName("Amir's brother Shahrokh")).toBe(false);
  });

  it("handles empty / junk input", () => {
    expect(isPlaceholderGuestName("")).toBe(false);
    expect(isPlaceholderGuestName("   ")).toBe(false);
  });
});

// ── 2. looksLikeUnnamedGuestOffer ──────────────────────────────────────

describe("looksLikeUnnamedGuestOffer — corroborates that it IS an offer", () => {
  it("fires on the production wording and its cousins", () => {
    expect(looksLikeUnnamedGuestOffer("@Kemal Ediz my brother can play if needed")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("my brother can play if needed")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("I can bring someone if you're short")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("my mate could fill in if you're short")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("two of my guys can play next week")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("I'll bring 2 friends")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("my mate wants to come")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("can I bring someone?")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("Lemme know if we need more to make it 14. I can find another")).toBe(true);
    expect(looksLikeUnnamedGuestOffer("I know a guy who can play")).toBe(true);
  });

  it("STAYS QUIET on banter that merely mentions a person", () => {
    expect(looksLikeUnnamedGuestOffer("my brother watched the game last night lol")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("my mate says the pitch is waterlogged")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("haha my brother would love that")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("tell your mate he owes me a fiver 😂")).toBe(false);
  });

  it("STAYS QUIET when there is no person at all", () => {
    expect(looksLikeUnnamedGuestOffer("I can play if needed")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("I'll be the 14th if you're short")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("what time is kickoff?")).toBe(false);
  });

  it("handles empty / junk input", () => {
    expect(looksLikeUnnamedGuestOffer("")).toBe(false);
    expect(looksLikeUnnamedGuestOffer("   ")).toBe(false);
  });
});

// ── 3. isVagueGuestOfferVerdict / stripPlaceholderGuests ───────────────

const V = (v: Partial<GuestOfferVerdict>): GuestOfferVerdict => ({
  intent: "noise",
  registerAttendance: null,
  registerFor: null,
  ...v,
});

describe("isVagueGuestOfferVerdict — which verdicts reach the ask path", () => {
  it("fires on a bare bring_guests_vague", () => {
    expect(isVagueGuestOfferVerdict(V({ intent: "bring_guests_vague" }))).toBe(true);
  });

  it("fires on the ghost-user verdict: registerFor with a placeholder name", () => {
    // MDs/analyzer-redesign-2026-08-31.md §4.1 — 6 of 6 runs emitted this.
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "in", registerFor: [{ name: "Amir's brother", action: "IN" }] }),
      ),
    ).toBe(true);
  });

  it("does NOT fire when a real name is present", () => {
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "in", registerFor: [{ name: "Shahrokh", action: "IN" }] }),
      ),
    ).toBe(false);
    // Mixed: a real name alongside a placeholder is still a real add.
    expect(
      isVagueGuestOfferVerdict(
        V({
          intent: "in",
          registerFor: [
            { name: "Shahrokh", action: "IN" },
            { name: "my brother", action: "IN" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT fire on a placeholder OUT/BENCH — never touch a drop", () => {
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "out", registerFor: [{ name: "my brother", action: "OUT" }] }),
      ),
    ).toBe(false);
  });

  // ── THE SWALLOWED-WRITE DEFECT (PR #29 review, 2026-08-31) ──────────
  //
  // The ask branch in the analyze route is TERMINAL: it `continue`s
  // before any apply path. So anything this predicate says yes to has
  // its ENTIRE verdict discarded. The first cut only looked at
  // registerFor, which meant a single message carrying BOTH the sender's
  // own attendance and an unnamed guest ("I'm in, and my brother can
  // play too") returned true, and the player's own IN was never written.
  // They believe they are in the squad, the DB says otherwise, and the
  // pre-match reminder reads the DB. The OUT flavour is worse: a player
  // who typed OUT stays counted as playing.
  //
  // Rule: a verdict is the ask path ONLY when it is PURELY an unnamed
  // guest offer. Any other actionable payload and it falls through to
  // normal handling, where the placeholder ADD has already been
  // stripped, so no ghost is provisioned either way. Losing the name-ask
  // on a combined message is fine. Losing attendance is not.

  it("does NOT fire when the sender registers THEMSELVES in the same message", () => {
    // "I'm in, and my brother can play too"
    expect(
      isVagueGuestOfferVerdict(
        V({
          intent: "in",
          registerAttendance: "IN",
          registerFor: [{ name: "my brother", action: "IN" }],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT fire when the sender drops OUT in the same message", () => {
    // "I can't make it but my mate can play" — swallowing this leaves a
    // player who typed OUT counted as playing.
    expect(
      isVagueGuestOfferVerdict(
        V({
          intent: "out",
          registerAttendance: "OUT",
          registerFor: [{ name: "my mate", action: "IN" }],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT fire on a BENCH self-write alongside an unnamed guest", () => {
    expect(
      isVagueGuestOfferVerdict(
        V({
          intent: "conditional_in",
          registerAttendance: "BENCH",
          registerFor: [{ name: "someone", action: "IN" }],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT fire when a bring_guests_vague verdict carries a self write", () => {
    // Same swallow, reached through the other arm of the predicate.
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "bring_guests_vague", registerAttendance: "IN" }),
      ),
    ).toBe(false);
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "bring_guests_vague", registerAttendance: "OUT" }),
      ),
    ).toBe(false);
  });

  // Every other actionable field on AnalysisVerdict gets the same
  // treatment, because the terminal `continue` discards all of them.
  it("does NOT fire when the verdict carries ANY other actionable payload", () => {
    const cases: Array<[string, Partial<GuestOfferVerdict>]> = [
      ["benchConfirmation", { benchConfirmation: "yes" }],
      ["benchConfirmation no", { benchConfirmation: "no" }],
      ["scoreRed", { scoreRed: 5 }],
      ["scoreYellow", { scoreYellow: 2 }],
      ["scoreRed 0 (a real score, not absence)", { scoreRed: 0 }],
      ["includeNames", { includeNames: ["Ibrahim"] }],
      ["teamOverrides", { teamOverrides: [{ name: "Pete", team: "RED" }] }],
      ["teamNames", { teamNames: ["Wolves", "Hawks"] }],
      ["bulkPayment", { bulkPayment: { payerName: "Amir", count: 4 } }],
      ["reminder", { reminder: { date: "2026-09-01", note: "confirm" } }],
    ];
    for (const [label, extra] of cases) {
      expect(
        isVagueGuestOfferVerdict(V({ intent: "bring_guests_vague", ...extra })),
        `a verdict carrying ${label} must not be swallowed by the terminal ask branch`,
      ).toBe(false);
    }
  });

  // The OUT safety net (analyze/route.ts) fires on
  // intent:"replacement_request" with registerAttendance NOT "OUT", and
  // forces the sender OUT when the reasoning shows a strong drop signal.
  // registerAttendance is null there, so carriesOtherAction cannot see
  // it: "someone replace me, my mate could fill in" would have taken the
  // terminal ask branch and skipped the net, silently keeping a player
  // who asked to be replaced in the squad. Only two intents may ever
  // reach the ask path, and neither is drop-shaped.
  it("does NOT fire on a DROP-shaped intent, even with a placeholder-only add", () => {
    for (const intent of ["out", "replacement_request", "conditional_in"]) {
      expect(
        isVagueGuestOfferVerdict(
          V({ intent, registerFor: [{ name: "my mate", action: "IN" }] }),
        ),
        `intent "${intent}" is about the SENDER's own slot and must never be swallowed`,
      ).toBe(false);
    }
  });

  it("does NOT fire on an unrelated action intent carrying a placeholder add", () => {
    for (const intent of ["score", "question", "generate_teams_request", "reminder_request"]) {
      expect(
        isVagueGuestOfferVerdict(
          V({ intent, registerFor: [{ name: "someone", action: "IN" }] }),
        ),
        `intent "${intent}" must fall through to its own handler`,
      ).toBe(false);
    }
  });

  it("STILL fires on the ghost-user shape, which is intent \"in\"", () => {
    // The one intent other than bring_guests_vague that may reach the
    // ask path. Safe because the IN safety net's own relay guard skips
    // any verdict with a non-empty registerFor, so nothing is lost.
    expect(
      isVagueGuestOfferVerdict(
        V({ intent: "in", registerFor: [{ name: "Amir's brother", action: "IN" }] }),
      ),
    ).toBe(true);
  });

  it("STILL fires on a genuinely bare unnamed-guest verdict", () => {
    // The guard above must not have killed the feature: an empty
    // payload alongside the offer is the normal, expected case.
    expect(
      isVagueGuestOfferVerdict(
        V({
          intent: "bring_guests_vague",
          registerAttendance: null,
          benchConfirmation: null,
          scoreRed: null,
          scoreYellow: null,
          includeNames: null,
          teamOverrides: null,
          teamNames: null,
          bulkPayment: null,
          reminder: null,
        }),
      ),
    ).toBe(true);
  });

  it("does NOT fire on ordinary self-attendance", () => {
    expect(isVagueGuestOfferVerdict(V({ intent: "in", registerAttendance: "IN" }))).toBe(false);
    expect(isVagueGuestOfferVerdict(V({ intent: "conditional_in" }))).toBe(false);
    expect(isVagueGuestOfferVerdict(V({ intent: "noise" }))).toBe(false);
  });
});

describe("stripPlaceholderGuests — a placeholder can only ever create a ghost", () => {
  it("removes placeholder entries and keeps real ones", () => {
    expect(
      stripPlaceholderGuests([
        { name: "Shahrokh", action: "IN" },
        { name: "my brother", action: "IN" },
      ]),
    ).toEqual([{ name: "Shahrokh", action: "IN" }]);
  });

  it("leaves a non-IN placeholder alone (a drop is never invented or eaten)", () => {
    expect(stripPlaceholderGuests([{ name: "my brother", action: "OUT" }])).toEqual([
      { name: "my brother", action: "OUT" },
    ]);
  });

  it("handles null / empty", () => {
    expect(stripPlaceholderGuests(null)).toEqual([]);
    expect(stripPlaceholderGuests([])).toEqual([]);
  });
});

// ── 4. shouldAskForGuestName ───────────────────────────────────────────

const BASE: GuestAskInput = {
  body: "my brother can play if needed",
  tagged: false,
  senderKnown: true,
  attendanceOn: true,
  hasActiveMatch: true,
  confirmedCount: 8,
  maxPlayers: 14,
  alreadyAsked: false,
};

const ask = (over: Partial<GuestAskInput> = {}) => shouldAskForGuestName({ ...BASE, ...over });

describe("shouldAskForGuestName — fires exactly once, only when it helps", () => {
  it("FIRES on an unnamed offer while the squad is short", () => {
    expect(ask().ask).toBe(true);
  });

  it("FIRES on the production message verbatim", () => {
    expect(ask({ body: "@Kemal Ediz my brother can play if needed" }).ask).toBe(true);
  });

  it("FIRES on \"I can bring someone if you're short\"", () => {
    expect(ask({ body: "I can bring someone if you're short" }).ask).toBe(true);
  });

  it("does NOT fire twice — one ask per player per match, whatever they say next", () => {
    expect(ask({ alreadyAsked: true }).ask).toBe(false);
    expect(ask({ alreadyAsked: true }).reason).toContain("already");
  });

  it("does NOT fire on banter that merely mentions a mate", () => {
    expect(ask({ body: "my brother watched the game last night lol" }).ask).toBe(false);
    expect(ask({ body: "my mate says the pitch is waterlogged" }).ask).toBe(false);
  });

  it("does NOT fire, untagged, when the squad is already FULL", () => {
    // Nothing to offer them: soliciting a name we would then have to
    // bench or refuse is worse than staying quiet.
    expect(ask({ confirmedCount: 14, maxPlayers: 14 }).ask).toBe(false);
    expect(ask({ confirmedCount: 15, maxPlayers: 14 }).ask).toBe(false);
    expect(ask({ confirmedCount: 14, maxPlayers: 14 }).reason).toContain("full");
  });

  it("DOES fire on a full squad when MatchTime was TAGGED — they asked us directly", () => {
    expect(ask({ confirmedCount: 14, maxPlayers: 14, tagged: true }).ask).toBe(true);
  });

  it("a tag also excuses an unusual wording the offer regex misses", () => {
    // Tagged = the sender addressed MT on purpose; the deterministic
    // corroboration exists to stop MT piping up UNPROMPTED.
    expect(ask({ body: "@Match Time got a spare if you want", tagged: true }).ask).toBe(true);
    expect(ask({ body: "got a spare if you want", tagged: false }).ask).toBe(false);
  });

  it("does NOT fire when the sender could not be resolved", () => {
    // No userId means no per-player dedupe key, so the ask could repeat
    // forever. Silence is the safe branch.
    expect(ask({ senderKnown: false }).ask).toBe(false);
    expect(ask({ senderKnown: false, tagged: true }).ask).toBe(false);
  });

  it("does NOT fire when the org does not track attendance", () => {
    expect(ask({ attendanceOn: false }).ask).toBe(false);
    expect(ask({ attendanceOn: false, tagged: true }).ask).toBe(false);
  });

  it("does NOT fire when there is no match to add anyone to", () => {
    expect(ask({ hasActiveMatch: false }).ask).toBe(false);
    expect(ask({ hasActiveMatch: false, tagged: true }).ask).toBe(false);
  });

  it("always reports a reason, whichever way it goes", () => {
    expect(ask().reason.length).toBeGreaterThan(0);
    expect(ask({ alreadyAsked: true }).reason.length).toBeGreaterThan(0);
  });
});

// ── 5. renderGuestNameAsk ──────────────────────────────────────────────

describe("renderGuestNameAsk — server-composed, house style", () => {
  it("is short, warm, and names the next step", () => {
    const t = renderGuestNameAsk({ askerName: "Amir Ahmadi", body: "my brother can play if needed" });
    expect(t).toBe("Nice one Amir 🙌 What's their name? Reply with it and I'll add them to the squad.");
  });

  it("works without a sender name", () => {
    const t = renderGuestNameAsk({ askerName: null, body: "my brother can play if needed" });
    expect(t).toBe("Nice one 🙌 What's their name? Reply with it and I'll add them to the squad.");
  });

  it("goes plural when the offer is plural", () => {
    const t = renderGuestNameAsk({ askerName: "Amir", body: "two of my guys can play next week" });
    expect(t).toBe("Nice one Amir 🙌 What are their names? Reply with them and I'll add them to the squad.");
    expect(
      renderGuestNameAsk({ askerName: null, body: "I'll bring 2 friends" }),
    ).toContain("What are their names?");
  });

  it("never uses an em dash or a slash (house style)", () => {
    for (const body of [
      "my brother can play if needed",
      "two of my guys can play next week",
      "I can bring someone if you're short",
    ]) {
      for (const askerName of ["Amir Ahmadi", null]) {
        const t = renderGuestNameAsk({ askerName, body });
        expect(t).not.toContain("—");
        expect(t).not.toContain("–");
        expect(t).not.toContain("/");
      }
    }
  });

  it("uses the FIRST token of the sender name only, and never a raw number", () => {
    expect(renderGuestNameAsk({ askerName: "Oscar Owner", body: "my mate wants to come" })).toContain(
      "Nice one Oscar",
    );
    // A raw @lid / phone-number pushname must never be printed as a name.
    expect(renderGuestNameAsk({ askerName: "447700900123", body: "my mate wants to come" })).toBe(
      "Nice one 🙌 What's their name? Reply with it and I'll add them to the squad.",
    );
  });

  it("stays under a sensible group-chat length", () => {
    expect(
      renderGuestNameAsk({ askerName: "Amir", body: "my brother can play if needed" }).length,
    ).toBeLessThan(120);
  });
});

// ── 6. The ask can never carry a write ─────────────────────────────────

describe("the ask path is READ-ONLY by construction", () => {
  it("shouldAskForGuestName returns no attendance instruction at all", () => {
    const r = ask();
    // The shape is deliberately {ask, reason} — there is nowhere for an
    // attendance write to live, so no caller can smuggle one through.
    expect(Object.keys(r).sort()).toEqual(["ask", "reason"]);
  });
});
