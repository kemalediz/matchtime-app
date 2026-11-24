/**
 * A TYPED SURNAME IS A DIFFERENT PERSON (FNF HQ, Mon 23 Nov 2026).
 *
 * HM (an FNF admin) tried to add a new player, "Umar Noor", from the
 * players page. FNF already had one "Umar" (a different man). The add
 * path's dedupe (`findExistingOrgMember`) reused a member on a unique
 * FIRST-WORD match, so "Umar Noor" came back as the existing "Umar", no
 * player was created, and the page said "Added existing player to this
 * group". He tried again: same answer.
 *
 * The first-word reuse stays for a single typed word ("Riley" for "Riley
 * Rater", "Ed" for "Ediz"): that is the admin being brief. A typed name
 * with a surname is deliberate, so it is reused only when it is that
 * member's own name (or an alias); otherwise it is somebody new.
 *
 * db is mocked. No live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { user: { id: string; name: string | null } };
let roster: Row[] = [];
const aliasFindUnique = vi.fn(async (..._a: unknown[]) => null as unknown);

vi.mock("@/lib/db", () => ({
  db: {
    userAlias: { findUnique: (...a: unknown[]) => aliasFindUnique(...a) },
    membership: { findMany: vi.fn(async () => roster), findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
  },
}));

import { findExistingOrgMember } from "@/lib/resolve-player";

const member = (id: string, name: string): Row => ({ user: { id, name } });

beforeEach(() => {
  vi.clearAllMocks();
  roster = [];
});

describe("an admin types a full name the club does not have", () => {
  it("FNF 23 Nov: 'Umar Noor' is not the club's only 'Umar'", async () => {
    roster = [member("u-umar", "Umar"), member("u-mo", "Mo")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toBeNull();
  });

  it("a different surname is a different person", async () => {
    roster = [member("u-umar", "Umar Nisar")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toBeNull();
  });

  it("a surname does not reuse a longer first name either", async () => {
    roster = [member("u-ed", "Ediz")];
    expect(await findExistingOrgMember("fnf", { name: "Ed Smith" })).toBeNull();
  });
});

describe("what is still reused", () => {
  it("the member's own full name, case and spacing aside", async () => {
    roster = [member("u-umar", "Umar Noor"), member("u-umar2", "Umar")];
    expect(await findExistingOrgMember("fnf", { name: "  umar   NOOR " })).toEqual({ userId: "u-umar", name: "Umar Noor" });
  });

  it("an alias the club set", async () => {
    roster = [member("u-umar", "Umar")];
    aliasFindUnique.mockResolvedValueOnce({ userId: "u-umar", user: { id: "u-umar", name: "Umar" } });
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toEqual({ userId: "u-umar", name: "Umar" });
  });

  it("a single typed word: the one member whose first name it is", async () => {
    roster = [member("u-riley", "Riley Rater"), member("u-pat", "Pat Player")];
    expect(await findExistingOrgMember("fnf", { name: "Riley" })).toEqual({ userId: "u-riley", name: "Riley Rater" });
  });

  it("a single typed word that starts a longer first name", async () => {
    roster = [member("u-ed", "Ediz")];
    expect(await findExistingOrgMember("fnf", { name: "Edi" })).toEqual({ userId: "u-ed", name: "Ediz" });
  });

  it("a single typed word two members share is nobody (unchanged)", async () => {
    roster = [member("o1", "Omar One"), member("o2", "Omar Two")];
    expect(await findExistingOrgMember("fnf", { name: "Omar" })).toBeNull();
  });
});

describe("the same person written a little differently (review of #631)", () => {
  it("a stored name with an emoji or a note in brackets", async () => {
    roster = [member("u-umar", "Umar Noor ⚽"), member("u-gk", "Sam Keeper (GK)")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toEqual({ userId: "u-umar", name: "Umar Noor ⚽" });
    expect(await findExistingOrgMember("fnf", { name: "Sam Keeper" })).toEqual({ userId: "u-gk", name: "Sam Keeper (GK)" });
  });

  it("a stored middle name or initial", async () => {
    roster = [member("u-umar", "Umar A Noor")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toEqual({ userId: "u-umar", name: "Umar A Noor" });
  });

  it("a typed middle name or a full stop", async () => {
    roster = [member("u-umar", "Umar Noor")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Ali Noor" })).toEqual({ userId: "u-umar", name: "Umar Noor" });
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor." })).toEqual({ userId: "u-umar", name: "Umar Noor" });
  });

  it("still never a one-word stored name for a typed full name (FNF)", async () => {
    roster = [member("u-umar", "Umar ⚽")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toBeNull();
  });

  it("two members who both fit is nobody", async () => {
    roster = [member("a", "Umar Noor ⚽"), member("b", "Umar A Noor")];
    expect(await findExistingOrgMember("fnf", { name: "Umar Noor" })).toBeNull();
  });
});

describe("add-to-match keeps the form's promise (review of #631)", () => {
  it("with firstWord off, one typed word is only an exact name", async () => {
    roster = [member("u-umar", "Umar Noor")];
    expect(await findExistingOrgMember("fnf", { name: "Umar" }, { firstWord: false })).toBeNull();
    expect(await findExistingOrgMember("fnf", { name: "umar noor" }, { firstWord: false })).toEqual({ userId: "u-umar", name: "Umar Noor" });
  });
});
