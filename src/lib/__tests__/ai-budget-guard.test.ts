/**
 * THE GUARD: every model call made inside a club's scope reserves before
 * it runs and books its real cost after. The ledger here is an in-memory
 * copy of the database rule (reserve only while spend plus holds is under
 * the cap), so the RESERVATION DESIGN is tested here and the SQL that
 * implements it is tested against Postgres in `e2e/api/ai-daily-cap.spec.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AiBudgetExceededError,
  bindAiBudgetKey,
  guardedModelCall,
  isAiBudgetExceeded,
  runWithAiBudget,
  runWithDeferredAiBudget,
  type AiBudgetHold,
  type AiBudgetLedger,
} from "../ai-budget-context";
import {
  anthropicModel,
  budgetedModel,
  anthropicMessageCost,
  costOf,
  guardedAnthropicCall,
  UNPRICED_CALL_USD,
  type PipelineModel,
} from "../pipeline/llm";

const RESERVE = 0.01;

/** The database rule, in memory. */
function memoryLedger(cap: number) {
  const row = { costUsd: 0, reservedUsd: 0, calls: 0, refused: 0 };
  const ledger: AiBudgetLedger = {
    async reserve(key, label) {
      // One synchronous step, exactly as the SQL is one statement.
      if (row.costUsd + row.reservedUsd >= cap) {
        row.refused++;
        throw new AiBudgetExceededError(key, label);
      }
      row.reservedUsd += RESERVE;
      return { key, day: "2026-09-29", reservedUsd: RESERVE };
    },
    async settle(hold: AiBudgetHold, cost) {
      row.costUsd += cost;
      row.reservedUsd = Math.max(0, row.reservedUsd - hold.reservedUsd);
      row.calls++;
    },
    async release(hold: AiBudgetHold) {
      row.reservedUsd = Math.max(0, row.reservedUsd - hold.reservedUsd);
    },
  };
  return { ledger, row };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("guardedModelCall", () => {
  it("outside a scope it is a pass-through: nothing reserved, nothing refused", async () => {
    const call = vi.fn(async () => "ok");
    expect(await guardedModelCall("x", call, () => 1, 1)).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("inside a scope it books the call's real cost and frees the hold", async () => {
    const { ledger, row } = memoryLedger(1);
    await runWithAiBudget("org-1", ledger, () => guardedModelCall("router", async () => "ok", () => 0.0031, 1));
    expect(row).toMatchObject({ costUsd: 0.0031, reservedUsd: 0, calls: 1 });
  });

  it("at the cap the model is NOT called and the error says so", async () => {
    const { ledger, row } = memoryLedger(0.5);
    row.costUsd = 0.5;
    const call = vi.fn(async () => "ok");
    const err = await runWithAiBudget("org-1", ledger, () => guardedModelCall("router", call, () => 0, 1)).catch(
      (e) => e,
    );
    expect(isAiBudgetExceeded(err)).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(row.refused).toBe(1);
  });

  it("a call that throws releases its hold and is not booked", async () => {
    const { ledger, row } = memoryLedger(1);
    await expect(
      runWithAiBudget("org-1", ledger, () =>
        guardedModelCall("x", async () => {
          throw new Error("529 overloaded");
        }, () => 0, 1),
      ),
    ).rejects.toThrow("529");
    expect(row).toMatchObject({ costUsd: 0, reservedUsd: 0, calls: 0 });
  });

  it("a result it cannot price is booked at the unpriced rate, never at zero", async () => {
    const { ledger, row } = memoryLedger(1);
    await runWithAiBudget("org-1", ledger, () => guardedModelCall("x", async () => "ok", () => null, 0.05));
    expect(row.costUsd).toBe(0.05);
  });

  it("a deferred scope guards nothing until the club is named, then guards everything", async () => {
    const { ledger, row } = memoryLedger(1);
    await runWithDeferredAiBudget(ledger, async () => {
      await guardedModelCall("before", async () => "ok", () => 0.2, 1);
      bindAiBudgetKey("org-1");
      await guardedModelCall("after", async () => "ok", () => 0.3, 1);
    });
    expect(row.costUsd).toBe(0.3);
  });
});

describe("the overshoot bound under concurrency", () => {
  it("fifty calls at once against $0.25: spend ends within one hold plus each in-flight call's excess over its hold", async () => {
    const cap = 0.25;
    const { ledger, row } = memoryLedger(cap);
    row.costUsd = 0.2; // $0.05 of headroom left
    const perCall = 0.012; // a little over the $0.01 hold, like a long composer answer
    const results = await runWithAiBudget("org-1", ledger, () =>
      Promise.allSettled(
        Array.from({ length: 50 }, () =>
          guardedModelCall("extractor", async () => {
            await tick();
            return "ok";
          }, () => perCall, 1),
        ),
      ),
    );
    const made = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected").length;
    expect(made).toBe(5); // 0.20 + 5 holds of 0.01 reaches the cap
    expect(refused).toBe(45);
    // The bound stated in ai-budget.ts: cap + one hold + Σ max(0, cost - hold).
    const bound = cap + RESERVE + made * Math.max(0, perCall - RESERVE);
    expect(row.costUsd).toBeLessThanOrEqual(bound + 1e-9);
    expect(row.costUsd).toBeCloseTo(0.2 + made * perCall, 9);
    expect(row.reservedUsd).toBeCloseTo(0, 9);
  });
});

describe("anthropicModel and the stub models go through the guard", () => {
  function fakeClient(usage: Record<string, unknown>) {
    const create = vi.fn(async () => ({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "{}" }],
      usage,
    }));
    return { client: { messages: { create } } as never, create };
  }
  const req = { model: "claude-haiku-4-5", system: "s", user: "u", maxTokens: 100, label: "router" };

  it("a real call inside a scope is priced from the usage the API reported", async () => {
    const { ledger, row } = memoryLedger(1);
    const { client } = fakeClient({ input_tokens: 1000, output_tokens: 100 });
    const model = anthropicModel({ apiKey: "k", client });
    await runWithAiBudget("org-1", ledger, () => model.complete(req));
    // haiku-4-5: $1/M in, $5/M out -> 0.001 + 0.0005
    expect(row.costUsd).toBeCloseTo(0.0015, 9);
    expect(row.calls).toBe(1);
  });

  it("books a 1-hour cache write at 2x and a cache read at 0.1x, and the model reports the same figure", async () => {
    // 2026-09-29: the pipeline's cached prompts moved to the 1-hour TTL.
    // The cap and the model's own `costUsd` must both see the 2x write,
    // or the cap under-books the day's first call of every prompt.
    const { ledger, row } = memoryLedger(1);
    const { client } = fakeClient({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 0 },
    });
    const model = anthropicModel({ apiKey: "k", client });
    const res = await runWithAiBudget("org-1", ledger, () => model.complete(req));
    // haiku-4-5 $1/M: (1000 + 2000 x 0.1 + 3000 x 2) input + 100 x $5/M output
    const expected = (1000 + 200 + 6000) / 1_000_000 + 0.0005;
    expect(row.costUsd).toBeCloseTo(expected, 9);
    expect(res.costUsd).toBeCloseTo(expected, 9);
  });

  it("at the cap the SDK is never touched", async () => {
    const { ledger, row } = memoryLedger(1);
    row.costUsd = 1;
    const { client, create } = fakeClient({ input_tokens: 1, output_tokens: 1 });
    const model = anthropicModel({ apiKey: "k", client });
    await expect(runWithAiBudget("org-1", ledger, () => model.complete(req))).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("a truncated response is still booked: the tokens were billed", async () => {
    const { ledger, row } = memoryLedger(1);
    const create = vi.fn(async () => ({
      model: "claude-haiku-4-5",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "{" }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    }));
    const model = anthropicModel({ apiKey: "k", client: { messages: { create } } as never });
    await expect(runWithAiBudget("org-1", ledger, () => model.complete(req))).rejects.toThrow(/max_tokens/);
    expect(row.costUsd).toBeCloseTo(0.0015, 9);
  });

  it("budgetedModel wraps any PipelineModel (the e2e stubs) and books what it reports", async () => {
    const { ledger, row } = memoryLedger(1);
    const inner: PipelineModel = {
      name: "stub",
      complete: vi.fn(async () => ({
        text: "{}",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.004,
        ms: 0,
      })),
    };
    await runWithAiBudget("org-1", ledger, () => budgetedModel(inner).complete(req));
    expect(row).toMatchObject({ costUsd: 0.004, calls: 1 });
    row.costUsd = 1;
    await expect(runWithAiBudget("org-1", ledger, () => budgetedModel(inner).complete(req))).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });
});

describe("anthropicMessageCost: pricing a raw SDK response", () => {
  it("prices 1-hour cache writes at 2x and 5-minute ones at 1.25x", () => {
    const cost = anthropicMessageCost({
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 },
      },
    });
    // sonnet-5 input $2/M: 1M x 2 x $2 + 1M x 1.25 x $2 = $6.50
    expect(cost).toBeCloseTo(6.5, 9);
  });

  it("an unknown model is unpriced (null), so the guard books it at the unpriced rate", () => {
    expect(anthropicMessageCost({ model: "claude-new-thing", usage: { input_tokens: 5, output_tokens: 5 } })).toBeNull();
  });

  // The API answers a request for `claude-haiku-4-5` with the DATED
  // snapshot in `resp.model`: `claude-haiku-4-5-20251001`. The rate table
  // is keyed by the alias, so every raw Haiku call site was priced null
  // and booked at UNPRICED_CALL_USD ($0.12) instead of about $0.0015.
  it("a dated snapshot name is priced as its alias", () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf("claude-haiku-4-5-20251001", usage)).toBeCloseTo(0.0015, 9);
    expect(costOf("claude-haiku-4-5-20251001", usage)).toBe(costOf("claude-haiku-4-5", usage));
  });

  it("a dated snapshot of a model nobody priced is still unpriced", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf("claude-new-thing-20251001", usage)).toBeNull();
  });

  it("through the guard, a dated Haiku response books its real price, not the unpriced rate", async () => {
    const { ledger, row } = memoryLedger(1);
    await runWithAiBudget("org-1", ledger, () =>
      guardedAnthropicCall("dm-intent", async () => ({
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 1000, output_tokens: 100 },
      })),
    );
    // haiku-4-5: $1/M in, $5/M out -> 0.001 + 0.0005
    expect(row.costUsd).toBeCloseTo(0.0015, 9);
    expect(row.costUsd).not.toBe(UNPRICED_CALL_USD);
    expect(row.calls).toBe(1);
  });
});

