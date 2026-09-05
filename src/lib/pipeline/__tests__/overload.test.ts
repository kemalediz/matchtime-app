/**
 * THE OVERLOAD, FOR REAL — not a stubbed throw.
 *
 * §10 step 6 puts the extractor on the WRITE path and changes the shape
 * of its exposure: the analyzer makes one call per BATCH and rides an
 * overload window out; the engine makes one per MESSAGE, fanned out in
 * parallel, and does not. PR #44's first live corpus sweep measured that
 * exactly — 27 `529 Overloaded` and 3 `500`s across 10 of 177 messages
 * at the SDK default of two retries. `maxRetries: 4` took that to zero,
 * which is good news and a problem of its own: **the fallback never
 * fired in the corpus sweep**, so the second line of defence was proven
 * only by tests that stubbed the failure they were testing.
 *
 * This file removes the stub. It stands up a real HTTP server that
 * answers every request the way an overloaded API does, points the real
 * `anthropicModel()` at it, and measures what actually happens:
 *
 *   • how many attempts the SDK really makes before giving up;
 *   • how long the retry ladder really takes, which is the thing that
 *     decides whether a window is ridden out or not;
 *   • the exact `Error.message` the pipeline then has to deal with.
 *
 * That last one is what makes the cheap seams honest: `OVERLOADED_MESSAGE`
 * in `extractor-stub.ts` is what the e2e overload spec injects across a
 * production-shaped batch mix, and it is pinned HERE against the real
 * thing. If the SDK ever changes what it throws, this fails rather than
 * the e2e suite quietly testing a fiction.
 *
 * No call leaves the machine: the base URL is a loopback server.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { anthropicModel } from "../llm";
import { extractForRoute } from "../extractors";
import { OVERLOADED_MESSAGE } from "../extractor-stub";

interface Overloaded {
  server: Server;
  url: string;
  attempts: () => number;
}

/** An API that is overloaded for every request, and counts the attempts. */
async function overloadedApi(status = 529, retryAfterMs?: number): Promise<Overloaded> {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts++;
    // Drain the body so the socket is reusable and the SDK sees a clean
    // response rather than a transport error, which retries differently.
    req.resume();
    res.writeHead(status, {
      "content-type": "application/json",
      "request-id": `req_overload_${attempts}`,
      ...(retryAfterMs !== undefined ? { "retry-after-ms": String(retryAfterMs) } : {}),
    });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: status === 529 ? "overloaded_error" : "api_error", message: "Overloaded" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, attempts: () => attempts };
}

const ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let open: Overloaded | null = null;

function point(at: Overloaded): void {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ANTHROPIC_BASE_URL = at.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  open = at;
}

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (open) await new Promise<void>((r) => open!.server.close(() => r()));
  open = null;
});

const MSG = {
  id: "wa-overload",
  body: "In",
  authorName: "Pete",
  tagged: false,
  history: [],
  lastBotPost: null,
};

describe("a genuinely overloaded API, through the real SDK", () => {
  it("retries FIVE times in total before giving up — the budget is real, not a comment", async () => {
    // `maxRetries: 4` in `llm.ts` means one attempt plus four retries.
    // The number is load-bearing (it is what took the corpus sweep from
    // 10 lost messages to 0) and it is otherwise unverifiable from
    // inside the process, so it is measured here from the server's side.
    const api = await overloadedApi(529, 1);
    point(api);

    const t0 = Date.now();
    const res = await extractForRoute(anthropicModel(), "self_att", MSG);
    const ms = Date.now() - t0;

    expect(api.attempts()).toBe(5);
    // With `retry-after-ms: 1` honoured the ladder collapses, which is
    // how this stays a fast test. The ladder itself is measured below.
    expect(ms).toBeLessThan(10_000);
    expect(res.facts.kind).toBe("none");
  }, 60_000);

  it("surfaces the failure as a LOUD degradation, never as empty facts", async () => {
    // The distinction the whole fallback rests on: an extractor that
    // FOUND NOTHING and an extractor that FAILED both return no claims,
    // and only the second one may hand the message to the analyzer.
    // `attendance-engine-batch.ts` tells them apart by this degradation,
    // matching /failed|could not be parsed/i.
    const api = await overloadedApi(529, 1);
    point(api);

    const res = await extractForRoute(anthropicModel(), "self_att", MSG);

    expect(res.degradations).toHaveLength(1);
    const [d] = res.degradations;
    expect(d.stage).toBe("extractor");
    expect(d.messageId).toBe("wa-overload");
    expect(d.detail).toMatch(/^attendance extractor failed: /);
    expect(d.detail).toMatch(/failed|could not be parsed/i);
  }, 60_000);

  it("throws the message the cheap seams claim it throws", async () => {
    // THE PIN. `OVERLOADED_MESSAGE` is what the e2e overload spec injects
    // across a whole batch mix; if the SDK ever changes what it throws,
    // this test fails rather than that suite quietly testing a fiction.
    const api = await overloadedApi(529, 1);
    point(api);

    const err = await anthropicModel()
      .complete({
        model: "claude-sonnet-5",
        system: "s",
        user: "u",
        maxTokens: 16,
        label: "extractor:attendance",
      })
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(OVERLOADED_MESSAGE);
  }, 60_000);

  it("a 500 fails the same way — the class, not one status code", async () => {
    const api = await overloadedApi(500, 1);
    point(api);

    const res = await extractForRoute(anthropicModel(), "self_att", MSG);

    expect(api.attempts()).toBe(5);
    expect(res.degradations[0].detail).toMatch(/^attendance extractor failed: /);
  }, 60_000);

  it("MEASURES the real retry ladder, with no `retry-after` to collapse it", async () => {
    // The number that decides whether an overload window is ridden out
    // rather than lost. Measured rather than asserted from the SDK's
    // documentation: exponential backoff from ~0.5s, so four retries
    // cover several seconds of a bad minute. The assertion is loose on
    // purpose — this pins the ORDER of magnitude, not a jittered value.
    const api = await overloadedApi(529);
    point(api);

    const t0 = Date.now();
    await extractForRoute(anthropicModel(), "self_att", MSG);
    const ms = Date.now() - t0;

    expect(api.attempts()).toBe(5);
    expect(ms).toBeGreaterThan(1_000);
    console.log(`[overload] 5 attempts over ${ms}ms of real SDK backoff`);
  }, 120_000);
});
