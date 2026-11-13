/**
 * POST /api/play/visit (visits 2026-11-03, steps 2026-11-04): the /play
 * page's beacon for the two steps only the browser sees, opened and
 * started. It answers at once and records AFTER the answer (`after`), so a
 * count never slows the page, and whatever it is sent it never fails the
 * caller. Sent and confirmed are counted by the server where they happen,
 * so a page claiming them counts nothing. Our own staff's visits count
 * nothing (2026-11-12): the staff cookie, or a session for an owner or admin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const later = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => later.tasks.push(fn) }));
const visits = vi.hoisted(() => ({ recordPoolVisit: vi.fn() }));
vi.mock("@/lib/pool/visits", () => visits);
const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined) }) }));
const session = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => session);
const org = vi.hoisted(() => ({ getUserOrg: vi.fn(), isOrgAdmin: vi.fn() }));
vi.mock("@/lib/org", () => org);

import { POST } from "../route";

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const req = (body: string, ua: string | null = PERSON) =>
  new Request("http://localhost/api/play/visit", { method: "POST", body, headers: ua === null ? {} : { "user-agent": ua } });

beforeEach(() => {
  vi.clearAllMocks();
  later.tasks.length = 0;
  visits.recordPoolVisit.mockResolvedValue("fb-sutton");
  jar.cookies.clear();
  session.auth.mockResolvedValue(null);
  org.getUserOrg.mockResolvedValue(null);
  org.isOrgAdmin.mockResolvedValue(false);
});

describe("POST /api/play/visit", () => {
  it("answers 204 before recording, then records the code it was sent, the step and the user agent", async () => {
    const res = await POST(req(JSON.stringify({ src: "FB-Sutton", ref: "", step: "started" })));
    expect(res.status).toBe(204);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith({
      source: { campaignCode: "fb-sutton", referralCode: null },
      userAgent: PERSON,
      now: expect.any(Date),
      step: "started",
      detail: { openedBy: null, visibleMs: null },
    });
  });

  it("passes on what opened the page and its visible time, checked and clamped (2026-11-13)", async () => {
    await POST(req(JSON.stringify({ src: "fb-sutton", step: "opened", trigger: "scroll", visibleMs: 5234 })));
    await POST(req(JSON.stringify({ src: "fb-sutton", step: "opened", trigger: "<script>", visibleMs: 9e15 })));
    await POST(req(JSON.stringify({ src: "fb-sutton", step: "started", trigger: "key", visibleMs: -1 })));
    for (const task of later.tasks) await task();
    expect(visits.recordPoolVisit.mock.calls.map((c) => c[0].detail)).toEqual([
      { openedBy: "scroll", visibleMs: 5200 },
      { openedBy: null, visibleMs: 24 * 3600 * 1000 },
      { openedBy: null, visibleMs: 0 },
    ]);
  });

  it("never passes on anything that identifies the visitor: no address, no cookie", async () => {
    const r = new Request("http://localhost/api/play/visit", {
      method: "POST",
      body: JSON.stringify({ src: "fb-sutton", ref: "AB12cd", step: "opened", trigger: "touch", visibleMs: 100, userId: "u1", ip: "1.2.3.4" }),
      headers: { "user-agent": PERSON, "x-forwarded-for": "203.0.113.9", cookie: "session=abc" },
    });
    await POST(r);
    await later.tasks[0]();
    const arg = visits.recordPoolVisit.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(["detail", "now", "source", "step", "userAgent"]);
    expect(JSON.stringify(arg)).not.toMatch(/203\.0\.113\.9|1\.2\.3\.4|session=abc|u1/);
  });

  it("no step is opened: a page cached before steps existed still counts its visit", async () => {
    await POST(req(JSON.stringify({ src: "fb-sutton" })));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ step: "opened" }));
  });

  it("a page claiming sent or confirmed, or any other step, gets 204 and counts nothing", async () => {
    for (const step of ["sent", "confirmed", "paid", 3]) {
      expect((await POST(req(JSON.stringify({ src: "fb-sutton", step })))).status).toBe(204);
    }
    expect(later.tasks).toHaveLength(0);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
  });

  it("a body that is not JSON counts as plain /play, opened", async () => {
    expect((await POST(req("not json"))).status).toBe(204);
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ source: { campaignCode: null, referralCode: null }, step: "opened" }));
  });

  it("no user agent is passed on as none (the recorder treats it as a fetcher)", async () => {
    await POST(req("{}", null));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
  });

  describe("our own staff (2026-11-12)", () => {
    it("the staff cookie: 204 as ever, nothing counted, one log line, no session looked up", async () => {
      jar.cookies.set("mt-staff", "1");
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      expect((await POST(req(JSON.stringify({ src: "fb-sutton", step: "started" })))).status).toBe(204);
      await later.tasks[0]();
      expect(visits.recordPoolVisit).not.toHaveBeenCalled();
      expect(session.auth).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[pool-funnel] skipped staff visit step=started code=fb-sutton ref=no");
      log.mockRestore();
    });

    it("a session for an owner or admin, the admin pages' own check: nothing counted", async () => {
      session.auth.mockResolvedValue({ user: { id: "u-owner" } });
      org.getUserOrg.mockResolvedValue({ orgId: "org-1" });
      org.isOrgAdmin.mockResolvedValue(true);
      vi.spyOn(console, "info").mockImplementation(() => {});
      expect((await POST(req(JSON.stringify({ src: "fb-sutton" })))).status).toBe(204);
      await later.tasks[0]();
      expect(org.isOrgAdmin).toHaveBeenCalledWith("u-owner", "org-1");
      expect(visits.recordPoolVisit).not.toHaveBeenCalled();
      vi.mocked(console.info).mockRestore();
    });

    it("a signed-in player who is not an admin counts", async () => {
      session.auth.mockResolvedValue({ user: { id: "u-player" } });
      org.getUserOrg.mockResolvedValue({ orgId: "org-1" });
      await POST(req(JSON.stringify({ src: "fb-sutton" })));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
    });

    it("signed in with no club: counts, and no admin check is made", async () => {
      session.auth.mockResolvedValue({ user: { id: "u-new" } });
      await POST(req(JSON.stringify({ src: "fb-sutton" })));
      await later.tasks[0]();
      expect(org.isOrgAdmin).not.toHaveBeenCalled();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
    });

    it("a cookie with another value counts", async () => {
      jar.cookies.set("mt-staff", "0");
      await POST(req(JSON.stringify({ src: "fb-sutton" })));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
    });

    it("a session lookup that fails still counts: a count is never lost to the staff check", async () => {
      session.auth.mockRejectedValue(new Error("db down"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await POST(req(JSON.stringify({ src: "fb-sutton" })));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
      vi.mocked(console.warn).mockRestore();
    });
  });
});
