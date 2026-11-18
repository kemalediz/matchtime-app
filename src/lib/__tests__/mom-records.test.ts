/**
 * THE MAN OF THE MATCH LOADER (`mom-records.ts`, review of #608), with the
 * database mocked. This is the production credit path every wins table and
 * the "last Man of the Match" answer read, so crediting an open vote's
 * leader, or a re-count of a posted result, fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = 60 * 60 * 1000;
const DAY = 24 * H;
const NOW = new Date("2026-11-10T19:25:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

interface M {
  id: string;
  date: Date;
  status?: string;
  isHistorical?: boolean;
  postMatchEndFlow?: boolean;
  votes: Array<[string, number]>;
  posted?: boolean;
  /** The Pi stamped the sent message's id on the claim (default true). */
  sent?: boolean;
  stored?: unknown;
  /** The post's own words (`SentNotification.text`). */
  text?: string;
  /** Who played it (CONFIRMED attendance), by name. */
  played?: string[];
}
const state = vi.hoisted(() => ({
  matches: [] as Array<Record<string, unknown>>,
  momVoting: true,
  momChosenBy: "players",
  posting: true,
  storedThrows: null as Error | null,
  calls: { match: 0, stored: 0 },
}));
let fixture: M[] = [];

vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ momVoting: state.momVoting, momChosenBy: state.momChosenBy }) }));
vi.mock("@/lib/db", () => {
  const act = { orgId: "org-1", venue: "Goals", dayOfWeek: 2, ratingWindowHours: 120, sport: { teamLabels: ["Red", "Yellow"] } };
  return {
    db: {
      organisation: {
        findUnique: async () => ({ teamLabels: [], language: "en" }),
        count: async () => (state.posting ? 1 : 0),
      },
      moMAnnouncement: {
        findMany: async () => {
          state.calls.stored++;
          if (state.storedThrows) throw state.storedThrows;
          return fixture.filter((m) => m.stored).map((m) => ({ matchId: m.id, result: m.stored }));
        },
      },
      match: {
        findMany: async (args: { where: { OR?: unknown } }) => {
          const rows = fixture.map((m) => ({
            id: m.id,
            date: m.date,
            status: m.status ?? "COMPLETED",
            isHistorical: m.isHistorical ?? false,
            postMatchEndFlow: m.postMatchEndFlow ?? true,
            activityId: "act-1",
            redScore: 1,
            yellowScore: 0,
            teamLabels: [],
            activity: act,
          }));
          if (args.where.OR) state.calls.match++;
          return args.where.OR ? rows.sort((a, b) => b.date.getTime() - a.date.getTime()) : [];
        },
      },
      moMVote: {
        groupBy: async () => fixture.flatMap((m) => m.votes.map(([p, n]) => ({ matchId: m.id, playerId: `u-${p}`, _count: { playerId: n } }))),
      },
      sentNotification: {
        findMany: async () =>
          fixture
            .filter((m) => m.posted)
            .map((m) => ({ key: `${m.id}:mom-announcement`, createdAt: new Date(m.date.getTime() + DAY), text: m.text ?? null, waMessageId: m.sent === false ? null : `wa-${m.id}` })),
      },
      attendance: {
        findMany: async () => fixture.flatMap((m) => (m.played ?? []).map((n) => ({ matchId: m.id, user: { id: `u-${n}`, name: n } }))),
      },
      teamAssignment: { findMany: async () => [] },
      user: {
        findMany: async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id, name: id.slice(2) })),
      },
    },
  };
});

import { clearMomRecordsForTests, loadMomDecisions, loadMomRecords, withMomRecordsScope } from "../mom-records";

const credits = async () => {
  const d = await loadMomDecisions("org-1", NOW);
  return Object.fromEntries([...d].map(([id, x]) => [id, x.credit.map((w) => w.name)]));
};

beforeEach(() => {
  fixture = [];
  state.momVoting = true;
  state.momChosenBy = "players";
  state.posting = true;
  state.storedThrows = null;
  state.calls = { match: 0, stored: 0 };
  clearMomRecordsForTests();
});

