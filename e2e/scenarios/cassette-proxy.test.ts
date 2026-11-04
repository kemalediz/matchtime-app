import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CassetteProxy } from "./cassette-proxy";

const servers: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A stand-in for api.anthropic.com that counts what reaches it. */
async function fakeUpstream(): Promise<{ url: string; hits: () => number; failNext: (status: number) => void }> {
  let hits = 0;
  let fail: number | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      hits++;
      if (fail) {
        const s = fail;
        fail = null;
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: Array<{ content: string }> };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          content: [{ type: "text", text: `answer to ${body.messages[0].content}` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  servers.push({ close: () => new Promise((r) => server.close(() => r())) });
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, failNext: (s) => (fail = s) };
}

async function start(proxy: CassetteProxy): Promise<string> {
  const url = await proxy.listen(0);
  servers.push({ close: () => proxy.close() });
  return url;
}

const ask = (url: string, content: string, model = "claude-haiku-5-5") =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "whatever" },
    body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content }] }),
  });

const control = async (url: string, p: string, body?: unknown) =>
  (await (await fetch(`${url}${p}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) })).json()) as Record<string, unknown>;

describe("CassetteProxy", () => {
  it("records through to the upstream, then replays with no network and the same answers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mt-cassette-"));
    dirs.push(dir);
    const up = await fakeUpstream();

    const rec = new CassetteProxy({ mode: "record", dir, upstream: up.url });
    const recUrl = await start(rec);
    await control(recUrl, "/__cassette/scope", { club: "sutton" });
    const a = await (await ask(recUrl, "IN")).json();
    const b = await (await ask(recUrl, "OUT", "claude-sonnet-5")).json();
    const saved = await control(recUrl, "/__cassette/save", {});
    expect(up.hits()).toBe(2);
    expect(saved).toMatchObject({ club: "sutton", calls: 2 });
    const file = JSON.parse(readFileSync(path.join(dir, "sutton.cassette.json"), "utf8"));
    expect(file.entries).toHaveLength(2);
    expect(file.meter.calls).toBe(2);
    expect(file.meter.costUsd).toBeGreaterThan(0);

    const rep = new CassetteProxy({ mode: "replay", dir, upstream: "http://127.0.0.1:1" });
    const repUrl = await start(rep);
    await control(repUrl, "/__cassette/scope", { club: "sutton" });
    expect(await (await ask(repUrl, "IN")).json()).toEqual(a);
    expect(await (await ask(repUrl, "OUT", "claude-sonnet-5")).json()).toEqual(b);
    const stats = await control(repUrl, "/__cassette/save", {});
    expect(stats).toMatchObject({ club: "sutton", hits: 2, misses: 0, upstreamCalls: 0 });
    expect(up.hits()).toBe(2);
  });

  it("answers a request it never saw with a non-retryable error and lists it, without calling anyone", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mt-cassette-"));
    dirs.push(dir);
    const up = await fakeUpstream();
    const rec = new CassetteProxy({ mode: "record", dir, upstream: up.url });
    const recUrl = await start(rec);
    await control(recUrl, "/__cassette/scope", { club: "fnf" });
    await ask(recUrl, "IN");
    await control(recUrl, "/__cassette/save", {});

    const rep = new CassetteProxy({ mode: "replay", dir, upstream: up.url });
    const repUrl = await start(rep);
    await control(repUrl, "/__cassette/scope", { club: "fnf" });
    const res = await ask(repUrl, "IN please");
    // 400: the SDK does not retry it, so one changed prompt is one miss.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/cassette miss/);
    const stats = await control(repUrl, "/__cassette/save", {});
    expect(stats).toMatchObject({ misses: 1, upstreamCalls: 0 });
    expect((stats.missList as Array<{ firstDifference: string }>)[0].firstDifference).toContain("IN please");
    expect(rep.totals()).toMatchObject({ misses: 1, upstreamCalls: 0 });
    expect(up.hits()).toBe(1);
  });

  it("keeps a transient upstream failure out of the cassette (the SDK's retry is what gets recorded)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mt-cassette-"));
    dirs.push(dir);
    const up = await fakeUpstream();
    const rec = new CassetteProxy({ mode: "record", dir, upstream: up.url });
    const recUrl = await start(rec);
    await control(recUrl, "/__cassette/scope", { club: "vets" });
    up.failNext(529);
    expect((await ask(recUrl, "IN")).status).toBe(529);
    expect((await ask(recUrl, "IN")).status).toBe(200);
    const saved = await control(recUrl, "/__cassette/save", {});
    expect(saved).toMatchObject({ calls: 1 });
  });

  it("refuses to spend past its cap: once the recorded cost reaches it, nothing more goes upstream", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mt-cassette-"));
    dirs.push(dir);
    const up = await fakeUpstream();
    // Each fake answer is 1000 in / 100 out on Haiku 5.5: $0.00015.
    const rec = new CassetteProxy({ mode: "record", dir, upstream: up.url, capUsd: 0.0002 });
    const recUrl = await start(rec);
    await control(recUrl, "/__cassette/scope", { club: "cap" });
    expect((await ask(recUrl, "one")).status).toBe(200);
    expect((await ask(recUrl, "two")).status).toBe(200);
    const third = await ask(recUrl, "three");
    expect(third.status).toBe(400);
    expect(((await third.json()) as { error: { message: string } }).error.message).toMatch(/cost cap/);
    expect(up.hits()).toBe(2);
    expect(rec.totals()).toMatchObject({ capRefusals: 1 });
  });

  it("speaks the meter's control endpoint, so existing readers of /__meter keep working", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mt-cassette-"));
    dirs.push(dir);
    const up = await fakeUpstream();
    const rec = new CassetteProxy({ mode: "record", dir, upstream: up.url });
    const recUrl = await start(rec);
    await ask(recUrl, "IN");
    const m = await control(recUrl, "/__meter");
    expect(m).toMatchObject({ calls: 1 });
    expect(rec.all).toHaveLength(1);
  });
});
