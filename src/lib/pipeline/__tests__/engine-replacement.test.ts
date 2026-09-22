/**
 * "MOJIB IS REPLACING NAJIB": THE 2026-09-22 INCIDENT, END TO END IN
 * THE ENGINE.
 *
 * Sutton FC, 28 minutes before kickoff. A player posted, untagged:
 *
 *   "Hi guys, Mojib is replacing Najib on the list. We can change"
 *
 * MatchTime did nothing. Mojib played, Najib did not: the team sheet
 * named the wrong man, the rating DMs would have gone to him, and the
 * fee was about to be charged to him. Kemal corrected the rows by hand
 * that night (Mojib took position 5 and the Yellow slot, Najib went to
 * DROPPED), and this file is that correction, made by the code.
 *
 * The claims below are what the extractor returns once it is told a
 * replacement is two claims with a direction (`replaces` on the arrival).
 * Everything these tests exercise after that point is deterministic.
 *
 * HALF OF THIS FILE IS ABOUT NOT DOING IT. A false positive DROPS A REAL
 * PLAYER FROM A REAL SQUAD, so every refusal below is as load-bearing as
 * the incident itself.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, SUTTON, attendanceFacts, claim, msg, statusOf, world } from "./helpers";

const CONFIRMED = ["kemal", "sait", "mustafa", "abid", "najib", "zeeshan", "faris"];
/** Najib holds position 5 and the Yellow slot, exactly as he did. */
const TEAMS = {
  kemal: "RED",
  sait: "RED",
  mustafa: "RED",
  abid: "YELLOW",
  najib: "YELLOW",
  zeeshan: "YELLOW",
  faris: "RED",
} as const;

const INCIDENT = "Hi guys, Mojib is replacing Najib on the list. We can change";

function mojibIn(over: Partial<ReturnType<typeof claim>> = {}) {
  return claim({
    subject: "other",
    personRef: "Mojib",
    personNamed: true,
    polarity: "in",
    replaces: "Najib",
    ...over,
  });
}

function najibOut(over: Partial<ReturnType<typeof claim>> = {}) {
  return claim({
    subject: "other",
    personRef: "Najib",
    personNamed: true,
    polarity: "out",
    ...over,
  });
}

function run(
  claims: ReturnType<typeof claim>[],
  o: {
    body?: string;
    tagged?: boolean;
    from?: string;
    teams?: Record<string, "RED" | "YELLOW">;
    confirmed?: string[];
    bench?: string[];
    maxPlayers?: number;
  } = {},
) {
  const state = world({
    players: [...SUTTON],
    confirmed: o.confirmed ?? CONFIRMED,
    bench: o.bench ?? [],
    teams: o.teams,
    maxPlayers: o.maxPlayers ?? 14,
  });
  return {
    state,
    result: decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: o.from ?? "wasim",
          body: o.body ?? INCIDENT,
          tagged: o.tagged ?? false,
          route: "other_att",
          facts: attendanceFacts(claims),
        }),
      ],
    }),
  };
}

const attendance = (r: ReturnType<typeof run>["result"]) =>
  r.writes.filter((w) => w.kind === "attendance");

