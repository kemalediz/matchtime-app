/**
 * U1, the admin unpaid list (MDs/friday-group-features-plan-2026-09-30.md,
 * 2.12), decided by Kemal 2026-10-01:
 *
 *   - clubs whose admin channel is "one-person" or "admin-group" only; a
 *     club on "each-admin" (Sutton FC and every club that existed before
 *     the admin channel) gets nothing new;
 *   - 10:00 London two days after a COMPLETED match, payment tracking on,
 *     at least one unpaid CONFIRMED player;
 *   - once, claimed by `<matchId>:unpaid-list`;
 *   - the group tail's unpaid rule (holder out, credits off, no-signal);
 *   - through `sendAdminNotice`, the admin channel's one door.
 *
 * Prisma and the admin channel are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    org: null as Record<string, unknown> | null,
    matches: [] as Array<Record<string, unknown>>,
    matchWhere: null as unknown,
    claimed: new Set<string>(),
    claimsDeleted: [] as string[],
    notices: [] as Array<{ orgId: string; text: string }>,
    noticeFails: false,
  },
}));

vi.mock("../db", () => ({
  db: {
    organisation: { findUnique: async () => h.state.org },
    match: {
      findMany: async (args: { where: unknown }) => {
        h.state.matchWhere = args.where;
        return h.state.matches;
      },
    },
    sentNotification: {
      create: async ({ data }: { data: { key: string } }) => {
        if (h.state.claimed.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        h.state.claimed.add(data.key);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        h.state.claimed.delete(where.key);
        h.state.claimsDeleted.push(where.key);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (a: { orgId: string; text: string }) => {
    if (h.state.noticeFails) throw new Error("db down");
    h.state.notices.push(a);
    return { channel: "dm", queued: 1 };
  },
}));

const { sendDueUnpaidLists, unpaidListKey } = await import("../unpaid-list");
const { buildUnpaidListAdminNotice } = await import("../dm-copy");
const { dayTimeLabel } = await import("../i18n/dates");
const { t } = await import("../i18n/t");

/** Fri 15 Jan 2027 20:30 GMT; the list is due Sun 17 Jan 10:00 GMT. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
const SUN_1005 = new Date("2027-01-17T10:05:00.000Z");
const SUN_0955 = new Date("2027-01-17T09:55:00.000Z");
const PAID = new Date("2027-01-15T22:00:00.000Z");

function att(userId: string, name: string | null, paid: boolean, position: number) {
  return { userId, position, paidAt: paid ? PAID : null, user: { name } };
}

function completedMatch(over: Record<string, unknown> = {}) {
  return {
    id: "m-fri",
    date: KICKOFF,
    status: "COMPLETED",
    postMatchEndFlow: true,
    activity: { name: "Friday 9-a-side" },
    attendances: [
      att("holder", "Hamzah", false, 1),
      att("u2", "Raihan", true, 2),
      att("u3", "Wasim", false, 3),
      att("u4", "Ali", true, 4),
      att("u5", null, false, 5),
    ],
    paymentCredits: [] as Array<{ count: number }>,
    ...over,
  };
}

beforeEach(() => {
  h.state.org = {
    id: "org-fnf",
    language: "en",
    approvalStatus: "approved",
    dormantAt: null,
    adminChannelMode: "one-person",
    paymentTrackingEnabled: true,
    paymentHolderId: "holder",
  };
  h.state.matches = [completedMatch()];
  h.state.matchWhere = null;
  h.state.claimed = new Set();
  h.state.claimsDeleted = [];
  h.state.notices = [];
  h.state.noticeFails = false;
});

describe("the admin unpaid list (U1)", () => {
  it("10:05 two days after: one notice naming the unpaid, holder left out, through the admin channel", async () => {
    const res = await sendDueUnpaidLists("org-fnf", SUN_1005);
    expect(res).toEqual({ sent: 1 });
    expect(h.state.notices).toHaveLength(1);
    expect(h.state.notices[0].orgId).toBe("org-fnf");
    expect(h.state.notices[0].text).toBe(
      "💷 Unpaid for *Friday 9-a-side* (Fri 15 Jan at 20:30): Wasim, (unnamed). 2 of 4 paid.",
    );
    expect(h.state.claimed.has(unpaidListKey("m-fri"))).toBe(true);
    expect(unpaidListKey("m-fri")).toBe("m-fri:unpaid-list");
  });

  it("only COMPLETED, post-match-flow matches are loaded", async () => {
    await sendDueUnpaidLists("org-fnf", SUN_1005);
    expect(h.state.matchWhere).toMatchObject({
      activity: { orgId: "org-fnf" },
      status: "COMPLETED",
      isHistorical: false,
      postMatchEndFlow: true,
    });
  });

  it("not before 10:00", async () => {
    expect(await sendDueUnpaidLists("org-fnf", SUN_0955)).toEqual({ sent: 0 });
    expect(h.state.notices).toEqual([]);
  });

  it("once: a later poll finds the claim and sends nothing", async () => {
    await sendDueUnpaidLists("org-fnf", SUN_1005);
    await sendDueUnpaidLists("org-fnf", new Date(SUN_1005.getTime() + 10 * 60_000));
    expect(h.state.notices).toHaveLength(1);
  });

  it("an admin group club gets it too", async () => {
    h.state.org = { ...h.state.org, adminChannelMode: "admin-group" };
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 1 });
  });

  it("a club on each-admin (Sutton FC) gets nothing new", async () => {
    h.state.org = { ...h.state.org, adminChannelMode: "each-admin" };
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
    expect(h.state.notices).toEqual([]);
    expect(h.state.claimed.size).toBe(0);
  });

  it("payment tracking off: nothing", async () => {
    h.state.org = { ...h.state.org, paymentTrackingEnabled: false };
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
  });

  it("a club that is not operational (dormant) gets nothing", async () => {
    h.state.org = { ...h.state.org, dormantAt: new Date("2027-01-01T00:00:00.000Z") };
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
  });

  it("everyone paid: nothing, and no claim", async () => {
    h.state.matches = [
      completedMatch({ attendances: [att("u2", "Raihan", true, 1), att("u3", "Wasim", true, 2)] }),
    ];
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
    expect(h.state.claimed.size).toBe(0);
  });

  it("no signal (nobody has paid, no credit): nothing", async () => {
    h.state.matches = [
      completedMatch({ attendances: [att("u2", "Raihan", false, 1), att("u3", "Wasim", false, 2)] }),
    ];
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
  });

  it("credits come off the count, exactly as the group tail", async () => {
    h.state.matches = [completedMatch({ paymentCredits: [{ count: 1 }] })];
    await sendDueUnpaidLists("org-fnf", SUN_1005);
    expect(h.state.notices[0].text).toBe(
      "💷 Unpaid for *Friday 9-a-side* (Fri 15 Jan at 20:30): Wasim, (unnamed). 3 of 4 paid.",
    );
  });

  it("Turkish club: the Turkish notice", async () => {
    h.state.org = { ...h.state.org, language: "tr" };
    await sendDueUnpaidLists("org-fnf", SUN_1005);
    expect(h.state.notices[0].text).toBe(
      buildUnpaidListAdminNotice({
        activityName: "Friday 9-a-side",
        whenLabel: dayTimeLabel("tr", KICKOFF),
        names: ["Wasim", t("tr").unnamed],
        paid: 2,
        n: 4,
        lang: "tr",
      }),
    );
    expect(h.state.notices[0].text).toContain("için ödemeyenler: Wasim");
    expect(h.state.notices[0].text).toContain("4 kişiden 2 kişi ödedi.");
  });

  it("a failed send releases the claim so the next poll retries", async () => {
    h.state.noticeFails = true;
    expect(await sendDueUnpaidLists("org-fnf", SUN_1005)).toEqual({ sent: 0 });
    expect(h.state.claimsDeleted).toEqual(["m-fri:unpaid-list"]);
    expect(h.state.claimed.size).toBe(0);
  });
});
