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

describe("POST /api/auth/signout clears the staff cookie", () => {
  it("a redirecting sign-out (the sidebar, the claim page): Auth.js's own answer, plus the staff cookie cleared", async () => {
    // Response.redirect has immutable headers, as Auth.js's may.
    const upstream = Response.redirect("https://matchtime.ai/login", 302);
    const withSession = new Response(null, { status: 302, headers: upstream.headers });
    withSession.headers.append("set-cookie", "__Secure-authjs.session-token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
    auth.handlers.POST.mockResolvedValue(withSession);
    const res = await POST(req("/api/auth/signout") as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://matchtime.ai/login");
    const cookies = setCookies(res);
    expect(cookies).toContain("__Secure-authjs.session-token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
    expect(cookies).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure");
  });

  it("a sign-out without a redirect (the player's erase on /play/manage): its JSON answer kept, the cookie cleared", async () => {
    auth.handlers.POST.mockResolvedValue(Response.json({ url: "https://matchtime.ai/" }));
    const res = await POST(req("/api/auth/signout") as never);
    expect(await res.json()).toEqual({ url: "https://matchtime.ai/" });
    expect(setCookies(res)).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure");
  });

  it("plain http (next dev): cleared without Secure", async () => {
    auth.handlers.POST.mockResolvedValue(new Response(null, { status: 200 }));
    const res = await POST(new Request("http://localhost:3000/api/auth/signout", { method: "POST" }) as never);
    expect(setCookies(res)).toContain("mt-staff=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly");
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
