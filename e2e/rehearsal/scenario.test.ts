import { describe, expect, it } from "vitest";
import { ScenarioError, localToUtc, parseScenario, formatLocal } from "./scenario";

/** A small, valid, entirely fictional scenario. Tests mutate copies. */
function base(): Record<string, unknown> {
  return {
    version: 1,
    title: "Riverside Tuesday",
    timezone: "Europe/London",
    start: "2027-01-04 09:00",
    end: "2027-01-06 23:00",
    club: {
      name: "Riverside FC",
      owner: "ann",
      maxPlayers: 4,
      sport: { name: "Football 2-a-side", playersPerTeam: 2 },
      activity: { day: "tuesday", time: "20:30", venue: "Test Park" },
      settings: { listAnnouncer: "organisers", rollingSquadEnabled: true },
      paymentHolder: "bob",
    },
    groups: [
      { key: "main", subject: "Riverside", role: "players", matchtime: true },
      { key: "hq", subject: "Riverside HQ", role: "admin", matchtime: true },
      { key: "news", subject: "Riverside News", role: "other", matchtime: false, onlyAdminsCanSend: true },
    ],
    members: [
      { key: "ann", name: "Ann Organiser", phone: "+447700900001", role: "OWNER", groups: ["main", "hq", "news"] },
      { key: "bob", name: "Bob Collector", phone: "+447700900002", role: "ADMIN", groups: ["main", "hq"] },
      { key: "cal", name: "Cal Player", phone: "+447700900003", groups: ["main"] },
    ],
    steps: [
      { at: "2027-01-04 10:00", do: "message", group: "main", from: "cal", body: "lol" },
      { at: "2027-01-04 09:30", do: "note", text: "Monday" },
      { at: "2027-01-04 10:00", do: "message", group: "hq", from: "ann", body: "teams" },
    ],
  };
}

