import { describe, expect, it } from "vitest";
import { cronFiresBetween, flushTimeFor, kickoffsBetween, parseCron, planTimeline, type Tick } from "./clock";
import { parseScenario } from "./scenario";

const at = (iso: string) => new Date(iso);
const isoList = (ds: Date[]) => ds.map((d) => d.toISOString());

describe("parseCron / cronFiresBetween (UTC, minute and hour fields)", () => {
  it("reads the shapes vercel.json uses", () => {
    expect([...parseCron("0 12 * * *").hours]).toEqual([12]);
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 * * * *").hours.size).toBe(24);
    expect([...parseCron("5,35 9 * * *").minutes]).toEqual([5, 35]);
  });

  it("refuses day fields it cannot honour, rather than firing every day", () => {
    expect(() => parseCron("0 9 * * 1")).toThrow(/day/);
    expect(() => parseCron("0 9 1 * *")).toThrow(/day/);
    expect(() => parseCron("nonsense")).toThrow();
  });

  it("lists the firings in (from, to], so a firing exactly at `from` is not repeated", () => {
    expect(isoList(cronFiresBetween("*/15 * * * *", at("2027-01-04T09:00:00Z"), at("2027-01-04T09:45:00Z")))).toEqual([
      "2027-01-04T09:15:00.000Z",
      "2027-01-04T09:30:00.000Z",
      "2027-01-04T09:45:00.000Z",
    ]);
    expect(isoList(cronFiresBetween("0 12 * * *", at("2027-01-04T00:00:00Z"), at("2027-01-06T00:00:00Z")))).toEqual([
      "2027-01-04T12:00:00.000Z",
      "2027-01-05T12:00:00.000Z",
    ]);
  });
});

describe("kickoffsBetween", () => {
  it("lists the weekly kickoffs in the club's zone, across the clock change", () => {
    const k = kickoffsBetween({ dayOfWeek: 5, time: "20:30" }, "Europe/London", at("2026-10-17T00:00:00Z"), at("2026-11-01T00:00:00Z"));
    expect(isoList(k)).toEqual(["2026-10-23T19:30:00.000Z", "2026-10-30T20:30:00.000Z"]);
  });
});

describe("flushTimeFor: the Pi's ten-minute batches", () => {
  const kickoffs = [at("2026-10-23T19:30:00Z")];
  it("a message waits for the next ten-minute boundary", () => {
    expect(flushTimeFor(at("2026-10-20T10:03:12Z"), 10, kickoffs).toISOString()).toBe("2026-10-20T10:10:00.000Z");
    expect(flushTimeFor(at("2026-10-20T10:10:00Z"), 10, kickoffs).toISOString()).toBe("2026-10-20T10:20:00.000Z");
  });
  it("within an hour of kickoff it goes at once", () => {
    expect(flushTimeFor(at("2026-10-23T18:45:00Z"), 10, kickoffs).toISOString()).toBe("2026-10-23T18:45:00.000Z");
  });
  it("after kickoff it batches again", () => {
    expect(flushTimeFor(at("2026-10-23T19:45:00Z"), 10, kickoffs).toISOString()).toBe("2026-10-23T19:50:00.000Z");
  });
});

describe("planTimeline", () => {
  const scenario = parseScenario({
    version: 1,
    title: "t",
    start: "2027-01-04 09:00",
    end: "2027-01-04 12:00",
    pollEveryMinutes: 60,
    crons: [{ path: "/api/cron/generate-teams", schedule: "0 10 * * *" }],
    club: {
      name: "c",
      owner: "a",
      maxPlayers: 4,
      sport: { name: "Football", playersPerTeam: 2 },
      activity: { day: "friday", time: "20:00" },
    },
    groups: [
      { key: "main", subject: "Main", role: "players" },
      { key: "hq", subject: "HQ", role: "admin" },
    ],
    members: [{ key: "a", name: "A", phone: "+447700900001", role: "OWNER", groups: ["main", "hq"] }],
    steps: [
      { at: "2027-01-04 09:03", do: "message", group: "main", from: "a", body: "in" },
      { at: "2027-01-04 09:07", do: "message", group: "main", from: "a", body: "actually out" },
      { at: "2027-01-04 10:00", do: "message", group: "hq", from: "a", body: "teams" },
    ],
  });
  const ticks = planTimeline(scenario);
  const show = (t: Tick) =>
    `${t.at.toISOString().slice(11, 16)} ${t.kind}${t.kind === "cron" ? ` ${t.path}` : ""}${t.kind === "step" ? ` ${t.step.do}` : ""}${t.kind === "flush" ? ` ${t.stepSeqs.join(",")}` : ""}`;

  it("merges steps, one flush per batch, crons and polls, in time order", () => {
    expect(ticks.map(show)).toEqual([
      "09:00 poll",
      "09:03 step message",
      "09:07 step message",
      "09:10 flush 0,1",
      "09:11 poll",
      "10:00 cron /api/cron/generate-teams",
      "10:00 step message",
      "10:00 poll",
      "10:01 poll",
      "11:00 poll",
      "12:00 poll",
    ]);
  });

  it("admin-group messages are not batched: the Pi forwards them at once", () => {
    const hq = ticks.find((t) => t.kind === "step" && t.step.do === "message" && t.step.group === "hq");
    expect(hq).toBeDefined();
    expect(ticks.filter((t) => t.kind === "flush")).toHaveLength(1);
  });

  it("polls on the clock, whatever minute the scenario starts at", () => {
    const odd = { ...scenario, start: new Date("2027-01-04T08:50:00Z"), steps: [] };
    const polls = planTimeline(odd).filter((t) => t.kind === "poll").map((t) => t.at.toISOString().slice(11, 16));
    expect(polls.slice(0, 3)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("skips the crons the scenario says to skip", () => {
    const s2 = { ...scenario, skipCrons: ["/api/cron/generate-teams"] };
    expect(planTimeline(s2).some((t) => t.kind === "cron")).toBe(false);
  });
});
