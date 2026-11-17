/**
 * AN OPEN SQUAD WITH A TEAM SHEET OUT (review of #623, item 1).
 *
 * One IN joins the smaller side (level: the lower total rating), a second
 * IN the other side, each with a seat write and ONE post that redraws the
 * sheet with the new name marked, the replacement post's own mechanism.
 * A drop leaves the sides as they are: no rebalance, no post of teams.
 */
import { describe, it, expect } from "vitest";
import { decide } from "./support/stub-picks";
import { compose } from "../compose";
import { NOW, attendanceFacts, claim, msg, world } from "./helpers";

const CONFIRMED = ["kemal", "sait", "mustafa", "abid"];
const TEAMS = { kemal: "RED", sait: "RED", mustafa: "YELLOW", abid: "YELLOW" } as const;
const selfIn = (from: string) => msg({ from, body: "in", route: "self_att", facts: attendanceFacts([claim({})]) });
const selfOut = (from: string) => msg({ from, body: "out", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) });

function openWorld(over: { confirmed?: string[]; teams?: Record<string, "RED" | "YELLOW">; ratings?: Record<string, number> } = {}) {
  const base = world({ confirmed: over.confirmed ?? CONFIRMED, teams: over.teams ?? { ...TEAMS }, features: { openSquad: true } });
  return { ...base, teamRatings: over.ratings ?? { "u-kemal": 9, "u-sait": 9, "u-mustafa": 5, "u-abid": 5 } };
}

describe("open squad with a team sheet", () => {
  it("one IN: a seat on the side with the lower total rating (sides level), and one post redrawing the sheet", () => {
    const r = decide({ now: NOW, state: openWorld(), messages: [selfIn("zeeshan")] });
    const seat = r.writes.find((w) => w.kind === "team_slot_join");
    expect(seat).toMatchObject({ kind: "team_slot_join", userId: "u-zeeshan", team: "YELLOW" });
    const post = r.speech.find((s) => s.kind === "replacement_teams_post");
    expect(post).toMatchObject({ kind: "replacement_teams_post", swaps: [], joins: [{ team: "YELLOW" }] });
  });

  it("the post: who joined which side, then the whole sheet with him marked (EN and TR)", () => {
    const r = decide({ now: NOW, state: openWorld(), messages: [selfIn("zeeshan")] });
    const text = compose(r).utterances.map((u) => u.text).join("\n");
    expect(text).toMatch(/➕ \*\S+\* joins \*\S+\*\./);
    expect(text).toContain("(new)");
    const tr = decide({ now: NOW, state: { ...openWorld(), features: { ...openWorld().features, language: "tr" as const } }, messages: [selfIn("zeeshan")] });
    expect(compose(tr).utterances.map((u) => u.text).join("\n")).toMatch(/takıma katıldı\..*/);
  });

  it("a second IN after the first: the other side (now the smaller one)", () => {
    const after = openWorld({ confirmed: [...CONFIRMED, "zeeshan"], teams: { ...TEAMS, zeeshan: "YELLOW" } });
    const r = decide({ now: NOW, state: after, messages: [selfIn("najib")] });
    expect(r.writes.find((w) => w.kind === "team_slot_join")).toMatchObject({ userId: "u-najib", team: "RED" });
  });

  it("then a drop: the sides stay as they are, nothing re-seated, no teams post", () => {
    const after = openWorld({ confirmed: [...CONFIRMED, "zeeshan", "najib"], teams: { ...TEAMS, zeeshan: "YELLOW", najib: "RED" } });
    const r = decide({ now: NOW, state: after, messages: [selfOut("kemal")] });
    expect(r.writes.filter((w) => w.kind === "team_slot_join" || w.kind === "team_slot_inherit")).toEqual([]);
    expect(r.speech.some((s) => s.kind === "replacement_teams_post")).toBe(false);
  });

  it("off: a late IN on a full squad seats nobody, as before", () => {
    const base = world({ confirmed: CONFIRMED, teams: { ...TEAMS } });
    const r = decide({ now: NOW, state: { ...base, maxPlayers: 4 }, messages: [selfIn("zeeshan")] });
    expect(r.writes.some((w) => w.kind === "team_slot_join")).toBe(false);
  });
});
