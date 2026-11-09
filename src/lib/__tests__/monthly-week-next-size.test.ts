/**
 * THE MONTH'S LIST SAYS WHEN ONE MORE MAKES THE NEXT SIZE (Kemal,
 * 2026-11-09). The Vets play 7-a-side, 12 to 16: with the squad full at 14
 * and one on the bench, the list says "One more on the bench and the
 * organisers can make it 8-a-side." With two, the suggestion post fires
 * (bot-scheduler block 2-ter) and the list says nothing more.
 *
 * `weekListPostText` is the ONE renderer every place the list is shown
 * uses (the scheduler's post, a reply to "who's in?", a member's matching
 * paste, a switch, the monthly reader), so the line is decided there, from
 * the database, and the hash means the same everywhere. Prisma mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy({}, { get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method) }),
    },
  ),
}));
vi.mock("@/lib/player-display-name", () => ({ loadPlayerNames: async () => new Map() }));

import { weekListPostText } from "@/lib/monthly-week";
import type { WeekList } from "@/lib/monthly-week-rules";

const MATCH_ID = "m-vets-9-nov";
/** Mon 9 Nov 2026, 20:30 London. */
const KICKOFF = new Date("2026-11-09T20:30:00.000Z");
/** The same day, 14:50 London. */
const NOW = new Date("2026-11-09T14:50:00.000Z");
const LINE_EN = "One more on the bench and the organisers can make it 8-a-side.";

function list(p: { confirmed: number; bench: number; places?: number }): WeekList {
  const places = p.places ?? 14;
  return {
    slots: Array.from({ length: Math.max(places, p.confirmed) }, (_, i) =>
      i < p.confirmed ? { slot: i + 1, userId: `u${i}`, name: `Player ${i}`, mark: "paid" as const } : { slot: i + 1, userId: null, name: "", mark: null },
    ),
    paidCantPlay: [],
    cantPlay: [],
    reserves: Array.from({ length: p.bench }, (_, i) => ({ userId: `b${i}`, name: `Bench ${i}` })),
    open: Math.max(0, places - p.confirmed),
  };
}

function world(p: {
  status?: string;
  places?: number;
  actMax?: number | null;
  listAnnouncer?: string;
  teams?: number;
  keys?: string[];
  choseBench?: string[];
} = {}) {
  overrides.match = {
    findUnique: async () => ({
      id: MATCH_ID,
      status: p.status ?? "UPCOMING",
      date: KICKOFF,
      maxPlayers: p.places ?? 14,
      _count: { teamAssignments: p.teams ?? 0 },
      activity: {
        minPlayers: 12,
        maxPlayers: p.actMax === undefined ? 16 : p.actMax,
        sport: { playersPerTeam: 7 },
        org: { listAnnouncer: p.listAnnouncer ?? "matchtime" },
      },
    }),
  };
  overrides.sentNotification = { findMany: async () => (p.keys ?? []).map((key) => ({ key })) };
  overrides.attendanceEvent = {
    findMany: async () => (p.choseBench ?? []).map((userId) => ({ userId, note: "explicit bench request" })),
  };
}

async function render(l: WeekList, opts: { seeded?: boolean; lang?: string; now?: Date } = {}) {
  return weekListPostText({
    orgId: "org-vets",
    matchId: MATCH_ID,
    seeded: opts.seeded ?? true,
    now: opts.now ?? NOW,
    list: l,
    matchDate: KICKOFF,
    title: "Football 7-a-side",
    paygPricePence: null,
    organiserPicks: false,
    lang: opts.lang ?? "en",
  });
}

beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe("the month's list: one more on the bench for the next size", () => {
  it("THE VETS TONIGHT: 14 in, one on the bench: the line, as the last line", async () => {
    world();
    const r = await render(list({ confirmed: 14, bench: 1 }));
    // Last, after the bench it is about (Kemal, 2026-11-09).
    expect(r.text.split("\n").slice(-2)).toEqual(["", LINE_EN]);
    expect(r.text).toMatch(new RegExp(`\\*Bench:\\*\\n1\\. [^\\n]+\\n\\n${LINE_EN}$`));
    expect(r.nextSizePerSide).toBe(8);
  });

  it("Turkish", async () => {
    world();
    const r = await render(list({ confirmed: 14, bench: 1 }), { lang: "tr" });
    expect(r.text.split("\n").pop()).toBe("Yedeğe bir kişi daha gelirse organizatörler maçı 8'e 8 yapabilir.");
  });

  it("two on the bench: no line (the suggestion post covers it), and nothing at none", async () => {
    world();
    expect((await render(list({ confirmed: 14, bench: 2 }))).text).not.toContain("One more on the bench");
    expect((await render(list({ confirmed: 14, bench: 0 }))).text).not.toContain("One more on the bench");
  });

  it("the bench is counted as the suggestion counts it: somebody who ASKED to be on the bench is not one more", async () => {
    world({ choseBench: ["b0"] });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
    // Two on the bench, one by choice: one movable, so one more is needed.
    world({ choseBench: ["b1"] });
    expect((await render(list({ confirmed: 14, bench: 2 }))).text).toContain(LINE_EN);
  });

  it("never: the squad is not full", async () => {
    world();
    expect((await render(list({ confirmed: 13, bench: 1 }))).text).not.toContain("One more on the bench");
  });

  it("never: the size cannot go up (at the maximum, or no maximum above the places)", async () => {
    world({ places: 16 });
    expect((await render(list({ confirmed: 16, bench: 1, places: 16 }))).text).not.toContain("One more on the bench");
    world({ actMax: null });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
  });

  it("never: the teams are out, the organisers announce the list, the month is not seeded", async () => {
    world({ teams: 14 });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
    world({ listAnnouncer: "organisers" });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
    world();
    expect((await render(list({ confirmed: 14, bench: 1 }), { seeded: false })).text).not.toContain("One more on the bench");
  });

  it("never: the game is called off or under way", async () => {
    world({ status: "CANCELLED" });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
    world();
    expect((await render(list({ confirmed: 14, bench: 1 }), { now: new Date(KICKOFF.getTime() + 60_000) })).text).not.toContain("One more on the bench");
  });

  it("never: an organiser already switched through 8-a-side for this match (settled)", async () => {
    world({ keys: [`${MATCH_ID}:format-up:16`] });
    expect((await render(list({ confirmed: 14, bench: 1 }))).text).not.toContain("One more on the bench");
  });

  it("the hash: changes only with the line, and is stable for the same state (no flapping)", async () => {
    world();
    const a = await render(list({ confirmed: 14, bench: 1 }));
    const b = await render(list({ confirmed: 14, bench: 1 }));
    expect(a.hash).toBe(b.hash);
    world({ actMax: null });
    const without = await render(list({ confirmed: 14, bench: 1 }));
    expect(without.hash).not.toBe(a.hash);
  });

  it("no queries for the line when nobody is on the bench, or the squad has room", async () => {
    const reads: string[] = [];
    overrides.match = { findUnique: async () => (reads.push("match"), null) };
    overrides.attendanceEvent = { findMany: async () => (reads.push("events"), []) };
    await render(list({ confirmed: 14, bench: 0 }));
    await render(list({ confirmed: 13, bench: 1 }));
    expect(reads).toEqual([]);
  });

  it("a failed read leaves the list as it was (fails soft)", async () => {
    overrides.match = {
      findUnique: async () => {
        throw new Error("the database hiccuped");
      },
    };
    const r = await render(list({ confirmed: 14, bench: 1 }));
    expect(r.text).not.toContain("One more on the bench");
    expect(r.nextSizePerSide).toBeNull();
  });
});
