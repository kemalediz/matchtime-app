/**
 * THE LATE-MESSAGE GATE (Sutton FC, 2026-09-29).
 *
 * The admin's "@Match Time generate the teams. Put me on red team." was
 * sent at ~11:30 UTC, could not be decrypted, and a readable copy only
 * reached MatchTime at 22:00:38 UTC, after the match. It was processed as
 * fresh and the group was told "I'll build the teams on match day".
 *
 * The rule (Kemal approved): a message whose ORIGINAL WhatsApp timestamp
 * is more than 30 minutes old when it reaches analysis records attendance
 * silently and executes nothing else. These are the pure halves.
 */
import { describe, it, expect } from "vitest";
import {
  LATE_MESSAGE_AFTER_MS,
  composeLateMessageAlert,
  formatDelay,
  lateRouteAllowed,
  planLateMessages,
  silenceLateResult,
} from "../late-message";
import { ALL_ROUTES, type Route } from "../pipeline/types";
import { LATE_MESSAGE_KIND, alertKindLabel, isActiveAlert } from "../ops-alerts";

const NOW = new Date("2026-09-29T22:00:38Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

describe("planLateMessages: the age gate", () => {
  it("the threshold is 30 minutes", () => {
    expect(LATE_MESSAGE_AFTER_MS).toBe(30 * MIN);
  });

  it("THE INCIDENT: a copy sent 10.5 hours ago is late", () => {
    const plan = planLateMessages({
      messages: [{ waMessageId: "a", timestamp: "2026-09-29T11:30:00Z" }],
      now: NOW,
      kickoffs: [],
    });
    expect(plan.late.get("a")?.ageMs).toBe(NOW.getTime() - Date.parse("2026-09-29T11:30:00Z"));
  });

  it("a fresh message, one sent 29 minutes ago, and one exactly 30 minutes ago are not late", () => {
    const plan = planLateMessages({
      messages: [
        { waMessageId: "now", timestamp: ago(0) },
        { waMessageId: "29", timestamp: ago(29 * MIN) },
        { waMessageId: "30", timestamp: ago(30 * MIN) },
      ],
      now: NOW,
      kickoffs: [],
    });
    expect(plan.late.size).toBe(0);
  });

  it("31 minutes is late", () => {
    const plan = planLateMessages({
      messages: [{ waMessageId: "31", timestamp: ago(31 * MIN) }],
      now: NOW,
      kickoffs: [],
    });
    expect(plan.late.has("31")).toBe(true);
  });

  it("an unreadable, missing or future timestamp is never late (fail open to today's behaviour)", () => {
    const plan = planLateMessages({
      messages: [
        { waMessageId: "junk", timestamp: "not a date" },
        { waMessageId: "missing", timestamp: undefined },
        { waMessageId: "future", timestamp: new Date(NOW.getTime() + 5 * MIN).toISOString() },
      ],
      now: NOW,
      kickoffs: [],
    });
    expect(plan.late.size).toBe(0);
  });

  it("accepts epoch seconds and epoch milliseconds as well as ISO", () => {
    const sec = Math.floor((NOW.getTime() - 2 * 60 * MIN) / 1000);
    const plan = planLateMessages({
      messages: [
        { waMessageId: "sec", timestamp: sec },
        { waMessageId: "ms", timestamp: NOW.getTime() - 2 * 60 * MIN },
      ],
      now: NOW,
      kickoffs: [],
    });
    expect(plan.late.has("sec")).toBe(true);
    expect(plan.late.has("ms")).toBe(true);
  });

  it("a late message is blocked from attendance when a match kicked off between sending and now", () => {
    const kickoff = new Date("2026-09-29T19:30:00Z");
    const plan = planLateMessages({
      messages: [
        { waMessageId: "before", timestamp: "2026-09-29T11:30:00Z" },
        // Sent after that kickoff: it is about the NEXT match, so it is
        // only late, not blocked.
        { waMessageId: "after", timestamp: "2026-09-29T21:00:00Z" },
      ],
      now: NOW,
      kickoffs: [kickoff, new Date("2026-10-06T19:30:00Z")],
    });
    expect(plan.late.get("before")?.kickedOffAt?.toISOString()).toBe(kickoff.toISOString());
    expect(plan.late.get("after")?.kickedOffAt).toBeNull();
  });

  it("a fresh message is never blocked, whatever kicked off", () => {
    const plan = planLateMessages({
      messages: [{ waMessageId: "f", timestamp: ago(5 * MIN) }],
      now: NOW,
      kickoffs: [new Date(NOW.getTime() - 2 * MIN)],
    });
    expect(plan.late.size).toBe(0);
  });
});

describe("lateRouteAllowed: the age gate on each route kind", () => {
  const expected: Record<Route, boolean> = {
    self_att: true,
    other_att: true,
    offer: true,
    unsure: true,
    none: false,
    question: false,
    balancer: false,
    score: false,
    admin_ops: false,
  };
  for (const route of ALL_ROUTES) {
    it(`${route} → ${expected[route] ? "attendance, recorded silently" : "not executed"}`, () => {
      expect(lateRouteAllowed(route)).toBe(expected[route]);
    });
  }
  it("an unrouted message is not executed", () => {
    expect(lateRouteAllowed(undefined)).toBe(false);
  });
});

describe("silenceLateResult: what a late message may still say", () => {
  it("keeps a registration react so the player can see it was counted, and drops the reply", () => {
    for (const react of ["✅", "🪑", "👋"]) {
      expect(silenceLateResult({ react, reply: "You're in!" })).toEqual({ react, reply: null });
    }
  });
  it("drops every other react", () => {
    for (const react of ["👍", "📩", "👋🏻", "🤔", "📊"]) {
      expect(silenceLateResult({ react, reply: null }).react).toBeNull();
    }
  });
  it("leaves other fields alone", () => {
    const r = silenceLateResult({ waMessageId: "x", intent: "in", react: "✅", reply: "hi" });
    expect(r).toEqual({ waMessageId: "x", intent: "in", react: "✅", reply: null });
  });
});

describe("formatDelay", () => {
  it.each([
    [31 * MIN, "31m"],
    [60 * MIN, "1h"],
    [10 * 60 * MIN + 30 * MIN + 38_000, "10h 30m"],
    [26 * 60 * MIN, "1d 2h"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDelay(ms)).toBe(text);
  });
});

describe("composeLateMessageAlert: the /admin/health record", () => {
  it("is null for no late messages", () => {
    expect(composeLateMessageAlert([])).toBeNull();
  });

  it("names the delay, the author, the words and what happened, with no em dashes", () => {
    const alert = composeLateMessageAlert([
      {
        waMessageId: "3B878B2822E41994AF38",
        authorName: null,
        body: "@Match Time generate the teams. Put me on red team.",
        ageMs: 10 * 60 * MIN + 30 * MIN,
        outcome: "not-executed",
        route: "balancer",
      },
      {
        waMessageId: "m2",
        authorName: "Pat Player",
        body: "in",
        ageMs: 45 * MIN,
        outcome: "attendance-recorded",
        route: "self_att",
      },
    ])!;
    expect(alert.title).toBe("2 messages arrived late and were not answered");
    expect(alert.detail).toContain("10h 30m late");
    expect(alert.detail).toContain("unknown sender");
    expect(alert.detail).toContain("generate the teams");
    expect(alert.detail).toContain("not executed");
    expect(alert.detail).toContain("Pat Player");
    expect(alert.detail).toContain("attendance recorded");
    expect(alert.title + alert.detail).not.toMatch(/[—–]/);
    expect(alert.dedupeKey).toContain("3B878B2822E41994AF38");
  });

  it("says why a blocked attendance change was not recorded", () => {
    const alert = composeLateMessageAlert([
      {
        waMessageId: "x",
        authorName: "Pat Player",
        body: "out",
        ageMs: 3 * 60 * MIN,
        outcome: "match-kicked-off",
        route: undefined,
      },
    ])!;
    expect(alert.title).toBe("1 message arrived late and was not answered");
    expect(alert.detail).toContain("a match kicked off");
  });

  it("the dedupe key is stable for the same set of messages in any order", () => {
    const e = (id: string) => ({
      waMessageId: id,
      authorName: null,
      body: "x",
      ageMs: 40 * MIN,
      outcome: "not-executed" as const,
      route: "question" as const,
    });
    expect(composeLateMessageAlert([e("a"), e("b")])!.dedupeKey).toBe(
      composeLateMessageAlert([e("b"), e("a")])!.dedupeKey,
    );
  });
});

describe("the ops-alert kind", () => {
  it("is an event with a plain-English label, so it never shows as an open problem", () => {
    expect(LATE_MESSAGE_KIND).toBe("late-message");
    expect(alertKindLabel(LATE_MESSAGE_KIND)).toBe("Late message");
    expect(isActiveAlert({ kind: LATE_MESSAGE_KIND, resolvedAt: null })).toBe(false);
  });
});
