/**
 * A metering proxy in front of the Anthropic API.
 *
 * §10 step 3 wants cost and latency per pipeline MEASURED, not
 * estimated, and §8.2's table is the thing to measure against. The
 * analyze route does not record token usage anywhere, and this harness
 * is not allowed to edit that route, so the numbers are taken off the
 * wire instead: the server under test is pointed at this proxy via
 * `ANTHROPIC_BASE_URL`, every request is forwarded verbatim, and the
 * `usage` block of each response is banked.
 *
 * That gives exact input / output / cache-read / cache-write tokens per
 * call and the real upstream latency, with zero changes to `src/`.
 *
 * Sequencing note: the Playwright suite runs `workers: 1`, so the calls
 * that land between `begin()` and `end()` belong to the pipeline run
 * that was executing. The route's `after()` shadow analysis would also
 * land in that span; it is off by default (`SHADOW_ANALYZER_ENABLED`)
 * and the per-model breakdown makes a stray second call visible rather
 * than silently inflating the headline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CallMeter, MeteredSpan } from "./sweep";

const UPSTREAM = "https://api.anthropic.com";

/** $ per MTok, from §8 of the redesign doc. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const DEFAULT_PRICE = { input: 3, output: 15 };

/** Cache reads are 0.1× input. A 1-hour cache WRITE is 2×, a 5-minute
 *  one 1.25× — the analyze route asks for `ttl: "1h"`. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;

export interface MeteredCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mTokens: number;
  costUsd: number;
  ms: number;
  at: string;
}

export function costOf(call: Omit<MeteredCall, "costUsd" | "ms" | "at">): number {
  const p = PRICES[call.model] ?? DEFAULT_PRICE;
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    per(call.inputTokens, p.input) +
    per(call.outputTokens, p.output) +
    per(call.cacheReadTokens, p.input * CACHE_READ_MULTIPLIER) +
    per(call.cacheWrite1hTokens, p.input * CACHE_WRITE_1H_MULTIPLIER) +
    per(call.cacheWrite5mTokens, p.input * CACHE_WRITE_5M_MULTIPLIER)
  );
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

export function callFromUsage(model: string, usage: Usage, ms: number): MeteredCall {
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    usage.cache_creation?.ephemeral_5m_input_tokens ??
    Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write1h);
  const base = {
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite1hTokens: write1h,
    cacheWrite5mTokens: write5m,
  };
  return { ...base, costUsd: costOf(base), ms, at: new Date().toISOString() };
}

export class AnthropicMeter implements CallMeter {
  private server: Server | null = null;
  private calls: MeteredCall[] = [];
  private spanStart = 0;
  /** Every call seen, for the report's per-model breakdown. */
  readonly all: MeteredCall[] = [];

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const addr = this.server!.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    return `http://127.0.0.1:${bound}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  begin(): void {
    this.calls = [];
    this.spanStart = Date.now();
  }

  end(): MeteredSpan {
    const span: MeteredSpan = {
      calls: this.calls.length,
      costUsd: this.calls.reduce((a, c) => a + c.costUsd, 0),
      inputTokens: this.calls.reduce((a, c) => a + c.inputTokens, 0),
      outputTokens: this.calls.reduce((a, c) => a + c.outputTokens, 0),
      cacheReadTokens: this.calls.reduce((a, c) => a + c.cacheReadTokens, 0),
      cacheWriteTokens: this.calls.reduce((a, c) => a + c.cacheWrite1hTokens + c.cacheWrite5mTokens, 0),
      modelMs: this.calls.reduce((a, c) => a + c.ms, 0),
      models: [...new Set(this.calls.map((c) => c.model))],
    };
    this.calls = [];
    void this.spanStart;
    return span;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    }

    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM}${req.url ?? ""}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `meter proxy: ${(err as Error).message}` } }));
      return;
    }
    const ms = Date.now() - started;
    const text = await upstream.text();

    try {
      const parsed = JSON.parse(text) as { model?: string; usage?: Usage };
      if (parsed.usage) {
        const call = callFromUsage(parsed.model ?? "unknown", parsed.usage, ms);
        this.calls.push(call);
        this.all.push(call);
      }
    } catch {
      // A streamed or non-JSON response carries no usage we can bank.
      // Better to under-report than to invent a number.
    }

    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") out[k] = v;
    });
    res.writeHead(upstream.status, out);
    res.end(text);
  }
}

/** A no-op meter, for stubbed runs where no model is called. */
export const NULL_METER: CallMeter = {
  begin() {},
  end() {
    return {
      calls: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelMs: 0,
      models: [],
    };
  },
};