describe("the incident: an untagged replacement from an ordinary member", () => {
  it("drops Najib and confirms Mojib", () => {
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    expect(statusOf(result.nextState, "najib")).toBe("DROPPED");
    expect(statusOf(result.nextState, "mojib")).toBe("CONFIRMED");
  });

  it("does not need an @Match Time tag, and says which rule let it through", () => {
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    expect(result.outcomes[0].reasons.join(" ")).not.toMatch(/requires an @Match Time tag/i);
    expect(result.outcomes[0].reasons.join(" ")).toMatch(/REPLACEMENT_OUT_IS_TAG_FREE/);
    // Wasim is not an admin, so the admin waiver carried nothing and must
    // not be named: the reason trail is where a wrong drop is traced back
    // to the policy that let it through.
    expect(result.outcomes[0].reasons.join(" ")).not.toMatch(/ADMIN_REPORTED_OUT_IS_TAG_FREE/);
  });

  it("gives Mojib the position Najib was holding", () => {
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    const najib = result.nextState.rows.find((r) => r.userId === "u-najib")!;
    const mojib = result.nextState.rows.find((r) => r.userId === "u-mojib")!;
    expect(mojib.position).toBe(najib.position);
  });

  it("moves Najib's team slot to Mojib and leaves every other slot alone", () => {
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    const moves = result.writes.filter((w) => w.kind === "team_slot_inherit");
    // ONE write, of the one kind #82 introduced, however the pair was
    // found. The state check at the end of `decide` must not add a
    // second move for the same pair.
    expect(moves).toEqual([
      expect.objectContaining({
        kind: "team_slot_inherit",
        fromUserId: "u-najib",
        toUserId: "u-mojib",
        team: "YELLOW",
      }),
    ]);
    expect(result.nextState.teams.find((t) => t.userId === "u-mojib")?.team).toBe("YELLOW");
    expect(result.nextState.teams.some((t) => t.userId === "u-najib")).toBe(false);
    expect(result.nextState.teams.filter((t) => t.team === "RED").length).toBe(4);
    expect(result.nextState.teams.filter((t) => t.team === "YELLOW").length).toBe(3);
  });

  it("Mojib stands where Najib stood on the sheet, not at the bottom of Yellow", () => {
    // Sheet order is `id: asc` in `load-state.ts`. The row changes hands
    // in place (#82's `moveTeamSlot`), so the projected sheet must keep
    // the same order with Mojib in Najib's row.
    const { state, result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    const before = state.teams.map((t) => t.userId);
    const after = result.nextState.teams.map((t) => t.userId);
    expect(after).toEqual(before.map((id) => (id === "u-najib" ? "u-mojib" : id)));
  });

  it("tells the group ONCE: the teams, declared again, naming the swap", () => {
    // Kemal's instruction (2026-09-15): "declare the teams again with the
    // swapped replacement and the person that is out". One post, never
    // a one-liner beside a teams post.
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS });
    expect(result.speech.map((s) => s.kind)).toEqual(["replacement_teams_post"]);
    expect(result.speech[0]).toMatchObject({
      kind: "replacement_teams_post",
      messageId: result.outcomes[0].messageId,
      swaps: [{ outName: "Najib Ahmadi", inName: "Mojib Sadat", team: "YELLOW", outWentOut: true }],
    });
  });

  it("says nothing extra when there are no teams yet: the squad post covers it", () => {
    const { result } = run([najibOut(), mojibIn()]);
    expect(result.writes.some((w) => w.kind === "team_slot_inherit")).toBe(false);
    expect(result.speech.map((s) => s.kind)).toEqual(["squad_status"]);
    expect(statusOf(result.nextState, "mojib")).toBe("CONFIRMED");
  });

  it("does not offer the vacated slot to the bench: it is already taken", () => {
    const { result } = run([najibOut(), mojibIn()], { teams: TEAMS, bench: ["amir", "ayoub"] });
    expect(result.writes.some((w) => w.kind === "open_bench_offer")).toBe(false);
    expect(result.speech.map((s) => s.kind)).toEqual(["replacement_teams_post"]);
    expect(result.nextState.openOffers).toEqual([]);
    expect(statusOf(result.nextState, "amir")).toBe("BENCH");
  });

  it("confirms the replacement even in a full squad, because the slot was freed first", () => {
    const full = [...CONFIRMED, "elvin", "idris", "shaz", "adam", "efat", "usama", "karahan"];
    expect(full.length).toBe(14);
    const { result } = run([najibOut(), mojibIn()], { confirmed: full, teams: TEAMS });
    expect(statusOf(result.nextState, "mojib")).toBe("CONFIRMED");
  });
});

