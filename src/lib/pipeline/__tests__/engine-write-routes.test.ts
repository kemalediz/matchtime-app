/**
 * §10 STEP 7 PART 2 — THE ENGINE, ON THE TWO ROUTES THAT WRITE.
 *
 * `score` and `admin_ops` were held back from part 1 for reasons
 * `answer-batch.ts`'s header states precisely: a score is a write
 * against a finished match with the Elo deltas behind it, and an admin
 * op is real money on a live club plus a time phrase that nothing
 * resolved. Everything below is those reasons, discharged one at a time.
 *
 * A separate file from `engine.test.ts` on purpose: these are the rules
 * a revert of `SCORE_ENGINE_ENABLED` or `ADMIN_OPS_ENGINE_ENABLED` would
 * be reverting, and keeping them together makes "what does this flag
 * actually decide?" one file rather than a grep.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import type { TeamFacts } from "../types";
import { NOW, msg, world } from "./helpers";

describe("S17 · a score from an UNRESOLVED sender is still recorded", () => {
  // `route.ts:3457-3462` in its own words: "If we CAN'T resolve them
  // (e.g. WhatsApp hid the phone via @lid and the pushname didn't match
  // any player) → still write the score, because … losing the score
  // entirely is a worse failure mode than occasionally trusting a wrong
  // number." Since the @lid change an unresolved sender is ROUTINE
  // rather than exotic, so this covers most of a real group's reports.
  const played = () =>
    world({
      confirmed: ["kemal", "elvin"],
      completedMatch: { id: "done-1", participantUserIds: ["u-kemal", "u-elvin"] },
    });

  it("records the result, and says why it accepted an unknown sender", () => {
    const r = decide({
      now: NOW,
      state: played(),
      messages: [
        msg({
          from: null,
          body: "we won 5-3",
          route: "score",
          facts: { kind: "score", first: 5, second: 3 },
        }),
      ],
    });
    expect(r.writes.find((w) => w.kind === "score")).toMatchObject({ red: 5, yellow: 3 });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/unresolved sender/i);
  });

  it("still refuses a RESOLVED member who neither played nor is an admin", () => {
    // The §9 authorisation seatbelt is untouched. The widening is about
    // "WhatsApp did not tell us who this is", never about "we know who
    // this is and they may not".
    const r = decide({
      now: NOW,
      state: played(),
      messages: [
        msg({
          from: "zair",
          body: "we won 9-0",
          route: "score",
          facts: { kind: "score", first: 9, second: 0 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });

  it("an unresolved sender cannot overwrite a result already recorded", () => {
    const r = decide({
      now: NOW,
      state: world({
        confirmed: ["kemal"],
        completedMatch: { id: "done-1", redScore: 5, yellowScore: 2, participantUserIds: [] },
      }),
      messages: [
        msg({
          from: null,
          body: "nah it was 9-0",
          route: "score",
          facts: { kind: "score", first: 9, second: 0 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/already recorded/i);
  });

  it("records a score on a match still sitting at TEAMS_PUBLISHED", () => {
    // The status the shipped path accepts and the old loader could not
    // produce. A match only becomes COMPLETED when somebody records a
    // score, so this shape IS the first score of every match.
    const r = decide({
      now: NOW,
      state: world({
        confirmed: ["kemal"],
        completedMatch: {
          id: "done-1",
          status: "TEAMS_PUBLISHED",
          participantUserIds: ["u-kemal"],
        },
      }),
      messages: [
        msg({
          from: "kemal",
          body: "4-4",
          route: "score",
          facts: { kind: "score", first: 4, second: 4 },
        }),
      ],
    });
    expect(r.writes.find((w) => w.kind === "score")).toMatchObject({ red: 4, yellow: 4 });
    expect(r.nextState.completedMatch?.status).toBe("COMPLETED");
  });
});

describe("S22 · the reminder time is resolved by code, never by the model", () => {
  const ask = (phrase: string, over: Parameters<typeof world>[0] = {}) =>
    decide({
      // Tue 1 Sep 2026, 19:00 London (18:00Z, BST).
      now: NOW,
      state: world({ confirmed: ["kemal"], ...over }),
      messages: [
        msg({
          from: "zair",
          body: `@Match Time remind me ${phrase}`,
          tagged: true,
          route: "admin_ops",
          facts: { kind: "admin", action: "reminder", phrase },
        }),
      ],
    });

  it("turns the phrase into an instant and a label", () => {
    const r = ask("tomorrow at 6");
    const w = r.writes.find((x) => x.kind === "reminder");
    expect(w).toBeTruthy();
    if (w?.kind === "reminder") {
      expect(w.sendAt.toISOString()).toBe("2026-09-02T17:00:00.000Z"); // 18:00 BST
      expect(w.whenLabel).toBe("Wed 2 Sep at 18:00");
      expect(w.phrase).toBe("tomorrow at 6");
    }
  });

  it("acknowledges with the RESOLVED time, not the words asked", () => {
    const s = ask("tomorrow at 6").speech.find((x) => x.kind === "reminder_ack");
    expect(s).toMatchObject({ whenLabel: "Wed 2 Sep at 18:00" });
  });

  it("refuses a phrase the resolver cannot read, and says so", () => {
    const r = ask("before the match");
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /could not be resolved/i.test(d.detail))).toBe(true);
  });

  it("refuses anything outside the shipped 60-day window", () => {
    const r = ask("in 80 days");
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /60-day/i.test(d.detail))).toBe(true);
  });

  it("stays silent for an org that has reminders switched off", () => {
    const r = ask("tomorrow", { features: { reminders: false } });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/reminders are off/i);
  });

  it("degrades for a member with no phone number on file", () => {
    // Nowhere to send it. The shipped path answers in the group; this
    // hands the message back so the player reads that shipped sentence
    // rather than a second wording of it.
    const r = ask("tomorrow", { noPhone: ["zair"] });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /no phone/i.test(d.detail))).toBe(true);
  });

  it("requires the @Match Time tag, exactly as the contract does", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({
          from: "zair",
          body: "remind me tomorrow",
          tagged: false,
          route: "admin_ops",
          facts: { kind: "admin", action: "reminder", phrase: "tomorrow" },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });
});

describe("S21 · the covered list, when the money names people", () => {
  const credit = (coveredRefs: string[] | undefined, from = "elvin") =>
    decide({
      now: NOW,
      state: world({
        confirmed: ["kemal", "elvin", "sait", "amir"],
        features: { paymentTracking: true },
        completedMatch: {
          id: "done-1",
          participantUserIds: ["u-kemal", "u-elvin", "u-sait", "u-amir"],
        },
      }),
      messages: [
        msg({
          from,
          body: "@Match Time Amir paid",
          tagged: true,
          route: "admin_ops",
          facts: {
            kind: "admin",
            action: "bulk_payment",
            payerRef: "Amir",
            count: 2,
            ...(coveredRefs ? { coveredRefs } : {}),
          },
        }),
      ],
    });

  it("a bare count is an AGGREGATE credit", () => {
    const w = credit(undefined).writes.find((x) => x.kind === "payment_credit");
    expect(w).toMatchObject({ namedCovered: false, coveredUserIds: [] });
  });

  it("named players are a NAMED credit, which is a different write", () => {
    const w = credit(["Sait", "Kemal"]).writes.find((x) => x.kind === "payment_credit");
    expect(w).toMatchObject({ namedCovered: true });
    if (w?.kind === "payment_credit") {
      expect([...w.coveredUserIds].sort()).toEqual(["u-kemal", "u-sait"]);
    }
  });

  it('"me" is the sender, resolved from a closed list and not by a model', () => {
    const w = credit(["me", "Sait"]).writes.find((x) => x.kind === "payment_credit");
    if (w?.kind === "payment_credit") {
      expect([...w.coveredUserIds].sort()).toEqual(["u-elvin", "u-sait"]);
      expect(w.namedCovered).toBe(true);
    }
  });

  it("keeps the names it could resolve and reports the ones it could not", () => {
    const r = credit(["Sait", "Bartholomew"]);
    const w = r.writes.find((x) => x.kind === "payment_credit");
    if (w?.kind === "payment_credit") expect(w.coveredUserIds).toEqual(["u-sait"]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/Bartholomew/);
  });

  it("refuses outright when it names people and NONE of them resolve", () => {
    // The shipped path credits nothing here and then announces that it
    // did (`route.ts:3841-3886`, then `:3910`). Falling through to the
    // aggregate branch would be worse still — a number credited for
    // people nobody could identify. Neither: hand it back.
    const r = credit(["Bartholomew", "Cuthbert"]);
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /none of them resolve/i.test(d.detail))).toBe(true);
  });
});

describe("the recruit blast is DECIDED by the engine and RUN by the route", () => {
  const recruit = (from: string, lookbackMatches?: number, tagged = true) =>
    decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "elvin", "sait"] }),
      messages: [
        msg({
          from,
          tagged,
          body: "@Match Time message everyone from the last 5 games and invite them",
          route: "admin_ops",
          facts: {
            kind: "admin",
            action: "recruit",
            ...(lookbackMatches === undefined ? {} : { lookbackMatches }),
          },
        }),
      ],
    });

  it("an admin's ask proposes a blast, with no lookback when none was stated", () => {
    const w = recruit("kemal").writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: null });
  });

  it("carries a stated lookback through", () => {
    const w = recruit("kemal", 5).writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: 5 });
  });

  it("CLAMPS a number the model read out of a sentence", () => {
    // A mass DM from an unofficial WhatsApp client is how the account
    // gets banned, which takes the whole product down. "the last 50
    // games" must never reach `inviteRecentPlayers` as 50.
    const r = recruit("kemal", 50);
    const w = r.writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: 12 });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/clamped to 12/);
  });

  it("refuses a non-admin", () => {
    const r = recruit("zair");
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/only an admin/i);
  });

  // ── THE TAG IS REQUIRED FOR THE BULK COMMAND (2026-09-06) ──────────
  //
  // Measured on the live router, 20 runs of each phrasing:
  //
  //   "message everyone from the last 50 games"
  //        admin_ops 13/20 · question 4/20 · none 3/20
  //   "message everyone from the last 50 games and invite them"
  //        admin_ops 20/20
  //   "@Match Time DM everyone who played in the last 50 games …"
  //        admin_ops 20/20
  //
  // The route is the ONLY gate this action had, and for that one
  // wording it is a coin flip: the same message, in the same state,
  // DM'd 20 people twice and did nothing the third time. A missed blast
  // costs the owner one re-typed message. A wrong one is a mass DM from
  // an unofficial WhatsApp client, which is how the account — and with
  // it the whole product — goes away.
  //
  // So the tag is required HERE, and required unconditionally, which
  // makes the DECISION invariant even though the ROUTE is not: every
  // route the model samples for an untagged message now converges on
  // "no blast". `question` and `none` already refused it; `admin_ops`
  // now does too.
  //
  // WHAT THIS IS NOT. It is not a revert of PR #33. That fix lives on
  // the ATTENDANCE path — `facts.sideRequests` in `handleAttendance`,
  // via `RECRUIT_COMMAND_IMPLIES_ADDRESSED` — and is untouched: "Najib
  // is out. We need one more player." still drops Najib untagged and
  // still carries its recruit side-request, at the bounded default of
  // 5. See the 2026-09-01 block in `engine.test.ts`, which is the pin.
  it("REFUSES an untagged blast, however sure the router sounded", () => {
    const r = recruit("kemal", undefined, false);
    expect(r.writes.filter((x) => x.kind === "recruit_blast")).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/@Match Time tag/i);
  });

  it("refuses an untagged blast that named a lookback too — the number is the risk", () => {
    // "the last 50 games" is the widest a model-read number can make
    // this blast. An untagged message must never be what widens it.
    const r = recruit("kemal", 50, false);
    expect(r.writes.filter((x) => x.kind === "recruit_blast")).toHaveLength(0);
  });

  it("says nothing in the group when it refuses — silence is the contract for untagged", () => {
    // The refusal is recorded on the message's `reasoning` row for the
    // admin log. It is NOT a new sentence in the group: MatchTime stays
    // out of untagged traffic, and a bot that answers "tag me" to every
    // ambiguous line is the nagging §13 exists to prevent.
    const r = recruit("kemal", 50, false);
    expect(r.speech).toHaveLength(0);
  });

  it("still fires for the same admin the moment they tag it", () => {
    const w = recruit("kemal", 50, true).writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: 12 });
  });

  it("proposes no speech of its own — the route speaks after the blast runs", () => {
    // 2026-09-01: the blast ran FIRST, counted a squad the same message
    // was about to change, and told the owner it was full one line after
    // he said Najib was out. The engine models the DECISION only; the
    // words come from what `inviteRecentPlayers` actually did.
    const r = recruit("kemal");
    expect(r.speech).toHaveLength(0);
  });
});

describe("S19 · `generate` is owned; `rename` and `swap` are not", () => {
  // §10 step 8. `generate_teams_request` is the club's most-used
  // command — 23 in 120 days on Sutton FC, more than every question
  // shape put together — so deleting the mega-prompt without an owner
  // for it would have taken the feature with it. These are the rules a
  // revert of `BALANCER_ENGINE_ENABLED` now reverts.
  const SQUAD = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"];

  const teams = (
    over: Partial<Omit<TeamFacts, "kind">> = {},
    opts: {
      from?: string | null;
      tagged?: boolean;
      state?: Parameters<typeof world>[0];
    } = {},
  ) =>
    decide({
      now: NOW,
      state: world({ confirmed: SQUAD, ...(opts.state ?? {}) }),
      messages: [
        msg({
          from: opts.from === undefined ? "kemal" : opts.from,
          body: "@Match Time generate the teams",
          tagged: opts.tagged ?? true,
          route: "balancer",
          facts: {
            kind: "teams",
            action: "generate",
            includeRefs: [],
            teamNames: null,
            swaps: [],
            pairings: [],
            ...over,
          },
        }),
      ],
    });

  const genWrite = (r: ReturnType<typeof decide>) =>
    r.writes.find((w) => w.kind === "generate_teams");

  it("proposes a generate_teams write for a tagged request", () => {
    const r = teams();
    expect(genWrite(r)).toMatchObject({
      forceInclude: [],
      pinned: [],
      unmatchedIncludes: [],
      unmatchedPins: [],
      teamNames: null,
    });
    expect(r.outcomes[0].disposition).toBe("acted");
  });

  it("proposes NO speech — the post is the balancer's own output", () => {
    // The composer cannot render the line-ups from `SquadState`: they do
    // not exist until the write has run. `team-ops-engine.ts` composes
    // from what LANDED (§3.2 S7).
    expect(teams().speech).toHaveLength(0);
  });

  it("refuses an untagged request (both team intents are ACTIONY_INTENTS)", () => {
    const r = teams({}, { tagged: false });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/@Match Time tag/);
  });

  it("does NOT require an admin — the shipped path does not either", () => {
    expect(genWrite(teams({}, { from: "zair" }))).toBeTruthy();
  });

  it("resolves an include against ANY attendance row, not just CONFIRMED ones", () => {
    // "generate the teams including Zair" pulling a BENCH player back in
    // is the whole point of the feature.
    const r = teams({ includeRefs: ["Zair"] }, { state: { confirmed: SQUAD, bench: ["zair"] } });
    expect(genWrite(r)).toMatchObject({
      forceInclude: [{ userId: "u-zair", name: "Zair Malik", ref: "Zair" }],
    });
  });

  it("reports an include it cannot place rather than guessing", () => {
    const r = teams({ includeRefs: ["Bazza"] });
    expect(genWrite(r)).toMatchObject({ forceInclude: [], unmatchedIncludes: ["Bazza"] });
  });

  it("never force-includes somebody with no attendance row at all", () => {
    // Ehtisham is on the ROSTER but has no row on this match. The
    // shipped path matches against the match's attendance rows, so he is
    // not a candidate, and inventing a row for him is a squad change
    // nobody asked for.
    const r = teams({ includeRefs: ["Ehtisham"] });
    expect(genWrite(r)).toMatchObject({ forceInclude: [], unmatchedIncludes: ["Ehtisham"] });
  });

  it("turns a named side into an absolute pin, against CONFIRMED players", () => {
    const r = teams({ swaps: [{ personRef: "Sait", team: "YELLOW" }] });
    expect(genWrite(r)).toMatchObject({
      pinned: [{ userId: "u-sait", name: "Sait Demir", team: "YELLOW" }],
    });
  });

  it("does not pin somebody who is not in the squad", () => {
    const r = teams({ swaps: [{ personRef: "Zair", team: "RED" }] });
    expect(genWrite(r)).toMatchObject({ pinned: [], unmatchedPins: ["Zair"] });
  });

  it("de-duplicates an include named twice", () => {
    // "generate the teams, Zair is playing, Zair Malik is playing" must
    // not flip the same row twice or print the name twice above the post.
    const r = teams(
      { includeRefs: ["Zair", "Zair Malik"] },
      { state: { confirmed: SQUAD, bench: ["zair"] } },
    );
    expect(genWrite(r)!.forceInclude).toEqual([
      { userId: "u-zair", name: "Zair Malik", ref: "Zair" },
    ]);
  });

  it("keeps the FIRST pin when one player is named for both sides", () => {
    // Two instructions about one player contradict each other and the
    // balancer can honour only one; the earlier is at least the one the
    // message said first.
    const r = teams({
      swaps: [
        { personRef: "Sait", team: "RED" },
        { personRef: "Sait", team: "YELLOW" },
      ],
    });
    expect(genWrite(r)!.pinned).toEqual([{ userId: "u-sait", name: "Sait Demir", team: "RED" }]);
  });

  it("rebinds `me` to the sender, from a closed list and never from a model", () => {
    const r = teams({ swaps: [{ personRef: "me", team: "RED" }] });
    expect(genWrite(r)).toMatchObject({ pinned: [{ userId: "u-kemal", team: "RED" }] });
  });

  it("lets a pin name somebody the SAME message force-includes", () => {
    const r = teams(
      { includeRefs: ["Zair"], swaps: [{ personRef: "Zair", team: "RED" }] },
      { state: { confirmed: SQUAD, bench: ["zair"] } },
    );
    expect(genWrite(r)).toMatchObject({
      forceInclude: [{ userId: "u-zair" }],
      pinned: [{ userId: "u-zair", team: "RED" }],
    });
  });

  it("honours a PAIRING by pinning the group to one arbitrary colour", () => {
    // `generateTeamsForMatch` takes an absolute team per player and has
    // no notion of "together", so the constraint is preserved by pinning
    // the group to one side. Which side means nothing, and the reason
    // says so out loud rather than pretending otherwise.
    const r = teams({ pairings: [["me", "Sait"]] });
    expect(genWrite(r)!.pinned).toEqual([
      { userId: "u-kemal", name: "Kemal Ediz", team: "RED" },
      { userId: "u-sait", name: "Sait Demir", team: "RED" },
    ]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/the colour is arbitrary/);
  });

  it("a pairing inherits the colour of a member already pinned by name", () => {
    const r = teams({
      swaps: [{ personRef: "Sait", team: "YELLOW" }],
      pairings: [["me", "Sait"]],
    });
    expect(genWrite(r)!.pinned).toEqual([
      { userId: "u-sait", name: "Sait Demir", team: "YELLOW" },
      { userId: "u-kemal", name: "Kemal Ediz", team: "YELLOW" },
    ]);
  });

  it("does not pin a pairing that resolved to fewer than two people", () => {
    const r = teams({ pairings: [["me", "Bazza"]] });
    expect(genWrite(r)!.pinned).toEqual([]);
    expect(genWrite(r)!.unmatchedPins).toEqual(["Bazza"]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/constrains nothing/);
  });

  it("does not change the projected squad — the apply layer owns the flip", () => {
    // Modelling the force-include in the projection would flip
    // `squadChanged` and put a batch-level squad post BESIDE the team
    // post: two posts for one message, §3.2 S36.
    const r = teams({ includeRefs: ["Zair"] }, { state: { confirmed: SQUAD, bench: ["zair"] } });
    expect(r.nextState.rows.find((x) => x.userId === "u-zair")?.status).toBe("BENCH");
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(0);
  });

  it("degrades `rename` and `swap` rather than owning either", () => {
    for (const action of ["rename", "swap"] as const) {
      const r = decide({
        now: NOW,
        state: world({ confirmed: SQUAD }),
        messages: [
          msg({
            from: "kemal",
            body: "@Match Time do the thing",
            tagged: true,
            route: "balancer",
            facts: {
              kind: "teams",
              action,
              includeRefs: [],
              teamNames: null,
              swaps: [],
              pairings: [],
            },
          }),
        ],
      });
      expect(r.writes).toHaveLength(0);
      expect(r.outcomes[0].disposition).toBe("degraded");
      expect(r.degradations.map((d) => d.detail).join(" ")).toMatch(/has no owner in the pipeline/);
    }
  });

  it("still owns `show`, and still writes nothing for it", () => {
    // The other half of the two-owner split, asserted from the engine's
    // side: `show` and `generate` cannot both take the same branch.
    const r = decide({
      now: NOW,
      state: world({ confirmed: SQUAD, teams: { kemal: "RED", sait: "YELLOW" } }),
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time show the teams",
          tagged: true,
          route: "balancer",
          facts: {
            kind: "teams",
            action: "show",
            includeRefs: [],
            teamNames: null,
            swaps: [],
            pairings: [],
          },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.speech.map((s) => s.kind)).toContain("teams_post");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// THE STATS BLAST — DECIDED BY THE ENGINE, RUN BY THE ROUTE (2026-09-10)
// ═══════════════════════════════════════════════════════════════════════
//
// THE INCIDENT. At 18:38 Kemal posted an ordinary reminder to his
// players:
//
//   "please do not forget to rate the players via the link from
//    Matchtime DM'ed to you. the more accurate ratings, the more
//    balanced teams next time"
//
// MatchTime queued 69 personal stats-link DMs. The trigger was three
// keyword tests ANDed together in `analyze/route.ts`: a send word ("DM'ed
// to you"), a stats word ("the more accurate ratings") and an everyone
// word ("rate the players") — three unrelated fragments of one sentence,
// from an instruction TO THE PLAYERS that means roughly the opposite of
// what fired.
//
// That is a regex doing CLASSIFICATION, which this codebase has now
// deleted three times — 2026-04-21 (`handlers.ts:7-10`), 2026-09-01
// (`looksLikeRecruitRequest`) and here — each time after an incident.
//
// The replacement is the recruit blast's shape exactly: the extractor
// reports the ask as a typed FACT (`AdminFacts.action = "stats_blast"`),
// the engine decides WHO may fire one, and the route performs the blast
// deterministically so the action is never the model's to invent.
describe("the stats blast is DECIDED by the engine and RUN by the route", () => {
  const blast = (
    from: string | null,
    opts: { tagged?: boolean; taggedExplicitly?: boolean; body?: string } = {},
  ) =>
    decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "elvin", "sait"] }),
      messages: [
        {
          ...msg({
            from,
            tagged: opts.tagged ?? true,
            body: opts.body ?? "@Match Time send everyone their stats",
            route: "admin_ops",
            facts: { kind: "admin", action: "stats_blast" },
          }),
          ...(opts.taggedExplicitly === undefined
            ? {}
            : { taggedExplicitly: opts.taggedExplicitly }),
        },
      ],
    });

  it("a tagged ADMIN's ask proposes a blast", () => {
    const w = blast("kemal").writes.find((x) => x.kind === "stats_blast");
    expect(w).toBeTruthy();
  });

  it("refuses a non-admin — the blast DMs the whole club", () => {
    const r = blast("zair");
    expect(r.writes.filter((x) => x.kind === "stats_blast")).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/only an admin/i);
  });

  it("refuses an unresolved sender — nobody is an admin until they are somebody", () => {
    const r = blast(null);
    expect(r.writes.filter((x) => x.kind === "stats_blast")).toHaveLength(0);
  });

  it("REFUSES an untagged blast, exactly as the recruit blast does", () => {
    const r = blast("kemal", {
      tagged: false,
      taggedExplicitly: false,
      body: "send everyone their stats",
    });
    expect(r.writes.filter((x) => x.kind === "stats_blast")).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/@Match Time tag/i);
  });

  // ── THE HEADLINE, IN THE ENGINE ────────────────────────────────────
  //
  // The incident sentence contains the bare word "Matchtime", so
  // `messageTagsBot` — and therefore `EngineMessage.tagged` — is TRUE
  // for it. A gate that read `tagged` alone would have let it through.
  // This is the case that makes the fix independent of the model: even
  // if the extractor MISREADS the sentence as a bulk-DM command, the
  // engine refuses it, because nobody addressed the bot with an @.
  it("REFUSES the 2026-09-10 incident sentence even when the model calls it a blast", () => {
    const r = blast("kemal", {
      tagged: true, // ← `messageTagsBot` says yes: the body says "Matchtime"
      taggedExplicitly: false, // ← but nobody @-mentioned the bot
      body:
        "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
        "the more accurate ratings, the more balanced teams next time",
    });
    expect(r.writes.filter((x) => x.kind === "stats_blast")).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/@Match Time tag/i);
  });

  it("says nothing in the group when it refuses — silence is the contract", () => {
    const r = blast("kemal", { tagged: false, taggedExplicitly: false });
    expect(r.speech).toHaveLength(0);
  });

  it("proposes no speech of its own — the route speaks after the blast runs", () => {
    // Same rule as the recruit blast: the words come from what the
    // action ACTUALLY did (how many DMs were queued), which the engine
    // cannot know.
    expect(blast("kemal").speech).toHaveLength(0);
  });

  it("derives the explicit tag from the BODY when the caller supplied none", () => {
    // The Pi rewrites a real bot @-mention into the literal "@Match
    // Time" in the body, so a caller that has not been taught the new
    // field still gets the right answer — and gets it in the safe
    // direction for a body with no @ in it.
    expect(
      blast("kemal", { body: "@Match Time send everyone their stats" }).writes.filter(
        (x) => x.kind === "stats_blast",
      ),
    ).toHaveLength(1);
    expect(
      blast("kemal", { body: "send everyone their stats" }).writes.filter(
        (x) => x.kind === "stats_blast",
      ),
    ).toHaveLength(0);
  });
});
