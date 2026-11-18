/**
 * WHICH REPLY CARRIES THE BATCH'S SQUAD POST (`squad-post-carrier.ts`,
 * review of #595, found in #604, carried onto main 2026-11-18).
 *
 * The marker went on the LAST reply that speaks, and the composition skips
 * some replies (the unified answer, stats answers, help, the pitch set by
 * words, any reply that is not the model's): a marker on one of those was
 * stripped, and "Ian Innes is in" beside "@Match Time who's on the bench?"
 * lost the squad post. It now goes on the last speaking reply the
 * composition renders, else on the message that changed the squad. A team
 * post is left as before (its sheet is the squad post once teams exist).
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
    ["a stats table", "stats_table"],
    ["a generic stats answer", "stats_generic"],
    ["the stats link line", "stats_link"],
  ])("%s, last in the batch: the message that changed the squad carries it", (_what, intent) => {
    expect(carrier([IN, ask(intent)])).toBe("wa-in");
  });

  it.each(["help", "not_understood", "guest_name_ask"])("a reply that is not the model's (%s, fast-path): the change carries it", (intent) => {
    expect(carrier([IN, ask(intent, "fast-path")])).toBe("wa-in");
  });

  it("a skipped reply first and a composed one last: the composed one carries it", () => {
    expect(carrier([ask("unified_answer"), IN, { waMessageId: "wa-out", handledBy: "llm", intent: "out", reply: "Pat, you're out." }])).toBe("wa-out");
  });

  it("a late reply never carries it", () => {
    const late: CarrierResult = { waMessageId: "wa-late", handledBy: "llm", intent: "out", reply: "Pat, you're out." };
    expect(carrier([IN, late], { late: ["wa-late"] })).toBe("wa-in");
  });

  it("the changing message is not in the results: nobody", () => {
    expect(squadPostCarrierId([ask("unified_answer")], { squadPostId: "wa-gone", late: new Set(), teamPostIds: new Set() })).toBeNull();
  });
});

describe("UNCHANGED: a team post is left as it was", () => {
  it.each(["show_teams_request", "generate_teams_request"])("%s, last: it takes the marker, as before", (intent) => {
    expect(carrier([IN, ask(intent)])).toBe("wa-q");
  });

  it("a replacement or swap sheet (by id), last: it takes the marker, as before", () => {
    expect(carrier([IN, ask("in")], { teamPosts: ["wa-q"] })).toBe("wa-q");
  });

  it("a composable reply last: it carries it, as before", () => {
    expect(carrier([IN, ask("count")])).toBe("wa-q");
  });
});

describe("composesSquadPost: the composition's own filter", () => {
  it("the model's reply with an ordinary intent", () => {
    expect(composesSquadPost(ask("count"), new Set())).toBe(true);
  });
  it("a pasted roster's ack, the one fast-path reply it renders", () => {
    expect(composesSquadPost(ask("pasted_roster", "fast-path"), new Set())).toBe(true);
  });
  it("no words, a skipped intent, or a team post by id: not rendered", () => {
    expect(composesSquadPost({ ...ask("count"), reply: null }, new Set())).toBe(false);
    expect(composesSquadPost(ask("unified_answer"), new Set())).toBe(false);
    expect(composesSquadPost(ask("count"), new Set(["wa-q"]))).toBe(false);
  });
});
