/**
 * Is a /play request from MatchTime staff? (2026-11-16, Kemal: staff means
 * only his own browsers, not every club organiser.) The staff cookie
 * decides without a database read; without it, the request's session, if
 * any, must be a `User.isSuperadmin` account. A club owner or admin is not
 * staff. A lookup that fails is not staff: a count is never lost to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => session);
const org = vi.hoisted(() => ({ isSuperadmin: vi.fn(), isOrgAdmin: vi.fn(), getUserOrg: vi.fn() }));
vi.mock("@/lib/org", () => org);

import { isPoolStaffRequest } from "../staff-request";

beforeEach(() => {
  vi.clearAllMocks();
  session.auth.mockResolvedValue(null);
  org.isSuperadmin.mockResolvedValue(false);
  org.isOrgAdmin.mockResolvedValue(true);
});

describe("isPoolStaffRequest", () => {
  it("the staff cookie: staff, and no session is looked up", async () => {
    expect(await isPoolStaffRequest("2")).toBe(true);
    expect(session.auth).not.toHaveBeenCalled();
  });

  it("a MatchTime staff session (User.isSuperadmin): staff, with or without a cookie", async () => {
    session.auth.mockResolvedValue({ user: { id: "u-kemal" } });
    org.isSuperadmin.mockResolvedValue(true);
    for (const cookie of [null, "1", "0"]) expect(await isPoolStaffRequest(cookie)).toBe(true);
    expect(org.isSuperadmin).toHaveBeenCalledWith("u-kemal");
  });

  it("a club owner or admin who is not MatchTime staff: not staff, whatever his club role, even with the old cookie", async () => {
    session.auth.mockResolvedValue({ user: { id: "u-organiser" } });
    for (const cookie of [null, "1"]) expect(await isPoolStaffRequest(cookie)).toBe(false);
    expect(org.isOrgAdmin).not.toHaveBeenCalled();
    expect(org.getUserOrg).not.toHaveBeenCalled();
  });

  it("signed out with the old cookie every organiser got until 2026-11-16: not staff", async () => {
    expect(await isPoolStaffRequest("1")).toBe(false);
  });

  it("signed out, no cookie: not staff, and no account is looked up", async () => {
    expect(await isPoolStaffRequest(null)).toBe(false);
    expect(org.isSuperadmin).not.toHaveBeenCalled();
  });

  it("a lookup that fails: not staff, logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session.auth.mockRejectedValue(new Error("db down"));
    expect(await isPoolStaffRequest(null)).toBe(false);
    session.auth.mockResolvedValue({ user: { id: "u-kemal" } });
    org.isSuperadmin.mockRejectedValue(new Error("db down"));
    expect(await isPoolStaffRequest(null)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });
});
