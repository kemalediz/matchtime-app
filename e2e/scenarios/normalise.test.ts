import { describe, expect, it } from "vitest";
import type { RehearsalEvent } from "../rehearsal/transcript";
import type { Step } from "../rehearsal/scenario";
import { hashOutboundText } from "@/lib/dispatch-claim";
import { buildTranscript, normaliseMarkdown, outboundTextLabels, relabelText } from "./normalise";

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
    expect(relabelText("https://localhost:3471/r/AbCdEf12", labels)).toBe("<app>/r/<tok>");
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
        text: "You're in. Pay here <app>/p/<tok> (user @cal)",
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

  it("is byte-identical for two runs that differ only in ids, tokens, seconds and the app's port", () => {
    const e2 = events();
    e2[3] = { ...e2[3], text: "You're in. Pay here http://localhost:3472/p/Qq00Rr (user cmhx0abcdefghijklmnopqrst)" };
    e2[6] = { ...e2[6], text: "POST /api/x → 500 boom at 2027-01-06T09:01:59.999Z" };
    const t2 = buildTranscript({ club: "fnf", title: "FNF type", mode: "replay", timezone: "Europe/London", steps, events: e2, labels, members, final: { "user @cal": "name \"Cal\"" } });
    expect(JSON.stringify(t2)).toBe(JSON.stringify(t));
  });
});

describe("buildTranscript's final snapshot", () => {
  it("is ordered by the normalised keys, so an id or hash that differs per run never reorders it", () => {
    const l = new Map([["aaaaaaaa11", "<z>"], ["zzzzzzzz11", "<z>"]]);
    const build = (final: Record<string, string>) =>
      JSON.stringify(buildTranscript({ club: "fnf", title: "FNF type", mode: "replay", timezone: "Europe/London", steps, events: [], labels: l, members, final }).final);
    expect(build({ "aaaaaaaa11 row": "1", "b row": "2" })).toBe(build({ "zzzzzzzz11 row": "1", "b row": "2" }));
  });
});

describe("normaliseMarkdown (the readable <club>/transcript.md)", () => {
  const md = (tok: string, port: number, id: string) =>
    [
      "# FNF type (replay)",
      "",
      `- 2027-01-05 18:41 [DM Cal Cooper] **MatchTime**: Rate here:`,
      `    http://localhost:${port}/r/${tok}`,
      `    Or open: http://localhost:${port}/admin/matches/${id}/cancel`,
      `- 2027-01-05 18:41 database: sent-notification offer-${id}:dm:@cal: (new) dm`,
      `    user cmhx0abcdefghijklmnopqrst at 2027-01-05T18:41:07.512Z`,
    ].join("\n");

  it("masks link tokens, the app's port, ids and seconds exactly as the .transcript.json does", () => {
    expect(normaliseMarkdown(md("iCSqhP4Vrk", 3471, "cmw8z3eun00g4yr9k6g083lp0"), labels)).toBe(
      [
        "# FNF type (replay)",
        "",
        "- 2027-01-05 18:41 [DM Cal Cooper] **MatchTime**: Rate here:",
        "    <app>/r/<tok>",
        "    Or open: <app>/admin/<tok>",
        "- 2027-01-05 18:41 database: sent-notification offer-<id>:dm:@cal: (new) dm",
        "    user @cal at 2027-01-05T18:41Z",
      ].join("\n"),
    );
  });

  it("is byte-identical for two runs that differ only in link tokens, ids and the app's port", () => {
    expect(normaliseMarkdown(md("iCSqhP4Vrk", 3471, "cmw8z3eun00g4yr9k6g083lp0"), labels)).toBe(
      normaliseMarkdown(md("gfvVRSbFg8", 3472, "cmw8z3eun00g40k9k6g083lp0"), labels),
    );
  });
});

describe("outboundTextLabels (the server's txtlog:<org>:<hash of the sent text> rows)", () => {
  // The server hashes each text it sends (src/lib/dispatch-claim.ts). A text
  // holding the app's link hashes differently on another MT_E2E_APP_PORT,
  // so the hash is swapped for one of the text in stable terms.
  const sent = (text: string, port: number): RehearsalEvent => ({
    at: at("2027-01-05T18:41:00Z"),
    frame: 0,
    channel: { group: "hq" },
    kind: "out",
    from: "matchtime",
    text: text.replace("{app}", `http://localhost:${port}`),
  });
  const hq = "Rate the new players here: {app}/admin/ratings";
  const row = (port: number) => `sent-notification txtlog:<club>:${hashOutboundText(hq.replace("{app}", `http://localhost:${port}`))}:botjob-<id>`;

  it("gives a text sent on two ports the same label", () => {
    const a = relabelText(row(3471), new Map([...labels, ...outboundTextLabels([sent(hq, 3471)])]));
    const b = relabelText(row(3472), new Map([...labels, ...outboundTextLabels([sent(hq, 3472)])]));
    expect(a).toMatch(/^sent-notification txtlog:<club>:<text [0-9a-f]{8}>:botjob-<id>$/);
    expect(b).toBe(a);
  });

  it("keeps two different texts apart (rows that differ only by the hash stay two rows)", () => {
    const other = "Teams are out: {app}/admin/teams";
    const l = outboundTextLabels([sent(hq, 3471), sent(other, 3471)]);
    expect(new Set(l.values()).size).toBe(2);
  });

  it("covers a poll, which the server hashes as its question and options", () => {
    const ev = sent("📊 Man of the match?\n○ Ann\n○ Cal", 3471);
    const l = outboundTextLabels([ev]);
    expect(l.get(hashOutboundText("Man of the match?\nAnn\nCal"))).toMatch(/^<text [0-9a-f]{8}>$/);
  });

  it("ignores what MatchTime did not send as a text (incoming messages, reactions)", () => {
    const incoming: RehearsalEvent = { ...sent(hq, 3471), kind: "in", from: "ann" };
    const react: RehearsalEvent = { ...sent("✅", 3471), kind: "react" };
    expect(outboundTextLabels([incoming, react]).size).toBe(0);
  });
});