describe("stated pairing and #82's state check, landed together (2026-09-23)", () => {
  it("the message's pairing beats sheet order when the sheet has two holes", () => {
    // Sait (RED, earlier on the sheet) dropped in an earlier batch and
    // was never replaced, so his slot is already a vacancy. The state
    // check alone would zip the first arrival into the FIRST vacancy in
    // sheet order: Mojib into Sait's RED slot. The message said Mojib
    // replaces NAJIB, so he takes Najib's YELLOW slot, and Sait's hole
    // is left for whoever replaces Sait.
    const { result } = run([najibOut(), mojibIn()], {
      confirmed: CONFIRMED.filter((k) => k !== "sait"),
      teams: TEAMS,
    });
    expect(result.nextState.teams.find((t) => t.userId === "u-mojib")?.team).toBe("YELLOW");
    expect(result.nextState.teams.some((t) => t.userId === "u-sait")).toBe(true);
    expect(result.writes.filter((w) => w.kind === "team_slot_inherit")).toEqual([
      expect.objectContaining({ fromUserId: "u-najib", toUserId: "u-mojib" }),
    ]);
  });

  it("an arrival who already holds a slot keeps his own and takes nobody else's", () => {
    // Mojib was on the sheet, dropped, and comes back "replacing Najib".
    // Handing him Najib's row too would be two rows for one man.
    const { result } = run([najibOut(), mojibIn()], {
      confirmed: CONFIRMED,
      teams: { ...TEAMS, mojib: "RED" },
    });
    expect(result.nextState.teams.filter((t) => t.userId === "u-mojib")).toEqual([
      { userId: "u-mojib", team: "RED" },
    ]);
    expect(result.writes.some((w) => w.kind === "team_slot_inherit")).toBe(false);
  });
});

describe("a slot refilled in the SAME batch is not offered to the bench (#82's path)", () => {
  // Two messages, two people, no word like "replacing": the drop opens
  // an offer on message one and the arrival on message two takes the
  // slot through #82's state check. The offer is taken back so the group
  // does not read "bench, first to say IN" beside the teams post.
  const dropThenArrival = (bench: string[], second: ReturnType<typeof msg>) => {
    const state = world({ players: [...SUTTON], confirmed: CONFIRMED, bench, teams: TEAMS, maxPlayers: 7 });
    return decide({
      now: NOW,
      state,
      messages: [
        msg({
          id: "m-drop",
          from: "najib",
          body: "sorry lads I'm out tonight",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
        second,
      ],
    });
  };
  const amirBringsMojib = () =>
    msg({
      id: "m-arrive",
      from: "amir",
      body: "Mojib can play",
      route: "other_att",
      facts: attendanceFacts([
        claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "in" }),
      ]),
    });

  it("no offer, no bench line, one teams post", () => {
    const r = dropThenArrival(["ayoub"], amirBringsMojib());
    expect(statusOf(r.nextState, "najib")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(false);
    expect(r.outcomes.flatMap((o) => o.writes).some((w) => w.kind === "open_bench_offer")).toBe(false);
    expect(r.speech.map((s) => s.kind)).toEqual(["replacement_teams_post"]);
    expect(r.nextState.openOffers).toEqual([]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/bench offer .* taken back/);
  });

  it("CONTROL: the drop alone still opens the offer to the bench", () => {
    const state = world({ players: [...SUTTON], confirmed: CONFIRMED, bench: ["ayoub"], teams: TEAMS, maxPlayers: 7 });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "najib",
          body: "sorry lads I'm out tonight",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
    expect(r.speech.map((s) => s.kind)).toContain("bench_offer_open");
  });

  it("CONTROL: a bench player who claims the offer keeps it claimed", () => {
    const r = dropThenArrival(
      ["ayoub"],
      msg({
        id: "m-claim",
        from: "ayoub",
        body: "IN",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "in" })]),
      }),
    );
    expect(statusOf(r.nextState, "ayoub")).toBe("CONFIRMED");
    // The offer did its job, so it is not taken back: it was opened and
    // then resolved by the claim, exactly as before.
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
    expect(r.writes.some((w) => w.kind === "resolve_bench_offer")).toBe(true);
    expect(r.nextState.teams.find((t) => t.userId === "u-ayoub")?.team).toBe("YELLOW");
  });
});

