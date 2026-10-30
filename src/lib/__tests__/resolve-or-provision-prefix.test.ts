/**
 * THE FIRST-NAME PREFIX MATCH NEVER RESOLVES A MULTI-WORD REF (2026-10-30,
 * review of PR #476, HIGH 1c): "the lads" must not become Theo, nor
 * "everyone" Eve. The engine already refuses a ref the model did not call a
 * named person; this pins the roster lookup itself.
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

  it("a single word still matches a short form of a member's first name", async () => {
    expect((await resolveOrProvisionByName("org-1", "Moham"))?.userId).toBe("u-mo");
  });

  it("an exact first name still resolves, whatever follows it", async () => {
    expect((await resolveOrProvisionByName("org-1", "Theo W"))?.userId).toBe("u-theo");
  });
});
