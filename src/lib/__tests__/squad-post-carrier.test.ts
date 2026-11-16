/**
 * WHICH REPLY CARRIES THE BATCH'S SQUAD POST (`squad-post-carrier.ts`,
 * 2026-11-16, the defect PR #604's item 5 found).
 *
 * The analyze route puts the batch's `[SQUAD]` marker on the LAST reply that
 * speaks, and the squad composition then renders it. But the composition
 * skips some replies (the unified and open answers, stats answers, help, the
 * team posts, the pitch set by words, any reply that is not the model's),
 * and a marker on one of those was never rendered and was stripped: "Ian
 * Innes is in" beside "@Match Time who's on the bench?" (UNIFIED_ANSWERS on)
 * lost the squad post. The marker now goes on the last speaking reply the
 * composition does render, else on the message that changed the squad.
 *
 * EXCEPT when the batch already posts a team sheet (review of #604,
 * 2026-11-16): once teams exist the squad post the composition renders IS
 * the team sheet, so the IN carrying it sent the sheet twice ("Ian Innes is
 * in" + "@Match Time show the teams"). Then nobody carries it: the sheet is
 * the batch's squad post. And a reply the composition turns into that same
 * sheet keeps only its own words (`withoutRepeatedTeamSheet`).
 *
 * The results of one batch, in the route's order. Pure. Made-up ids.
 */
import { describe, expect, it } from "vitest";
import { composesSquadPost, postsTeamSheet, squadPostCarrierId, withoutRepeatedTeamSheet, type CarrierResult } from "../squad-post-carrier";

const IN: CarrierResult = { waMessageId: "wa-in", handledBy: "llm", intent: "in", reply: null };
const ask = (intent: string, handledBy = "llm"): CarrierResult => ({ waMessageId: "wa-q", handledBy, intent, reply: "an answer" });
const carrier = (results: CarrierResult[], opts: { late?: string[]; teamPosts?: string[]; appendedSheets?: string[] } = {}) =>
  squadPostCarrierId(results, {
    squadPostId: "wa-in",
    late: new Set(opts.late ?? []),
    teamPostIds: new Set(opts.teamPosts ?? []),
    appendedSheetIds: new Set(opts.appendedSheets ?? []),
  });

describe("a reply the squad composition skips never carries the squad post", () => {
  it.each([
    ["the unified answer", "unified_answer"],
    ["the open answer", "open_answer"],
    ["a stats table", "stats_table"],
    ["a generic stats answer", "stats_generic"],
    ["the stats link line", "stats_link"],
    ["the pitch set by words", "venue-set"],
    ["the organisers' space answer", "organisers_space"],
  ])("%s, last in the batch: the IN that changed the squad carries it", (_what, intent) => {
    expect(carrier([IN, ask(intent)])).toBe("wa-in");
  });

  it.each([
    ["help", "help"],
    ["the not-understood line", "not_understood"],
    ["a guest-name ask", "guest_name_ask"],
  ])("a reply that is not the model's (%s, fast-path): the IN carries it", (_what, intent) => {
    expect(carrier([IN, ask(intent, "fast-path")])).toBe("wa-in");
  });


  it("a skipped reply first and a composed one last: the composed one carries it", () => {
    expect(carrier([ask("unified_answer"), IN, { waMessageId: "wa-out", handledBy: "llm", intent: "out", reply: "Pat, you're out." }])).toBe("wa-out");
  });
});

