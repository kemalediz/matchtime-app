/**
 * /welcome and /profile never wipe a player's own number (FNF 2026-10-18).
 *
 * Feroz, created by the bot from FNF's group with his number, opened
 * /welcome, left the optional phone field blank, and `completeOnboarding`
 * wrote `phoneNumber: null`. These pin the action-level rule: blank keeps,
 * a stored number is the sign-in number and cannot be changed here, and a
 * new number is only added when nobody else holds it.
 *
 * auth / db / next are mocked with a small in-memory store. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type U = { id: string; name: string | null; phoneNumber: string | null; onboarded: boolean };
const users = new Map<string, U>();
const authMock = vi.fn();
const userUpdate = vi.fn();
const redirectMock = vi.fn();
let raceOnUpdate = false;

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn() }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirectMock(p) }));
vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: async ({ where }: { where: { id?: string; phoneNumber?: string } }) => {
        if (where.id) return users.get(where.id) ?? null;
        return [...users.values()].find((u) => u.phoneNumber === where.phoneNumber) ?? null;
      },
      update: async (args: { where: { id: string }; data: Partial<U> }) => {
        userUpdate(args);
        if (raceOnUpdate) throw Object.assign(new Error("unique"), { code: "P2002" });
        const u = users.get(args.where.id)!;
        Object.assign(u, args.data);
        return u;
      },
    },
  },
}));

import { completeOnboarding, updateProfile } from "@/app/actions/players";

const ME = "feroz";
const FEROZ_PHONE = "+447700900321";

beforeEach(() => {
  vi.clearAllMocks();
  users.clear();
  raceOnUpdate = false;
  authMock.mockResolvedValue({ user: { id: ME } });
  users.set(ME, { id: ME, name: "Feroz", phoneNumber: FEROZ_PHONE, onboarded: false });
  users.set("other", { id: "other", name: "Other", phoneNumber: "+447700900999", onboarded: true });
});

describe.each([
  ["completeOnboarding", completeOnboarding],
  ["updateProfile", updateProfile],
] as const)("%s", (label, action) => {
  it("a blank phone keeps the stored number (the Feroz case)", async () => {
    await action({ name: "Feroz Khan" });
    await action({ name: "Feroz Khan", phoneNumber: "" });
    await action({ name: "Feroz Khan", phoneNumber: "   " });
    expect(users.get(ME)!.phoneNumber).toBe(FEROZ_PHONE);
    for (const call of userUpdate.mock.calls) expect(call[0].data).not.toHaveProperty("phoneNumber");
    expect(users.get(ME)!.name).toBe("Feroz Khan");
    if (label === "completeOnboarding") {
      expect(users.get(ME)!.onboarded).toBe(true);
      expect(redirectMock).toHaveBeenCalledWith("/");
    }
  });

  it("the same number in another spelling is accepted and writes no phone", async () => {
    const res = await action({ name: "Feroz", phoneNumber: "07700 900321" });
    expect(res).not.toMatchObject({ ok: false });
    expect(userUpdate.mock.calls[0][0].data).not.toHaveProperty("phoneNumber");
  });

  it("a different number when one is stored is refused: it is the sign-in number", async () => {
    const res = await action({ name: "Feroz", phoneNumber: "+447700900555" });
    expect(res).toEqual({ ok: false, reason: "locked" });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(users.get(ME)!.phoneNumber).toBe(FEROZ_PHONE);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("no stored number: a free valid number is added, normalised", async () => {
    users.get(ME)!.phoneNumber = null;
    await action({ name: "Feroz", phoneNumber: "07700 900555" });
    expect(users.get(ME)!.phoneNumber).toBe("+447700900555");
  });

  it("no stored number: a number somebody else holds is refused, naming nobody", async () => {
    users.get(ME)!.phoneNumber = null;
    const res = await action({ name: "Feroz", phoneNumber: "+447700900999" });
    expect(res).toEqual({ ok: false, reason: "taken" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("no stored number: a race on the unique index is refused as taken", async () => {
    users.get(ME)!.phoneNumber = null;
    raceOnUpdate = true;
    const res = await action({ name: "Feroz", phoneNumber: "+447700900556" });
    expect(res).toEqual({ ok: false, reason: "taken" });
  });

  it("no stored number: an invalid number is refused", async () => {
    users.get(ME)!.phoneNumber = null;
    const res = await action({ name: "Feroz", phoneNumber: "12345" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
