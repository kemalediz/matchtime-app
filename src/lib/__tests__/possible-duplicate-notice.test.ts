/**
 * A POSSIBLE DUPLICATE IS TOLD TO THE CLUB'S ADMINS, ONCE (review of #574,
 * round 3, B4).
 *
 * The participant sweep makes a new member for every number MatchTime has
 * not seen; it never gives that number to a phoneless placeholder by a
 * match of names. When who-is-who reads the newcomer's WhatsApp name as
 * (or possibly as) a phoneless provisional member, the admins are told
 * once, through the club's admin channel, so they can merge the two.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const membershipFindMany = vi.fn();
const aliasFindMany = vi.fn();
const orgFindUnique = vi.fn();
const sentFindUnique = vi.fn();
const sentCreate = vi.fn();
const sentDeleteMany = vi.fn();
const sendAdminNotice = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    userAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    sentNotification: {
      findUnique: (...a: unknown[]) => sentFindUnique(...a),
      create: (...a: unknown[]) => sentCreate(...a),
      deleteMany: (...a: unknown[]) => sentDeleteMany(...a),
    },
  },
}));
vi.mock("@/lib/admin-channel", () => ({ sendAdminNotice: (...a: unknown[]) => sendAdminNotice(...a) }));
vi.mock("@/lib/ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn() }));

import { notifyPossibleDuplicates } from "@/lib/possible-duplicate-notice";
import type { PersonPicker, WhoRequest, PersonPick } from "@/lib/pipeline/who-is-who";

const ORG = "org-vets";
let claimed: Set<string>;

function picker(answer: (name: string) => PersonPick): { fn: PersonPicker; calls: WhoRequest[] } {
  const calls: WhoRequest[] = [];
  const fn: PersonPicker = async (req) => {
    calls.push(req);
    const picks = new Map<string, Map<string, PersonPick>>();
    for (const m of req.messages) picks.set(m.id, new Map(m.refs.map((r) => [r, answer(r)])));
    return { picks, usage: null, degradations: [] };
  };
  return { fn, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimed = new Set();
  membershipFindMany.mockResolvedValue([{ user: { id: "u-hamzah", name: "Hamzah" } }]);
  aliasFindMany.mockResolvedValue([]);
  orgFindUnique.mockResolvedValue({ language: "en", whatsappBotEnabled: true });
  sentFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (claimed.has(where.key) ? { id: "x" } : null));
  sentCreate.mockImplementation(async ({ data }: { data: { key: string } }) => {
    if (claimed.has(data.key)) throw new Error("unique");
    claimed.add(data.key);
    return {};
  });
  sentDeleteMany.mockResolvedValue({ count: 1 });
  sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
});

describe("notifyPossibleDuplicates", () => {
  it("a newcomer who-is-who places on a phoneless placeholder: the admins are told, with a link to the players page", async () => {
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    const n = await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah Ali" }], { identify: p.fn });

    expect(n).toBe(1);
    // Only the phoneless provisional members are asked about.
    const where = membershipFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: ORG, leftAt: null, provisionallyAddedAt: { not: null }, user: { phoneNumber: null } });
    // The newcomer's name goes as a WhatsApp name.
    expect(p.calls[0].messages[0]).toMatchObject({ refs: ["Hamzah Ali"], waNames: true });
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
    const req = sendAdminNotice.mock.calls[0][0];
    expect(req).toMatchObject({ orgId: ORG, nextPath: "/admin/players" });
    const text = req.text("https://x/l", "dm");
    expect(text).toContain("Hamzah Ali");
    expect(text).toContain("Hamzah");
    expect(text).toContain("https://x/l");
  });

  it("an ambiguous pick is a possible duplicate too (each candidate)", async () => {
    membershipFindMany.mockResolvedValue([
      { user: { id: "u-mo1", name: "Mo" } },
      { user: { id: "u-mo2", name: "Moe" } },
    ]);
    const p = picker(() => ({ kind: "ambiguous", userIds: ["u-mo1", "u-mo2"] }));
    const n = await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Mo K" }], { identify: p.fn });
    expect(n).toBe(2);
    expect(sendAdminNotice).toHaveBeenCalledTimes(2);
  });

  it("none: nobody is told", async () => {
    const p = picker(() => ({ kind: "none" }));
    expect(await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "David" }], { identify: p.fn })).toBe(0);
    expect(sendAdminNotice).not.toHaveBeenCalled();
    expect(sentCreate).not.toHaveBeenCalled();
  });

  it("ONCE: the same pair seen by the next sweep is not told again", async () => {
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah Ali" }], { identify: p.fn });
    await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah Ali" }], { identify: p.fn });
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
  });

  it("no placeholders, no newcomer with a name: no model call at all", async () => {
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: null }], { identify: p.fn });
    membershipFindMany.mockResolvedValue([]);
    await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah" }], { identify: p.fn });
    expect(p.calls).toHaveLength(0);
  });

  it("a muted club is not told (a queued notice would go out on unmute, long stale)", async () => {
    orgFindUnique.mockResolvedValue({ language: "en", whatsappBotEnabled: false });
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    expect(await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah" }], { identify: p.fn })).toBe(0);
    expect(p.calls).toHaveLength(0);
  });

  it("a failed queue releases the claim so the next sweep tries again", async () => {
    sendAdminNotice.mockRejectedValueOnce(new Error("db down"));
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    expect(await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah" }], { identify: p.fn })).toBe(0);
    expect(sentDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("Turkish club: the notice is in Turkish", async () => {
    orgFindUnique.mockResolvedValue({ language: "tr", whatsappBotEnabled: true });
    const p = picker(() => ({ kind: "member", userId: "u-hamzah" }));
    await notifyPossibleDuplicates(ORG, [{ userId: "u-new", name: "Hamzah Ali" }], { identify: p.fn });
    const text = sendAdminNotice.mock.calls[0][0].text("https://x/l", "dm");
    expect(text).toContain("birleştir");
  });
});
