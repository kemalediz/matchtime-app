import { describe, expect, it } from "vitest";
import { classifyPlayersGroupPost, diffSnapshots, renderHtml, renderMarkdown, summarise, type RehearsalEvent } from "./transcript";

const t = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00Z`);

const groups = [
  { key: "main", subject: "Riverside", role: "players" as const, matchtime: true, onlyAdminsCanSend: false },
  { key: "hq", subject: "Riverside HQ", role: "admin" as const, matchtime: true, onlyAdminsCanSend: false },
];
const names = { ann: "Ann", cal: "Cal" };

function events(): RehearsalEvent[] {
  return [
    { at: t("10:00"), channel: { group: "main" }, kind: "in", from: "cal", text: "out, sorry" },
    { at: t("10:10"), channel: { group: "main" }, kind: "react", from: "matchtime", text: "👍", replyTo: 0 },
    { at: t("10:11"), channel: { group: "hq" }, kind: "out", from: "matchtime", text: "Cal is out. 17/18." },
    { at: t("10:12"), channel: { dm: "+447700900003" }, kind: "out", from: "matchtime", text: "Thanks Cal" },
    { at: t("17:00"), channel: { group: "main" }, kind: "out", from: "matchtime", text: "📋 Squad for Friday\n1. Ann", meta: { instruction: "group-message" } },
    { at: t("17:01"), channel: { group: "main" }, kind: "out", from: "matchtime", text: "Man of the Match?", meta: { instruction: "group-poll" } },
    { at: t("17:02"), channel: { group: "main" }, kind: "blocked", from: "matchtime", text: "would have posted", meta: { reason: "postability" } },
    { at: t("17:03"), channel: { system: true }, kind: "error", text: "analyze 500" },
    { at: t("17:04"), channel: { group: "hq" }, kind: "graphic", from: "matchtime", text: "Ready to post", image: "graphics/1-list.png" },
  ];
}

describe("diffSnapshots", () => {
  it("reports what was added, changed and removed, in key order", () => {
    expect(
      diffSnapshots(
        { "match.att.Ann": "CONFIRMED", "match.att.Cal": "CONFIRMED", "match.status": "UPCOMING" },
        { "match.att.Ann": "CONFIRMED", "match.att.Cal": "DROPPED", "match.status": "UPCOMING", "match.team.Ann": "RED" },
      ),
    ).toEqual(["match.att.Cal: CONFIRMED → DROPPED", "match.team.Ann: (new) RED"]);
    expect(diffSnapshots({ a: "1" }, {})).toEqual(["a: 1 → (gone)"]);
    expect(diffSnapshots({ a: "1" }, { a: "1" })).toEqual([]);
  });
});

describe("summarise", () => {
  it("counts what MatchTime posted per group and per DM", () => {
    const s = summarise(events(), { groups, names, organisersAnnounce: true });
    expect(s.perGroup.main).toEqual({ posts: 2, reactions: 1, graphics: 0, blocked: 1 });
    expect(s.perGroup.hq).toEqual({ posts: 1, reactions: 0, graphics: 1, blocked: 0 });
    expect(s.dmsByRecipient["+447700900003"]).toBe(1);
  });

  it("in organisers mode, every post in the players' group that is not a reaction is a violation", () => {
    const s = summarise(events(), { groups, names, organisersAnnounce: true });
    expect(s.mainChatViolations.map((v) => v.text)).toEqual(["📋 Squad for Friday\n1. Ann", "Man of the Match?"]);
  });

  it("tells a post that lists the squad or the teams from any other post", () => {
    expect(classifyPlayersGroupPost("📋 *Squad for Friday*\n1. Ann\n2. Bob\n3. Cal")).toBe("squad-or-teams");
    expect(classifyPlayersGroupPost("✅ *Final teams*\nRed: Ann, Bob")).toBe("squad-or-teams");
    expect(classifyPlayersGroupPost("Eve is out, 5 of 6 for Fri 20:00. One slot open, say *IN* to take it.")).toBe("other");
    expect(classifyPlayersGroupPost("⚽ 20:00 at the park, see you there!")).toBe("other");
    const s = summarise(events(), { groups, names, organisersAnnounce: true });
    expect(s.mainChatViolations.map((v) => v.meta?.category)).toEqual(["squad-or-teams", "other"]);
  });

  it("with MatchTime announcing, posting in the players' group is not a violation", () => {
    expect(summarise(events(), { groups, names, organisersAnnounce: false }).mainChatViolations).toEqual([]);
  });

  it("collects errors", () => {
    expect(summarise(events(), { groups, names, organisersAnnounce: true }).errors.map((e) => e.text)).toEqual(["analyze 500"]);
  });
});

describe("render", () => {
  const facts = { title: "Riverside rehearsal", mode: "stubbed" as const, timezone: "Europe/London", groups, names, organisersAnnounce: true, sections: [{ heading: "Final squad", lines: ["Ann", "Cal"] }] };

  it("HTML: says stubbed mode proves nothing about the model, flags violations, embeds graphics and escapes text", () => {
    const evs = [...events(), { at: t("18:00"), channel: { group: "main" }, kind: "in", from: "cal", text: "<script>x</script>" } as RehearsalEvent];
    const html = renderHtml(evs, facts);
    expect(html).toContain("STUBBED");
    expect(html).toMatch(/does not prove/i);
    expect(html).toContain("VIOLATION CHECK");
    expect(html).toContain('src="graphics/1-list.png"');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Final squad");
  });

  it("HTML: a note from the scenario heads every panel", () => {
    const evs: RehearsalEvent[] = [{ at: t("09:00"), channel: { system: true }, kind: "note", text: "Week 2" }, ...events()];
    const html = renderHtml(evs, facts);
    expect(html.split("Week 2").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("Markdown: the same summary, then every event in time order", () => {
    const md = renderMarkdown(events(), facts);
    expect(md).toContain("# Riverside rehearsal");
    expect(md).toMatch(/STUBBED/);
    expect(md.indexOf("out, sorry")).toBeLessThan(md.indexOf("Cal is out. 17/18."));
    expect(md).toContain("![graphic](graphics/1-list.png)");
  });
});
