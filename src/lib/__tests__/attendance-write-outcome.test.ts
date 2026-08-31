/**
 * The honest-ack rule for the GROUP path, as pure logic.
 *
 * The one thing these tests exist to pin: a confirmation is NEVER sent
 * for a write that did not land, and an apology is NEVER sent for a
 * write that legitimately did nothing (an OUT from someone who was
 * never down, a repeat IN from a confirmed player).
 */
import { describe, it, expect } from "vitest";
import {
  resolveAttendanceAck,
  buildAttendanceFailureReply,
  attendanceFailureAction,
  attendanceFailureLog,
  parseAttendanceFailureAction,
  describeAttendanceFailure,
  type AttendanceWriteFailure,
} from "../attendance-write-outcome";

const selfIn: AttendanceWriteFailure = {
  action: "IN",
  who: null,
  error: "connect ECONNREFUSED",
};
const selfOut: AttendanceWriteFailure = {
  action: "OUT",
  who: null,
  error: "connect ECONNREFUSED",
};

describe("resolveAttendanceAck", () => {
  it("passes a successful write through completely unchanged", () => {
    const ack = resolveAttendanceAck({
      failures: [],
      react: "✅",
      reply: "You're in Ian, squad is 5/5 💪",
      senderName: "Ian Innes",
    });
    expect(ack.failed).toBe(false);
    expect(ack.react).toBe("✅");
    expect(ack.reply).toBe("You're in Ian, squad is 5/5 💪");
  });

  it("passes a legitimate no-op through unchanged (OUT with no row)", () => {
    // The route returns react:null / reply:null for this case BEFORE
    // any write is attempted. No failure, so no apology.
    const ack = resolveAttendanceAck({
      failures: [],
      react: null,
      reply: null,
      senderName: "Pat Player",
    });
    expect(ack.failed).toBe(false);
    expect(ack.reply).toBeNull();
    expect(ack.react).toBeNull();
  });

  it("passes an idempotent repeat IN through unchanged (still a success)", () => {
    // registerAttendance is idempotent: a second IN from a CONFIRMED
    // player returns CONFIRMED and throws nothing. That is a success,
    // not a failure — same cheerful tick as the first time.
    const ack = resolveAttendanceAck({
      failures: [],
      react: "✅",
      reply: null,
      senderName: "Pat Player",
    });
    expect(ack.failed).toBe(false);
    expect(ack.react).toBe("✅");
  });

  it("drops the cheerful confirmation when the write threw", () => {
    const ack = resolveAttendanceAck({
      failures: [selfIn],
      react: "✅",
      reply: "You're in Ian, squad is 5/5 💪",
      senderName: "Ian Innes",
    });
    expect(ack.failed).toBe(true);
    expect(ack.react).toBeNull();
    expect(ack.reply).not.toContain("You're in");
    expect(ack.reply).toContain("not on the list");
  });

  it("still speaks when the LLM was going to say nothing at all", () => {
    // A silent ✅ is just as much a lie as a cheerful sentence.
    const ack = resolveAttendanceAck({
      failures: [selfIn],
      react: "✅",
      reply: null,
      senderName: null,
    });
    expect(ack.failed).toBe(true);
    expect(ack.reply).toBeTruthy();
    expect(ack.react).toBeNull();
  });
});

describe("buildAttendanceFailureReply", () => {
  it("tells an IN they are NOT on the list", () => {
    const t = buildAttendanceFailureReply([selfIn], "Ian Innes");
    expect(t).toContain("Ian");
    expect(t).toContain("not on the list");
    expect(t.toLowerCase()).not.toContain("you're in");
  });

  it("tells an OUT they are STILL down as playing", () => {
    const t = buildAttendanceFailureReply([selfOut], "Pat Player");
    expect(t).toContain("still down as playing");
  });

  it("names the third party when someone else's change failed", () => {
    const t = buildAttendanceFailureReply(
      [{ action: "IN", who: "Najib", error: "boom" }],
      "Wasim W",
    );
    expect(t).toContain("Najib");
    expect(t).toContain("hasn't changed");
  });

  it("covers both when the sender's own change AND a third party failed", () => {
    const t = buildAttendanceFailureReply([selfOut, { action: "IN", who: "Najib", error: "boom" }], "Wasim");
    expect(t).toContain("still down as playing");
    expect(t).toContain("Najib");
  });

  it("never prints a raw numeric pushname as a name", () => {
    const t = buildAttendanceFailureReply([selfIn], "447700900009");
    expect(t).not.toContain("447700900009");
    expect(t.startsWith("Sorry,")).toBe(true);
  });

  it("obeys house style: no em dashes, no slashes", () => {
    for (const name of ["Ian Innes", null]) {
      for (const failures of [[selfIn], [selfOut], [{ action: "BENCH" as const, who: "Tom", error: "x" }]]) {
        const t = buildAttendanceFailureReply(failures, name);
        expect(t).not.toContain("—");
        expect(t).not.toContain("–");
        expect(t).not.toContain("/");
      }
    }
  });

  it("stays short enough for a group message", () => {
    expect(buildAttendanceFailureReply([selfIn], "Ian Innes").length).toBeLessThan(220);
  });
});

