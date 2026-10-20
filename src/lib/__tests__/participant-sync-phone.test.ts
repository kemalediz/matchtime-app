/**
 * `importParticipants` must never replace a phone number that is already
 * saved (follow-up to #315, 2026-10-18).
 *
 * The pushname dedupe matches an org member by alias, exact name or a
 * unique first-token fuzzy name, and that member may already have a
 * number. A participant whose number we have never seen is then a
 * DIFFERENT WhatsApp account: a different person who shares a first name,
 * or the same person on a new number. Neither may silently take over the
 * saved number. The participant becomes their own user; the saved user is
 * left exactly as it was.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const userCreate = vi.fn();
const membershipFindUnique = vi.fn();
const membershipCreate = vi.fn();
const membershipUpdate = vi.fn();
const orgUpdate = vi.fn();
const findExisting = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
      create: (...a: unknown[]) => userCreate(...a),
    },
    membership: {
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      create: (...a: unknown[]) => membershipCreate(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
    },
    organisation: { update: (...a: unknown[]) => orgUpdate(...a) },
  },
}));
vi.mock("@/lib/resolve-player", () => ({
  findExistingOrgMember: (...a: unknown[]) => findExisting(...a),
}));
vi.mock("@/lib/placeholder-link", () => ({
  linkJoinerToPlaceholder: vi.fn(async () => ({ kind: "none" })),
}));

import { importParticipants } from "@/lib/participant-sync";

const ORG = "org-fnf";
const SAVED = "+447700900111";
const NEW = "+447700900222";

/** Users keyed by id; findUnique answers by phoneNumber or id. */
let users: Record<string, { id: string; name: string | null; phoneNumber: string | null }>;

beforeEach(() => {
  vi.clearAllMocks();
  users = {};
  userFindUnique.mockImplementation(async ({ where }: { where: { phoneNumber?: string; id?: string } }) => {
    if (where.id) return users[where.id] ?? null;
    return Object.values(users).find((u) => u.phoneNumber === where.phoneNumber) ?? null;
  });
  userUpdateMany.mockImplementation(
    async ({ where, data }: { where: { id: string; phoneNumber: null }; data: { phoneNumber: string } }) => {
      const u = users[where.id];
      if (!u || u.phoneNumber !== null) return { count: 0 };
      u.phoneNumber = data.phoneNumber;
      return { count: 1 };
    },
  );
  userCreate.mockImplementation(async ({ data }: { data: { name: string | null; phoneNumber: string } }) => {
    const u = { id: `u-new-${data.phoneNumber}`, name: data.name, phoneNumber: data.phoneNumber };
    users[u.id] = u;
    return { id: u.id, name: u.name };
  });
  membershipFindUnique.mockResolvedValue(null);
  membershipCreate.mockResolvedValue({});
  orgUpdate.mockResolvedValue({});
});

describe("importParticipants: a saved phone number is never replaced", () => {
  it("a name match that already holds a different number keeps it; the participant becomes a new user", async () => {
    users["u-ali"] = { id: "u-ali", name: "Ali Yilmaz", phoneNumber: SAVED };
    findExisting.mockResolvedValue({ userId: "u-ali", name: "Ali Yilmaz" });

    const res = await importParticipants(ORG, [{ phone: NEW.slice(1), pushname: "Ali K" }]);

    expect(users["u-ali"].phoneNumber).toBe(SAVED);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(userCreate.mock.calls[0][0].data.phoneNumber).toBe(NEW);
    // The membership written is the NEW user's, not Ali's.
    expect(membershipCreate.mock.calls[0][0].data.userId).toBe(`u-new-${NEW}`);
    expect(res.added).toBe(1);
  });

  it("a phoneless name match gets the number filled in", async () => {
    users["u-ghost"] = { id: "u-ghost", name: "Raihan", phoneNumber: null };
    findExisting.mockResolvedValue({ userId: "u-ghost", name: "Raihan" });

    const res = await importParticipants(ORG, [{ phone: NEW.slice(1), pushname: "Raihan" }]);

    expect(users["u-ghost"].phoneNumber).toBe(NEW);
    expect(userCreate).not.toHaveBeenCalled();
    expect(membershipCreate.mock.calls[0][0].data.userId).toBe("u-ghost");
    expect(res.alreadyKnown).toBe(1);
  });

  it("the fill is conditional: a number saved in the meantime is not overwritten", async () => {
    // Read as phoneless, but a sign-in saves a number before the write lands.
    users["u-ghost"] = { id: "u-ghost", name: "Raihan", phoneNumber: null };
    findExisting.mockImplementation(async () => {
      const r = { userId: "u-ghost", name: "Raihan" };
      return r;
    });
    userFindUnique.mockImplementation(async ({ where }: { where: { phoneNumber?: string; id?: string } }) => {
      if (where.id) {
        const snap = { ...users[where.id] };
        users[where.id].phoneNumber = SAVED; // the concurrent sign-in
        return snap;
      }
      return Object.values(users).find((u) => u.phoneNumber === where.phoneNumber) ?? null;
    });

    await importParticipants(ORG, [{ phone: NEW.slice(1), pushname: "Raihan" }]);

    expect(users["u-ghost"].phoneNumber).toBe(SAVED);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userCreate.mock.calls[0][0].data.phoneNumber).toBe(NEW);
  });

  it("a participant already known by phone is used as is, with no phone write", async () => {
    users["u-ali"] = { id: "u-ali", name: "Ali", phoneNumber: SAVED };

    await importParticipants(ORG, [{ phone: SAVED.slice(1), pushname: "Someone Else" }]);

    expect(findExisting).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(users["u-ali"].phoneNumber).toBe(SAVED);
  });
});
