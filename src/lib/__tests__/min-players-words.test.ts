/** Minimum players by WhatsApp: which game, the save, and what is said. No model, no network. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  games: [] as Array<{ id: string; name: string; dayOfWeek: number; minPlayers: number | null; ppt: number }>,
  updates: [] as Array<{ id: string; minPlayers: number | null }>,
}));
vi.mock("@/lib/db", () => ({
  db: {
    activity: {
      findMany: vi.fn(async () => state.games.map((g) => ({ id: g.id, name: g.name, dayOfWeek: g.dayOfWeek }))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const g = state.games.find((x) => x.id === where.id);
        return g ? { name: g.name, minPlayers: g.minPlayers, sport: { playersPerTeam: g.ppt } } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { minPlayers: number | null } }) => {
        state.updates.push({ id: where.id, minPlayers: data.minPlayers });
        return {};
      }),
    },
  },
}));

import { applyMinPlayersWords, pickGame } from "../min-players-words";

const VETS = { id: "vets-mon", name: "Vets 7s", dayOfWeek: 1, minPlayers: null as number | null, ppt: 7 };
const ask = (over: Partial<{ minPlayers: number | null; fullTeams: boolean; matchDay: string | null; lang: string }> = {}) =>
  applyMinPlayersWords({ orgId: "org-vets", minPlayers: 12, fullTeams: false, matchDay: null, lang: "en", ...over });

beforeEach(() => {
  state.games = [{ ...VETS }];
  state.updates = [];
});

describe("pickGame", () => {
  const mon = { id: "a", name: "Monday 7s", dayOfWeek: 1 };
  const thu = { id: "b", name: "Thursday 5s", dayOfWeek: 4 };
  it("the only game", () => expect(pickGame([mon], null)).toEqual({ kind: "one", game: mon }));
  it("several and no day: which", () => expect(pickGame([mon, thu], null)).toEqual({ kind: "which" }));
  it("several and a day: that day's game, English and Turkish", () => {
    expect(pickGame([mon, thu], "on Thursday")).toEqual({ kind: "one", game: thu });
    expect(pickGame([mon, thu], "pazartesi")).toEqual({ kind: "one", game: mon });
  });
  it("none", () => expect(pickGame([], null)).toEqual({ kind: "none" }));
});

describe("applyMinPlayersWords", () => {
  it("THE VETS: 'we can play with 12' sets 12 on their game, and says so with the places unchanged", async () => {
    const r = await ask();
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: 12 }]);
    expect(r.outcome).toBe("min-players-set");
    expect(r.replyText).toBe("✅ Done. *Vets 7s* goes ahead with *12* or more, so I'll only warn you when fewer than 12 are in. The game still has 14 places.");
  });
  it("Turkish", async () => {
    const r = await ask({ lang: "tr" });
    expect(r.replyText).toContain("en az *12* kişiyle oynanır");
  });
  it("the same again: unchanged, nothing written", async () => {
    state.games = [{ ...VETS, minPlayers: 12 }];
    const r = await ask();
    expect(state.updates).toEqual([]);
    expect(r.outcome).toBe("min-players-unchanged");
  });
  it("back to full teams clears it", async () => {
    state.games = [{ ...VETS, minPlayers: 12 }];
    const r = await ask({ minPlayers: null, fullTeams: true });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: null }]);
    expect(r.outcome).toBe("min-players-cleared");
    expect(r.replyText).toContain("fewer than 14");
  });
  it("more than the places: refused, nothing written", async () => {
    const r = await ask({ minPlayers: 15 });
    expect(state.updates).toEqual([]);
    expect(r.outcome).toBe("min-players-refused");
    expect(r.replyText).toBe("*Vets 7s* has 14 places, so the minimum can be 14 at most.");
  });
  it("fewer than 2: refused", async () => {
    expect((await ask({ minPlayers: 1 })).outcome).toBe("min-players-refused");
    expect(state.updates).toEqual([]);
  });
  it("no number read: asks for it", async () => {
    const r = await ask({ minPlayers: null });
    expect(r.outcome).toBe("min-players-refused");
    expect(r.replyText).toContain("*@Match Time minimum 12 players*");
  });
  it("two games and no day: asks which, writes nothing", async () => {
    state.games = [{ ...VETS }, { id: "thu", name: "Thursday 5s", dayOfWeek: 4, minPlayers: null, ppt: 5 }];
    const r = await ask();
    expect(r.outcome).toBe("min-players-which");
    expect(r.replyText).toContain("Vets 7s, Thursday 5s");
    expect(state.updates).toEqual([]);
  });
  it("two games and a day: that one", async () => {
    state.games = [{ ...VETS }, { id: "thu", name: "Thursday 5s", dayOfWeek: 4, minPlayers: null, ppt: 5 }];
    await ask({ minPlayers: 9, matchDay: "Thursday" });
    expect(state.updates).toEqual([{ id: "thu", minPlayers: 9 }]);
  });
  it("no game yet", async () => {
    state.games = [];
    expect((await ask()).outcome).toBe("min-players-no-game");
  });
});
