/**
 * F3, learned setup: the settings panel's data, the one-tap Undo and the
 * owner's line on /admin/clubs. Mocked database, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ org: {} as Row, learning: null as Row | null, updates: [] as Array<{ where: Row; data: Row }> }));
const dbMock = vi.hoisted(() => ({
  organisation: {
    findUnique: vi.fn(async () => ({ ...state.org })),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      state.updates.push(args);
      for (const [k, v] of Object.entries(args.where)) {
        if (k === "id" || k === "approvalStatus") continue;
        if (state.org[k] !== v) return { count: 0 };
      }
      const { settingsSetByOrganiser, ...rest } = args.data as Row & { settingsSetByOrganiser: { push: string } };
      Object.assign(state.org, rest);
      state.org.settingsSetByOrganiser = [...((state.org.settingsSetByOrganiser as string[]) ?? []), settingsSetByOrganiser.push];
      return { count: 1 };
    }),
  },
  clubSetupLearning: {
    findUnique: vi.fn(async () => (state.learning ? { ...state.learning } : null)),
    update: vi.fn(async ({ data }: { data: Row }) => Object.assign(state.learning!, data)),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadLearnedSetupView, undoLearnedSetting } from "../view";
import { ownerLearningSummary } from "../owner-summary";

const ORG = "org-1";
const NOW = new Date("2026-10-05T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = [];
  state.org = {
    rollingSquadEnabled: true,
    benchPickMode: "organiser",
    dropOutDeadlineDay: 1,
    dropOutDeadlineTime: "21:00",
    listPublishDay: null,
    listPublishTime: null,
    paymentTrackingEnabled: false,
    language: "en",
    settingsSetByOrganiser: [],
  };
  state.learning = {
    status: "applied",
    createdAt: NOW,
    applied: [
      { key: "rollingSquad", from: false, to: true, evidence: ["same lot"], undoneAt: null },
      { key: "dropOutDeadline", from: null, to: { day: 1, time: "21:00" }, evidence: ["by Monday 9pm"], undoneAt: null },
      { key: "organiserPicks", from: "first-come", to: "organiser", evidence: ["message me"], undoneAt: "2026-10-05T11:00:00.000Z" },
    ],
    suggestions: [{ key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: [] }],
    noted: [],
  };
});

describe("loadLearnedSetupView", () => {
  it("each switched setting with its state: active, undone, or changed since", async () => {
    state.org.rollingSquadEnabled = false; // the organiser turned it off by hand
    const v = await loadLearnedSetupView(ORG);
    expect(v!.applied.map((a) => [a.key, a.state])).toEqual([
      ["rollingSquad", "changed"],
      ["dropOutDeadline", "active"],
      ["organiserPicks", "undone"],
    ]);
    expect(v!.suggestions).toHaveLength(1);
  });
  it("nothing for a club never read, or read with nothing to show", async () => {
    state.learning = null;
    expect(await loadLearnedSetupView(ORG)).toBeNull();
    state.learning = { status: "skipped", applied: null, suggestions: null, noted: null, createdAt: NOW };
    expect(await loadLearnedSetupView(ORG)).toBeNull();
  });
});

describe("undoLearnedSetting: one tap, never over the organiser's own change", () => {
  it("puts the setting back, records it as the organiser's choice, and marks the item undone", async () => {
    expect(await undoLearnedSetting(ORG, "dropOutDeadline", NOW)).toEqual({ ok: true });
    expect(state.updates[0].where).toMatchObject({ id: ORG, approvalStatus: "approved", dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" });
    expect(state.org).toMatchObject({ dropOutDeadlineDay: null, dropOutDeadlineTime: null, settingsSetByOrganiser: ["dropOutDeadline"] });
    expect((state.learning!.applied as Row[])[1].undoneAt).toBe(NOW.toISOString());
  });
  it("a setting changed since is left alone: changed-since", async () => {
    state.org.rollingSquadEnabled = false;
    expect(await undoLearnedSetting(ORG, "rollingSquad", NOW)).toEqual({ ok: false, reason: "changed-since" });
    expect(state.org.settingsSetByOrganiser).toEqual([]);
  });
  it("twice: already-undone; an unknown key: not-found", async () => {
    expect(await undoLearnedSetting(ORG, "organiserPicks", NOW)).toEqual({ ok: false, reason: "already-undone" });
    expect(await undoLearnedSetting(ORG, "language", NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(await undoLearnedSetting(ORG, "listPublish", NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(state.updates).toEqual([]);
  });
});

describe("ownerLearningSummary (/admin/clubs)", () => {
  it("organisers pick, suggested: the owner sees the chat messages behind it", () => {
    expect(
      ownerLearningSummary({
        status: "nothing",
        reason: null,
        messageCount: 26,
        applied: [],
        kept: [],
        suggestions: [
          { key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: ["Kickoff 8pm"] },
          { key: "organiserPicks", current: "first-come", detected: "organiser", evidence: ["I'll sort the team", "I'll pick someone"] },
        ],
        noted: [],
        costUsd: 0.0068,
        dmQueuedAt: NOW,
      }).line,
    ).toBe(
      `Read 26 messages. Set nothing. Suggested: weeklyGameTime, organiserPicks ("I'll sort the team", "I'll pick someone"). Cost $0.0068. Organiser told.`,
    );
  });
  it("states what was read, set, left alone and suggested, the cost and the DM", () => {
    expect(
      ownerLearningSummary({
        status: "applied",
        reason: null,
        messageCount: 94,
        applied: [{ key: "rollingSquad", undoneAt: "x" }],
        kept: [{ key: "paymentTracking", reason: "monthly-list" }],
        suggestions: [{ key: "venue" }],
        noted: [
          {
            key: "monthlyList",
            prepayForMonth: true,
            payAsYouGoFillIns: true,
            creditForMissedGames: false,
            confidence: "high",
            evidence: ["pay monthly"],
          },
        ],
        costUsd: 0.0123,
        dmQueuedAt: NOW,
      }),
    ).toEqual({
      line:
        "Read 94 messages. Set: rollingSquad (undone). Left alone: paymentTracking (monthly-list). Suggested: venue. Cost $0.0123. Organiser told.",
      monthly: 'Monthly list (high): prepay, PAYG fill-ins. From: "pay monthly"',
    });
  });
  it("not read, skipped and failed", () => {
    expect(ownerLearningSummary(null).line).toBe("Chat not read yet.");
    expect(
      ownerLearningSummary({
        status: "skipped",
        reason: "too-short",
        messageCount: 5,
        applied: null,
        kept: null,
        suggestions: null,
        noted: null,
        costUsd: null,
        dmQueuedAt: null,
      }).line,
    ).toBe("Chat not read: too-short (5 messages). Nothing changed.");
  });
});

describe("the heading over the noted patterns (found by the manual test script, 2026-10-06)", () => {
  // The only pattern that is ever noted is the monthly list
  // (`NotedPattern.key`), and Monthly squad IS a setting now (Settings,
  // Monthly squad). The heading must not say there is none. It says what
  // is true of anything noted: MatchTime saw it and switched nothing.
  it("does not claim there is no setting, in English or Turkish", async () => {
    const { en } = await import("@/lib/i18n/strings.en");
    const { tr } = await import("@/lib/i18n/strings.tr");
    expect(en.settings_learned_noted_head).toBe("Noticed, left for you to decide");
    expect(tr.settings_learned_noted_head).toBe("Fark edildi, karar sizde");
    expect(en.settings_learned_noted_head).not.toMatch(/no setting/i);
    expect(tr.settings_learned_noted_head).not.toMatch(/ayarı yok/i);
    for (const head of [en.settings_learned_noted_head, tr.settings_learned_noted_head]) expect(head).not.toMatch(/[\u2013\u2014]/);
  });
});
