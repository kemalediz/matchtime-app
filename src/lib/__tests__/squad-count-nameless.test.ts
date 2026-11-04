/**
 * A BENCHER WITH NO NAME IN THE HQ COUNT LINE (2026-11-04).
 *
 * The sandbox club replay: an organiser pasted the list in HQ and the
 * reply said
 *
 *   ... 2 on the bench (? and Bilal) ... (for example ?)
 *
 * for a member imported with no name: `loadSquadCount` labelled him
 * `a.user.name ?? "?"`, and that label went into `buildSquadChangeReply`
 * (the bench clause and the pick hint). Every count line it feeds is read
 * by organisers only (the HQ "Done" and pasted-list replies, the late
 * drop-out notice), so like the pick list (`organiser-names.ts`, #520) he
 * is the best name MatchTime holds, else his phone, else the club's word
 * for "unnamed". A partner guest's phone is never shown.
 *
 * Drives the real `loadSquadCount` with the db mocked, then the real
 * reply builder. No model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type UserRow = { id: string; name: string | null; phoneNumber: string | null; email: string | null };

const state = vi.hoisted(() => ({
  users: [] as Array<{ id: string; name: string | null; phoneNumber: string | null; email: string | null }>,
  guests: [] as Array<{ userId: string; guestFromOrgId: string | null; guestMatchId: string | null }>,
}));

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn(async () => []) },
  analyzedMessage: { findMany: vi.fn(async () => []) },
  organisation: { findMany: vi.fn(async () => [{ id: "home", name: "Sutton FC" }]) },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadSquadCount } from "../squad-count";
import { buildSquadChangeReply } from "../admin-group-squad-rules";

function given(bench: UserRow[], lang = "en") {
  const squad: UserRow[] = [{ id: "u-hamzah", name: "Hamzah Ali", phoneNumber: "+447700900001", email: null }];
  state.users = [...squad, ...bench];
  dbMock.match.findUnique.mockResolvedValue({
    maxPlayers: 6,
    activity: { orgId: "club", org: { benchPickMode: "organiser", language: lang } },
    attendances: [
      ...squad.map((u) => ({ userId: u.id, status: "CONFIRMED", user: { name: u.name } })),
      ...bench.map((u) => ({ userId: u.id, status: "BENCH", user: { name: u.name } })),
    ],
  });
}

async function replyAfterPaste(lang = "en"): Promise<string> {
  const squad = await loadSquadCount("m1", lang);
  return buildSquadChangeReply({
    lang,
    changes: [{ kind: "in", name: "Hamzah Ali" }],
    failed: [],
    confirmed: squad.confirmed,
    maxPlayers: squad.maxPlayers ?? squad.confirmed,
    bench: squad.bench,
    benchPickMode: squad.benchPickMode,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.guests = [];
  dbMock.user.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    state.users.filter((u) => args.where.id.in.includes(u.id)),
  );
  // Nobody has left; the guest rows are the test's own.
  dbMock.membership.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.leftAt) return [];
    const ids = (args.where.userId as { in: string[] } | undefined)?.in ?? [];
    return state.guests.filter((g) => ids.includes(g.userId));
  });
});

describe("the HQ count line's label for a bencher with no name", () => {
  it("is his phone when MatchTime has one, never '(? and Bilal)'", async () => {
    given([
      { id: "u-anon", name: null, phoneNumber: "+447700900123", email: null },
      { id: "u-bilal", name: "Bilal", phoneNumber: "+447700900002", email: null },
    ]);
    const text = await replyAfterPaste();
    expect(text).not.toContain("?");
    expect(text).toContain("+44 7700 900123 and Bilal");
  });

  it("is the phone a WhatsApp-imported placeholder email carries", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: null, email: "wa-447700900456@placeholder.matchtime" }]);
    const squad = await loadSquadCount("m1", "en");
    expect(squad.bench).toEqual(["+44 7700 900456"]);
  });

  it("is the club's word for unnamed when there is no phone either, in English and Turkish", async () => {
    given([
      { id: "u-anon", name: null, phoneNumber: null, email: null },
      { id: "u-bilal", name: "Bilal", phoneNumber: null, email: null },
    ]);
    const en = await replyAfterPaste("en");
    expect(en).toContain("(unnamed) and Bilal");
    expect(en).not.toContain("?");
    given([{ id: "u-anon", name: null, phoneNumber: null, email: null }], "tr");
    const tr = await loadSquadCount("m1", "tr");
    expect(tr.bench).toEqual(["(isimsiz)"]);
  });

  it("falls back to the club's language when the caller gives none", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: null, email: null }], "tr");
    expect((await loadSquadCount("m1")).bench).toEqual(["(isimsiz)"]);
  });

  it("uses the name MatchTime knows him by (an alias here) before any phone", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: "+447700900123", email: null }]);
    dbMock.userAlias.findMany.mockResolvedValueOnce([{ userId: "u-anon", orgId: "club", alias: "big sam" }] as never);
    expect((await loadSquadCount("m1", "en")).bench).toEqual(["Big Sam"]);
  });

  it("never shows a partner guest's phone", async () => {
    given([{ id: "u-guest", name: null, phoneNumber: "+447700900777", email: null }]);
    state.guests = [{ userId: "u-guest", guestFromOrgId: "home", guestMatchId: "m1" }];
    const [label] = (await loadSquadCount("m1", "en")).bench;
    expect(label).not.toContain("900777");
    expect(label).not.toContain("?");
  });

  it("keeps the named bench in bench order and leaves out anyone who left", async () => {
    given([
      { id: "u-bilal", name: "Bilal", phoneNumber: null, email: null },
      { id: "u-gone", name: "Gone Guy", phoneNumber: null, email: null },
      { id: "u-ben", name: "Ben", phoneNumber: null, email: null },
    ]);
    dbMock.membership.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.leftAt ? [{ userId: "u-gone" }] : [],
    );
    const squad = await loadSquadCount("m1", "en");
    expect(squad).toMatchObject({ confirmed: 1, maxPlayers: 6, bench: ["Bilal", "Ben"], benchPickMode: "organiser" });
  });
});
