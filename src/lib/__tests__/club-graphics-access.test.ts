/**
 * Who may see a club's Posters card, preview its posters, choose a design
 * or upload a background (2026-10-14): the club's OWNER or ADMIN (and the
 * platform superadmin), for the club the request is operating in. A
 * player gets 403 on every one of those routes; nobody signed in, 401.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), getUserOrg: vi.fn(), seesAdminFields: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/org", () => ({ getUserOrg: m.getUserOrg }));
vi.mock("@/lib/admin-view", () => ({ seesAdminFields: m.seesAdminFields }));

import { clubGraphicsAccess } from "../club-graphics-access";

const membership = (role: string) => ({ orgId: "org-1", role, org: { id: "org-1", name: "Invented FC", language: "tr" } });

beforeEach(() => {
  m.auth.mockReset();
  m.getUserOrg.mockReset();
  m.seesAdminFields.mockReset();
});

describe("clubGraphicsAccess", () => {
  it("not signed in: 401", async () => {
    m.auth.mockResolvedValue(null);
    expect(await clubGraphicsAccess()).toEqual({ ok: false, status: 401 });
  });

  it("signed in with no club: 404", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    m.getUserOrg.mockResolvedValue(null);
    expect(await clubGraphicsAccess()).toEqual({ ok: false, status: 404 });
  });

  it("a player of the club: 403", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    m.getUserOrg.mockResolvedValue(membership("PLAYER"));
    m.seesAdminFields.mockResolvedValue(false);
    expect(await clubGraphicsAccess()).toEqual({ ok: false, status: 403 });
    expect(m.seesAdminFields).toHaveBeenCalledWith("u1", "PLAYER");
  });

  it("an owner or admin: the club it is for, its name and language", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    m.getUserOrg.mockResolvedValue(membership("OWNER"));
    m.seesAdminFields.mockResolvedValue(true);
    expect(await clubGraphicsAccess()).toEqual({ ok: true, userId: "u1", orgId: "org-1", clubName: "Invented FC", lang: "tr" });
  });
});
