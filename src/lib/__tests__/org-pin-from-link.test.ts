/**
 * Signing in through a magic link that names a club makes that club the
 * active one, but only for somebody who may act in it.
 *
 * The admin pages read the club from the `orgId` cookie and otherwise fall
 * back to the OLDEST membership (`getUserOrg`). Kemal is in Sutton FC and
 * in MT Test, so MT Test's setup links opened Sutton's admin pages. A link
 * that names the club now pins it at sign-in.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: (...a: unknown[]) => cookieSet(...a) }),
}));

const membershipFindUnique = vi.fn();
const userFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

import { pinOrgFromMagicLink } from "@/lib/org";

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ isSuperadmin: false });
});

describe("pinOrgFromMagicLink", () => {
  it("an active member: the club becomes the active one", async () => {
    membershipFindUnique.mockResolvedValue({ leftAt: null });
    expect(await pinOrgFromMagicLink("u1", "org-mt")).toBe(true);
    expect(cookieSet).toHaveBeenCalledWith("orgId", "org-mt", expect.any(Object));
  });

  it("a member who has left: nothing changes", async () => {
    membershipFindUnique.mockResolvedValue({ leftAt: new Date() });
    expect(await pinOrgFromMagicLink("u1", "org-mt")).toBe(false);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("not a member: nothing changes", async () => {
    membershipFindUnique.mockResolvedValue(null);
    expect(await pinOrgFromMagicLink("u1", "org-other")).toBe(false);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("the platform superadmin may open any club", async () => {
    membershipFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ isSuperadmin: true });
    expect(await pinOrgFromMagicLink("u1", "org-any")).toBe(true);
    expect(cookieSet).toHaveBeenCalledWith("orgId", "org-any", expect.any(Object));
  });

  it("never throws: a failure leaves sign-in working", async () => {
    membershipFindUnique.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await pinOrgFromMagicLink("u1", "org-mt")).toBe(false);
  });
});