describe("the sender may be the one leaving", () => {
  it("\"I'm out, Mojib is replacing me\" moves the slot to Mojib", () => {
    const { result } = run(
      [
        claim({ subject: "sender", personRef: "", polarity: "out", personNamed: false }),
        mojibIn({ replaces: "me" }),
      ],
      { from: "najib", body: "I'm out, Mojib is replacing me", teams: TEAMS },
    );
    expect(statusOf(result.nextState, "najib")).toBe("DROPPED");
    expect(statusOf(result.nextState, "mojib")).toBe("CONFIRMED");
    expect(result.nextState.teams.find((t) => t.userId === "u-mojib")?.team).toBe("YELLOW");
  });
});

describe("a false drop is the whole danger, so: what it refuses", () => {
  it("refuses an untagged drop when the arriving name is unknown", () => {
    const { result } = run([
      najibOut(),
      claim({ subject: "other", personRef: "Zork", personNamed: true, polarity: "in", replaces: "Najib" }),
    ]);
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
    expect(result.outcomes[0].reasons.join(" ")).toMatch(/needs an @Match Time tag/i);
  });

  it("refuses an untagged drop when the message states no direction", () => {
    // Two unrelated statements. Without `replaces` this is not a
    // replacement and Najib's drop needs a tag exactly as it always has.
    const { result } = run([najibOut(), mojibIn({ replaces: "" })]);
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
    expect(statusOf(result.nextState, "mojib")).toBe("CONFIRMED");
  });

  it("refuses an untagged drop below the confidence floor", () => {
    const { result } = run([najibOut({ confidence: 0.6 }), mojibIn()], { teams: TEAMS });
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
    expect(result.writes.some((w) => w.kind === "team_slot_inherit")).toBe(false);
  });

  it("refuses an untagged drop when the ARRIVAL is below the floor", () => {
    const { result } = run([najibOut(), mojibIn({ confidence: 0.6 })], { teams: TEAMS });
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
  });

  it("still refuses a non-admin's drop amid banter markers", () => {
    const { result } = run([najibOut(), mojibIn()], {
      body: "Najib is out 😂 Mojib is replacing him lads",
      teams: TEAMS,
    });
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
  });

  it("refuses when two people both claim to be replacing Najib", () => {
    const { result } = run([
      najibOut(),
      mojibIn(),
      claim({ subject: "other", personRef: "Amir", personNamed: true, polarity: "in", replaces: "Najib" }),
    ]);
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
  });

  it("never drops on `replaces` alone, with no out claim in the message", () => {
    const { result } = run([mojibIn()], { teams: TEAMS });
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
    expect(result.writes.some((w) => w.kind === "team_slot_inherit")).toBe(false);
    expect(attendance(result).map((w) => w.userId)).toEqual(["u-mojib"]);
  });

  it("does not move a slot when the replacement lands on the bench anyway", () => {
    // Najib is not in the squad, so nothing is freed and nothing is
    // inherited; Mojib joins a full squad on the bench, as he would have.
    const full = ["kemal", "sait", "mustafa", "abid", "zeeshan", "faris", "elvin", "idris", "shaz", "adam", "efat", "usama", "karahan", "zair"];
    const { result } = run([najibOut(), mojibIn()], { confirmed: full, teams: TEAMS });
    expect(statusOf(result.nextState, "mojib")).toBe("BENCH");
    expect(result.nextState.teams.some((t) => t.userId === "u-mojib")).toBe(false);
  });

  it("a tagged replacement behaves identically: the waiver adds nothing else", () => {
    const untagged = run([najibOut(), mojibIn()], { teams: TEAMS }).result;
    const tagged = run([najibOut(), mojibIn()], { teams: TEAMS, tagged: true }).result;
    expect(attendance(tagged).map((w) => ({ id: w.userId, s: w.status }))).toEqual(
      attendance(untagged).map((w) => ({ id: w.userId, s: w.status })),
    );
  });

  it("leaves an ordinary untagged third-party drop refused, as it is today", () => {
    const { result } = run([najibOut()]);
    expect(statusOf(result.nextState, "najib")).toBe("CONFIRMED");
    expect(result.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/i);
  });
});
