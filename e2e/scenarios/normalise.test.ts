import { describe, expect, it } from "vitest";
import type { RehearsalEvent } from "../rehearsal/transcript";
import type { Step } from "../rehearsal/scenario";
import { buildTranscript, relabelText } from "./normalise";

const at = (iso: string) => new Date(iso);
const labels = new Map([
  ["cmhx0abcdefghijklmnopqrst", "@cal"],
  ["reh-org-fnf", "<club>"],
  ["cmmatch0000000000000000001", "<match 2027-01-08 20:30>"],
]);
const members = { "447700970003": "cal", "447700970001": "ann" };

const steps: Step[] = [
  { at: at("2027-01-05T18:30:00Z"), seq: 0, do: "message", group: "main", from: "cal", body: "IN" },
  { at: at("2027-01-06T09:00:00Z"), seq: 1, do: "message", group: "hq", from: "ann", body: "@Match Time make teams", tag: true },
];

function events(): RehearsalEvent[] {
  return [
    { at: at("2027-01-05T09:00:00Z"), frame: -1, channel: { system: true }, kind: "info", from: "runner", text: "club live" },
    { at: at("2027-01-05T18:30:00Z"), frame: 0, channel: { group: "main" }, kind: "in", from: "cal", text: "IN", meta: { handledBy: "engine / self_in" } },
    { at: at("2027-01-05T18:40:00Z"), frame: 0, channel: { group: "main" }, kind: "react", from: "matchtime", text: "✅", replyTo: 1 },
    {
      at: at("2027-01-05T18:41:00Z"),
      frame: 0,
      channel: { dm: "447700970003" },
      kind: "out",
      from: "matchtime",
      text: "You're in. Pay here https://localhost:3471/p/Zx81kQ (user cmhx0abcdefghijklmnopqrst)",
      meta: { instruction: "dm", key: "cmmatch0000000000000000001:in-dm:cmhx0abcdefghijklmnopqrst", mentions: ["ann"] },
    },
    { at: at("2027-01-05T18:41:00Z"), frame: 0, channel: { system: true }, kind: "db", text: "match 2027-01-08 20:30: Cal Cooper: (new) CONFIRMED" },
    { at: at("2027-01-06T09:00:00Z"), frame: 1, channel: { group: "hq" }, kind: "in", from: "ann", text: "@Match Time make teams" },
    { at: at("2027-01-06T09:01:00Z"), frame: 1, channel: { system: true }, kind: "error", text: "POST /api/x → 500 boom at 2027-01-06T09:01:13.120Z" },
  ];
}

describe("relabelText", () => {
  it("turns every known id into its stable label and masks the rest of the run-to-run noise", () => {
    expect(relabelText("u cmhx0abcdefghijklmnopqrst m cmmatch0000000000000000001 x czzzzzzzzzzzzzzzzzzzzzzzz", labels)).toBe(
      "u @cal m <match 2027-01-08 20:30> x <id>",
    );
    expect(relabelText("https://localhost:3471/r/AbCdEf12", labels)).toBe("https://localhost:3471/r/<tok>");
  });

  it("keeps an epoch-milliseconds stamp only to the minute (the server's clock drifts within a step)", () => {
    expect(relabelText("org-x:provisional-review:admin-group:p1794823324308", labels)).toBe(relabelText("org-x:provisional-review:admin-group:p1794823320125", labels));
    expect(relabelText("k:1794243600000", labels)).toBe("k:1794243600000");
    expect(relabelText("count 12345", labels)).toBe("count 12345");
  });

  it("masks a squad fingerprint (a hash of user ids, new every run) but keeps the rest of the key", () => {
    expect(relabelText("cmmatch0000000000000000001:roster-shown:dd4d3b712b07c862:1794243600000", labels)).toBe(
      "<match 2027-01-08 20:30>:roster-shown:<squad>:1794243600000",
    );
    expect(relabelText("x:month-list:0123456789abcdef:2", labels)).toBe("x:month-list:<squad>:2");
    expect(relabelText("txtlog:<club>:976f148cb3b6dca2:x", labels)).toBe("txtlog:<club>:976f148cb3b6dca2:x");
  });
});

describe("buildTranscript", () => {
  const t = buildTranscript({ club: "fnf", title: "FNF type", mode: "replay", timezone: "Europe/London", steps, events: events(), labels, members, final: { "user @cal": "name \"Cal\"" } });

  it("has one entry per scenario step, plus what happened before the first", () => {
    expect(t.steps.map((s) => s.seq)).toEqual([-1, 0, 1]);
    expect(t.steps[1].step).toBe('2027-01-05 18:30 main @cal: "IN"');
    expect(t.steps[2].step).toBe('2027-01-06 09:00 hq @ann [tag]: "@Match Time make teams"');
  });

  it("records what MatchTime sent, where, with whom it tagged, all in stable terms", () => {
    const out = t.steps[1].out;
    expect(out).toEqual([
      { at: "2027-01-05 18:40", to: "group main", kind: "react", text: "✅", replyTo: "@cal: IN" },
      {
        at: "2027-01-05 18:41",
        to: "dm @cal",
        kind: "out",
        text: "You're in. Pay here https://localhost:3471/p/<tok> (user @cal)",
        instruction: "dm",
        key: "<match 2027-01-08 20:30>:in-dm:@cal",
        mentions: ["ann"],
      },
    ]);
  });

  it("keeps how each incoming message was handled, the database changes and the errors", () => {
    expect(t.steps[1].handled).toEqual(['@cal in main: "IN" → engine / self_in']);
    expect(t.steps[1].db).toEqual(["match 2027-01-08 20:30: Cal Cooper: (new) CONFIRMED"]);
    expect(t.steps[2].errors).toEqual(["POST /api/x → 500 boom at 2027-01-06T09:01Z"]);
  });

  it("is byte-identical for two runs that differ only in ids, tokens and seconds", () => {
    const e2 = events();
    e2[3] = { ...e2[3], text: "You're in. Pay here https://localhost:3471/p/Qq00Rr (user cmhx0abcdefghijklmnopqrst)" };
    e2[6] = { ...e2[6], text: "POST /api/x → 500 boom at 2027-01-06T09:01:59.999Z" };
    const t2 = buildTranscript({ club: "fnf", title: "FNF type", mode: "replay", timezone: "Europe/London", steps, events: e2, labels, members, final: { "user @cal": "name \"Cal\"" } });
    expect(JSON.stringify(t2)).toBe(JSON.stringify(t));
  });
});
