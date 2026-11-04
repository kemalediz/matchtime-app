/**
 * ONE PIPELINE FOR EVERY DM (Cloud API plan C3,
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.3).
 *
 * `handleInboundDm` in `src/lib/inbound-dm.ts` holds the whole DM
 * pipeline; `POST /api/whatsapp/dm-reply` (the Pi's door) is a thin
 * adapter over it: the API key and the JSON parse, then one call. The
 * Cloud API webhook (C5) will call the very same function, so there is
 * never a second DM path (Kemal's rule, 2026-10-16: one architecture).
 *
 * What the pipeline decides is pinned, unchanged by the move, by
 * `inbound-dm-characterisation.test.ts`. Here: the shape of the split, and
 * that the function answers by itself what the route answered. db is a
 * recording stub (every read empty). No network, no model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const dbMock = vi.hoisted(() => {
  const empty = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          calls.push(`${name}.${method}`);
          return method.startsWith("findMany") ? [] : method === "count" ? 0 : method === "updateMany" ? { count: 0 } : null;
        },
      },
    );
  return new Proxy({} as Record<string, unknown>, { get: (_t, model: string) => empty(model) });
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { handleInboundDm, type InboundDm } from "@/lib/inbound-dm";

const ROOT = path.resolve(__dirname, "../../..");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROUTE = strip(readFileSync(path.join(ROOT, "src/app/api/whatsapp/dm-reply/route.ts"), "utf8"));
const LIB = strip(readFileSync(path.join(ROOT, "src/lib/inbound-dm.ts"), "utf8"));

const request = () => new Request("http://x/api/whatsapp/dm-reply", { method: "POST" });
const answer = async (input: InboundDm, channel: "baileys" | "cloud" = "baileys") => {
  const res = await handleInboundDm(input, { channel, request: request() });
  return { status: res.status, body: await res.json() };
};

describe("the dm-reply route is a thin adapter over handleInboundDm", () => {
  it("imports nothing but next/server and the pipeline", () => {
    const imports = [...ROUTE.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["@/lib/inbound-dm", "next/server"]);
    expect(ROUTE).not.toMatch(/import\(/);
  });

  it("calls the pipeline once, as the Baileys channel", () => {
    expect(ROUTE.match(/handleInboundDm\(/g)).toHaveLength(1);
    expect(ROUTE).toMatch(/channel:\s*"baileys"/);
  });

  it("keeps the transport (the API key, the JSON parse) and nothing else", () => {
    expect(ROUTE).toMatch(/x-api-key/);
    expect(ROUTE).toMatch(/request\.json\(\)/);
    expect(ROUTE.split("\n").length).toBeLessThan(60);
  });

  it("the pipeline holds no transport of its own", () => {
    expect(LIB).not.toMatch(/x-api-key/);
    expect(LIB).not.toMatch(/WHATSAPP_API_KEY/);
    expect(LIB).not.toMatch(/request\.json\(/);
    expect(LIB).toMatch(/export async function handleInboundDm\(/);
  });
});

describe("handleInboundDm answers by itself", () => {
  it("400 without the text or the message id, before anything is read", async () => {
    calls.length = 0;
    expect(await answer({ phone: "447700900001", waMessageId: "w" })).toEqual({ status: 400, body: { error: "body, waMessageId required" } });
    expect(await answer({ phone: "447700900001", body: "IN" })).toEqual({ status: 400, body: { error: "body, waMessageId required" } });
    expect(calls).toEqual([]);
  });

  it("a number MatchTime does not know is ignored, on either channel, the same way", async () => {
    const dm: InboundDm = { phone: "447700900777", body: "hello, is this the football?", waMessageId: "wa-1", authorName: "Ali" };
    calls.length = 0;
    const baileys = await answer(dm, "baileys");
    const baileysReads = [...calls];
    calls.length = 0;
    const cloud = await answer(dm, "cloud");
    expect(baileys).toEqual({ status: 200, body: { ok: true, ignored: "unknown-sender" } });
    expect(cloud).toEqual(baileys);
    // The channel is a fact the pipeline carries; today nothing reads it.
    expect(calls).toEqual(baileysReads);
  });
});
