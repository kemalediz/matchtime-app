/**
 * THE CASSETTE PROXY: what the server under test talks to instead of
 * api.anthropic.com during a club-scenario run (e2e/scenarios/).
 *
 * It sits exactly where the metering proxy (e2e/replay/meter.ts) sits:
 * `buildTestEnv` points the server's ANTHROPIC_BASE_URL at it. Every
 * Anthropic client in src/ (the pipeline's and the six classifiers' own)
 * reads that variable, so this one seam sees every model call, and nothing
 * under src/ changes or knows it exists.
 *
 *   record  forwards each request to Anthropic verbatim (the key the server
 *           holds, which run.ts has made the DEVELOPER key), meters the
 *           usage block exactly as the meter does, and keeps the request
 *           and the answer for the club in scope.
 *   replay  answers each request from the club's cassette and never opens a
 *           connection to anyone. A request with no recorded answer gets a
 *           400 (which the SDK does not retry, so one changed prompt is one
 *           miss), and is listed; the run then fails.
 *
 * Control endpoints (never forwarded):
 *   POST /__cassette/scope {club}  start a club: record collects for it,
 *                                  replay loads <dir>/<club>.cassette.json
 *   POST /__cassette/save          record: write the club's cassette;
 *                                  replay: the club's hits, repeats, misses
 *   GET  /__meter                  the meter's reading, same shape
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { callFromUsage, type MeteredCall } from "../replay/meter";
import { Cassette, CassetteMissError, packCassette, unpackCassette, type CassetteFile, type CassetteMiss, type RecordedCall } from "./cassette";

export type CassetteMode = "record" | "replay";

/** Statuses the SDK retries: never kept, so the recorded answer is the retry's. */
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export const cassetteFile = (dir: string, club: string) => path.join(dir, `${club}.cassette.json`);

export class CassetteProxy {
  private server: Server | null = null;
  /** Every metered call (record only), for run.ts's "was it really live". */
  readonly all: MeteredCall[] = [];
  private club: string | null = null;
  private recording: RecordedCall[] = [];
  private scopeCalls: MeteredCall[] = [];
  private cassette: Cassette | null = null;
  private upstreamCalls = 0;
  private readonly allMisses: Array<CassetteMiss & { club: string | null }> = [];
  private replayHits = 0;
  private replayRepeats = 0;

  private capRefusals = 0;

  /**
   * `capUsd`: record mode stops forwarding once the run's metered cost has
   * reached it; every later request gets a non-retryable 400 and is counted.
   * The cost rule (Kemal, 2026-10-21) made mechanical: a projection that
   * turns out wrong cannot spend past the cap.
   */
  constructor(private readonly opts: { mode: CassetteMode; dir: string; upstream?: string; capUsd?: number }) {}

