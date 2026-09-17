/**
 * THE PERSONAL STATS LINK — DECIDED BY THE ENGINE (2026-09-17).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `STATS_REQUEST` in `analyze/route.ts`'s fast-path loop:
 *
 *   /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i
 *
 * English only, so the Turkish help's advertised "@Match Time
 * istatistiklerim" did nothing. `MDs/router-accuracy-2026-09-11.md` §1.9
 * measured it at 0 matches in 143 days and §2.5 recommended converting it
 * to a `question` topic rather than an `admin_ops` action, keeping the
 * personal-stats path away from the route that guards the mass-DM doors.
 *
 * The ask is now `QuestionFacts.topic = "my_stats"`. The engine decides;
 * the analyze route performs the DM. The DM carries no recipient from the
 * model or from the engine: the route sends it to the SENDER of the
 * message the flag sits on, so no fact can point it at anyone else.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, msg, world } from "./helpers";

const MY_STATS = { kind: "question", topic: "my_stats", personRef: null, statedCount: null } as const;

const ask = (
  from: string | null,
  opts: { tagged?: boolean; noMatch?: boolean; attendance?: boolean; topic?: "my_stats" | "stats" } = {},
) =>
  decide({
    now: NOW,
    state: world({
      confirmed: ["kemal", "elvin", "sait"],
      noMatch: opts.noMatch,
      features: { attendance: opts.attendance ?? true },
    }),
    messages: [
      msg({
        id: "wa-ask",
        from,
        tagged: opts.tagged ?? true,
        body: "@Match Time my stats",
        route: "question",
        facts: { ...MY_STATS, topic: opts.topic ?? "my_stats" },
      }),
    ],
  });

const outcome = (r: ReturnType<typeof decide>) => r.outcomes.find((o) => o.messageId === "wa-ask")!;

describe("the personal stats link is decided by the engine", () => {
  it("a tagged, resolved sender gets the link, and the 📊 react", () => {
    const r = ask("sait");
    expect(outcome(r).statsLinkRequested).toBe(true);
    expect(outcome(r).react).toBe("📊");
    expect(outcome(r).disposition).toBe("acted");
  });

  it("no admin gate: it is the sender's own data", () => {
    // Sait is not an admin in the test world.
    expect(outcome(ask("sait")).statsLinkRequested).toBe(true);
    expect(outcome(ask("kemal")).statsLinkRequested).toBe(true);
  });

  it("proposes no WRITE and no group speech: the link goes by DM, and only by DM", () => {
    const r = ask("sait");
    expect(r.writes).toHaveLength(0);
    expect(r.speech.filter((s) => s.messageId === "wa-ask")).toHaveLength(0);
  });

  it("UNTAGGED is refused (the interaction contract), with no react", () => {
    const r = ask("sait", { tagged: false });
    expect(outcome(r).statsLinkRequested ?? false).toBe(false);
    expect(outcome(r).react).toBeNull();
  });

  it("an UNRESOLVED sender is refused: there is nobody to DM", () => {
    const r = ask(null);
    expect(outcome(r).statsLinkRequested ?? false).toBe(false);
    expect(outcome(r).react).toBeNull();
    expect(outcome(r).reasons.join(" ")).toMatch(/unresolved/i);
  });

  it("does not depend on an upcoming match, nor on attendance tracking", () => {
    // "wrapped" is an end-of-season ask; the old fast path had neither gate.
    expect(outcome(ask("sait", { noMatch: true })).statsLinkRequested).toBe(true);
    expect(outcome(ask("sait", { attendance: false })).statsLinkRequested).toBe(true);
  });

  it("the GROUP stats topic never requests a link", () => {
    expect(outcome(ask("sait", { topic: "stats" })).statsLinkRequested ?? false).toBe(false);
  });
});

describe("the question extractor accepts the topic", () => {
  it("parses my_stats rather than degrading it to other", async () => {
    const { extractForRoute } = await import("../extractors");
    const res = await extractForRoute(
      {
        name: "stub",
        async complete() {
          return {
            text: JSON.stringify({ topic: "my_stats", personRef: "", statedCount: -1 }),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0,
            ms: 1,
          };
        },
      },
      "question",
      { id: "x", body: "@Match Time istatistiklerim", authorName: "Mehmet", tagged: true, history: [], lastBotPost: null },
    );
    expect(res.facts).toMatchObject({ kind: "question", topic: "my_stats" });
  });
});
