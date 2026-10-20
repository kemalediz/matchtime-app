/**
 * THE DM Q&A ANSWERS THE ASKER'S OWN MONEY (Kemal, 2026-10-20), and only
 * his: the payments read selects his rows alone, the CONTEXT carries them
 * with his pay link, and the call goes to Haiku 5.5 (DM_QA_CALL) through
 * the pipeline's model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { create, ORG, attendanceFindMany } = vi.hoisted(() => {
const create = vi.fn(async (_req: Record<string, unknown>) => ({
    content: [{ type: "text", text: "You owe £6 for Cuma Maçı 🙂" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "claude-haiku-5-5",
  }));
  const ORG = {
    id: "org-1",
    name: "Cuma Futbol",
    language: "en",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    aiDailyCapUsd: null,
    aiWindowStartAt: null,
    approvalStatus: "approved",
    approvedAt: null,
    paymentTrackingEnabled: false,
    paymentCollectionEnabled: true,
    paymentHolderId: "u-collector",
    paymentInstructions: "Monzo 04-00-04 12345678",
    squadMode: "weekly",
    payMethodPayByBank: false,
    payMethodCard: false,
    payMethodDirect: true,
    stripeChargesEnabled: false,
  };
  
  const attendanceFindMany = vi.fn(async (args: { where: { userId: string } }) =>
    args.where.userId === "u-me"
      ? [
          {
            paidAt: null,
            feeWaivedAt: null,
            paymentMethod: null,
            directPendingAt: null,
            match: {
              id: "m-11",
              date: new Date("2026-09-11T20:00:00.000Z"),
              feePerPlayer: 6,
              paymentLinksReleasedAt: new Date("2026-09-11T22:00:00.000Z"),
              activity: { name: "Cuma Maçı" },
            },
          },
        ]
      : [],
  );
  
  return { create, ORG, attendanceFindMany };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findFirst: async () => ORG, findUnique: async () => ORG },
    $queryRaw: async () => [{ ok: 1 }],
    $executeRaw: async () => 1,
    match: { findFirst: async () => null, findUnique: async () => null },
    attendance: { findMany: attendanceFindMany },
    user: { findMany: async () => [], findUnique: async () => ({ name: "Erdal Özkan" }) },
    sentNotification: { findMany: async () => [] },
    botJob: { findMany: async () => [] },
  },
}));
// The daily AI cap is not under test here (ai-budget.test.ts).
vi.mock("@/lib/ai-budget", () => ({
  withOrgAiBudget: async (_orgId: string, fn: () => Promise<unknown>) => fn(),
  isAiBudgetExceeded: () => false,
}));
vi.mock("@/lib/player-stats", () => ({ loadPlayerSeasonStats: async () => null }));
vi.mock("@/lib/match-history", () => ({ loadRecentHistory: async () => null, formatRecentHistoryBlock: () => "" }));
vi.mock("@/lib/reply-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/reply-context")>()),
  loadDmReplyContext: async () => ({ now: new Date(), quoted: null, recent: [], earlier: null }),
}));
vi.mock("@/lib/pay-link", () => ({
  buildPayLinkUrl: vi.fn(async (userId: string, matchId: string) => `https://mt.example/s/${userId}-${matchId}`),
}));

import { answerScopedQuestion, DM_QA_CALL, looksLikeQuestion } from "../dm-qa";
import { HAIKU_CALL } from "../pipeline/llm";
import { HAIKU_MODEL } from "../models";

beforeEach(() => {
  create.mockClear();
  attendanceFindMany.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  delete process.env.MT_TEST_DM_QA_STUB;
});

describe("answerScopedQuestion: the asker's own payments", () => {
  it("reads only the asker's own attendance rows", async () => {
    await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "how much do I owe?" });
    expect(attendanceFindMany).toHaveBeenCalledTimes(1);
    expect(attendanceFindMany.mock.calls[0][0].where.userId).toBe("u-me");
  });

  it("the model is told what he owes, for which match, how to pay, and his own pay link", async () => {
    await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "how much do I owe?" });
    const user = JSON.stringify((create.mock.calls[0][0] as { messages: unknown }).messages);
    expect(user).toContain("YOUR PAYMENTS");
    expect(user).toContain("Cuma Maçı, Fri 11 Sep at 21:00: owes £6, not paid yet. Pay link: https://mt.example/s/u-me-m-11");
    expect(user).toContain("Ways to pay: pay Erdal Özkan directly");
    expect(user).toContain("Monzo 04-00-04 12345678");
  });

  it("the collector is told he has nothing to pay, and no rows are read", async () => {
    await answerScopedQuestion({ userId: "u-collector", orgId: "org-1", question: "how much do I owe?" });
    expect(attendanceFindMany).not.toHaveBeenCalled();
    expect(JSON.stringify(create.mock.calls[0][0])).toContain("You collect this club's match fees");
  });

  it("a failed payments read costs the block, never the answer", async () => {
    attendanceFindMany.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const out = await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "when is the match?" });
    expect(out?.answer).toBeTruthy();
    expect(JSON.stringify((create.mock.calls[0][0] as { messages: unknown }).messages)).not.toContain("YOUR PAYMENTS");
  });

  it("goes to Haiku 5.5 with adaptive thinking (DM_QA_CALL)", async () => {
    expect(DM_QA_CALL).toBe(HAIKU_CALL);
    await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "how much do I owe?" });
    const req = create.mock.calls[0][0] as Record<string, unknown>;
    expect(req.model).toBe(HAIKU_MODEL);
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "medium" });
  });

  it("a cut-off answer is never sent: the apology", async () => {
    create.mockImplementationOnce(async () => ({
      content: [{ type: "text", text: "You owe £6, pay at https://mt.ex" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-haiku-5-5",
    }));
    const out = await answerScopedQuestion({ userId: "u-me", orgId: "org-1", question: "how do I pay?" });
    expect(out?.answer).not.toContain("mt.ex");
    expect(out?.answer).toMatch(/couldn't work that one out/i);
  });
});

describe("looksLikeQuestion: money questions reach the Q&A, a bare claim does not", () => {
  it.each(["how much do I owe", "did you get my payment", "have I paid", "what's the fee this week"])("EN %s", (q) => {
    expect(looksLikeQuestion(q, "en")).toBe(true);
  });
  it.each(["ne kadar borcum var", "ödememi aldınız mı", "nasıl ödeyeceğim", "ücret ne kadar"])("TR %s", (q) => {
    expect(looksLikeQuestion(q, "tr")).toBe(true);
  });
  it.each(["paid", "Paid!", "done", "sent"])("EN bare claim %s", (q) => {
    expect(looksLikeQuestion(q, "en")).toBe(false);
  });
  it.each(["ödedim", "gönderdim"])("TR bare claim %s", (q) => {
    expect(looksLikeQuestion(q, "tr")).toBe(false);
  });
});
