/**
 * The DM pacing RULES (slice L5a, approved 24 Oct 2026): pure, no clock, no
 * disk. "About 10 seconds between private messages (up to six a minute, up
 * from one), with a small random spread. One global setting for every DM.
 * A new number starts at one a minute for its first two weeks; the setting
 * drops back to one a minute at once if WhatsApp shows any warning."
 *
 * Until the env is set the bot behaves exactly as before: 60 s, no spread.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DM_PACING,
  MAX_GAP_MS,
  MIN_GAP_MS,
  SAFE_GAP_MS,
  WARM_UP_MS,
  WARNING_COOL_DOWN_MS,
  decideInTick,
  effectiveGap,
  initialPacingState,
  noteWarning,
  parsePersistedWarning,
  persistWarning,
  resolveDmPacingConfig,
  slotWaitMs,
  takeSlot,
  warningFromAckError,
  warningFromCloseStatus,
  warningFromReachoutTimelock,
  warningFromSendError,
  warningFromWwebjsDisconnect,
  type DmPacingConfig,
} from "./dm-pacing.js";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const LONG_AGO = Date.parse("2026-04-01T00:00:00Z");

const FAST: DmPacingConfig = { gapMs: 10_000, jitterMs: 3_000, numberStartedAtMs: LONG_AGO };

describe("resolveDmPacingConfig: env, read once, safe by default", () => {
  it("no env at all is today's behaviour: 60 s, no spread, no problems", () => {
    const r = resolveDmPacingConfig({});
    expect(r.config).toEqual(DEFAULT_DM_PACING);
    expect(r.config).toEqual({ gapMs: 60_000, jitterMs: 0, numberStartedAtMs: null });
    expect(r.problems).toEqual([]);
  });

  it("reads DM_GAP_SEC, DM_GAP_JITTER_SEC and DM_NUMBER_STARTED_AT", () => {
    const r = resolveDmPacingConfig({
      DM_GAP_SEC: "10",
      DM_GAP_JITTER_SEC: "3",
      DM_NUMBER_STARTED_AT: "2026-04-01",
    });
    expect(r.config).toEqual({ gapMs: 10_000, jitterMs: 3_000, numberStartedAtMs: LONG_AGO });
    expect(r.problems).toEqual([]);
  });

  it.each([
    ["abc"],
    ["0"],
    ["-5"],
    ["6"], // below the 7 s floor
    ["61"], // slower than one a minute is not a pacing setting
    ["NaN"],
    ["Infinity"],
  ])("a bad DM_GAP_SEC (%s) falls back to 60 s and says so", (v) => {
    const r = resolveDmPacingConfig({ DM_GAP_SEC: v, DM_NUMBER_STARTED_AT: "2026-04-01" });
    expect(r.config.gapMs).toBe(SAFE_GAP_MS);
    expect(r.problems.join(" ")).toContain("DM_GAP_SEC");
  });

  it.each([["x"], ["-1"], ["31"]])("a bad DM_GAP_JITTER_SEC (%s) falls back to no spread and says so", (v) => {
    const r = resolveDmPacingConfig({ DM_GAP_SEC: "10", DM_GAP_JITTER_SEC: v });
    expect(r.config.jitterMs).toBe(0);
    expect(r.problems.join(" ")).toContain("DM_GAP_JITTER_SEC");
  });

  it("a bad DM_NUMBER_STARTED_AT is no start date (so one a minute) and says so", () => {
    const r = resolveDmPacingConfig({ DM_GAP_SEC: "10", DM_NUMBER_STARTED_AT: "last spring" });
    expect(r.config.numberStartedAtMs).toBeNull();
    expect(r.problems.join(" ")).toContain("DM_NUMBER_STARTED_AT");
  });

  it("blank values are unset, not errors", () => {
    const r = resolveDmPacingConfig({ DM_GAP_SEC: " ", DM_GAP_JITTER_SEC: "", DM_NUMBER_STARTED_AT: "" });
    expect(r.config).toEqual(DEFAULT_DM_PACING);
    expect(r.problems).toEqual([]);
  });
});

describe("effectiveGap: which gap applies right now", () => {
  const state = initialPacingState();

  it("the default config is 60 s", () => {
    expect(effectiveGap(DEFAULT_DM_PACING, state, NOW)).toEqual({ baseMs: 60_000, jitterMs: 0, reason: "default" });
  });

  it("10 s with a spread once configured and past the warm-up", () => {
    expect(effectiveGap(FAST, state, NOW)).toEqual({ baseMs: 10_000, jitterMs: 3_000, reason: "configured" });
  });

  it("a fast gap with NO start date stays at 60 s: we cannot know the number is past its first two weeks", () => {
    const g = effectiveGap({ ...FAST, numberStartedAtMs: null }, state, NOW);
    expect(g.baseMs).toBe(SAFE_GAP_MS);
    expect(g.reason).toBe("no-start-date");
  });

  it("warm-up: 60 s for the first 14 days of the number, 10 s after", () => {
    const started = NOW - 3 * DAY;
    const cfg = { ...FAST, numberStartedAtMs: started };
    expect(effectiveGap(cfg, state, NOW)).toMatchObject({ baseMs: 60_000, reason: "warm-up" });
    expect(effectiveGap(cfg, state, started + WARM_UP_MS - 1)).toMatchObject({ baseMs: 60_000, reason: "warm-up" });
    expect(effectiveGap(cfg, state, started + WARM_UP_MS)).toMatchObject({ baseMs: 10_000, reason: "configured" });
    expect(WARM_UP_MS).toBe(14 * DAY);
  });

  it("a start date in the future is treated as a brand-new number (60 s)", () => {
    expect(effectiveGap({ ...FAST, numberStartedAtMs: NOW + DAY }, state, NOW).baseMs).toBe(60_000);
  });

  it("a warning drops to 60 s AT ONCE, stays through the 24 h cool-down, and the fast gap returns after", () => {
    const warned = noteWarning(state, NOW, { source: "test", detail: "x" });
    expect(effectiveGap(FAST, warned, NOW)).toMatchObject({ baseMs: 60_000, reason: "warning" });
    expect(effectiveGap(FAST, warned, NOW + WARNING_COOL_DOWN_MS - 1).baseMs).toBe(60_000);
    expect(effectiveGap(FAST, warned, NOW + WARNING_COOL_DOWN_MS)).toMatchObject({ baseMs: 10_000, reason: "configured" });
    expect(WARNING_COOL_DOWN_MS).toBe(24 * 3_600_000);
  });

  it("a later warning restarts the cool-down", () => {
    const first = noteWarning(state, NOW, { source: "a", detail: "" });
    const second = noteWarning(first, NOW + 20 * 3_600_000, { source: "b", detail: "" });
    expect(effectiveGap(FAST, second, NOW + 30 * 3_600_000).baseMs).toBe(60_000);
  });
});

describe("takeSlot and slotWaitMs: the gap after each DM", () => {
  it("the first DM goes at once", () => {
    expect(slotWaitMs(FAST, initialPacingState(), NOW)).toBe(0);
  });

  it("default: the next DM waits exactly 60 s, no spread whatever the random source says", () => {
    for (const r of [0, 0.5, 0.999]) {
      const s = takeSlot(DEFAULT_DM_PACING, initialPacingState(), NOW, () => r);
      expect(s.gapAfterLastMs).toBe(60_000);
      expect(slotWaitMs(DEFAULT_DM_PACING, s, NOW)).toBe(60_000);
      expect(slotWaitMs(DEFAULT_DM_PACING, s, NOW + 59_999)).toBe(1);
      expect(slotWaitMs(DEFAULT_DM_PACING, s, NOW + 60_000)).toBe(0);
    }
  });

  it("configured: 10 s plus or minus 3 s, the spread drawn from the random source", () => {
    expect(takeSlot(FAST, initialPacingState(), NOW, () => 0).gapAfterLastMs).toBe(7_000);
    expect(takeSlot(FAST, initialPacingState(), NOW, () => 0.5).gapAfterLastMs).toBe(10_000);
    expect(takeSlot(FAST, initialPacingState(), NOW, () => 0.9999999).gapAfterLastMs).toBe(13_000);
  });

  it("the spread is clamped: never below the 7 s floor, never above 60 s", () => {
    const wide: DmPacingConfig = { gapMs: 8_000, jitterMs: 30_000, numberStartedAtMs: LONG_AGO };
    for (let i = 0; i <= 100; i++) {
      const g = takeSlot(wide, initialPacingState(), NOW, () => i / 100).gapAfterLastMs;
      expect(g).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(g).toBeLessThanOrEqual(MAX_GAP_MS);
    }
    expect(MIN_GAP_MS).toBe(7_000);
    expect(MAX_GAP_MS).toBe(60_000);
  });

  it("a warning that lands after a fast DM makes the NEXT one wait the full 60 s", () => {
    const sent = takeSlot(FAST, initialPacingState(), NOW, () => 0.5);
    expect(slotWaitMs(FAST, sent, NOW + 5_000)).toBe(5_000);
    const warned = noteWarning(sent, NOW + 5_000, { source: "t", detail: "" });
    expect(slotWaitMs(FAST, warned, NOW + 5_000)).toBe(55_000);
  });
});

describe("decideInTick: send now, wait inside the tick, or hold (release)", () => {
  const base = { waitMs: 0, gapMs: 10_000, budgetLeftMs: 25_000, heldAlready: false };

  it("an open slot sends", () => {
    expect(decideInTick(base)).toEqual({ action: "send" });
  });

  it("a slot due within the gap and the tick's budget is awaited", () => {
    expect(decideInTick({ ...base, waitMs: 9_000 })).toEqual({ action: "wait", ms: 9_000 });
  });

  it("a wait longer than the budget left is held", () => {
    expect(decideInTick({ ...base, waitMs: 9_000, budgetLeftMs: 8_000 }).action).toBe("hold");
  });

  it("a wait longer than the gap is held", () => {
    expect(decideInTick({ ...base, waitMs: 11_000 }).action).toBe("hold");
  });

  it("at the 60 s safe gap nothing waits inside a tick: exactly the old held-and-released behaviour", () => {
    expect(decideInTick({ ...base, gapMs: 60_000, waitMs: 1_000 }).action).toBe("hold");
    expect(decideInTick({ ...base, gapMs: 60_000, waitMs: 0 }).action).toBe("send");
  });

  it("once a DM was held in this tick, every later one is held too, so the server's order is kept", () => {
    expect(decideInTick({ ...base, heldAlready: true }).action).toBe("hold");
  });
});

describe("the persisted warning survives a restart", () => {
  it("round-trips through the JSON shape", () => {
    const warned = noteWarning(initialPacingState(), NOW, { source: "baileys:close", detail: "status 403" });
    const restored = parsePersistedWarning(JSON.parse(JSON.stringify(persistWarning(warned))));
    expect(restored).toEqual({ atMs: NOW, source: "baileys:close", detail: "status 403" });
  });

  it.each([[null], [undefined], ["x"], [{}], [{ lastWarningAtIso: "nope" }], [[1, 2]]])(
    "a missing or corrupt file (%j) is no warning, never a crash",
    (raw) => {
      expect(parsePersistedWarning(raw)).toBeNull();
    },
  );
});

describe("warning signals the code can actually see", () => {
  it("Baileys closes: 401 logged out and 403 forbidden are warnings; a blip is not", () => {
    expect(warningFromCloseStatus(401)?.source).toBe("baileys:close");
    expect(warningFromCloseStatus(403)?.detail).toContain("403");
    for (const s of [undefined, 408, 428, 440, 500, 515]) expect(warningFromCloseStatus(s)).toBeNull();
  });

  it("Baileys reach-out timelock: active is a warning, lifted is not", () => {
    expect(warningFromReachoutTimelock({ isActive: true, enforcementType: "DEFAULT" })?.source).toBe(
      "baileys:reachout-timelock",
    );
    expect(warningFromReachoutTimelock({ isActive: false })).toBeNull();
    expect(warningFromReachoutTimelock(undefined)).toBeNull();
  });

  it("Baileys bad ack on our own message: 463 (account restricted) is a warning, 479 is not", () => {
    expect(warningFromAckError(["463"])?.source).toBe("baileys:ack-463");
    expect(warningFromAckError(["463", "account restricted"])).not.toBeNull();
    expect(warningFromAckError(["479"])).toBeNull();
    expect(warningFromAckError(undefined)).toBeNull();
  });

  it("send errors: rate-overlimit, 429, 463 and spam are warnings; ordinary failures are not", () => {
    const boom = (message: string, statusCode?: number) =>
      Object.assign(new Error(message), statusCode ? { output: { statusCode } } : {});
    expect(warningFromSendError(boom("rate-overlimit", 429))).not.toBeNull();
    expect(warningFromSendError(boom("whatever", 429))).not.toBeNull();
    expect(warningFromSendError(boom("rate-overlimit"))).not.toBeNull();
    expect(warningFromSendError(boom("error 463"))).not.toBeNull();
    expect(warningFromSendError(boom("flagged as spam"))).not.toBeNull();
    for (const e of [
      boom("not on WhatsApp"),
      boom("DM send to 447700900000 timed out after 30000ms"),
      boom("forbidden", 403), // a group we may not post in, not an account warning
      boom("item-not-found", 404),
      "plain string",
      undefined,
    ]) {
      expect(warningFromSendError(e)).toBeNull();
    }
  });

  it("whatsapp-web.js disconnect reasons: TOS blocks, logout and unpairing are warnings", () => {
    for (const r of ["TOS_BLOCK", "SMB_TOS_BLOCK", "LOGOUT", "UNPAIRED"]) {
      expect(warningFromWwebjsDisconnect(r)?.source).toBe("wwebjs:disconnected");
    }
    for (const r of ["CONFLICT", "NAVIGATION", "Max qrcode retries reached", ""]) {
      expect(warningFromWwebjsDisconnect(r)).toBeNull();
    }
  });
});