describe("a batch that already posts a team sheet: NOBODY carries the squad post (the sheet is it)", () => {
  it.each([
    ["making the teams", "generate_teams_request"],
    ["showing the teams", "show_teams_request"],
  ])("%s beside the IN: no carrier, so the sheet is not sent twice", (_what, intent) => {
    expect(carrier([IN, ask(intent)])).toBeNull();
  });

  it("a replacement team sheet or a team-ops swap's sheet (a deterministic team post): no carrier", () => {
    expect(carrier([IN, { ...ask("in"), waMessageId: "wa-swap" }], { teamPosts: ["wa-swap"] })).toBeNull();
  });

  it("the team half of an attendance message, appended after the composition: no carrier", () => {
    expect(carrier([IN, ask("count")], { appendedSheets: ["wa-in"] })).toBeNull();
  });

  it("the team post first and a composable reply last: still no carrier", () => {
    expect(carrier([ask("show_teams_request"), IN, { waMessageId: "wa-out", handledBy: "llm", intent: "out", reply: "Pat, you're out." }])).toBeNull();
  });

  it("a team-post intent with nothing said (show the teams when none are made: a react) posts no sheet", () => {
    expect(carrier([IN, { ...ask("show_teams_request"), reply: null }])).toBe("wa-in");
  });
});

describe("postsTeamSheet", () => {
  it("the two team posts with words, and a deterministic team post, yes", () => {
    expect(postsTeamSheet(ask("generate_teams_request"), new Set())).toBe(true);
    expect(postsTeamSheet(ask("show_teams_request"), new Set())).toBe(true);
    expect(postsTeamSheet(ask("in"), new Set(["wa-q"]))).toBe(true);
  });

  it("anything else, or no words, no", () => {
    expect(postsTeamSheet(ask("count"), new Set())).toBe(false);
    expect(postsTeamSheet({ ...ask("show_teams_request"), reply: null }, new Set())).toBe(false);
  });
});

describe("withoutRepeatedTeamSheet: a reply composed into the sheet the batch already posts", () => {
  const SHEET = "⚽ *Teams for tonight*: 22:00\n\n*Red*:\n1. A\n\n*Yellow*:\n1. B";

  it("only the sheet: nothing", () => {
    expect(withoutRepeatedTeamSheet(SHEET, SHEET)).toBeNull();
  });

  it("its own lead and the sheet: the lead", () => {
    expect(withoutRepeatedTeamSheet(`Pat, you're in.\n\n${SHEET}`, SHEET)).toBe("Pat, you're in.");
  });

  it("anything else: unchanged", () => {
    expect(withoutRepeatedTeamSheet("12 in, 2 to go.", SHEET)).toBe("12 in, 2 to go.");
  });
});

describe("UNCHANGED: the last speaking reply the composition renders carries it (one send)", () => {
  it("a squad answer beside the IN", () => {
    expect(carrier([IN, ask("squad_status")])).toBe("wa-q");
  });

  it("two speaking replies: the last", () => {
    expect(carrier([{ ...ask("in"), waMessageId: "wa-a" }, IN, ask("count")])).toBe("wa-q");
  });

  it("a pasted roster's ack (fast-path, but rendered by the composition)", () => {
    expect(carrier([IN, ask("pasted_roster", "fast-path")])).toBe("wa-q");
  });

  it("a late reply never carries it", () => {
    expect(carrier([IN, ask("count")], { late: ["wa-q"] })).toBe("wa-in");
  });

  it("nothing else speaks: the IN itself", () => {
    expect(carrier([IN])).toBe("wa-in");
  });

  it("the squad-change message is not in the results: nobody", () => {
    expect(squadPostCarrierId([ask("unified_answer")], { squadPostId: "wa-gone", late: new Set(), teamPostIds: new Set(), appendedSheetIds: new Set() })).toBeNull();
  });
});

describe("composesSquadPost: the composition's own filter, one definition for both", () => {
  it("a model reply with a squad-shaped intent: yes", () => {
    expect(composesSquadPost(ask("count"), new Set())).toBe(true);
  });

  it("no words: no", () => {
    expect(composesSquadPost(IN, new Set())).toBe(false);
  });

  it("a skipped intent, a fast-path reply or a team post: no", () => {
    expect(composesSquadPost(ask("unified_answer"), new Set())).toBe(false);
    expect(composesSquadPost(ask("help", "fast-path"), new Set())).toBe(false);
    expect(composesSquadPost(ask("in"), new Set(["wa-q"]))).toBe(false);
  });
});