describe("every model call site in src/ is behind the guard", () => {
  it("each file that calls messages.create wraps every call in guardedAnthropicCall", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "__tests__" || name === "generated" || name === "node_modules") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const sites: string[] = [];
    const unguarded: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        // comments mention messages.create by name; only code counts
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const calls = src.match(/\.messages\.create\(/g)?.length ?? 0;
      if (calls === 0) continue;
      sites.push(path.relative(root, f));
      const guarded = src.match(/guardedAnthropicCall\([^,]+,\s*\(\)\s*=>\s*\n?\s*[\w.]*\.messages\.create\(/g)?.length ?? 0;
      if (guarded < calls) unguarded.push(`${path.relative(root, f)} (${calls - guarded} unguarded)`);
    }
    expect(unguarded).toEqual([]);
    // The inventory, so a new site is noticed in review: pipeline/llm.ts
    // (router, extractors, composer, generic stats answer, none-shadow)
    // plus the eleven raw sites.
    expect(sites.sort()).toEqual(
      [
        "lib/dm-intent.ts",
        "lib/dm-qa.ts",
        "lib/fee-confirm.ts",
        "lib/match-availability-classifier.ts",
        "lib/message-analyzer.ts",
        "lib/onboarding-analyzer.ts",
        "lib/onboarding-conversation.ts",
        "lib/payment-claim-classifier.ts",
        "lib/pipeline/llm.ts",
        "lib/rating-adjuster.ts",
        "lib/roster-survey-classifier.ts",
        "lib/squad-from-list.ts",
      ].sort(),
    );
  });
});
