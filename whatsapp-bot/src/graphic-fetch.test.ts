/**
 * The Pi fetching a list poster or team sheet before posting it
 * (2026-10-14). Only from MatchTime's own server, only a PNG, only up to a
 * size, and never forever: any doubt is a throw, and the scheduler then
 * posts nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { GraphicFetchError, MAX_GRAPHIC_BYTES, fetchGraphic } from "./graphic-fetch.js";

const API = "https://matchtime.ai";
const URL_OK = "https://matchtime.ai/api/graphics/abc.def";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

function respond(body: Buffer, init: { status?: number; type?: string } = {}) {
  return vi.fn(async () =>
    new Response(new Uint8Array(body), { status: init.status ?? 200, headers: { "content-type": init.type ?? "image/png" } }),
  );
}

describe("fetchGraphic", () => {
  it("returns the PNG bytes", async () => {
    const f = respond(PNG);
    const out = await fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: f });
    expect(out.equals(PNG)).toBe(true);
    expect(f).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ redirect: "error" }));
  });

  it("refuses a URL that is not on MatchTime's own server, without fetching it", async () => {
    const f = respond(PNG);
    for (const bad of ["https://evil.example/api/graphics/x", "http://matchtime.ai/api/graphics/x", "https://matchtime.ai/api/other/x", "not a url"]) {
      await expect(fetchGraphic(bad, { apiUrl: API, fetchImpl: f })).rejects.toBeInstanceOf(GraphicFetchError);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a non-200, a non-PNG content type, and bytes that are not a PNG", async () => {
    await expect(fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: respond(PNG, { status: 404 }) })).rejects.toThrow(/404/);
    await expect(fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: respond(PNG, { type: "text/html" }) })).rejects.toThrow(/content type/);
    await expect(fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: respond(Buffer.from("<html>")) })).rejects.toThrow(/not a PNG/);
  });

  it("refuses anything too big", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_GRAPHIC_BYTES)]);
    await expect(fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: respond(big) })).rejects.toThrow(/too big/);
  });

  it("gives up after the timeout", async () => {
    const hang = vi.fn(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(fetchGraphic(URL_OK, { apiUrl: API, fetchImpl: hang as never, timeoutMs: 20 })).rejects.toBeInstanceOf(GraphicFetchError);
  });

  it("www. or not is the same server (the app's own URL and MATCHTIME_API_URL may differ only by it)", async () => {
    const f = respond(PNG);
    await expect(fetchGraphic("https://www.matchtime.ai/api/graphics/t", { apiUrl: API, fetchImpl: f })).resolves.toBeInstanceOf(Buffer);
  });

  it("a local dev server on http is its own origin", async () => {
    const f = respond(PNG);
    await expect(fetchGraphic("http://localhost:3105/api/graphics/t", { apiUrl: "http://localhost:3105", fetchImpl: f })).resolves.toBeInstanceOf(Buffer);
  });
});
