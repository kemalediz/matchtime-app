/**
 * A member imported with NO name gets the WhatsApp name the Pi knows for
 * him at the next participant sweep (2026-11-03, Vets MNF).
 *
 * Vets MNF: 20 of 27 members were imported from the WhatsApp member list
 * with `User.name` NULL, because the Pi had not yet heard their WhatsApp
 * names. The Pi learns names from every message and from contact sync
 * (`whatsapp-bot/src/baileys/contacts.ts`) and sends them with each sweep
 * (`whatsapp-bot/src/index.ts`, `pushname`), but the sweep only named NEW
 * users, so a nameless member stayed nameless and the month's list could
 * match nobody. Now a nameless member known by phone takes the name, only
 * while his name is still empty (a name anybody set is never replaced),
 * and only a real name (never a phone number shown as a name).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdateMany = vi.fn();
const userCreate = vi.fn();
const membershipFindUnique = vi.fn();
const membershipCreate = vi.fn();
const membershipUpdate = vi.fn();
const orgUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
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
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn(async () => null) }));
vi.mock("@/lib/placeholder-link", () => ({ linkJoinerToPlaceholder: vi.fn(async () => ({ kind: "none" })) }));

import { importParticipants } from "@/lib/participant-sync";

const ORG = "org-vets";
const PHONE = "+447700900321";

let users: Record<string, { id: string; name: string | null; phoneNumber: string | null }>;

beforeEach(() => {
  vi.clearAllMocks();
  users = {};
  userFindUnique.mockImplementation(async ({ where }: { where: { phoneNumber?: string; id?: string } }) => {
    if (where.id) return users[where.id] ?? null;
    return Object.values(users).find((u) => u.phoneNumber === where.phoneNumber) ?? null;
  });
  userUpdateMany.mockImplementation(async ({ where, data }: { where: { id: string; name?: null }; data: { name?: string } }) => {
    const u = users[where.id];
    if (!u || !("name" in where) || u.name !== null || !data.name) return { count: 0 };
    u.name = data.name;
    return { count: 1 };
  });
  userCreate.mockImplementation(async ({ data }: { data: { name: string | null; phoneNumber: string } }) => {
    const u = { id: `u-new-${data.phoneNumber}`, name: data.name, phoneNumber: data.phoneNumber };
    users[u.id] = u;
    return { id: u.id, name: u.name };
  });
  membershipFindUnique.mockResolvedValue({ id: "mem-1", leftAt: null });
  membershipUpdate.mockResolvedValue({});
  membershipCreate.mockResolvedValue({});
  orgUpdate.mockResolvedValue({});
});

describe("importParticipants: a nameless member takes the WhatsApp name the Pi knows", () => {
  it("names a member known by phone whose name is empty", async () => {
    users["u-nabz"] = { id: "u-nabz", name: null, phoneNumber: PHONE };
    await importParticipants(ORG, [{ phone: PHONE.slice(1), pushname: "  Nabz " }]);
    expect(users["u-nabz"].name).toBe("Nabz");
    // Conditional on the name still being empty: a name set in between stays.
    expect(userUpdateMany).toHaveBeenCalledWith({ where: { id: "u-nabz", name: null }, data: { name: "Nabz" } });
  });

  it("never replaces a name the member already has", async () => {
    users["u-shane"] = { id: "u-shane", name: "Shane Walton", phoneNumber: PHONE };
    await importParticipants(ORG, [{ phone: PHONE.slice(1), pushname: "Shaney" }]);
    expect(users["u-shane"].name).toBe("Shane Walton");
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("a phone number shown as a name is not a name, for a known member or a new one", async () => {
    users["u-anon"] = { id: "u-anon", name: null, phoneNumber: PHONE };
    await importParticipants(ORG, [
      { phone: PHONE.slice(1), pushname: "+44 7700 900321" },
      { phone: "447700900999", pushname: "447700900999" },
    ]);
    expect(users["u-anon"].name).toBeNull();
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(userCreate.mock.calls[0][0].data.name).toBeNull();
  });

  it("no WhatsApp name: nothing is written", async () => {
    users["u-anon"] = { id: "u-anon", name: null, phoneNumber: PHONE };
    await importParticipants(ORG, [{ phone: PHONE.slice(1) }]);
    expect(users["u-anon"].name).toBeNull();
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("a failed name write never stops the sweep", async () => {
    users["u-anon"] = { id: "u-anon", name: null, phoneNumber: PHONE };
    userUpdateMany.mockRejectedValueOnce(new Error("db down"));
    const res = await importParticipants(ORG, [{ phone: PHONE.slice(1), pushname: "Steff" }, { phone: "447700900555", pushname: "Dan" }]);
    expect(res.total).toBe(2);
    expect(userCreate.mock.calls[0][0].data.name).toBe("Dan");
  });
});
