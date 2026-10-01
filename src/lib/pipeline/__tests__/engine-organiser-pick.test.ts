/**
 * ORGANISER PICK IN THE ENGINE (slice 2b, 2026-10-01, plan 2.6 and 2.12).
 *
 * In an organiser-pick club MatchTime never fills an open place by
 * itself: a non-admin IN goes on the waiting list with 🪑, even with
 * places open, and that is the same rule `registerAttendance` applies to
 * the write (`canTakeFreePlace`), so the react cannot disagree with the
 * row. An admin, a reclaim and a running fallback offer take the place. A
 * drop opens no bench offer (the admins are asked instead), and the "a
 * place just opened" post is quiet while somebody is waiting.
 *
 * A first-come club (every club until it chooses otherwise, Sutton FC
 * included) is untouched: the same inputs with no `benchPickMode`.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { compose } from "../compose";
import { NOW, attendanceFacts, claim, confirmedCount, msg, statusOf, world } from "./helpers";

const THIRTEEN = ["abid", "mustafa", "idris", "elvin", "kemal", "sait", "faris", "shaz", "adam", "efat", "usama", "karahan", "zair"];
const organiser = { features: { benchPickMode: "organiser" as const } };

const selfIn = (from: string) => msg({ from, body: "in", route: "self_att", facts: attendanceFacts([claim({})]) });
const selfOut = (from: string) => msg({ from, body: "out", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) });

describe("a non-admin IN with places open", () => {
  it("organiser: waiting list, 🪑, and the write says BENCH with the organiser note", () => {
    const state = world({ confirmed: THIRTEEN, ...organiser });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
    expect(r.outcomes[0].react).toBe("🪑");
    const w = r.writes.find((x) => x.kind === "attendance");
    expect(w).toMatchObject({ status: "BENCH", explicitBench: false, reason: "organiser picks who plays" });
  });

  it("first-come (Sutton): CONFIRMED and ✅, exactly as before", () => {
    const state = world({ confirmed: THIRTEEN });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("CONFIRMED");
    expect(r.outcomes[0].react).toBe("✅");
  });

  it("a bench player's own IN stays on the waiting list in an organiser club", () => {
    const state = world({ confirmed: THIRTEEN, bench: ["youssef"], ...organiser });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
    expect(r.writes.filter((x) => x.kind === "attendance")).toHaveLength(0);
  });
});

describe("who may take the place in an organiser club", () => {
  it("an admin's own IN", () => {
    const state = world({ confirmed: THIRTEEN.filter((k) => k !== "kemal"), players: undefined, ...organiser });
    const r = decide({ now: NOW, state, messages: [selfIn("kemal")] });
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
    expect(r.outcomes[0].react).toBe("✅");
  });

  it("a reclaim: in, OUT, and IN again while the place is free", () => {
    const state = { ...world({ confirmed: THIRTEEN, dropped: ["youssef"], ...organiser }), reclaimUserIds: ["u-youssef"] };
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("CONFIRMED");
  });

  it("a dropped player who was never in is not a reclaim", () => {
    const state = world({ confirmed: THIRTEEN, dropped: ["youssef"], ...organiser });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
  });

  it("while the fallback offer is running, a bench player's IN takes the place", () => {
    const state = world({
      confirmed: THIRTEEN,
      bench: ["youssef"],
      openOffers: [{ id: "offer-1", replacingUserId: null, offeredToUserIds: ["u-youssef"] }],
      ...organiser,
    });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("CONFIRMED");
  });

  it("full is the waiting list for everyone, admins included", () => {
    const state = world({ confirmed: [...THIRTEEN.filter((k) => k !== "kemal"), "youssef", "najib"], ...organiser });
    expect(confirmedCount(state)).toBe(14);
    const r = decide({ now: NOW, state, messages: [selfIn("kemal")] });
    expect(statusOf(r.nextState, "kemal")).toBe("BENCH");
  });
});

describe("a drop in an organiser club", () => {
  const full = [...THIRTEEN, "youssef"];
  it("opens no bench offer and says nothing while somebody is waiting (the admins are asked)", () => {
    const state = world({ confirmed: full, bench: ["najib"], ...organiser });
    const r = decide({ now: NOW, state, messages: [selfOut("abid")] });
    expect(statusOf(r.nextState, "abid")).toBe("DROPPED");
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(false);
    expect(r.speech.map((s) => s.kind)).toEqual([]);
  });

  it("with an empty waiting list, the place-opened post in the pick wording (P13)", () => {
    const state = world({ confirmed: full, ...organiser });
    const r = decide({ now: NOW, state, messages: [selfOut("abid")] });
    expect(r.speech.map((s) => s.kind)).toEqual(["slot_opened"]);
    const out = compose(r);
    expect(out.utterances.map((u) => u.text)).toEqual([
      "A place just opened for Tue 21:30. Say *IN* to go on the waiting list, and the organisers will pick who plays.",
    ]);
  });

  it("first-come (Sutton) still opens the offer to the bench", () => {
    const state = world({ confirmed: full, bench: ["najib"] });
    const r = decide({ now: NOW, state, messages: [selfOut("abid")] });
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
  });
});
