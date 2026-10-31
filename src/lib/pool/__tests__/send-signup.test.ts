import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
let analyticsThrows = false;
vi.mock("@vercel/analytics", () => ({
  track: (...a: unknown[]) => {
    track(...a);
    if (analyticsThrows) throw new Error("blocked");
  },
}));

import { sendPoolSignup } from "../send-signup";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

const BODY = { name: "Ali Veli", area: "SM1", phone: "+447700900000" };

describe("sendPoolSignup: the /play form's POST /api/play/signup", () => {
  beforeEach(() => {
    track.mockReset();
    analyticsThrows = false;
  });

  it("on success returns the confirm details and counts one pool_signup event with no personal data", async () => {
    const r = await sendPoolSignup(BODY, fakeFetch(200, { ok: true, code: "AB12", prefill: "JOIN AB12", waLink: "https://wa.me/x", earlyList: true }));
    expect(r).toEqual({ kind: "ok", confirm: { code: "AB12", prefill: "JOIN AB12", waLink: "https://wa.me/x", earlyList: true } });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("pool_signup");
  });

  it("does not count an event when the server returns field errors", async () => {
    const r = await sendPoolSignup(BODY, fakeFetch(400, { ok: false, errors: { name: "required" } }));
    expect(r).toEqual({ kind: "fields", errors: { name: "required" } });
    expect(track).not.toHaveBeenCalled();
  });

  it("does not count an event when the server refuses with a reason", async () => {
    const r = await sendPoolSignup(BODY, fakeFetch(503, { ok: false, reason: "paused" }));
    expect(r).toEqual({ kind: "error", reason: "paused" });
    expect(track).not.toHaveBeenCalled();
  });

  it("an unknown reason, or a reply missing the code, is the generic error and no event", async () => {
    expect(await sendPoolSignup(BODY, fakeFetch(500, { ok: false, reason: "weird" }))).toEqual({ kind: "error", reason: "generic" });
    expect(await sendPoolSignup(BODY, fakeFetch(200, { ok: true }))).toEqual({ kind: "error", reason: "generic" });
    expect(track).not.toHaveBeenCalled();
  });

  it("a network failure is the generic error and no event", async () => {
    const r = await sendPoolSignup(BODY, (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(r).toEqual({ kind: "error", reason: "generic" });
    expect(track).not.toHaveBeenCalled();
  });

  it("a failure inside analytics never breaks a sign-up that succeeded", async () => {
    analyticsThrows = true;
    const r = await sendPoolSignup(BODY, fakeFetch(200, { ok: true, code: "AB12", prefill: "p", waLink: "w" }));
    expect(r.kind).toBe("ok");
    expect(track).toHaveBeenCalledTimes(1);
  });
});
