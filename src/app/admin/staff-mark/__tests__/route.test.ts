/**
 * POST /admin/staff-mark (2026-11-16): the SERVER sets the /play staff
 * cookie, so WebKit's 7-day cap on cookies a page script sets does not
 * apply and Kemal's iPhone keeps the mark for its year. MatchTime staff
 * (`User.isSuperadmin`) get "mt-staff=2"; a signed-in organiser who is not
 * staff has the cookie cleared; nobody signed in, or a check that fails,
 * leaves it as it is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => session);
const org = vi.hoisted(() => ({ isSuperadmin: vi.fn() }));
vi.mock("@/lib/org", () => org);
const jar = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));

import { POST } from "../route";

const call = (url = "https://matchtime.ai/admin/staff-mark") => POST(new Request(url, { method: "POST" }));

beforeEach(() => {
  vi.clearAllMocks();
  session.auth.mockResolvedValue({ user: { id: "u-kemal" } });
  org.isSuperadmin.mockResolvedValue(true);
});

describe("POST /admin/staff-mark", () => {
  it("MatchTime staff: the server sets the staff cookie for a year, Secure on https, not readable by page script", async () => {
    const res = await call();
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(org.isSuperadmin).toHaveBeenCalledWith("u-kemal");
    expect(jar.set).toHaveBeenCalledWith({ name: "mt-staff", value: "2", maxAge: 31_536_000, path: "/", sameSite: "lax", secure: true, httpOnly: true });
  });

  it("plain http (next dev): the same cookie without Secure", async () => {
    await call("http://localhost:3000/admin/staff-mark");
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ value: "2", secure: false }));
  });

  it("a club owner or admin who is not MatchTime staff: the cookie is cleared, never set", async () => {
    org.isSuperadmin.mockResolvedValue(false);
    expect((await call()).status).toBe(204);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ name: "mt-staff", value: "", maxAge: 0 }));
    expect(jar.set).not.toHaveBeenCalledWith(expect.objectContaining({ value: "2" }));
  });

  it("nobody signed in: nothing set or cleared", async () => {
    session.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(204);
    expect(jar.set).not.toHaveBeenCalled();
    expect(org.isSuperadmin).not.toHaveBeenCalled();
  });

  it("a check that fails leaves the cookie as it is: staff never lose it to a blip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    org.isSuperadmin.mockRejectedValue(new Error("db down"));
    expect((await call()).status).toBe(204);
    expect(jar.set).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
