/**
 * POST /api/play/visit (visits 2026-11-03, steps 2026-11-04): the /play
 * page's beacon for the two steps only the browser sees, opened and
 * started. It answers at once and records AFTER the answer (`after`), so a
 * count never slows the page, and whatever it is sent it never fails the
 * caller. Sent and confirmed are counted by the server where they happen,
 * so a page claiming them counts nothing. Since 2026-11-16 an open counts
 * only with what a person did (a tap, touch, key, wheel or scroll, or a
 * start first), and nothing per visit is passed on but that. Our own
 * staff's visits count nothing (2026-11-12), and staff means MatchTime
 * staff (2026-11-16): the staff cookie, or a `User.isSuperadmin` session,
 * never a club's owner or admin.
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
const org = vi.hoisted(() => ({ isSuperadmin: vi.fn(), getUserOrg: vi.fn(), isOrgAdmin: vi.fn() }));
vi.mock("@/lib/org", () => org);

import { POST } from "../route";

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const req = (body: string, ua: string | null = PERSON) =>
  new Request("http://localhost/api/play/visit", { method: "POST", body, headers: ua === null ? {} : { "user-agent": ua } });
const opened = (extra: Record<string, unknown> = {}) => JSON.stringify({ src: "fb-sutton", step: "opened", trigger: "touch", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  later.tasks.length = 0;
  visits.recordPoolVisit.mockResolvedValue("fb-sutton");
  jar.cookies.clear();
  session.auth.mockResolvedValue(null);
  org.isSuperadmin.mockResolvedValue(false);
  org.getUserOrg.mockResolvedValue({ orgId: "org-1" });
  org.isOrgAdmin.mockResolvedValue(true);
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
      trigger: "none",
    });
  });

  it("an open with what a person did: recorded with that trigger, and no time on screen passed on", async () => {
    for (const trigger of ["pointer", "touch", "key", "wheel", "scroll", "before-start"]) await POST(req(opened({ trigger, visibleMs: 5234 })));
    for (const task of later.tasks) await task();
    expect(visits.recordPoolVisit.mock.calls.map((c) => [c[0].step, c[0].trigger])).toEqual([
      ["opened", "pointer"],
      ["opened", "touch"],
      ["opened", "key"],
      ["opened", "wheel"],
      ["opened", "scroll"],
      ["opened", "before-start"],
    ]);
    for (const c of visits.recordPoolVisit.mock.calls) expect(JSON.stringify(c[0])).not.toContain("5234");
  });

  // 15 November 2026: the 4 counted opens were scanners that waited 5000 ms.
  it("an open by time on screen, with no trigger or an unknown one: 204, nothing counted, one short log line saying why", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const body of [opened({ trigger: "visible-time", visibleMs: 5000 }), opened({ trigger: undefined }), opened({ trigger: "<script>" }), JSON.stringify({ src: "fb-sutton" })]) {
      expect((await POST(req(body))).status).toBe(204);
    }
    expect(later.tasks).toHaveLength(0);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "[pool-funnel] beacon rejected step=opened reason=time-on-screen",
      "[pool-funnel] beacon rejected step=opened reason=no-trigger",
      "[pool-funnel] beacon rejected step=opened reason=unknown-trigger",
      "[pool-funnel] beacon rejected step=opened reason=no-trigger",
    ]);
    log.mockRestore();
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
    expect(Object.keys(arg).sort()).toEqual(["now", "source", "step", "trigger", "userAgent"]);
    expect(JSON.stringify(arg)).not.toMatch(/203\.0\.113\.9|1\.2\.3\.4|session=abc|u1/);
  });

  it("no step is opened, as ever: with what a person did, it counts", async () => {
    await POST(req(JSON.stringify({ src: "fb-sutton", trigger: "scroll" })));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ step: "opened", trigger: "scroll" }));
  });

  it("a page claiming sent or confirmed, or any other step, gets 204 and counts nothing; the log names only our own steps", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const step of ["sent", "confirmed", "paid", 3]) {
      expect((await POST(req(JSON.stringify({ src: "fb-sutton", step, trigger: "touch" })))).status).toBe(204);
    }
    expect(later.tasks).toHaveLength(0);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "[pool-funnel] beacon rejected step=sent reason=server-step",
      "[pool-funnel] beacon rejected step=confirmed reason=server-step",
      "[pool-funnel] beacon rejected step=other reason=unknown-step",
      "[pool-funnel] beacon rejected step=other reason=unknown-step",
    ]);
    log.mockRestore();
  });

  it("a body that is not JSON is not a beacon the page sends: 204, nothing counted, logged as not-json", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await POST(req('not json <script> Mozilla/5.0'))).status).toBe(204);
    expect(later.tasks).toHaveLength(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["[pool-funnel] beacon rejected step=other reason=not-json"]);
    log.mockRestore();
  });

  it("no user agent is passed on as none (the recorder treats it as a fetcher)", async () => {
    await POST(req(opened(), null));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
  });

  describe("our own staff: MatchTime staff only (2026-11-12, 2026-11-16)", () => {
    it("the staff cookie: 204 as ever, nothing counted, one log line, no session looked up", async () => {
      jar.cookies.set("mt-staff", "2");
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      expect((await POST(req(JSON.stringify({ src: "fb-sutton", step: "started" })))).status).toBe(204);
      await later.tasks[0]();
      expect(visits.recordPoolVisit).not.toHaveBeenCalled();
      expect(session.auth).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[pool-funnel] skipped staff visit step=started trigger=none");
      log.mockRestore();
    });

    it("a MatchTime staff session (User.isSuperadmin): nothing counted", async () => {
      session.auth.mockResolvedValue({ user: { id: "u-kemal" } });
      org.isSuperadmin.mockResolvedValue(true);
      vi.spyOn(console, "info").mockImplementation(() => {});
      expect((await POST(req(opened()))).status).toBe(204);
      await later.tasks[0]();
      expect(org.isSuperadmin).toHaveBeenCalledWith("u-kemal");
      expect(visits.recordPoolVisit).not.toHaveBeenCalled();
      vi.mocked(console.info).mockRestore();
    });

    it("a club owner or admin who is not MatchTime staff counts, and his club role is never asked", async () => {
      session.auth.mockResolvedValue({ user: { id: "u-organiser" } });
      await POST(req(opened()));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
      expect(org.isOrgAdmin).not.toHaveBeenCalled();
    });

    it("the old cookie every club organiser got until 2026-11-16 counts, signed in as an organiser or signed out", async () => {
      jar.cookies.set("mt-staff", "1");
      session.auth.mockResolvedValueOnce({ user: { id: "u-organiser" } }).mockResolvedValueOnce(null);
      await POST(req(opened()));
      await POST(req(opened()));
      for (const task of later.tasks) await task();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(2);
    });

    it("a cookie with another value counts", async () => {
      jar.cookies.set("mt-staff", "0");
      await POST(req(opened()));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
    });

    it("a session lookup that fails still counts: a count is never lost to the staff check", async () => {
      session.auth.mockRejectedValue(new Error("db down"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await POST(req(opened()));
      await later.tasks[0]();
      expect(visits.recordPoolVisit).toHaveBeenCalledTimes(1);
      vi.mocked(console.warn).mockRestore();
    });
  });
});
