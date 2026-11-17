/**
 * AN OPEN SQUAD'S LATE IN THROUGH A PATH THAT IS NOT THE ENGINE (the match
 * page, a friend link, the pool, a guest card, a pasted list), review of
 * #623 item 1: with the teams made he is seated (the smaller side; level,
 * the lower total rating), and the group gets one post with the redrawn
 * sheet. A second IN goes to the other side. A drop seats nobody. A club
 * without the setting, or with no sheet yet, is untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openSquad: true,
  rows: [] as Array<{ userId: string; status: string; position: number }>,
  teams: [] as Array<{ id: string; userId: string; team: string }>,
  jobs: [] as Array<{ text: string }>,
  ratings: new Map<string, number>(),
}));

vi.mock("../db", () => {
  const tx = {
    $executeRaw: async () => 0,
    attendance: { findMany: async () => h.rows.map((r) => ({ ...r })) },
    teamAssignment: {
      findMany: async () => h.teams.map((t) => ({ ...t })),
      update: async ({ where, data }: { where: { id: string }; data: { userId: string } }) => {
        h.teams.find((t) => t.id === where.id)!.userId = data.userId;
      },
      create: async ({ data }: { data: { userId: string; team: string } }) => {
        h.teams.push({ id: `t${h.teams.length + 1}`, userId: data.userId, team: data.team });
      },
    },
    benchSlotOffer: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    db: {
      ...tx,
      $transaction: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
      match: {
        findUnique: async () => ({
          id: "m1",
          date: new Date("2026-11-23T20:15:00Z"),
          teamLabels: [],
          _count: { teamAssignments: h.teams.length },
          activity: { orgId: "vets", venue: "Goals", sport: { teamLabels: ["Red", "Yellow"] }, org: { openSquad: h.openSquad, language: "en", listAnnouncer: "matchtime", teamLabels: [] } },
        }),
      },
      attendance: {
        findMany: async ({ where }: { where: { status?: string } }) =>
          h.rows.filter((r) => !where.status || r.status === where.status).map((r) => ({ userId: r.userId })),
      },
      teamAssignment: tx.teamAssignment,
      botJob: { create: async ({ data }: { data: { text: string } }) => h.jobs.push({ text: data.text }) },
    },
  };
});
vi.mock("../team-generation", () => ({ clubRatingsFor: async () => h.ratings }));
vi.mock("../player-display-name", () => ({
  loadPlayerNames: async (_o: string, ids: string[]) => new Map(ids.map((id) => [id, { name: id[0].toUpperCase() + id.slice(1), display: id[0].toUpperCase() + id.slice(1) }])),
}));

import { seatOpenSquadLateIns } from "../open-squad-seat";

const confirmed = (...ids: string[]) => ids.map((userId, i) => ({ userId, status: "CONFIRMED", position: i + 1 }));

beforeEach(() => {
  h.openSquad = true;
  h.rows = confirmed("ali", "ben", "cem", "dan");
  h.teams = [
    { id: "t1", userId: "ali", team: "RED" },
    { id: "t2", userId: "ben", team: "RED" },
    { id: "t3", userId: "cem", team: "YELLOW" },
    { id: "t4", userId: "dan", team: "YELLOW" },
  ];
  h.jobs = [];
  h.ratings = new Map([["ali", 9], ["ben", 9], ["cem", 5], ["dan", 5]]);
});

describe("seatOpenSquadLateIns", () => {
  it("one IN joins the lower-rated side (sides level), and one post redraws the sheet", async () => {
    h.rows.push({ userId: "eve", status: "CONFIRMED", position: 5 });
    expect(await seatOpenSquadLateIns("m1")).toEqual({ seated: 1 });
    expect(h.teams.find((t) => t.userId === "eve")?.team).toBe("YELLOW");
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0].text).toContain("➕ *Eve* joins *Yellow*.");
    expect(h.jobs[0].text).toContain("Eve");
    expect(h.jobs[0].text).toContain("(new)");
  });

  it("a second IN goes to the other side, now the smaller one", async () => {
    h.rows.push({ userId: "eve", status: "CONFIRMED", position: 5 });
    await seatOpenSquadLateIns("m1");
    h.rows.push({ userId: "fay", status: "CONFIRMED", position: 6 });
    await seatOpenSquadLateIns("m1");
    expect(h.teams.find((t) => t.userId === "fay")?.team).toBe("RED");
  });

  it("then a drop: nobody is moved or seated, and nothing is posted", async () => {
    h.rows.push({ userId: "eve", status: "CONFIRMED", position: 5 });
    await seatOpenSquadLateIns("m1");
    h.jobs = [];
    h.rows.find((r) => r.userId === "ali")!.status = "DROPPED";
    const before = JSON.stringify(h.teams);
    expect(await seatOpenSquadLateIns("m1")).toEqual({ seated: 0 });
    expect(JSON.stringify(h.teams)).toBe(before);
    expect(h.jobs).toEqual([]);
  });

  it("off, or no sheet yet: nothing", async () => {
    h.rows.push({ userId: "eve", status: "CONFIRMED", position: 5 });
    h.openSquad = false;
    expect(await seatOpenSquadLateIns("m1")).toEqual({ seated: 0 });
    h.openSquad = true;
    h.teams = [];
    expect(await seatOpenSquadLateIns("m1")).toEqual({ seated: 0 });
    expect(h.jobs).toEqual([]);
  });
});
