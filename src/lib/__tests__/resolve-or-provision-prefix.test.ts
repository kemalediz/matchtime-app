/**
 * A NEW PERSON IS NEVER LOOKED UP AGAIN (review of #574, finding 1).
 *
 * Every caller of `provisionNewPerson` is a name who-is-who already placed
 * on nobody, reading it in its message. This used to look the name up a
 * second time: by spelling ("David" became the member Davide De Sousa,
 * Vets MNF 2026-11-09), then by a second model call with NO message, which
 * could overrule the first ("Mo, Ali's cousin, is in" read as the member
 * Mohammed). Now the first answer stands: no membership is read and no
 * model is asked; "none" is a new person.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn(async () => [{ id: "m-mo", userId: "u-mo", leftAt: null, user: { id: "u-mo", name: "Mohammed Ali" } }]) },
  userAlias: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const sender = vi.hoisted(() => ({
  createProvisionalByName: vi.fn(async (_o: string, name: string) => ({ userId: `new:${name}`, name, phone: null })),
  restoreMembership: vi.fn(),
}));
vi.mock("../resolve-sender", () => sender);
const picker = vi.hoisted(() => ({ personPickerFor: vi.fn() }));
vi.mock("../pipeline/identify-batch", () => picker);

import { provisionNewPerson } from "../resolve-or-provision-name";

beforeEach(() => vi.clearAllMocks());

describe("provisionNewPerson", () => {
  it("'Mo, Ali's cousin' placed on nobody is a new person: never re-asked, never the member Mohammed", async () => {
    const r = await provisionNewPerson("org-1", "Mo", { adminConfirmed: true });
    expect(r?.userId).toBe("new:Mo");
    expect(sender.createProvisionalByName).toHaveBeenCalledWith("org-1", "Mo", null, { deliberate: true });
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
    expect(picker.personPickerFor).not.toHaveBeenCalled();
  });

  it("'David' (the Vets incident) is a new person, by the third party's rule", async () => {
    expect((await provisionNewPerson("org-1", "David"))?.userId).toBe("new:David");
    expect(sender.createProvisionalByName).toHaveBeenCalledWith("org-1", "David", null, { deliberate: false });
  });

  it("an empty or one-letter name is nobody", async () => {
    expect(await provisionNewPerson("org-1", " ")).toBeNull();
    expect(await provisionNewPerson("org-1", "A")).toBeNull();
    expect(sender.createProvisionalByName).not.toHaveBeenCalled();
  });
});
