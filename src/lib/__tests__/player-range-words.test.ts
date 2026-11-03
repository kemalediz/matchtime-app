/** A game's fewest and most players by WhatsApp: which game, the save, and what is said. No model, no network. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  games: [] as Array<{ id: string; name: string; dayOfWeek: number; minPlayers: number | null; maxPlayers: number | null; ppt: number }>,
  updates: [] as Array<{ id: string; minPlayers: number | null; maxPlayers: number | null }>,
  /** Matches still to come, as `savePlayerRange` reads them (already switched ones). */
  matches: [] as Array<{ date: Date; maxPlayers: number }>,
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: vi.fn(async () => state.matches) },
    activity: {
      findMany: vi.fn(async () => state.games.map((g) => ({ id: g.id, name: g.name, dayOfWeek: g.dayOfWeek }))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const g = state.games.find((x) => x.id === where.id);
        return g ? { name: g.name, minPlayers: g.minPlayers, maxPlayers: g.maxPlayers, sport: { playersPerTeam: g.ppt } } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { minPlayers: number | null; maxPlayers: number | null } }) => {
        state.updates.push({ id: where.id, minPlayers: data.minPlayers, maxPlayers: data.maxPlayers });
        return {};
      }),
    },
  },
}));

import { applyPlayerRangeWords, pickGame } from "../player-range-words";

const VETS = { id: "vets-mon", name: "Vets 7s", dayOfWeek: 1, minPlayers: null as number | null, maxPlayers: null as number | null, ppt: 7 };
type Ask = Partial<{ minPlayers: number | null; maxPlayers: number | null; fullTeams: boolean; matchDay: string | null; lang: string }>;
const ask = (over: Ask = {}) =>
  applyPlayerRangeWords({ orgId: "org-vets", minPlayers: 12, maxPlayers: null, fullTeams: false, matchDay: null, lang: "en", ...over });

beforeEach(() => {
  state.games = [{ ...VETS }];
  state.updates = [];
  state.matches = [];
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

describe("applyPlayerRangeWords", () => {
  it("THE VETS: 'we play 12 to 16' sets both, and says the sizes it allows", async () => {
    const r = await ask({ minPlayers: 12, maxPlayers: 16 });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: 12, maxPlayers: 16 }]);
    expect(r.outcome).toBe("player-range-set");
    expect(r.replyText).toContain("is played 6, 7 or 8 a side now (12 to 16)");
    expect(r.replyText).toContain("suggest going up a size");
  });
  it("'we can play with 12' sets the minimum only, the maximum kept", async () => {
    state.games = [{ ...VETS, maxPlayers: 16 }];
    await ask({ minPlayers: 12 });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: 12, maxPlayers: 16 }]);
  });
  it("'up to 16' sets the maximum only, the minimum kept", async () => {
    state.games = [{ ...VETS, minPlayers: 12 }];
    await ask({ minPlayers: null, maxPlayers: 16 });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: 12, maxPlayers: 16 }]);
  });
  it("Turkish", async () => {
    const r = await ask({ minPlayers: 12, maxPlayers: 16, lang: "tr" });
    expect(r.replyText).toContain("artık 6'ya 6, 7'ye 7 ya da 8'e 8 oynanıyor (12 ile 16 arası)");
  });
  it("an odd number is refused: even numbers only, nothing written", async () => {
    const r = await ask({ minPlayers: 13 });
    expect(state.updates).toEqual([]);
    expect(r.outcome).toBe("player-range-refused");
    expect(r.replyText).toContain("even number");
    expect((await ask({ minPlayers: null, maxPlayers: 15 })).outcome).toBe("player-range-refused");
    expect(state.updates).toEqual([]);
  });
  it("the same again: unchanged, nothing written", async () => {
    state.games = [{ ...VETS, minPlayers: 12, maxPlayers: 16 }];
    const r = await ask({ minPlayers: 12, maxPlayers: 16 });
    expect(state.updates).toEqual([]);
    expect(r.outcome).toBe("player-range-unchanged");
  });
  it("back to full teams clears the minimum; with no maximum it is the one format again", async () => {
    state.games = [{ ...VETS, minPlayers: 12 }];
    const r = await ask({ minPlayers: null, fullTeams: true });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: null, maxPlayers: null }]);
    expect(r.outcome).toBe("player-range-cleared");
    expect(r.replyText).toContain("7-a-side only again");
  });
  it("a minimum above the places, or a maximum below them: refused", async () => {
    expect((await ask({ minPlayers: 16 })).replyText).toBe("*Vets 7s* has 14 places, so the minimum can be 14 at most.");
    expect((await ask({ minPlayers: null, maxPlayers: 12 })).replyText).toBe("*Vets 7s* has 14 places, so the maximum has to be at least 14.");
    expect(state.updates).toEqual([]);
  });
  it("no number read: asks for it", async () => {
    const r = await ask({ minPlayers: null });
    expect(r.outcome).toBe("player-range-refused");
    expect(r.replyText).toContain("*@Match Time we play with 12 to 16*");
  });
  it("two games and no day: asks which, writes nothing", async () => {
    state.games = [{ ...VETS }, { id: "thu", name: "Thursday 5s", dayOfWeek: 4, minPlayers: null, maxPlayers: null, ppt: 5 }];
    const r = await ask();
    expect(r.outcome).toBe("player-range-which");
    expect(r.replyText).toContain("Vets 7s, Thursday 5s");
    expect(state.updates).toEqual([]);
  });
  it("two games and a day: that one", async () => {
    state.games = [{ ...VETS }, { id: "thu", name: "Thursday 5s", dayOfWeek: 4, minPlayers: null, maxPlayers: null, ppt: 5 }];
    await ask({ minPlayers: 8, matchDay: "Thursday" });
    expect(state.updates).toEqual([{ id: "thu", minPlayers: 8, maxPlayers: null }]);
  });
  it("no game yet", async () => {
    state.games = [];
    expect((await ask()).outcome).toBe("player-range-no-game");
  });
  it("REVIEW #517: a match switched to 8-a-side still to come: clearing the maximum is refused, nothing written", async () => {
    state.games = [{ ...VETS, minPlayers: 12, maxPlayers: 16 }];
    state.matches = [{ date: new Date("2026-11-09T20:30:00Z"), maxPlayers: 16 }];
    const r = await ask({ minPlayers: null, maxPlayers: 14 });
    expect(state.updates).toEqual([]);
    expect(r.outcome).toBe("player-range-refused");
    expect(r.replyText).toBe("Monday's game is 8-a-side now, so those numbers would leave it out. Switch it back first, for example *@Match Time make it 7 a side*, then change them.");
  });
  it("widening, or a change that keeps the switched match inside, is saved", async () => {
    state.games = [{ ...VETS, minPlayers: 12, maxPlayers: 16 }];
    state.matches = [{ date: new Date("2026-11-09T20:30:00Z"), maxPlayers: 16 }];
    await ask({ minPlayers: 10, maxPlayers: null });
    expect(state.updates).toEqual([{ id: "vets-mon", minPlayers: 10, maxPlayers: 16 }]);
  });
});