describe("attendanceFailureAction", () => {
  it("records what actually happened, not what was intended", () => {
    expect(attendanceFailureAction([selfIn])).toBe("attendance-failed:IN");
    expect(attendanceFailureAction([selfOut])).toBe("attendance-failed:OUT");
  });

  it("names the third party whose write failed", () => {
    expect(attendanceFailureAction([{ action: "IN", who: "Najib", error: "x" }])).toBe(
      "attendance-failed:IN:Najib",
    );
  });

  it("lists every failure in one batch", () => {
    expect(
      attendanceFailureAction([selfOut, { action: "IN", who: "Najib", error: "x" }]),
    ).toBe("attendance-failed:OUT,IN:Najib");
  });

  it("never exceeds a sane column length", () => {
    const many: AttendanceWriteFailure[] = Array.from({ length: 40 }, (_, i) => ({
      action: "IN" as const,
      who: `Player Number ${i}`,
      error: "x",
    }));
    expect(attendanceFailureAction(many).length).toBeLessThanOrEqual(200);
  });
});

describe("attendanceFailureLog", () => {
  it("is a CRITICAL line and carries the underlying error", () => {
    const line = attendanceFailureLog([selfIn]);
    expect(line).toContain("CRITICAL");
    expect(line).toContain("IN");
    expect(line).toContain("connect ECONNREFUSED");
  });

  it("names every failed target in the batch", () => {
    const line = attendanceFailureLog([selfOut, { action: "IN", who: "Najib", error: "boom" }]);
    expect(line).toContain("Najib");
    expect(line).toContain("boom");
  });
});

describe("parseAttendanceFailureAction", () => {
  it("round-trips what attendanceFailureAction wrote", () => {
    const failures: AttendanceWriteFailure[] = [
      { action: "OUT", who: null, error: "x" },
      { action: "IN", who: "Najib", error: "x" },
    ];
    expect(parseAttendanceFailureAction(attendanceFailureAction(failures))).toEqual([
      { action: "OUT", who: null },
      { action: "IN", who: "Najib" },
    ]);
  });

  it("ignores anything that isn't a failure marker", () => {
    expect(parseAttendanceFailureAction("IN")).toEqual([]);
    expect(parseAttendanceFailureAction(null)).toEqual([]);
    expect(parseAttendanceFailureAction("react")).toEqual([]);
  });

  it("survives a truncated value without inventing an action", () => {
    expect(parseAttendanceFailureAction("attendance-failed:IN,OU")).toEqual([
      { action: "IN", who: null },
    ]);
  });
});

describe("describeAttendanceFailure", () => {
  it("reads as plain English for an admin", () => {
    expect(describeAttendanceFailure([{ action: "IN", who: null }], "Ian Innes")).toBe(
      "Ian Innes tried to join",
    );
    expect(describeAttendanceFailure([{ action: "OUT", who: null }], "Pat")).toBe(
      "Pat tried to drop out",
    );
    expect(describeAttendanceFailure([{ action: "IN", who: "Najib" }], "Wasim")).toBe(
      "Wasim tried to add Najib",
    );
    expect(describeAttendanceFailure([{ action: "BENCH", who: "Tom" }], "Alex")).toBe(
      "Alex tried to bench Tom",
    );
  });

  it("falls back gracefully with no name and no parsed target", () => {
    expect(describeAttendanceFailure([], null)).toBe("An attendance change failed");
  });
});