describe("who each match credits, through the loader", () => {
  it("an OPEN vote credits nobody; a posted result credits the ANNOUNCED winner, not the re-count; a final one its winner", async () => {
    fixture = [
      { id: "open", date: ago(1), votes: [["Greg", 4]] },
      { id: "posted", date: ago(6), votes: [["Dan", 3], ["Pete", 1]], posted: true, stored: { v: 1, kind: "vote", tally: [{ userId: "u-Pete", name: "Pete", votes: 3 }, { userId: "u-Dan", name: "Dan", votes: 1 }] } },
      { id: "final", date: ago(12), votes: [["Alice", 2]] },
    ];
    expect(await credits()).toEqual({ open: [], posted: ["Pete"], final: ["Alice"] });
  });

  // Round 5: ids are stored, so names are the CURRENT ones everywhere (the
  // answer, the tables, the web), not the name a post once used.
  it("a stored result is told by the players' CURRENT names", async () => {
    fixture = [{ id: "renamed", date: ago(6), votes: [], posted: true, stored: { v: 1, kind: "vote", tally: [{ userId: "u-Pete", name: "Pete (old name)", votes: 3 }], winners: ["u-Pete"] } }];
    expect(await credits()).toEqual({ renamed: ["Pete"] });
    const { records } = await loadMomRecords("org-1", NOW);
    const r = records[0].announcedResult;
    expect(r?.kind === "vote" && r.tally.map((t) => t.name)).toEqual(["Pete"]);
  });

  it("a posted result whose vote rows are gone is still loaded from its record", async () => {
    fixture = [{ id: "norows", date: ago(10), votes: [], posted: true, stored: { v: 1, kind: "pick", winner: { userId: "u-Owner", name: "Owner" } } }];
    expect(await credits()).toEqual({ norows: ["Owner"] });
  });

  it("a historical anchor is decided by its final winner", async () => {
    fixture = [{ id: "hist", date: ago(1), isHistorical: true, votes: [["Erdal", 1]] }];
    expect(await credits()).toEqual({ hist: ["Erdal"] });
  });
});

describe("a post with no stored record, but its own words kept (review of #608, round 3)", () => {
  it("is read back from the post's text (exact re-render only) and told as announced", async () => {
    const { buildMomAnnouncement } = await import("../mom-announcement");
    const text = buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday", lang: "en", tally: [{ name: "Pete", votes: 3 }, { name: "Dan", votes: 1 }] });
    // The votes moved to Dan after the post, and the record write failed.
    fixture = [{ id: "p", date: ago(2), votes: [["Dan", 3], ["Pete", 1]], posted: true, text, played: ["Pete", "Dan"] }];
    expect(await credits()).toEqual({ p: ["Pete"] });
    const { records } = await loadMomRecords("org-1", NOW);
    expect(records[0].announcedResult).toEqual({ v: 1, kind: "vote", tally: [{ userId: "u-Pete", name: "Pete", votes: 3 }, { userId: "u-Dan", name: "Dan", votes: 1 }], winners: ["u-Pete"] });
  });

  it("a text that does not re-render exactly, or names someone not at the match, is no record", async () => {
    fixture = [
      { id: "bad", date: ago(2), votes: [["Dan", 3]], posted: true, text: "Congrats Pete!", played: ["Pete", "Dan"] },
      { id: "stranger", date: ago(3), votes: [["Dan", 3]], posted: true, played: ["Dan"], text: "" },
    ];
    const { buildMomAnnouncement } = await import("../mom-announcement");
    fixture[1].text = buildMomAnnouncement({ mvpLabel: "Man of the Match", activityName: "Tuesday", lang: "en", tally: [{ name: "Zed", votes: 2 }] });
    const { records } = await loadMomRecords("org-1", NOW);
    expect(records.map((r) => r.announcedResult)).toEqual([null, null]);
  });
});

describe("no post is promised when the scheduler will not send one", () => {
  const promised = async () => (await loadMomRecords("org-1", NOW)).records.map((r) => r.announceable);

  it("announceable when completed, the post-match flow on, MoM votes on and the club's posts not suppressed", async () => {
    fixture = [{ id: "a", date: ago(1), votes: [["Greg", 1]] }];
    expect(await promised()).toEqual([true]);
  });

  it("not when the bot is off or billing has paused the club (the due-posts gate)", async () => {
    state.posting = false;
    fixture = [{ id: "a", date: ago(1), votes: [["Greg", 1]] }];
    expect(await promised()).toEqual([false]);
  });

  it("not when MoM votes are off or the post-match flow is off", async () => {
    fixture = [{ id: "flow", date: ago(1), postMatchEndFlow: false, votes: [["Greg", 1]] }];
    expect(await promised()).toEqual([false]);
    clearMomRecordsForTests();
    state.momVoting = false;
    fixture = [{ id: "a", date: ago(1), votes: [["Greg", 1]] }];
    expect(await promised()).toEqual([false]);
  });
});

