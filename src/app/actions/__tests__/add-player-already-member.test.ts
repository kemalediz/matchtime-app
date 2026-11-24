/**
 * THE PLAYERS PAGE NEVER SAYS "ADDED" WHEN NOTHING WAS ADDED (FNF HQ,
 * Mon 23 Nov 2026).
 *
 * HM typed a name on the players page's Add form; the name resolved to a
 * player already in the club, nothing was written, and the page said
 * "Added existing player to this group". He could not tell that MatchTime
 * had taken the name for somebody already on the list.
 *
 * When the typed name is a member who is already active here, the add
 * now refuses in the club's language and names who it found, so the admin
 * can use a fuller name or the player's number.
 *
 * auth / db / org / next-cache are mocked. No live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n/t";

const authMock = vi.fn();
const membershipFindUnique = vi.fn();
const membershipCreate = vi.fn(async (..._a: unknown[]) => ({}));
const membershipUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const userCreate = vi.fn(async (..._a: unknown[]) => ({ id: "new-user" }));
let lang: "en" | "tr" = "en";

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/player-account-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/player-account-guard")>()),
  playerEditContext: vi.fn(async () => ({ s: t(lang), refusal: null })),
  isClubOwnedUser: vi.fn(async () => true),
}));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn(async () => null) }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      create: (...a: unknown[]) => membershipCreate(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
    },
    user: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), create: (...a: unknown[]) => userCreate(...a) },
  },
}));

import { createPlayer } from "@/app/actions/players";
import { findExistingOrgMember } from "@/lib/resolve-player";

beforeEach(() => {
  vi.clearAllMocks();
  lang = "en";
  authMock.mockResolvedValue({ user: { id: "admin1" } });
});

describe("a typed name that is already an active member", () => {
  it("refuses and names who it found, instead of a success that added nothing", async () => {
    vi.mocked(findExistingOrgMember).mockResolvedValueOnce({ userId: "u-umar", name: "Umar" });
    membershipFindUnique.mockResolvedValue({ id: "mem1", leftAt: null });
    const r = await createPlayer("fnf", "Umar");
    expect(r).toEqual({ ok: false, error: t("en").pg_err_already_player({ name: "Umar" }) });
    expect(r.ok === false && r.error).toContain("Umar");
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(membershipUpdate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("in the club's language", async () => {
    lang = "tr";
    vi.mocked(findExistingOrgMember).mockResolvedValueOnce({ userId: "u-umar", name: "Umar" });
    membershipFindUnique.mockResolvedValue({ id: "mem1", leftAt: null });
    const r = await createPlayer("fnf", "Umar");
    expect(r).toEqual({ ok: false, error: t("tr").pg_err_already_player({ name: "Umar" }) });
    expect(t("tr").pg_err_already_player({ name: "Umar" })).not.toBe(t("en").pg_err_already_player({ name: "Umar" }));
  });
});

describe("unchanged", () => {
  it("no match: a new player is created", async () => {
    const r = await createPlayer("fnf", "Umar Noor");
    expect(r).toMatchObject({ ok: true, created: true });
    expect((userCreate.mock.calls[0][0] as { data: { name: string } }).data.name).toBe("Umar Noor");
  });

  it("a former member by name is welcomed back", async () => {
    vi.mocked(findExistingOrgMember).mockResolvedValueOnce({ userId: "u-umar", name: "Umar" });
    membershipFindUnique.mockResolvedValue({ id: "mem1", leftAt: new Date() });
    const r = await createPlayer("fnf", "Umar");
    expect(r).toMatchObject({ ok: true, rejoined: true });
  });
});
