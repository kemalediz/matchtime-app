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
 * The results of one batch, in the route's order. Pure. Made-up ids.
 */
import { describe, expect, it } from "vitest";
import { composesSquadPost, squadPostCarrierId, type CarrierResult } from "../squad-post-carrier";

const IN: CarrierResult = { waMessageId: "wa-in", handledBy: "llm", intent: "in", reply: null };
const ask = (intent: string, handledBy = "llm"): CarrierResult => ({ waMessageId: "wa-q", handledBy, intent, reply: "an answer" });
const carrier = (results: CarrierResult[], opts: { late?: string[]; teamPosts?: string[] } = {}) =>
  squadPostCarrierId(results, { squadPostId: "wa-in", late: new Set(opts.late ?? []), teamPostIds: new Set(opts.teamPosts ?? []) });

describe("a reply the squad composition skips never carries the squad post", () => {
  it.each([
    ["the unified answer", "unified_answer"],
    ["the open answer", "open_answer"],
    ["a stats table", "stats_table"],
    ["a generic stats answer", "stats_generic"],
    ["the stats link line", "stats_link"],
    ["making the teams", "generate_teams_request"],
    ["showing the teams", "show_teams_request"],
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

  it("a replacement team sheet (a deterministic team post): the IN carries it", () => {
    expect(carrier([IN, { ...ask("in"), waMessageId: "wa-swap" }], { teamPosts: ["wa-swap"] })).toBe("wa-in");
  });

  it("a skipped reply first and a composed one last: the composed one carries it", () => {
    expect(carrier([ask("unified_answer"), IN, { waMessageId: "wa-out", handledBy: "llm", intent: "out", reply: "Pat, you're out." }])).toBe("wa-out");
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
    expect(squadPostCarrierId([ask("unified_answer")], { squadPostId: "wa-gone", late: new Set(), teamPostIds: new Set() })).toBeNull();
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
