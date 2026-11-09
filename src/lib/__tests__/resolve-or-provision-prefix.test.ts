/**
 * NO FIRST-NAME PREFIX MATCH. First pinned for a multi-word ref (2026-10-30,
 * review of PR #476, HIGH 1c): "the lads" must not become Theo, nor
 * "everyone" Eve. Since 2026-11-09 (Vets MNF, "David" read as Davide De
 * Sousa) not for a single word either: only the whole name, an exact first
 * name or an alias finds a member.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  userAlias: { findUnique: vi.fn(async () => null) },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const sender = vi.hoisted(() => ({
  createProvisionalByName: vi.fn(async (_o: string, name: string) => ({ userId: `new:${name}`, name })),
  restoreMembership: vi.fn(),
}));
vi.mock("../resolve-sender", () => sender);

import { resolveOrProvisionByName } from "../resolve-or-provision-name";

const member = (id: string, name: string) => ({ id: `m-${id}`, userId: id, leftAt: null, user: { id, name } });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue([member("u-theo", "Theo Walcott"), member("u-eve", "Eve Adams"), member("u-mo", "Mohammed Ali")]);
});

describe("the prefix match", () => {
  it("a multi-word ref is never prefix-matched to a member's first name", async () => {
    const r = await resolveOrProvisionByName("org-1", "the lads");
    expect(r?.userId).not.toBe("u-theo");
  });

  // Vets MNF, 2026-11-09. The engine said "David" is nobody in the club; a
  // first-name PREFIX here would have read him as the member Davide De Sousa
  // on the way to provisioning him. One name being the start of another
  // does not make them the same person ("David"/"Davide", "Luca"/"Lucas"),
  // so a name nobody has exactly is a new person. A nickname is an alias.
  it("'David' is not the member Davide De Sousa: he is provisioned as a new person", async () => {
    dbMock.membership.findMany.mockResolvedValue([member("u-davide", "Davide De Sousa"), member("u-kemal", "Kemal")]);
    const r = await resolveOrProvisionByName("org-1", "David");
    expect(r?.userId).toBe("new:David");
    expect(sender.createProvisionalByName).toHaveBeenCalledWith("org-1", "David", null, { deliberate: false });
  });

  it("a short form of a member's first name is not that member ('Moham' is a new person)", async () => {
    expect((await resolveOrProvisionByName("org-1", "Moham"))?.userId).toBe("new:Moham");
  });

  it("an exact first name still resolves ('Mohammed' is Mohammed Ali)", async () => {
    expect((await resolveOrProvisionByName("org-1", "Mohammed"))?.userId).toBe("u-mo");
  });

  it("an accent difference is the same name ('Théo' is Theo Walcott)", async () => {
    expect((await resolveOrProvisionByName("org-1", "Théo"))?.userId).toBe("u-theo");
  });

  it("an exact first name still resolves, whatever follows it", async () => {
    expect((await resolveOrProvisionByName("org-1", "Theo W"))?.userId).toBe("u-theo");
  });
});
