/**
 * The player pool banner's route (2026-10-28): "Not interested" only ever
 * writes the SIGNED-IN person's own row (the session's id; a user id in the
 * body is ignored), only for a known banner, and the load never throws a
 * page down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserOrg: vi.fn(),
  poolEnvForRequest: vi.fn(),
  dismissPoolBanner: vi.fn(),
  loadPoolBanner: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ getUserOrg: h.getUserOrg }));
vi.mock("@/lib/pool/switch-env", () => ({ poolEnvForRequest: h.poolEnvForRequest }));
vi.mock("@/lib/pool/banner", () => ({ dismissPoolBanner: h.dismissPoolBanner, loadPoolBanner: h.loadPoolBanner }));

import { GET, POST } from "../pool-banner/route";

const post = (body: unknown) =>
  POST(new Request("http://x/api/pool-banner", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.auth.mockResolvedValue({ user: { id: "me" } });
  h.getUserOrg.mockResolvedValue({ orgId: "org1" });
  h.poolEnvForRequest.mockResolvedValue({ MT_POOL_OPEN: "1" });
  h.dismissPoolBanner.mockResolvedValue({ ok: true });
  h.loadPoolBanner.mockResolvedValue({ kind: "join", language: "en", whatsApp: null, adminLine: false });
});

describe("Not interested", () => {
  it("dismisses the join banner for himself", async () => {
    expect(await json(await post({ kind: "join" }))).toEqual({ status: 200, body: { ok: true } });
    expect(h.dismissPoolBanner).toHaveBeenCalledWith("me", "join");
  });

  it("dismisses the share banner for himself; a user id in the body is ignored", async () => {
    expect((await post({ kind: "share", userId: "someone-else" })).status).toBe(200);
    expect(h.dismissPoolBanner).toHaveBeenCalledWith("me", "share");
  });

  it("signed out writes nothing", async () => {
    h.auth.mockResolvedValue(null);
    expect(await json(await post({ kind: "join" }))).toEqual({ status: 401, body: { ok: false, reason: "signed-out" } });
    expect(h.dismissPoolBanner).not.toHaveBeenCalled();
  });

  it("anything but join or share writes nothing", async () => {
    for (const bad of [{ kind: "JOIN" }, {}, { kind: null }, ["join"], "not json", null]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(h.dismissPoolBanner).not.toHaveBeenCalled();
  });

  it("the columns not there yet: unavailable, no throw", async () => {
    h.dismissPoolBanner.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect(await json(await post({ kind: "join" }))).toEqual({ status: 503, body: { ok: false, reason: "unavailable" } });
  });
});

describe("the banner's load", () => {
  it("for himself, with the switch resolved for this request and his current club, never cached", async () => {
    const r = await GET();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ kind: "join", language: "en", whatsApp: null, adminLine: false });
    expect(h.loadPoolBanner).toHaveBeenCalledWith("me", { env: { MT_POOL_OPEN: "1" }, currentOrgId: "org1" });
  });

  it("signed out: nothing, nothing read", async () => {
    h.auth.mockResolvedValue(null);
    expect(await (await GET()).json()).toBeNull();
    expect(h.loadPoolBanner).not.toHaveBeenCalled();
  });

  it("any failure: no banner, never a thrown page", async () => {
    h.loadPoolBanner.mockRejectedValue(new Error("db down"));
    expect(await (await GET()).json()).toBeNull();
    h.poolEnvForRequest.mockRejectedValue(new Error("no row"));
    expect(await (await GET()).json()).toBeNull();
  });
});
