/**
 * Routine ops alerts go to a table, never to anybody's phone or inbox.
 *
 * These are the pure halves of `src/lib/ops-alerts.ts`: how an hourly
 * health check turns into rows (open, keep open, close), and how the
 * owner's dashboard summarises a club in one word.
 */
import { describe, it, expect } from "vitest";
import {
  alertKindLabel,
  HEALTH_KIND_PREFIX,
  OPERATOR_NOTE_KIND,
  clubStatus,
  healthKind,
  isActiveAlert,
  planHealthRecord,
  type HealthFindingLike,
  type OpenHealthAlert,
} from "../ops-alerts";

const NOW = new Date("2026-09-28T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const finding = (over: Partial<HealthFindingLike> = {}): HealthFindingLike => ({
  code: "inbound-silent",
  severity: "warning",
  headline: "No messages for 31 hours.",
  detail: "The group may just be quiet.",
  ...over,
});

describe("planHealthRecord", () => {
  it("opens a row for a finding nobody has recorded yet", () => {
    const plan = planHealthRecord({ open: [], findings: [finding()], now: NOW });
    expect(plan.create).toEqual([
      {
        kind: "health:inbound-silent",
        severity: "warning",
        title: "No messages for 31 hours.",
        detail: "The group may just be quiet.",
        firstSeenAt: NOW,
      },
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.resolve).toEqual([]);
  });

  it("dates a new row from when the fault began, when the rule knows it", () => {
    const began = new Date(NOW.getTime() - 40 * HOUR);
    const plan = planHealthRecord({
      open: [],
      findings: [finding({ brokenSince: began })],
      now: NOW,
    });
    expect(plan.create[0].firstSeenAt).toEqual(began);
  });

  it("never dates a row in the future, whatever the rule says", () => {
    const plan = planHealthRecord({
      open: [],
      findings: [finding({ brokenSince: new Date(NOW.getTime() + HOUR) })],
      now: NOW,
    });
    expect(plan.create[0].firstSeenAt).toEqual(NOW);
  });

  it("keeps an existing row open and refreshes its text instead of opening a second one", () => {
    const open: OpenHealthAlert[] = [{ id: "a1", kind: "health:inbound-silent" }];
    const plan = planHealthRecord({
      open,
      findings: [finding({ headline: "No messages for 32 hours." })],
      now: NOW,
    });
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([
      {
        id: "a1",
        severity: "warning",
        title: "No messages for 32 hours.",
        detail: "The group may just be quiet.",
      },
    ]);
    expect(plan.resolve).toEqual([]);
  });

  it("closes a row whose rule no longer holds", () => {
    const open: OpenHealthAlert[] = [
      { id: "a1", kind: "health:inbound-silent" },
      { id: "a2", kind: "health:sweep-stale" },
    ];
    const plan = planHealthRecord({ open, findings: [finding()], now: NOW });
    expect(plan.resolve).toEqual(["a2"]);
  });

  it("closes a duplicate open row rather than leaving two active for one fault", () => {
    const open: OpenHealthAlert[] = [
      { id: "a1", kind: "health:inbound-silent" },
      { id: "a9", kind: "health:inbound-silent" },
    ];
    const plan = planHealthRecord({ open, findings: [finding()], now: NOW });
    expect(plan.update.map((u) => u.id)).toEqual(["a1"]);
    expect(plan.resolve).toEqual(["a9"]);
  });

  it("never touches a row that is not a health condition", () => {
    const open: OpenHealthAlert[] = [{ id: "n1", kind: OPERATOR_NOTE_KIND }];
    const plan = planHealthRecord({ open, findings: [], now: NOW });
    expect(plan.resolve).toEqual([]);
  });

  it("does nothing at all for a healthy club with nothing open", () => {
    expect(planHealthRecord({ open: [], findings: [], now: NOW })).toEqual({
      create: [],
      update: [],
      resolve: [],
    });
  });
});

describe("healthKind", () => {
  it("namespaces a health code so it cannot collide with an event kind", () => {
    expect(healthKind("pi-silent")).toBe(`${HEALTH_KIND_PREFIX}pi-silent`);
  });
});

describe("isActiveAlert", () => {
  it("counts an open health condition as active", () => {
    expect(isActiveAlert({ kind: "health:pi-silent", resolvedAt: null })).toBe(true);
  });
  it("does not count a closed one", () => {
    expect(isActiveAlert({ kind: "health:pi-silent", resolvedAt: NOW })).toBe(false);
  });
  it("never counts a one-off event as active, even if it was stored open", () => {
    expect(isActiveAlert({ kind: OPERATOR_NOTE_KIND, resolvedAt: null })).toBe(false);
  });
});

describe("clubStatus", () => {
  it("is OK with nothing active", () => {
    expect(clubStatus([])).toBe("ok");
    expect(
      clubStatus([{ kind: "health:pi-silent", severity: "critical", resolvedAt: NOW }]),
    ).toBe("ok");
  });

  it("is a warning when only warnings are active", () => {
    expect(
      clubStatus([{ kind: "health:inbound-silent", severity: "warning", resolvedAt: null }]),
    ).toBe("warning");
  });

  it("is a problem when anything critical is active", () => {
    expect(
      clubStatus([
        { kind: "health:inbound-silent", severity: "warning", resolvedAt: null },
        { kind: "health:pi-silent", severity: "critical", resolvedAt: null },
      ]),
    ).toBe("problem");
  });

  it("ignores one-off events: a note from this morning does not make a club red", () => {
    expect(
      clubStatus([{ kind: OPERATOR_NOTE_KIND, severity: "warning", resolvedAt: null }]),
    ).toBe("ok");
  });
});

describe("alertKindLabel", () => {
  it("gives every health code a plain English name", () => {
    const codes = [
      "pi-silent",
      "seen-not-buffered",
      "messages-dropped",
      "synthetic-ids",
      "enrichment-degraded",
      "nameless-senders",
      "reactions-failing",
      "capability-degraded",
      "sweep-stale",
      "none-shadow-stale",
      "inbound-silent",
    ];
    for (const c of codes) {
      const label = alertKindLabel(healthKind(c));
      expect(label, c).not.toContain(c);
      expect(label, c).not.toMatch(/[—–]/);
    }
    expect(alertKindLabel(healthKind("inbound-silent"))).toBe("Group quiet before a match");
  });

  it("names an operator note", () => {
    expect(alertKindLabel(OPERATOR_NOTE_KIND)).toBe("Message not handled");
  });

  it("falls back to the raw kind for something this build has never heard of", () => {
    expect(alertKindLabel("health:brand-new")).toBe("brand-new");
  });
});
