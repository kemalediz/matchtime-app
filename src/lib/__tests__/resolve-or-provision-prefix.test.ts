/**
 * NAMING OR PROVISIONING A THIRD PARTY (rewritten 2026-11-09).
 *
 * No name is matched by spelling here any more (Kemal: "never use string
 * matching"). The names go to who-is-who in ONE call with every membership
 * of the club, current and former, and its aliases; the code only acts on
 * the pick: a member it is sure of is that member (a former one brought
 * back), nobody is a new provisional member, anything else is nobody at
 * all. First pinned for a multi-word ref (2026-10-30: "the lads" must not
 * become Theo) and for "David" read as Davide De Sousa (Vets MNF,
 * 2026-11-09).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonPick, PersonPicker, WhoRequest } from "../pipeline/who-is-who";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn(async () => [{ userId: "u-mo", alias: "habibi" }]) },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const sender = vi.hoisted(() => ({
  createProvisionalByName: vi.fn(async (_o: string, name: string) => ({ userId: `new:${name}`, name })),
  restoreMembership: vi.fn(),
}));
vi.mock("../resolve-sender", () => sender);

import { resolveOrProvisionByName, resolveOrProvisionNames } from "../resolve-or-provision-name";

const member = (id: string, name: string, leftAt: Date | null = null) => ({ id: `m-${id}`, userId: id, leftAt, user: { id, name } });

/** A picker that answers from a table, and records what it was shown. */
function picker(answers: Record<string, PersonPick>) {
  const seen: WhoRequest[] = [];
  const pick: PersonPicker = async (req) => {
    seen.push(req);
    return {
      picks: new Map(req.messages.map((m) => [m.id, new Map(m.refs.map((r) => [r, answers[r] ?? { kind: "unidentified", why: "not in the table" }]))])),
      usage: null,
      degradations: [],
    };
  };
  return { pick, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue([
    member("u-theo", "Theo Walcott"),
    member("u-davide", "Davide De Sousa"),
    member("u-mo", "Mohammed Ali"),
    member("u-old", "Oldham Jones", new Date("2026-01-01")),
  ]);
});

describe("the model's pick decides, code only acts on it", () => {
  it("'David' the model places on nobody is provisioned as a new person, never Davide", async () => {
    const { pick } = picker({ David: { kind: "none" } });
    const r = await resolveOrProvisionByName("org-1", "David", { identify: pick });
    expect(r?.userId).toBe("new:David");
    expect(sender.createProvisionalByName).toHaveBeenCalledWith("org-1", "David", null, { deliberate: false });
  });

  it("'Moham' the model is sure is Mohammed Ali is that member, not a new person", async () => {
    const { pick } = picker({ Moham: { kind: "member", userId: "u-mo" } });
    expect((await resolveOrProvisionByName("org-1", "Moham", { identify: pick }))?.userId).toBe("u-mo");
    expect(sender.createProvisionalByName).not.toHaveBeenCalled();
  });

  it("a former member the model recognises is brought back, not added twice", async () => {
    const { pick } = picker({ Oldham: { kind: "member", userId: "u-old" } });
    expect((await resolveOrProvisionByName("org-1", "Oldham", { identify: pick }))?.userId).toBe("u-old");
    expect(sender.restoreMembership).toHaveBeenCalledWith("m-u-old", "Oldham Jones");
  });

  it("several possible members: nobody registered and nobody provisioned", async () => {
    const { pick } = picker({ Mo: { kind: "ambiguous", userIds: ["u-mo", "u-theo"] } });
    expect(await resolveOrProvisionByName("org-1", "Mo", { identify: pick })).toBeNull();
    expect(sender.createProvisionalByName).not.toHaveBeenCalled();
  });

  it("a failed call: nobody registered and nobody provisioned", async () => {
    const { pick } = picker({});
    expect(await resolveOrProvisionByName("org-1", "Theo", { identify: pick })).toBeNull();
    expect(sender.createProvisionalByName).not.toHaveBeenCalled();
  });

  it("an admin's deliberate name only former members could be is a new player, as the preview promised", async () => {
    const { pick } = picker({ Old: { kind: "ambiguous", userIds: ["u-old"] } });
    expect((await resolveOrProvisionByName("org-1", "Old", { identify: pick, adminConfirmed: true }))?.userId).toBe("new:Old");
  });
});

describe("one call for a list, with the whole club shown", () => {
  it("every name in one call; former members marked; aliases shown", async () => {
    const { pick, seen } = picker({ Naim: { kind: "none" }, habibi: { kind: "member", userId: "u-mo" } });
    const out = await resolveOrProvisionNames("org-1", ["Naim", "habibi", "Naim"], { identify: pick, context: "1. Naim\n2. habibi" });
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0].refs).toEqual(["Naim", "habibi"]);
    expect(seen[0].messages[0].body).toBe("1. Naim\n2. habibi");
    expect(seen[0].roster.find((m) => m.userId === "u-old")?.former).toBe(true);
    expect(seen[0].roster.find((m) => m.userId === "u-mo")?.aliases).toEqual(["habibi"]);
    expect(out.get("Naim")?.userId).toBe("new:Naim");
    expect(out.get("habibi")?.userId).toBe("u-mo");
  });

  it("a name under two letters is nobody, and is not asked", async () => {
    const { pick, seen } = picker({});
    expect(await resolveOrProvisionByName("org-1", "A", { identify: pick })).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
