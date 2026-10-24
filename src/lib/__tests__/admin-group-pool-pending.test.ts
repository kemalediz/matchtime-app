/**
 * HQ ASKING THE POOL, AND THE POOL'S ITEMS WAITING FOR AN ORGANISER'S YES
 * (local player pool L10, 2026-10-24). The pure half: what the router is
 * told is waiting, and the safe-YES rule deciding a YES about it. No
 * database, no model.
 */
import { describe, expect, it } from "vitest";
import { decideApproval, type PendingItem } from "../admin-group-confirm-rules";
import type { HqLogRow } from "../admin-group-log";
import { organisersContext } from "../admin-group-context";
import { parsePoolAskRef, poolAskRef } from "../admin-group-pool-refs";

const T0 = new Date("2026-10-27T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const POOL: PendingItem = { ref: poolAskRef("m1"), kind: "pool-ask", askedAt: at(0) };
const TEAMS: PendingItem = { ref: "teams:m1", kind: "teams" };
const row = (over: Partial<HqLogRow>): HqLogRow => ({
  waMessageId: `mt:${Math.random()}`,
  fromMatchTime: true,
  senderUserId: null,
  text: "",
  askRef: null,
  createdAt: at(0),
  ...over,
});
const NOTICE = "📋 Tue 27 Oct, 20:00: 6 of 7 so far.\n\n🔎 Or ask nearby players from the MatchTime pool (a few near you). Open the match page: https://matchtime.ai/matches/m1";

describe("the ref", () => {
  it("round-trips, and never reads another kind's ref", () => {
    expect(parsePoolAskRef(poolAskRef("m1"))).toBe("m1");
    expect(parsePoolAskRef("xask:a1")).toBeNull();
    expect(parsePoolAskRef("teams:m1")).toBeNull();
    expect(parsePoolAskRef("pool:")).toBeNull();
  });
});

describe("what the router is told is waiting", () => {
  it("the pool notice: a YES to ask nearby players from the pool, for the game's day", () => {
    const lines = organisersContext({ pending: [{ ...POOL, day: "Tue 27 Oct", askedAt: at(0) }], recent: [] });
    expect(lines[0]).toMatch(/^WAITING: YES to ask nearby players from the MatchTime player pool for Tue 27 Oct, asked at \d\d:\d\d\.$/);
  });

  it("names no number, area or player (only what the notice already said)", () => {
    const lines = organisersContext({ pending: [{ ...POOL, day: "Tue 27 Oct", askedAt: at(0) }], recent: [] });
    expect(lines.join("\n")).not.toMatch(/\+?\d{6,}|miles|SM\d/);
  });
});

describe("a YES about the pool notice, by the safe-YES rule", () => {
  const log = [row({ askRef: POOL.ref, text: NOTICE, createdAt: at(0) })];

  it("the next message after the notice, within the window, approves the pool ask", () => {
    expect(decideApproval({ pending: [POOL], quoted: null, log, now: at(3) })).toEqual({ kind: "approve", item: POOL, why: "next-message" });
  });

  it("a reply quoting the notice approves it", () => {
    expect(decideApproval({ pending: [POOL], quoted: { text: NOTICE, fromMatchTime: true }, log, now: at(40) })).toMatchObject({ kind: "approve", item: POOL, why: "quoted" });
  });

  it("after other talk, MatchTime asks once", () => {
    const talk = [...log, row({ fromMatchTime: false, senderUserId: "u2", text: "who has the bibs?", createdAt: at(1) })];
    expect(decideApproval({ pending: [POOL], quoted: null, log: talk, now: at(3) })).toEqual({ kind: "ask", item: POOL });
  });

  it("the pool notice and the teams both waiting, unquoted after talk: asks which", () => {
    const talk = [row({ askRef: "teams:m1", createdAt: at(-5) }), ...log, row({ fromMatchTime: false, senderUserId: "u2", text: "hm", createdAt: at(1) })];
    expect(decideApproval({ pending: [TEAMS, POOL], quoted: null, log: talk, now: at(3) }).kind).toBe("ask-which");
  });

  it("another item asked about last: the next message approves THAT, never the pool", () => {
    const later = [...log, row({ askRef: TEAMS.ref, text: "📝 Proposed teams", createdAt: at(1) })];
    expect(decideApproval({ pending: [POOL, TEAMS], quoted: null, log: later, now: at(2) })).toEqual({ kind: "approve", item: TEAMS, why: "next-message" });
  });
});
