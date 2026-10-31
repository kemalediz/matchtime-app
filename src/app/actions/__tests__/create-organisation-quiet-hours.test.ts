/**
 * /create-org (self-join off): the club it creates starts with quiet hours
 * OFF (Kemal, 2026-10-31). db, auth, org and next-cache are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgCreate = vi.fn();
const orgFindUnique = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/db", () => ({
  db: { organisation: { create: (...a: unknown[]) => orgCreate(...a), findUnique: (...a: unknown[]) => orgFindUnique(...a) } },
}));
vi.mock("@/lib/org", () => ({ setCurrentOrgId: vi.fn(), requireOrgAdmin: vi.fn(), getCurrentOrgId: vi.fn() }));
vi.mock("@/lib/self-join-flag", () => ({ selfJoinEnabledForRequest: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createOrganisation } from "../org";

beforeEach(() => {
  vi.clearAllMocks();
  orgFindUnique.mockResolvedValue(null);
  orgCreate.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: "org-new", slug: data.slug }));
});

describe("createOrganisation", () => {
  it("creates the club with quiet hours off", async () => {
    await createOrganisation({ name: "Riverside FC", slug: "riverside-fc" });
    const data = orgCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Riverside FC", slug: "riverside-fc", quietHoursEnabled: false });
  });
});