describe("round 6 of the review", () => {
  it("a claim the Pi never confirmed sent (no message id) is not 'as announced': the winner only, no counts", async () => {
    fixture = [
      {
        id: "unsent",
        date: ago(6),
        votes: [["Dan", 3], ["Pete", 1]],
        posted: true,
        sent: false,
        stored: { v: 1, kind: "vote", tally: [{ userId: "u-Pete", name: "Pete", votes: 3 }, { userId: "u-Dan", name: "Dan", votes: 1 }], winners: ["u-Pete"] },
      },
    ];
    const { records } = await loadMomRecords("org-1", NOW);
    expect(records[0].announced).toBe(false);
    expect(records[0].postedAt).toBeNull();
    expect(records[0].announcedResult).toBeNull();
    const d = await loadMomDecisions("org-1", NOW);
    const x = d.get("unsent")!;
    expect(x.decision.kind).toBe("told");
    if (x.decision.kind !== "told") return;
    expect(x.decision.mom.told).toBe("winner-only");
    expect(x.decision.mom.votes).toBeNull();
    expect(x.credit.map((w) => w.name)).toEqual(["Dan"]);
  });

  it("the same claim once the Pi stamped its message id is as announced", async () => {
    fixture = [
      {
        id: "sent",
        date: ago(6),
        votes: [["Dan", 3], ["Pete", 1]],
        posted: true,
        stored: { v: 1, kind: "vote", tally: [{ userId: "u-Pete", name: "Pete", votes: 3 }, { userId: "u-Dan", name: "Dan", votes: 1 }], winners: ["u-Pete"] },
      },
    ];
    const d = await loadMomDecisions("org-1", NOW);
    const x = d.get("sent")!;
    expect(x.decision.kind === "told" && x.decision.mom.told).toBe("announced");
    expect(x.credit.map((w) => w.name)).toEqual(["Pete"]);
  });

  it("an organisers' pick in the gap after kickoff, before the match is COMPLETED, waits for its post", async () => {
    state.momChosenBy = "organisers";
    fixture = [{ id: "kicked-off", date: new Date(NOW.getTime() - 3 * H), status: "TEAMS_PUBLISHED", votes: [["Akram", 1]] }];
    const { records } = await loadMomRecords("org-1", NOW);
    expect(records[0].announceable).toBe(true);
    const x = (await loadMomDecisions("org-1", NOW)).get("kicked-off")!;
    expect(x.decision.kind).toBe("pending");
    expect(x.credit).toEqual([]);
  });
});

describe("loaded once per request", () => {
  it("inside a request scope, every reader shares one load", async () => {
    fixture = [{ id: "a", date: ago(1), votes: [["Greg", 1]] }];
    await withMomRecordsScope(async () => {
      await loadMomDecisions("org-1", NOW);
      await loadMomDecisions("org-1", NOW);
      await loadMomRecords("org-1", NOW, { take: 10 });
    });
    expect(state.calls.match).toBe(1);
  });

  it("outside a scope (or in a new one) it reads afresh, so a later request sees new votes", async () => {
    fixture = [{ id: "a", date: ago(1), votes: [["Greg", 1]] }];
    await withMomRecordsScope(() => loadMomDecisions("org-1", NOW));
    await withMomRecordsScope(() => loadMomDecisions("org-1", NOW));
    await loadMomDecisions("org-1", NOW);
    expect(state.calls.match).toBe(3);
  });
});

describe("before the migration is applied", () => {
  it("a missing MoMAnnouncement table is a quiet fallback: one info line, never an error, records read as none", async () => {
    const err = Object.assign(new Error('The table `public.MoMAnnouncement` does not exist in the current database.'), { code: "P2021" });
    state.storedThrows = err;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture = [{ id: "posted", date: ago(12), votes: [["Alice", 2]], posted: true }];
    expect(await credits()).toEqual({ posted: ["Alice"] });
    clearMomRecordsForTests({ keepWarned: true });
    await credits();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
    error.mockRestore();
  });

  it("any other failure is still an error", async () => {
    state.storedThrows = new Error("connection reset");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await credits();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
