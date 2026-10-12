/**
 * GET /api/r/[code], with the REAL `NextResponse` and real signed tokens
 * (security review of PR #248, fix 6). Only the database is mocked.
 *
 *   a code whose token still signs in     200  { token }
 *   an expired link of ours               410  { error: "expired" }  and nothing else
 *   everything else                       404  { error: "not-found-or-expired" }
 *
 * "Everything else" includes a token that is live but refused by the
 * lifetime policy: it is not "expired", so it gets no sign-in notice.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ shortLink: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "unit-test-secret";

import { GET } from "@/app/api/r/[code]/route";
import { signMagicLinkToken, verifyMagicLinkToken } from "@/lib/magic-link";

const sign = (ttlSeconds: number) =>
  signMagicLinkToken({ userId: "u-hana", purpose: "sign-in", nextPath: "/billing/org_secret", orgId: "org_secret", ttlSeconds });

/** Signed by us, but minted for far longer than a sign-in link may live. */
function policyRefused(): string {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const iat = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ userId: "u-hana", purpose: "sign-in", iat, exp: iat + 50 * 365 * 24 * 3600 }));
  return `${body}.${b64(createHmac("sha256", process.env.AUTH_SECRET!.trim()).update(body).digest())}`;
}

async function call(code: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await GET(new Request("http://x/api/r/x"), { params: Promise.resolve({ code }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

/** What the row lookup returns for a short code. */
const stored = (token: string | null) => dbMock.shortLink.findUnique.mockResolvedValue(token ? { token, expiresAt: new Date(0) } : null);

beforeEach(() => {
  vi.clearAllMocks();
  stored(null);
});

describe("GET /api/r/[code]: the real response", () => {
  it("unknown code: 404", async () => {
    expect(await call("neverACode")).toMatchObject({ status: 404, body: { error: "not-found-or-expired" } });
  });

  it("a live code: 200 and its token, which really signs in", async () => {
    const token = sign(600);
    stored(token);
    const res = await call("k7Qp2m9");
    expect(res).toMatchObject({ status: 200, body: { token } });
    expect(await verifyMagicLinkToken(token)).not.toBeNull();
  });

  it("an expired code: 410 and the word 'expired', with no page, club, language or person in the answer", async () => {
    stored(sign(-60));
    const res = await call("k7Qp2m9");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "expired" });
    for (const secret of ["billing", "org_secret", "u-hana", "login", "lang", "token"]) {
      expect(res.text, secret).not.toContain(secret);
    }
  });

  it("an expired LONG token put where the code goes: 410 too, and it is never looked up as a code", async () => {
    const res = await call(sign(-60));
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "expired" });
    expect(dbMock.shortLink.findUnique).not.toHaveBeenCalled();
  });

  it("a live token refused by the lifetime policy is NOT 'expired': 404, as a code and as a long token", async () => {
    const token = policyRefused();
    expect(await verifyMagicLinkToken(token)).toBeNull();
    stored(token);
    expect(await call("k7Qp2m9")).toMatchObject({ status: 404, body: { error: "not-found-or-expired" } });
    expect(await call(token)).toMatchObject({ status: 404, body: { error: "not-found-or-expired" } });
  });

  it("a forged token: 404", async () => {
    const forged = `${sign(-60).split(".")[0]}.AAAA`;
    expect((await call(forged)).status).toBe(404);
    stored(forged);
    expect((await call("k7Qp2m9")).status).toBe(404);
  });

  it("a live LONG token put where the code goes has nothing to resolve: 404", async () => {
    expect((await call(sign(600))).status).toBe(404);
  });
});
