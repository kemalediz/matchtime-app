/**
 * THE CLAUSE PEEL — the unit tests for the mechanism that ends the
 * terminal-short-circuit bug class in `api/whatsapp/analyze/route.ts`.
 *
 * Six production incidents have the same shape: a fast path matched
 * PART of a message, claimed the WHOLE message, and every other clause
 * in it was destroyed. The most recent, still unfixed at the time these
 * tests were written:
 *
 *   "@Match Time swap Elvin with Raihan, and I'm out"
 *      → the swap applied, the sender stayed CONFIRMED.
 *
 * `peelClause` is the same move `registerForEntryRequiresTag` made one
 * layer down on 2026-09-08: ask the question PER CLAUSE, not per
 * message. A fast path claims the clause it recognises; the rest of the
 * body carries on down the pipeline.
 *
 * THE SAFETY PROPERTY THESE TESTS EXIST TO PIN: the split can only ever
 * ADD a residual. Every body a fast path owns today, it still owns —
 * because when no split produces a matching clause, the WHOLE body is
 * the last fallback. A clause peel can never make a handled message
 * unhandled, and `never loses a body the predicate matched` says so
 * over every shape in this file.
 */
import { describe, it, expect } from "vitest";
import {
  mergeOneReply,
  applyClauseReports,
  type ClauseReport,
  type MergeableResult,
} from "../clause-peel";

describe("mergeOneReply — MatchTime replies once or not at all", () => {
  it("joins two sentences into ONE outbound message", () => {
    expect(mergeOneReply("👋 You're out, Kemal.", "🔁 Raihan takes Elvin's place.")).toBe(
      "👋 You're out, Kemal.\n\n🔁 Raihan takes Elvin's place.",
    );
  });
  it("passes either half through alone", () => {
    expect(mergeOneReply(null, "🔁 Swapped.")).toBe("🔁 Swapped.");
    expect(mergeOneReply("👋 Out.", null)).toBe("👋 Out.");
  });
  it("treats whitespace as silence", () => {
    expect(mergeOneReply("   ", "  ")).toBeNull();
    expect(mergeOneReply(undefined, undefined)).toBeNull();
  });
  it("collapses two identical lines rather than saying them twice", () => {
    expect(mergeOneReply("🔁 Swapped.", "🔁 Swapped.")).toBe("🔁 Swapped.");
  });
});

describe("applyClauseReports — two owners wrote, one speaks", () => {
  const SWAP: ClauseReport = {
    handledBy: "fast-path",
    intent: "team_swap",
    action: "team-swap",
    reasoning: "team-slot-transfer applied",
    react: "✅",
    reply: "🔁 Ian takes Pat's place.",
  };

  /** Collects what `augmentAnalysis` was asked to do. */
  function recorder() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      augment: async (a: Record<string, unknown>) => {
        calls.push(a);
      },
    };
  }

  it("merges into the owner's ONE result rather than pushing a second", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: "👋 You're out." },
    ];
    const rec = recorder();
    await applyClauseReports({
      reports: new Map([["m1", SWAP]]),
      results,
      augment: rec.augment,
    });
    expect(results).toHaveLength(1);
    expect(results[0].reply).toBe("👋 You're out.\n\n🔁 Ian takes Pat's place.");
  });

  // The owner's react describes the write that actually landed, and for
  // a sender's own attendance it has already been reconciled against the
  // final database row. The fast path's only fills a hole.
  it("keeps the OWNER's react and lets the fast path fill an empty one", async () => {
    const withReact: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: null },
    ];
    const withoutReact: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: null, reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results: withReact, augment: rec.augment });
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results: withoutReact, augment: rec.augment });
    expect(withReact[0].react).toBe("👋");
    expect(withoutReact[0].react).toBe("✅");
  });

  it("keeps the owner's LABEL and appends the fast path's outcome to the row", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results[0].intent).toBe("out");
    expect(results[0].handledBy).toBe("llm");
    // The row records BOTH halves; neither replaces the other.
    expect(rec.calls[0]).toMatchObject({
      waMessageId: "m1",
      action: "team-swap",
      reasoningSuffix: "team-slot-transfer applied",
    });
    expect(rec.calls[0].handledBy).toBeUndefined();
  });

  // When nobody owned the residual, the ONLY thing that happened to the
  // message is what the fast path did — so the admin log must say
  // `team_swap`, not `noise`, or the log and the world disagree.
  it("RELABELS when the owner recorded nothing", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "ignored", intent: "noise", react: null, reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results[0].handledBy).toBe("fast-path");
    expect(results[0].intent).toBe("team_swap");
    expect(results[0].react).toBe("✅");
    expect(rec.calls[0]).toMatchObject({ handledBy: "fast-path", intent: "team_swap" });
  });

  it("logs rather than invents when there is no result to merge into", async () => {
    const results: MergeableResult[] = [];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);
  });
});
