/**
 * A SWAP WITH THE BENCH ON A FULL SQUAD (FNF HQ, 2026-11-10).
 *
 * Rafi asked "Should we swap Yaseen for Wasim?"; the owner said to ask
 * MatchTime. The squad was full (18 of 18), Yaseen playing, Wasim on the
 * bench. The organisers mean: Wasim plays, Yaseen goes to the bench. The
 * HQ squad reader reads it right (Wasim in, taking Yaseen's place, and
 * Yaseen to the bench), and the live check showed the engine still left
 * Wasim on the bench and the squad one short: it applied Wasim's IN first,
 * while the squad was still full, because only an OUT was ordered ahead of
 * an IN. A move to the bench frees a place just as an OUT does.
 *
 * Here: Najib plays the part of Yaseen, Wasim is Wasim, Kemal (an admin)
 * sends it, the squad is 7 of 7.
 */
import { describe, it, expect } from "vitest";
import { decide } from "./support/stub-picks";
import { NOW, SUTTON, attendanceFacts, claim, confirmedCount, msg, statusOf, world } from "./helpers";

const CONFIRMED = ["kemal", "sait", "mustafa", "abid", "najib", "zeeshan", "faris"];
const TEAMS = { kemal: "RED", sait: "RED", mustafa: "RED", abid: "YELLOW", najib: "YELLOW", zeeshan: "YELLOW", faris: "RED" } as const;

const wasimIn = (replaces = "") => claim({ subject: "other", personRef: "Wasim", personNamed: true, polarity: "in", replaces, confidence: 1 });
const najibTo = (polarity: "bench" | "out") => claim({ subject: "other", personRef: "Najib", personNamed: true, polarity, confidence: 1 });

function run(claims: ReturnType<typeof claim>[], o: { teams?: Record<string, "RED" | "YELLOW">; pick?: "organiser" | "first-come" } = {}) {
  const state = world({
    players: [...SUTTON],
    confirmed: CONFIRMED,
    bench: ["wasim", "habib"],
    teams: o.teams,
    maxPlayers: 7,
    features: { benchPickMode: o.pick ?? "organiser" },
  });
  return decide({
    now: NOW,
    state,
    messages: [msg({ from: "kemal", body: "@Match Time swap Najib for Wasim", tagged: true, route: "other_att", facts: attendanceFacts(claims) })],
  });
}

describe("a swap with the bench on a full squad: Wasim plays, Najib goes to the bench", () => {
  for (const pick of ["organiser", "first-come"] as const) {
    it(`Wasim in for Najib, Najib to the bench, the IN read first (${pick})`, () => {
      const r = run([wasimIn("Najib"), najibTo("bench")], { pick });
      expect(statusOf(r.nextState, "wasim")).toBe("CONFIRMED");
      expect(statusOf(r.nextState, "najib")).toBe("BENCH");
      expect(confirmedCount(r.nextState)).toBe(7);
    });

    it(`"Wasim in, Najib to the bench" with no replacement stated (${pick})`, () => {
      const r = run([wasimIn(), najibTo("bench")], { pick });
      expect(statusOf(r.nextState, "wasim")).toBe("CONFIRMED");
      expect(statusOf(r.nextState, "najib")).toBe("BENCH");
      expect(confirmedCount(r.nextState)).toBe(7);
    });
  }

  it("Najib's place on the bench opens nothing for the rest of the bench", () => {
    const r = run([wasimIn("Najib"), najibTo("bench")], { pick: "first-come" });
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(false);
    expect(statusOf(r.nextState, "habib")).toBe("BENCH");
  });

  it("with teams made, Wasim takes Najib's slot on the sheet", () => {
    const r = run([wasimIn("Najib"), najibTo("bench")], { teams: TEAMS });
    expect(r.writes.filter((w) => w.kind === "team_slot_inherit")).toEqual([
      expect.objectContaining({ kind: "team_slot_inherit", fromUserId: "u-najib", toUserId: "u-wasim", team: "YELLOW" }),
    ]);
    expect(r.nextState.teams.find((t) => t.userId === "u-wasim")?.team).toBe("YELLOW");
    expect(r.nextState.teams.some((t) => t.userId === "u-najib")).toBe(false);
  });

  it("CONTROL: the plain replacement (Najib out) still drops Najib", () => {
    const r = run([wasimIn("Najib"), najibTo("out")]);
    expect(statusOf(r.nextState, "wasim")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "najib")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(7);
  });

  it("CONTROL: 'Wasim in' alone on a full squad leaves Najib where he is (nothing inferred from replaces)", () => {
    const r = run([wasimIn("Najib")]);
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(confirmedCount(r.nextState)).toBe(7);
  });
});
