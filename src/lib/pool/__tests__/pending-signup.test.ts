/**
 * The /play reminder's memory in the browser (2026-10-31): only what the
 * reminder needs (the code, the wa.me link, the status token, when the code
 * runs out), in localStorage, read defensively, and never required to work.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPendingSignup,
  clearPendingSignup,
  decodePendingSignup,
  encodePendingSignup,
  loadPendingSignup,
  pendingSignupExpired,
  PENDING_SIGNUP_KEY,
  savePendingSignup,
  type PendingSignup,
} from "../pending-signup";

const P: PendingSignup = { code: "ABCDE", waLink: "https://wa.me/447700900555?text=Hi", token: "prof1.sig", expiresAt: Date.parse("2026-11-03T12:00:00Z") };

function fakeStore(opts: { throws?: boolean } = {}) {
  const m = new Map<string, string>();
  const s = {
    getItem: (k: string) => {
      if (opts.throws) throw new Error("blocked");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error("blocked");
      m.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts.throws) throw new Error("blocked");
      m.delete(k);
    },
  };
  return { m, s };
}

afterEach(() => vi.unstubAllGlobals());

describe("encode and decode", () => {
  it("has a versioned key", () => expect(PENDING_SIGNUP_KEY).toMatch(/v1$/));
  it("round-trips", () => expect(decodePendingSignup(encodePendingSignup(P))).toEqual(P));
  it("stores only the four things the reminder needs: no name, area, days or message text", () => {
    const raw = JSON.parse(encodePendingSignup({ ...P, name: "Ali", prefill: "x" } as unknown as PendingSignup));
    expect(Object.keys(raw).sort()).toEqual(["code", "expiresAt", "token", "v", "waLink"]);
  });
  it.each([
    ["nothing", null],
    ["not json", "{"],
    ["another version", JSON.stringify({ ...P, v: 2 })],
    ["a link that is not WhatsApp", JSON.stringify({ v: 1, ...P, waLink: "https://evil.example/x" })],
    ["a javascript link", JSON.stringify({ v: 1, ...P, waLink: "javascript:alert(1)" })],
    ["a code of the wrong shape", JSON.stringify({ v: 1, ...P, code: "AB" })],
    ["no token", JSON.stringify({ v: 1, ...P, token: "" })],
    ["no expiry", JSON.stringify({ v: 1, ...P, expiresAt: "soon" })],
    ["an array", "[]"],
  ])("drops %s", (_n, raw) => expect(decodePendingSignup(raw)).toBeNull());
});

describe("expiry", () => {
  it("before the code runs out: not expired", () => expect(pendingSignupExpired(P, P.expiresAt - 1)).toBe(false));
  it("at or after: expired", () => {
    expect(pendingSignupExpired(P, P.expiresAt)).toBe(true);
    expect(pendingSignupExpired(P, P.expiresAt + 1)).toBe(true);
  });
});

describe("the browser's store", () => {
  it("save, load, clear", () => {
    const { s } = fakeStore();
    vi.stubGlobal("window", { localStorage: s });
    savePendingSignup(P);
    expect(loadPendingSignup()).toEqual(P);
    clearPendingSignup();
    expect(loadPendingSignup()).toBeNull();
  });
  it("blocked storage: nothing thrown, nothing kept", () => {
    const { s } = fakeStore({ throws: true });
    vi.stubGlobal("window", { localStorage: s });
    expect(() => savePendingSignup(P)).not.toThrow();
    expect(loadPendingSignup()).toBeNull();
    expect(() => clearPendingSignup()).not.toThrow();
  });
  it("no localStorage at all (the getter throws): nothing thrown", () => {
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get: () => { throw new Error("denied"); } }));
    expect(() => savePendingSignup(P)).not.toThrow();
    expect(loadPendingSignup()).toBeNull();
    expect(() => clearPendingSignup()).not.toThrow();
  });
});

describe("checkPendingSignup: POST /api/play/signup/status", () => {
  const answer = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  it("sends only the token and the code", async () => {
    const f = vi.fn(answer(200, { state: "waiting" }));
    await checkPendingSignup(P, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith("/api/play/signup/status", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: P.token, code: P.code });
  });
  it.each(["waiting", "done", "gone"] as const)("reads %s", async (state) => expect(await checkPendingSignup(P, answer(200, { state }))).toBe(state));
  it("busy, a broken answer or no network: unknown", async () => {
    expect(await checkPendingSignup(P, answer(429, { reason: "busy" }))).toBe("unknown");
    expect(await checkPendingSignup(P, answer(200, { state: "maybe" }))).toBe("unknown");
    expect(await checkPendingSignup(P, (async () => { throw new Error("offline"); }) as typeof fetch)).toBe("unknown");
  });
});
