/**
 * THE NOON CRON NEVER BUILDS OR PUBLISHES TEAMS.
 *
 * `/api/cron/generate-teams` runs at `0 12 * * *` UTC (`vercel.json`).
 * Until 2026-09-29 it did three things: generated teams for every
 * UPCOMING match past its attendance deadline, auto-published any
 * TEAMS_GENERATED match older than an hour, and auto-completed finished
 * matches. Kemal's rule: teams are built only when a human asks, on
 * match day. So the first two are gone and only auto-complete is left.
 *
 * The route keeps its path and its cron entry so the completion backstop
 * still runs. These tests seed the database with exactly the rows the
 * old code acted on (a full squad past its deadline, a sheet generated
 * hours ago) and assert the cron leaves every one of them alone.
 *
 * db, match completion and the team helper are mocked. No DB, no
 * network, no model call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const CRON_SECRET = "test-cron-secret";

const completeFinishedMatchesMock = vi.fn();
const generateTeamsForMatchMock = vi.fn();
const getOrgFeaturesMock = vi.fn();

/** Every write the route makes, so a test asserts on what reached Postgres. */
let writes: { op: string; args: unknown }[] = [];

function record(op: string) {
  return (args: unknown) => {
    writes.push({ op, args });
    return Promise.resolve({ count: 0 });
  };
}

/** A full 3-a-side squad whose attendance deadline has passed. */
const upcomingPastDeadline = {
  id: "match-upcoming",
  status: "UPCOMING",
  attendanceDeadline: new Date("2026-09-29T09:00:00Z"),
  activity: { orgId: "org-1", sport: { playersPerTeam: 3 } },
  attendances: Array.from({ length: 6 }, (_, i) => ({ userId: `u-${i}` })),
};

/** A sheet generated hours ago and never published by a human. */
const generatedLongAgo = {
  id: "match-generated",
  status: "TEAMS_GENERATED",
  updatedAt: new Date("2026-09-29T08:00:00Z"),
};

vi.mock("@/lib/match-completion", () => ({
  completeFinishedMatches: (...a: unknown[]) => completeFinishedMatchesMock(...a),
}));
vi.mock("@/lib/team-generation", () => ({
  generateTeamsForMatch: (...a: unknown[]) => generateTeamsForMatchMock(...a),
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeaturesMock(...a),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findMany: (args: { where?: { status?: string } }) =>
        Promise.resolve(
          args.where?.status === "TEAMS_GENERATED"
            ? [generatedLongAgo]
            : args.where?.status === "UPCOMING"
              ? [upcomingPastDeadline]
              : [],
        ),
      findUnique: () => Promise.resolve(upcomingPastDeadline),
      update: record("match.update"),
      updateMany: record("match.updateMany"),
    },
    teamAssignment: {
      create: record("teamAssignment.create"),
      createMany: record("teamAssignment.createMany"),
      deleteMany: record("teamAssignment.deleteMany"),
      upsert: record("teamAssignment.upsert"),
    },
    botJob: {
      create: record("botJob.create"),
      createMany: record("botJob.createMany"),
      upsert: record("botJob.upsert"),
    },
  },
}));

import { GET } from "@/app/api/cron/generate-teams/route";

function cronRequest(secret = CRON_SECRET) {
  return new Request("https://matchtime.app/api/cron/generate-teams", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function statusWrites(status: string) {
  return writes.filter((w) => {
    const data = (w.args as { data?: { status?: string } }).data;
    return w.op.startsWith("match.") && data?.status === status;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  process.env.CRON_SECRET = CRON_SECRET;
  completeFinishedMatchesMock.mockResolvedValue({ completed: 0 });
  generateTeamsForMatchMock.mockResolvedValue({ ok: true, groupPost: "teams" });
  getOrgFeaturesMock.mockResolvedValue({ teamBalancing: true });
});

describe("the noon cron never builds teams", () => {
  it("writes no TeamAssignment rows for a full squad past its deadline", async () => {
    await GET(cronRequest());
    expect(writes.filter((w) => w.op.startsWith("teamAssignment."))).toEqual([]);
  });

  it("never calls the team generator", async () => {
    await GET(cronRequest());
    expect(generateTeamsForMatchMock).not.toHaveBeenCalled();
  });

  it("never moves a match to TEAMS_GENERATED", async () => {
    await GET(cronRequest());
    expect(statusWrites("TEAMS_GENERATED")).toEqual([]);
  });

  it("never auto-publishes: an old TEAMS_GENERATED sheet stays unpublished", async () => {
    await GET(cronRequest());
    expect(statusWrites("TEAMS_PUBLISHED")).toEqual([]);
  });

  it("changes no match status at all and queues nothing for the group", async () => {
    await GET(cronRequest());
    expect(writes).toEqual([]);
  });

  it("reports only what it completed", async () => {
    const body = await (await GET(cronRequest())).json();
    expect(Object.keys(body)).toEqual(["completed"]);
  });
});

describe("auto-complete is untouched", () => {
  it("still calls the idempotent match-completion backstop and reports it", async () => {
    completeFinishedMatchesMock.mockResolvedValue({ completed: 3 });
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ completed: 3 });
    expect(completeFinishedMatchesMock).toHaveBeenCalledTimes(1);
    expect(completeFinishedMatchesMock.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it("an unauthorised caller gets 401 and nothing runs", async () => {
    const res = await GET(cronRequest("wrong"));
    expect(res.status).toBe(401);
    expect(completeFinishedMatchesMock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