describe("localToUtc / formatLocal", () => {
  it("reads a London wall-clock time in winter (GMT) and summer (BST)", () => {
    expect(localToUtc("2027-01-04 09:00", "Europe/London").toISOString()).toBe("2027-01-04T09:00:00.000Z");
    expect(localToUtc("2026-10-23 20:30", "Europe/London").toISOString()).toBe("2026-10-23T19:30:00.000Z");
  });

  it("crosses the October clock change correctly (25 Oct 2026 is the last Sunday)", () => {
    expect(localToUtc("2026-10-24 12:00", "Europe/London").toISOString()).toBe("2026-10-24T11:00:00.000Z");
    expect(localToUtc("2026-10-26 12:00", "Europe/London").toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });

  it("accepts seconds, and an ISO instant with a zone as-is", () => {
    expect(localToUtc("2027-01-04 09:00:30", "Europe/London").toISOString()).toBe("2027-01-04T09:00:30.000Z");
    expect(localToUtc("2027-01-04T09:00:00+03:00", "Europe/London").toISOString()).toBe("2027-01-04T06:00:00.000Z");
    expect(localToUtc("2027-01-04T09:00:00Z", "Europe/London").toISOString()).toBe("2027-01-04T09:00:00.000Z");
  });

  it("works for another zone", () => {
    expect(localToUtc("2027-01-04 09:00", "Europe/Istanbul").toISOString()).toBe("2027-01-04T06:00:00.000Z");
  });

  it("refuses something that is not a time", () => {
    expect(() => localToUtc("next friday", "Europe/London")).toThrow(ScenarioError);
  });

  it("formats an instant back as local wall-clock time", () => {
    expect(formatLocal(new Date("2026-10-23T19:30:00Z"), "Europe/London")).toBe("2026-10-23 20:30");
    expect(formatLocal(new Date("2027-01-04T09:00:00Z"), "Europe/London")).toBe("2027-01-04 09:00");
  });
});

describe("parseScenario", () => {
  it("parses a valid scenario, with defaults filled in", () => {
    const s = parseScenario(base());
    expect(s.title).toBe("Riverside Tuesday");
    expect(s.timezone).toBe("Europe/London");
    expect(s.pollEveryMinutes).toBe(60);
    expect(s.batchMinutes).toBe(10);
    expect(s.start.toISOString()).toBe("2027-01-04T09:00:00.000Z");
    expect(s.club.activity.dayOfWeek).toBe(2);
    expect(s.club.language).toBe("en");
    expect(s.members.find((m) => m.key === "cal")?.role).toBe("PLAYER");
    expect(s.groups.find((g) => g.key === "news")?.onlyAdminsCanSend).toBe(true);
    expect(s.groups.find((g) => g.key === "main")?.onlyAdminsCanSend).toBe(false);
    expect(s.flags).toEqual({ selfJoin: true, setupHold: true, pictureReading: false, setupLearning: false });
  });

  it("keeps a step's stub shorthand and a DM's classifier answers", () => {
    const raw = base();
    (raw.steps as unknown[]).push(
      { at: "2027-01-04 11:00", do: "message", group: "main", from: "cal", body: "Bob out", stub: "other-out:Bob" },
      { at: "2027-01-04 11:01", do: "dm", from: "cal", body: "paid", paymentClaim: "paid" },
    );
    const s = parseScenario(raw);
    const msg = s.steps.find((x) => x.do === "message" && x.body === "Bob out");
    expect(msg?.do === "message" && msg.stub).toBe("other-out:Bob");
    const dm = s.steps.find((x) => x.do === "dm");
    expect(dm?.do === "dm" && dm.paymentClaim).toBe("paid");
  });

  it("a member's WhatsApp name defaults to their name; null means WhatsApp shows only the number", () => {
    const raw = base();
    (raw.members as Array<Record<string, unknown>>)[1].pushname = "Bobby";
    (raw.members as Array<Record<string, unknown>>)[2].pushname = null;
    const s = parseScenario(raw);
    expect(s.members.map((m) => m.pushname)).toEqual(["Ann Organiser", "Bobby", null]);
  });

  it("orders steps by time and keeps file order for equal times", () => {
    const s = parseScenario(base());
    expect(s.steps.map((x) => x.do)).toEqual(["note", "message", "message"]);
    const [, a, b] = s.steps;
    expect(a.do === "message" && a.group).toBe("main");
    expect(b.do === "message" && b.group).toBe("hq");
    expect(s.steps.map((x) => x.seq)).toEqual([1, 0, 2]);
  });

  it("refuses an unknown group or member in a step, naming the step", () => {
    const bad = base();
    (bad.steps as unknown[]).push({ at: "2027-01-04 11:00", do: "message", group: "nope", from: "cal", body: "x" });
    expect(() => parseScenario(bad)).toThrow(/step 3.*group "nope"/);
    const bad2 = base();
    (bad2.steps as unknown[]).push({ at: "2027-01-04 11:00", do: "dm", from: "zed", body: "x" });
    expect(() => parseScenario(bad2)).toThrow(/step 3.*member "zed"/);
  });

  it("refuses a member posting in a group they are not in", () => {
    const bad = base();
    (bad.steps as unknown[]).push({ at: "2027-01-04 11:00", do: "message", group: "hq", from: "cal", body: "x" });
    expect(() => parseScenario(bad)).toThrow(/"cal" is not in group "hq"/);
  });

  it("refuses an unknown step kind", () => {
    const bad = base();
    (bad.steps as unknown[]).push({ at: "2027-01-04 11:00", do: "teleport" });
    expect(() => parseScenario(bad)).toThrow(/unknown step "teleport"/);
  });

  it("refuses a phone outside E.164, and duplicate keys or phones", () => {
    const bad = base();
    (bad.members as Array<Record<string, unknown>>)[2].phone = "07700 900003";
    expect(() => parseScenario(bad)).toThrow(/phone/);
    const dup = base();
    (dup.members as Array<Record<string, unknown>>)[2].phone = "+447700900001";
    expect(() => parseScenario(dup)).toThrow(/same phone/);
    const dupKey = base();
    (dupKey.members as Array<Record<string, unknown>>)[2].key = "ann";
    expect(() => parseScenario(dupKey)).toThrow(/duplicate member key "ann"/);
  });

  it("needs exactly one players group, and at most one admin group", () => {
    const none = base();
    (none.groups as Array<Record<string, unknown>>)[0].role = "other";
    expect(() => parseScenario(none)).toThrow(/exactly one group with role "players"/);
    const two = base();
    (two.groups as Array<Record<string, unknown>>)[2].role = "admin";
    expect(() => parseScenario(two)).toThrow(/at most one group with role "admin"/);
  });

  it("refuses a step outside the scenario's start and end", () => {
    const bad = base();
    (bad.steps as unknown[]).push({ at: "2027-01-07 11:00", do: "note", text: "late" });
    expect(() => parseScenario(bad)).toThrow(/after the scenario's end/);
  });

  it("refuses settings it does not know, so a typo is never silently ignored", () => {
    const bad = base();
    (bad.club as Record<string, unknown>).settings = { listAnouncer: "organisers" };
    expect(() => parseScenario(bad)).toThrow(/unknown setting "listAnouncer"/);
  });

  it("reads a vote, a react and the setup steps", () => {
    const s = base();
    (s.steps as unknown[]).push(
      { at: "2027-01-05 22:00", do: "vote", from: "cal", poll: "Man of the Match", option: "Bob" },
      { at: "2027-01-05 22:01", do: "react", from: "cal", target: "Teams", emoji: "👍" },
      { at: "2027-01-06 09:00", do: "rate", from: "cal", mom: "Bob" },
      { at: "2027-01-04 09:01", do: "club-signup" },
      { at: "2027-01-04 09:02", do: "bot-added", group: "main", by: "ann" },
      { at: "2027-01-04 09:03", do: "approve" },
      { at: "2027-01-04 09:04", do: "settings", values: { teamsReadyTime: "10:00" } },
      { at: "2027-01-04 09:05", do: "link-admin-group", group: "hq", by: "ann" },
      { at: "2027-01-04 09:06", do: "go-live", from: "ann" },
      { at: "2027-01-04 09:07", do: "pi-poll" },
      { at: "2027-01-04 09:08", do: "cron", path: "/api/cron/generate-teams" },
    );
    const p = parseScenario(s);
    expect(p.steps.map((x) => x.do)).toContain("go-live");
    expect(p.steps.filter((x) => x.do === "vote")).toHaveLength(1);
    const rate = p.steps.find((x) => x.do === "rate");
    expect(rate?.do === "rate" && rate.mom).toBe("Bob");
  });
});
