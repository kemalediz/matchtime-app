/**
 * Signing out clears the /play staff cookie (round 2 of #607, 2026-11-16).
 * Kemal signing in once on someone else's device must not mark that browser
 * as MatchTime staff for a year. Every sign-out in the app (the sidebar, the
 * claim page, the player's own erase on /play/manage) is `signOut` from
 * next-auth/react, which POSTs to /api/auth/signout: so the auth route adds
 * the clearing to that one answer, whatever Auth.js itself sends back.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ handlers: { GET: vi.fn(), POST: vi.fn() } }));
vi.mock("@/lib/auth", () => auth);

import { GET, POST } from "../route";

const req = (path: string, method = "POST") => new Request(`https://matchtime.ai${path}`, { method });
const setCookies = (res: Response) => res.headers.getSetCookie();

beforeEach(() => {
  vi.clearAllMocks();
});

/** Auth.js's own clearing of the session, as `sessionStore.clean()` sends it on a real sign-out. */
const SESSION_CLEARED = "__Secure-authjs.session-token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

/** A response whose headers cannot be changed, as Response.redirect's:
 *  every write throws, so a wrapper that edits Auth.js's answer fails. */
function immutable(res: Response): Response {
  for (const method of ["append", "set", "delete"] as const) {
    Object.defineProperty(res.headers, method, {
      value: () => {
        throw new TypeError("immutable");
      },
    });
  }
  return res;
}

describe("POST /api/auth/signout clears the staff cookie, only when the sign-out happened", () => {
  it("the guard really is immutable: a write to it throws", () => {
    expect(() => immutable(new Response(null)).headers.append("set-cookie", "x=1")).toThrow(/immutable/);
    expect(() => Response.redirect("https://matchtime.ai/login", 302).headers.append("set-cookie", "x=1")).toThrow();
  });

  it("a redirecting sign-out with immutable headers (the sidebar, the claim page): Auth.js's own answer kept, plus the staff cookie cleared", async () => {
    auth.handlers.POST.mockResolvedValue(immutable(new Response(null, { status: 302, headers: [["location", "https://matchtime.ai/login"], ["set-cookie", SESSION_CLEARED]] })));
    const res = await POST(req("/api/auth/signout") as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://matchtime.ai/login");
    const cookies = setCookies(res);
    expect(cookies).toContain(SESSION_CLEARED);
    expect(cookies).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure");
  });

  it("a sign-out without a redirect (the player's erase on /play/manage): its JSON answer kept, the cookie cleared", async () => {
    const upstream = Response.json({ url: "https://matchtime.ai/" });
    upstream.headers.append("set-cookie", SESSION_CLEARED);
    auth.handlers.POST.mockResolvedValue(upstream);
    const res = await POST(req("/api/auth/signout") as never);
    expect(await res.json()).toEqual({ url: "https://matchtime.ai/" });
    expect(setCookies(res)).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure");
  });

  it("a chunked session cookie cleared counts as a sign-out too", async () => {
    auth.handlers.POST.mockResolvedValue(new Response(null, { status: 302, headers: [["location", "/login"], ["set-cookie", "authjs.session-token.0=; Path=/; Max-Age=0"]] }));
    const res = await POST(new Request("http://localhost:3000/api/auth/signout", { method: "POST" }) as never);
    // Plain http (next dev): cleared without Secure.
    expect(setCookies(res)).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly");
  });

  // Round 3 of #607: a sign-out Auth.js refused (no CSRF token) sends the
  // browser to /login?error=... and clears no session: the person is still
  // signed in, so the staff mark stays.
  it("a refused sign-out (missing CSRF: a 302 to /login?error=...): passed through untouched, no clearing", async () => {
    const refused = new Response(null, { status: 302, headers: [["location", "https://matchtime.ai/login?error=MissingCSRF"]] });
    auth.handlers.POST.mockResolvedValue(refused);
    const res = await POST(req("/api/auth/signout") as never);
    expect(res).toBe(refused);
    expect(setCookies(res).join("\n")).not.toContain("mt-staff");
  });

  it("nobody signed in (no session to clear): nothing to sign out, no clearing", async () => {
    const upstream = Response.json({ url: "https://matchtime.ai/login" });
    auth.handlers.POST.mockResolvedValue(upstream);
    expect(await POST(req("/api/auth/signout") as never)).toBe(upstream);
  });

  it("a session cookie SET, not cleared, is no sign-out", async () => {
    const upstream = new Response(null, { status: 302, headers: [["location", "/"], ["set-cookie", "__Secure-authjs.session-token=eyJabc; Path=/; HttpOnly; Secure"]] });
    auth.handlers.POST.mockResolvedValue(upstream);
    expect(await POST(req("/api/auth/signout") as never)).toBe(upstream);
  });

  it("any other auth call (signing in, the session, the CSRF token) is passed through untouched", async () => {
    for (const path of ["/api/auth/callback/credentials", "/api/auth/signin/whatsapp", "/api/auth/session", "/api/auth/signoutx"]) {
      const upstream = new Response("ok", { status: 200 });
      auth.handlers.POST.mockResolvedValue(upstream);
      expect(await POST(req(path) as never)).toBe(upstream);
    }
    const page = new Response("page", { status: 200 });
    auth.handlers.GET.mockResolvedValue(page);
    // GET /api/auth/signout only shows Auth.js's confirmation page: nobody is signed out.
    expect(await GET(req("/api/auth/signout", "GET") as never)).toBe(page);
  });
});

describe("every sign-out goes through that route", () => {
  const SRC = join(__dirname, "..", "..", "..", "..", "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "generated" || n === "__tests__" ? [] : files(p);
      return /\.(ts|tsx)$/.test(n) ? [p] : [];
    });

  it("each signOut in the app is next-auth/react's (it POSTs to /api/auth/signout), never the server's", () => {
    const users = files(SRC)
      .map((p) => ({ path: relative(SRC, p), text: readFileSync(p, "utf8") }))
      .filter((f) => /\bsignOut\s*\(/.test(f.text));
    expect(users.map((f) => f.path).sort()).toEqual(["app/(auth)/claim/page.tsx", "app/play/manage/manage-view.tsx", "components/layout/sidebar.tsx"]);
    for (const f of users) expect(f.text, f.path).toMatch(/import \{[^}]*\bsignOut\b[^}]*\} from "next-auth\/react"/);
  });
});
