/**
 * THE DM MATCH-AVAILABILITY CLASSIFIER (rewritten 2026-10-18).
 *
 * A wrong "in" puts a player in a squad from a DM, so the model is told
 * what MatchTime actually said to the player last (its words, or what a
 * scheduler DM was about), the match, and where the player stands for it,
 * instead of a bare "the bot asked them" flag. Every verdict is logged.
 *
 * These tests drive the real parse and the real user turn with an
 * injected model call: no key, no network. What the real model does with
 * the words is measured by `scripts/dryrun-match-availability.ts` and
 * `e2e/sim/match-availability-live.spec.ts`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MATCH_AVAILABILITY_MIN_CONFIDENCE,
  availabilityStatusLabel,
  buildMatchAvailabilitySystemPrompt,
  buildMatchAvailabilityUserTurn,
  classifyMatchAvailability,
  parse,
  type MatchAvailabilityContext,
} from "../match-availability-classifier";

const CTX: MatchAvailabilityContext = {
  userId: "u-ian",
  matchId: "m-tue",
  playerName: "Ian Innes",
  clubName: "Sutton FC",
  matchName: "Tuesday 7-a-side",
  matchWhen: "Tue 20 Oct, 20:00",
  currentStatus: "not signed up",
  lastBotDm: "Hi Ian, we're 2 short for Tuesday 7-a-side (Tue 20 Oct, 20:00). Playing? Reply IN or OUT.",
};

const answer = (o: object) => async () => JSON.stringify(o);

describe("the user turn carries what MatchTime said, the match and the player's status", () => {
  it("names the match with its day and time, and the player's current status", () => {
    const u = buildMatchAvailabilityUserTurn("go on then", CTX);
    expect(u).toContain("Tuesday 7-a-side");
    expect(u).toContain("Tue 20 Oct, 20:00");
    expect(u).toMatch(/status for it: not signed up/i);
  });

  it("quotes MatchTime's last message to the player, word for word", () => {
    const u = buildMatchAvailabilityUserTurn("go on then", CTX);
    expect(u).toContain(`MatchTime's last message to them: ${JSON.stringify(CTX.lastBotDm)}`);
  });

  it("a scheduler DM's bracketed description goes in as it is", () => {
    const u = buildMatchAvailabilityUserTurn("yes", {
      ...CTX,
      lastBotDm: "(a question asking whether they can play in the match: in or out)",
    });
    expect(u).toContain("MatchTime's last message to them: (a question asking whether they can play in the match: in or out)");
  });

  it("an unknown last message says so rather than inventing one", () => {
    const u = buildMatchAvailabilityUserTurn("yes", { ...CTX, lastBotDm: null });
    expect(u).toContain("MatchTime's last message to them: (not known)");
  });

  it("the message itself comes last, under its own header, read whole", () => {
    const u = buildMatchAvailabilityUserTurn("  yes\nsee you there  ", CTX);
    expect(u.endsWith("THE DM:\nyes\nsee you there")).toBe(true);
  });

  it("never hands the model ids, and the old yes/no flag is gone", () => {
    const u = buildMatchAvailabilityUserTurn("go on then", CTX);
    expect(u).not.toContain("u-ian");
    expect(u).not.toContain("m-tue");
    expect(u).not.toMatch(/Bot asked this player/i);
  });
});

describe("the prompt", () => {
  const p = buildMatchAvailabilitySystemPrompt();

  it("reads MatchTime's last message instead of a flag", () => {
    expect(p).toContain("MatchTime's last message");
    expect(p).not.toMatch(/context line says the bot asked/i);
  });

  it("is one bilingual definition: no Turkish rule bolted on as 1a", () => {
    expect(p).not.toMatch(/\b1a\./);
    expect(p).toMatch(/English \| Turkish/);
  });

  it("states the same certainty bar the code enforces", () => {
    expect(p).toContain(`${Math.round(MATCH_AVAILABILITY_MIN_CONFIDENCE * 100)}% sure`);
  });

  it("keeps the closed JSON contract", () => {
    expect(p).toContain('"decision": "in" | "out" | "unclear"');
  });
});

describe("the certainty bar", () => {
  it("is 0.8, the bar the prompt states and the sibling DM classifiers use", () => {
    expect(MATCH_AVAILABILITY_MIN_CONFIDENCE).toBe(0.8);
  });

  it("an 'in' below the bar is forced to unclear, so nothing is written", () => {
    const r = parse(JSON.stringify({ decision: "in", confidence: 0.79, reasoning: "casual yes" }));
    expect(r.decision).toBe("unclear");
    expect(r.reasoning).toContain("[low-confidence forced]");
  });

  it("an 'out' below the bar is forced too", () => {
    expect(parse(JSON.stringify({ decision: "out", confidence: 0.76, reasoning: "x" })).decision).toBe("unclear");
  });

  it("at the bar it stands", () => {
    expect(parse(JSON.stringify({ decision: "in", confidence: 0.8, reasoning: "x" })).decision).toBe("in");
  });

  it("an unknown decision is unclear", () => {
    expect(parse(JSON.stringify({ decision: "maybe", confidence: 1 })).decision).toBe("unclear");
  });
});

describe("the player's status, in words", () => {
  it.each([
    [{ status: "CONFIRMED" as const }, "in the squad"],
    [{ status: "BENCH" as const }, "on the bench"],
    [{ status: "DROPPED" as const }, "dropped out"],
    [{ status: null }, "not signed up"],
    [{ status: null, tentative: true }, "said maybe, not signed up"],
    [{ status: "CONFIRMED" as const, tentative: true }, "said maybe, in the squad"],
  ])("%o → %s", (input, want) => {
    expect(availabilityStatusLabel(input)).toBe(want);
  });
});

describe("every verdict is logged", () => {
  afterEach(() => vi.restoreAllMocks());
  const lines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => c.join(" ")).filter((l: string) => l.includes("[match-availability] verdict"));

  it("logs user, match, intent, confidence and reasoning", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await classifyMatchAvailability(
      "go on then",
      CTX,
      answer({ decision: "in", confidence: 0.92, reasoning: "casual yes to the invite" }),
    );
    expect(r.decision).toBe("in");
    const [line] = lines(info);
    expect(line).toContain("user=u-ian");
    expect(line).toContain("match=m-tue");
    expect(line).toContain("intent=in");
    expect(line).toContain("confidence=0.92");
    expect(line).toContain("casual yes to the invite");
  });

  it("logs an unclear, and a forced low-confidence one", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await classifyMatchAvailability("maybe", CTX, answer({ decision: "unclear", confidence: 0.9, reasoning: "hedge" }));
    await classifyMatchAvailability("hmm ok", CTX, answer({ decision: "in", confidence: 0.6, reasoning: "weak" }));
    const got = lines(info);
    expect(got).toHaveLength(2);
    expect(got[0]).toContain("intent=unclear");
    expect(got[1]).toContain("intent=unclear");
    expect(got[1]).toContain("confidence=0.60");
    expect(got[1]).toContain("low-confidence forced");
  });

  it("a failed call is unclear, and logged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await classifyMatchAvailability("go on then", CTX, async () => {
      throw new Error("overloaded");
    });
    expect(r.decision).toBe("unclear");
    expect(lines(info)[0]).toContain("classifier error");
  });

  it("an empty reply never reaches the model, so there is no verdict line", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const call = vi.fn();
    const r = await classifyMatchAvailability("   ", CTX, call);
    expect(r.decision).toBe("unclear");
    expect(call).not.toHaveBeenCalled();
    expect(lines(info)).toHaveLength(0);
  });

  it("no model (no key) is unclear", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await classifyMatchAvailability("go on then", CTX, null)).decision).toBe("unclear");
  });
});