  get mode(): CassetteMode {
    return this.opts.mode;
  }

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const addr = this.server!.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** The whole run, for run.ts's final verdict. */
  totals(): {
    upstreamCalls: number;
    misses: number;
    hits: number;
    repeats: number;
    capRefusals: number;
    costUsd: number;
    missList: Array<CassetteMiss & { club: string | null }>;
  } {
    return {
      upstreamCalls: this.upstreamCalls,
      misses: this.allMisses.length,
      hits: this.replayHits,
      repeats: this.replayRepeats,
      capRefusals: this.capRefusals,
      costUsd: this.all.reduce((a, c) => a + c.costUsd, 0),
      missList: [...this.allMisses],
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  }

  private scope(club: string): Record<string, unknown> {
    if (!/^[a-z0-9-]+$/.test(club)) throw new Error(`cassette: bad club name "${club}"`);
    this.club = club;
    this.recording = [];
    this.scopeCalls = [];
    this.cassette = null;
    if (this.opts.mode === "replay") {
      const f = cassetteFile(this.opts.dir, club);
      if (!existsSync(f)) throw new Error(`cassette: no recording for "${club}" at ${f}; record it first`);
      const loaded = unpackCassette(JSON.parse(readFileSync(f, "utf8")) as CassetteFile);
      this.cassette = new Cassette(loaded.calls);
      return { club, mode: "replay", recorded: loaded.calls.length };
    }
    return { club, mode: "record" };
  }

  private save(): Record<string, unknown> {
    const club = this.club;
    if (!club) throw new Error("cassette: save with no club in scope");
    if (this.opts.mode === "record") {
      const byModel: Record<string, { calls: number; costUsd: number }> = {};
      for (const c of this.scopeCalls) {
        const m = (byModel[c.model] ??= { calls: 0, costUsd: 0 });
        m.calls++;
        m.costUsd += c.costUsd;
      }
      const meter = { calls: this.scopeCalls.length, costUsd: this.scopeCalls.reduce((a, c) => a + c.costUsd, 0), byModel };
      mkdirSync(this.opts.dir, { recursive: true });
      writeFileSync(cassetteFile(this.opts.dir, club), `${JSON.stringify(packCassette({ club, calls: this.recording, meter }), null, 1)}\n`);
      return { club, mode: "record", calls: this.recording.length, meter };
    }
    const s = this.cassette!.stats();
    return { club, mode: "replay", ...s, upstreamCalls: this.upstreamCalls, missList: this.cassette!.missList() };
  }

  private meterReading(): Record<string, unknown> {
    const byModel: Record<string, { calls: number; costUsd: number }> = {};
    for (const c of this.all) {
      const m = (byModel[c.model] ??= { calls: 0, costUsd: 0 });
      m.calls++;
      m.costUsd += c.costUsd;
    }
    return { calls: this.all.length, costUsd: this.all.reduce((a, c) => a + c.costUsd, 0), truncated: 0, armed: false, byModel };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = req.url ?? "";
    try {
      if (url.startsWith("/__meter")) return this.json(res, 200, this.meterReading());
      if (url === "/__cassette/scope") return this.json(res, 200, this.scope(String((JSON.parse(raw.toString() || "{}") as { club?: string }).club ?? "")));
      if (url === "/__cassette/save") return this.json(res, 200, this.save());
      if (url === "/__cassette/totals") return this.json(res, 200, this.totals());
    } catch (err) {
      return this.json(res, 500, { error: (err as Error).message });
    }

    let body: unknown = null;
    try {
      body = JSON.parse(raw.toString() || "null");
    } catch {
      body = null;
    }

    if (this.opts.mode === "replay") {
      if (!this.cassette) {
        const miss = { key: "", model: String((body as { model?: string })?.model ?? "?"), site: "(no club in scope)", nearest: null, firstDifference: "" };
        this.allMisses.push({ ...miss, club: null });
        return this.json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "cassette miss: a model request arrived with no club in scope" } });
      }
      try {
        const hit = this.cassette.take(body);
        const s = this.cassette.stats();
        this.replayHits = s.hits;
        this.replayRepeats = s.repeats;
        res.writeHead(hit.status, { "content-type": "application/json", connection: "close" });
        res.end(hit.body);
      } catch (err) {
        if (!(err instanceof CassetteMissError)) throw err;
        this.allMisses.push({ ...err.miss, club: this.club });
        console.error(`[cassette] ${this.club}: ${err.message}`);
        this.json(res, 400, { type: "error", error: { type: "invalid_request_error", message: err.message } });
      }
      return;
    }

    // record
    if (this.opts.capUsd !== undefined && this.all.reduce((a, c) => a + c.costUsd, 0) >= this.opts.capUsd) {
      this.capRefusals++;
      return this.json(res, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: `cassette proxy: cost cap of $${this.opts.capUsd} reached; not forwarded` },
      });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && k !== "host" && k !== "content-length" && k !== "connection") headers[k] = v;
    }
    const started = Date.now();
    let upstream: Response;
    try {
      this.upstreamCalls++;
      upstream = await fetch(`${this.opts.upstream ?? "https://api.anthropic.com"}${url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      });
    } catch (err) {
      return this.json(res, 502, { type: "error", error: { type: "api_error", message: `cassette proxy: ${(err as Error).message}` } });
    }
    const text = await upstream.text();
    const ms = Date.now() - started;
    try {
      const parsed = JSON.parse(text) as { model?: string; usage?: Parameters<typeof callFromUsage>[1] };
      if (parsed.usage) {
        const call = callFromUsage(parsed.model ?? "unknown", parsed.usage, ms);
        this.all.push(call);
        this.scopeCalls.push(call);
      }
    } catch {
      // not JSON: no usage to bank
    }
    if (!TRANSIENT.has(upstream.status) && body !== null) this.recording.push({ request: body, status: upstream.status, body: text });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding" && k !== "connection") out[k] = v;
    });
    out.connection = "close";
    res.writeHead(upstream.status, out);
    res.end(text);
  }
}
