/**
 * GET /api/r/[code]: a working code gives its token; an expired link of
 * ours says so (410) with its sign-in page; anything else is 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveShortLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/short-link", () => ({ resolveShortLink }));

const expiredLinkInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/expired-link", async () => ({
  ...(await vi.importActual<typeof import("@/lib/expired-link")>("@/lib/expired-link")),
  expiredLinkInfo,
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));

import { GET } from "@/app/api/r/[code]/route";

const call = async (code: string) =>
  (await GET(new Request("http://x/api/r/x"), { params: Promise.resolve({ code }) })) as unknown as { body: unknown; status: number };

beforeEach(() => {
  vi.clearAllMocks();
  resolveShortLink.mockResolvedValue(null);
  expiredLinkInfo.mockResolvedValue(null);
});

describe("GET /api/r/[code]", () => {
  it("a working code: its token, as before", async () => {
    resolveShortLink.mockResolvedValue("body.sig");
    expect(await call("k7Qp2m9")).toEqual({ status: 200, body: { token: "body.sig" } });
  });

  it("an expired link: 410 and the sign-in page to go to, and nothing about who it was for", async () => {
    expiredLinkInfo.mockResolvedValue({ nextPath: "/admin/settings", lang: "tr" });
    expect(await call("k7Qp2m9")).toEqual({
      status: 410,
      body: { error: "expired", login: "/login?expired=1&lang=tr&callbackUrl=%2Fadmin%2Fsettings" },
    });
  });

  it("the code's row is still there but its TOKEN has expired: still 410, never a token that cannot sign in", async () => {
    resolveShortLink.mockResolvedValue("body.sig");
    expiredLinkInfo.mockResolvedValue({ nextPath: null, lang: "en" });
    expect(await call("k7Qp2m9")).toEqual({ status: 410, body: { error: "expired", login: "/login?expired=1" } });
  });

  it("a long token put where the code goes is never looked up as a code", async () => {
    expiredLinkInfo.mockResolvedValue({ nextPath: "/admin", lang: "en" });
    expect((await call("body.sig")).status).toBe(410);
    expect(resolveShortLink).not.toHaveBeenCalled();
  });

  it("unknown: 404, as before", async () => {
    expect(await call("neverACode")).toEqual({ status: 404, body: { error: "not-found-or-expired" } });
  });
});
