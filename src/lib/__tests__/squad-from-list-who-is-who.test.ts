/**
 * A PLAYERS'-GROUP SQUAD LIST: WHO EACH NAME IS (review of #574, finding 3).
 *
 * One who-is-who call per list. Only "nobody in the club" is a new player.
 * A name it was not sure of ("Moham", probably Mohammed), or that two
 * members could be, is left unresolved and surfaced: a new player there
 * would be a duplicate of a member.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: {
    findMany: vi.fn(async () => [
      { id: "m-mo", userId: "u-mo", leftAt: null, user: { id: "u-mo", name: "Mohammed Iqbal" } },
      { id: "m-o1", userId: "u-o1", leftAt: null, user: { id: "u-o1", name: "Omar One" } },
      { id: "m-o2", userId: "u-o2", leftAt: null, user: { id: "u-o2", name: "Omar Two" } },
      { id: "m-old", userId: "u-old", leftAt: new Date("2026-01-01"), user: { id: "u-old", name: "Oldham Jones" } },
    ]),
    update: vi.fn(async () => ({})),
    create: vi.fn(async () => ({})),
  },
  userAlias: { findMany: vi.fn(async () => []) },
  user: { create: vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `new-${data.name}`, name: data.name })) },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { resolveOrProvisionSquadNames } from "../squad-from-list";
import type { PersonPick, PersonPicker, WhoRequest } from "../pipeline/who-is-who";

function picker(answers: Record<string, PersonPick>) {
  const seen: WhoRequest[] = [];
  const pick: PersonPicker = async (req) => {
    seen.push(req);
    return {
      picks: new Map(req.messages.map((m) => [m.id, new Map(m.refs.map((r) => [r, answers[r] ?? { kind: "unidentified" as const, why: "no answer" }]))])),
      usage: null,
      degradations: [],
    };
  };
  return { pick, seen };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveOrProvisionSquadNames", () => {
  it("one call for the list; member reused, former member brought back, nobody provisioned", async () => {
    const { pick, seen } = picker({
      Mohammed: { kind: "member", userId: "u-mo" },
      Oldham: { kind: "member", userId: "u-old" },
      Zak: { kind: "none" },
    });
    const out = await resolveOrProvisionSquadNames("org", ["Mohammed", "Oldham", "Zak"], { identify: pick });
    expect(seen).toHaveLength(1);
    expect(seen[0].roster.find((m) => m.userId === "u-old")?.former).toBe(true);
    expect(out.get("Mohammed")).toEqual({ userId: "u-mo", name: "Mohammed Iqbal", provisional: false });
    expect(out.get("Oldham")?.userId).toBe("u-old");
    expect(dbMock.membership.update).toHaveBeenCalledWith({ where: { id: "m-old" }, data: { leftAt: null } });
    expect(out.get("Zak")).toMatchObject({ userId: "new-Zak", provisional: true });
  });

  it("RED before the fix: a single-candidate ambiguity ('Moham', probably Mohammed) is unresolved, never a new player", async () => {
    const { pick } = picker({ Moham: { kind: "ambiguous", userIds: ["u-mo"] } });
    const out = await resolveOrProvisionSquadNames("org", ["Moham"], { identify: pick });
    expect(out.get("Moham")).toBeNull();
    expect(dbMock.user.create).not.toHaveBeenCalled();
  });

  it("two possible members ('Omar') is unresolved too, and so is a failed call", async () => {
    const { pick } = picker({ Omar: { kind: "ambiguous", userIds: ["u-o1", "u-o2"] } });
    const out = await resolveOrProvisionSquadNames("org", ["Omar", "Nobody Answered"], { identify: pick });
    expect(out.get("Omar")).toBeNull();
    expect(out.get("Nobody Answered")).toBeNull();
    expect(dbMock.user.create).not.toHaveBeenCalled();
  });
});
