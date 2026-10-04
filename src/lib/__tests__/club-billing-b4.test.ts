/**
 * CLUB FEE BILLING, slice B4: the hourly scheduler and its messages.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.1, 4.5, 6, 7.
 *
 * The database is a small in-memory world of clubs; `setBillingState` is
 * replaced by one that applies the REAL pure `nextBillingState` (the one
 * writer and its row lock are covered by club-billing.test.ts and the e2e
 * cron spec). `queueBillingDm` is replaced by one that keeps the REAL
 * claim rules (one row per club, kind and cycle; a pending row may be
 * taken). Stripe is the fake adapter. No network, no model; DMs and admin
 * notices are recorded, never sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Member = { userId: string; role: string; leftAt: Date | null; name: string | null; phoneNumber: string | null };
type Club = {
  id: string;
  name: string;
  language: string;
  approvalStatus: string;
  approvedAt: Date | null;
  billingStatus: string;
  billingPlan: string;
  billingPricePence: number | null;
  paymentHolderId: string | null;
  members: Member[];
  billing: {
    trialEndsAt: Date;
    graceEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    pausedAt: Date | null;
    pausedReason: string | null;
    paymentFailedAt: Date | null;
    cardHolderUserId: string | null;
    stripePaymentMethodId: string | null;
  } | null;
  adminChannel?: { mode: string; channelUserId: string | null; adminGroupId: string | null };
};
type Notice = { orgId: string; kind: string; cycleKey: string; platformJobId: string | null; createdAt: Date };

const h = vi.hoisted(() => {
  const state = {
    clubs: new Map<string, Club>(),
    notices: new Map<string, Notice>(),
    dms: [] as Array<{ orgId: string; kind: string; cycleKey: string; userId: string; text: string; sendAfter: Date | null }>,
    adminNotices: [] as Array<{ orgId: string; dm: string; group: string; nextPath: string | null; excludeUserId: string | null }>,
    transitions: [] as Array<{ orgId: string; type: string; result: string }>,
    /** Runs inside setBillingState BEFORE it decides: a webhook that got the lock first. */
    beforeTransition: null as null | ((orgId: string) => void),
    ops: [] as Array<{ title: string; dedupeKey?: string | null }>,
    refundSweeps: 0,
    flagStates: [] as boolean[],
    pendingFlushes: [] as string[],
    tip: {
      pricePence: 999, perSide: 5, players: 10, games: 4, sharePence: 25, feePence: 800, feePlusPence: 825, feeSource: "example", split: false,
    } as Record<string, unknown> | null,
    jobSeq: 0,
  };
  const key = (orgId: string, kind: string, cycleKey: string) => `${orgId}|${kind}|${cycleKey}`;
  const orgView = (c: Club) => ({
    ...c,
    memberships: c.members.map((m) => ({ userId: m.userId, role: m.role, leftAt: m.leftAt, user: { name: m.name, phoneNumber: m.phoneNumber } })),
    clubBilling: c.billing ? { ...c.billing } : null,
  });
  const db = {
    organisation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = state.clubs.get(where.id);
        return c ? orgView(c) : null;
      }),
    },
    clubBilling: {
      findUnique: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        const b = state.clubs.get(where.orgId)?.billing;
        return b ? { ...b } : null;
      }),
      findMany: vi.fn(async () =>
        [...state.clubs.values()]
          .filter((c) => c.billing && c.approvalStatus === "approved")
          .map((c) => ({ orgId: c.id, org: { approvalStatus: c.approvalStatus, approvedAt: c.approvedAt, billingStatus: c.billingStatus } })),
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const c of state.clubs.values()) {
          const m = c.members.find((x) => x.userId === where.id);
          if (m) return { id: m.userId, name: m.name, phoneNumber: m.phoneNumber };
        }
        return null;
      }),
    },
    billingNotice: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string; kind: string; cycleKey: string } }) =>
        state.notices.get(key(where.orgId, where.kind, where.cycleKey)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { orgId: string; platformJobId?: null; kind?: { in: string[] } } }) =>
        [...state.notices.values()].filter(
          (n) =>
            n.orgId === where.orgId &&
            (where.platformJobId !== null || n.platformJobId === null) &&
            (!where.kind?.in || where.kind.in.includes(n.kind)),
        ),
      ),
      create: vi.fn(async ({ data }: { data: { orgId: string; kind: string; cycleKey: string; platformJobId?: string | null } }) => {
        const k = key(data.orgId, data.kind, data.cycleKey);
        if (state.notices.has(k)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { ...data, platformJobId: data.platformJobId ?? null, createdAt: new Date() };
        state.notices.set(k, row);
        return row;
      }),
      createMany: vi.fn(async ({ data }: { data: Array<{ orgId: string; kind: string; cycleKey: string; createdAt?: Date }> }) => {
        let count = 0;
        for (const d of data) {
          const k = key(d.orgId, d.kind, d.cycleKey);
          if (state.notices.has(k)) continue;
          state.notices.set(k, { orgId: d.orgId, kind: d.kind, cycleKey: d.cycleKey, platformJobId: null, createdAt: d.createdAt ?? new Date() });
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { orgId: string; kind: string; cycleKey: string; platformJobId?: string | null | { startsWith: string } }; data: { platformJobId: string | null; createdAt?: Date } }) => {
          const row = state.notices.get(key(where.orgId, where.kind, where.cycleKey));
          if (!row) return { count: 0 };
          const pj = (where as { platformJobId?: unknown }).platformJobId;
          if (pj && typeof pj === "object" && "startsWith" in (pj as object)) {
            if (!row.platformJobId?.startsWith((pj as { startsWith: string }).startsWith)) return { count: 0 };
          } else if ("platformJobId" in where && row.platformJobId !== pj) return { count: 0 };
          row.platformJobId = data.platformJobId;
          if ((data as { createdAt?: Date }).createdAt) row.createdAt = (data as { createdAt: Date }).createdAt;
          return { count: 1 };
        },
      ),
    },
  };
  return { state, db, key };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../db", () => ({ db: h.db }));
vi.mock("../admin-link", () => ({
  buildAdminLink: vi.fn(async (a: { userId: string; nextPath: string; ttlSeconds?: number }) => `https://mt.test/r/${a.userId}${a.nextPath}#ttl=${a.ttlSeconds ?? "default"}`),
  appUrl: (p: string) => `https://mt.test${p}`,
}));
vi.mock("../ops-alerts", () => ({
  BILLING_ALERT_KIND: "club-billing",
  recordOpsEvent: vi.fn(async (a: { title: string; dedupeKey?: string | null }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../admin-channel", async () => {
  const rules = await import("../admin-channel-rules");
  return {
    loadAdminChannel: vi.fn(async (orgId: string) => {
      const c = h.state.clubs.get(orgId);
      if (!c) return null;
      return {
        orgId,
        orgName: c.name,
        language: c.language,
        cfg: {
          mode: rules.normaliseAdminChannelMode(c.adminChannel?.mode ?? "one-person"),
          channelUserId: c.adminChannel?.channelUserId ?? null,
          adminGroupId: c.adminChannel?.adminGroupId ?? null,
        },
        admins: c.members
          .filter((m) => m.leftAt === null && (m.role === "OWNER" || m.role === "ADMIN"))
          .map((m) => ({ id: m.userId, name: m.name, role: m.role, phoneNumber: m.phoneNumber })),
      };
    }),
    sendAdminNotice: vi.fn(
      async (req: { orgId: string; text: (link: string, audience: "dm" | "group") => string; nextPath?: string | null; excludeUserId?: string | null }) => {
        h.state.adminNotices.push({
          orgId: req.orgId,
          dm: req.text(req.nextPath ? `https://mt.test/r/admin${req.nextPath}` : "", "dm"),
          group: req.text(req.nextPath ? `https://mt.test${req.nextPath}` : "", "group"),
          nextPath: req.nextPath ?? null,
          excludeUserId: req.excludeUserId ?? null,
        });
        return { channel: "dm", queued: 1 };
      },
    ),
  };
});
vi.mock("../club-billing-spells", () => ({
  recordBillingFlagState: vi.fn(async (on: boolean) => {
    h.state.flagStates.push(on);
    return true;
  }),
}));
vi.mock("../club-billing-months", () => ({
  // Slice P2: the void sweep replaced B3's refund-intent sweep.
  sweepUnwantedMonthInvoices: vi.fn(async () => {
    h.state.refundSweeps++;
    return { voided: 0, failed: 0 };
  }),
}));
vi.mock("../club-billing-stripe", () => ({
  flushPendingBillingNotices: vi.fn(async (orgId: string) => {
    h.state.pendingFlushes.push(orgId);
    return 0;
  }),
}));
vi.mock("../club-billing", async () => {
  const rules = await import("../club-billing-rules");
  return {
    CLAIM_STALE_MS: 10 * 60 * 1000,
    loadClubFeeTip: vi.fn(async () => (h.state.tip ? { ...h.state.tip } : null)),
    setBillingState: vi.fn(async (orgId: string, event: { type: string }, now: Date) => {
      if (h.state.beforeTransition) {
        const hook = h.state.beforeTransition;
        h.state.beforeTransition = null;
        hook(orgId);
      }
      const c = h.state.clubs.get(orgId)!;
      const b = c.billing;
      const t = rules.nextBillingState(
        { approvedAt: c.approvedAt, billingStatus: c.billingStatus, billingPlan: c.billingPlan, billing: b ? { trialEndsAt: b.trialEndsAt, graceEndsAt: b.graceEndsAt, pausedReason: b.pausedReason } : null },
        event as never,
        now,
      );
      if (!t) {
        h.state.transitions.push({ orgId, type: event.type, result: "no-change" });
        return { ok: false, reason: "no-change" };
      }
      const from = c.billingStatus;
      c.billingStatus = t.to;
      if (b) {
        if (t.to === "paused") Object.assign(b, { pausedAt: now, pausedReason: t.pausedReason });
        if (t.graceEndsAt) b.graceEndsAt = t.graceEndsAt;
      }
      h.state.transitions.push({ orgId, type: event.type, result: `${from}->${t.to}` });
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
    queueBillingDm: vi.fn(
      async (a: { orgId: string; kind: string; cycleKey: string; userId: string; text: (u: { name: string | null }) => string; sendAfter?: Date | null }) => {
        const k = h.key(a.orgId, a.kind, a.cycleKey);
        const row = h.state.notices.get(k);
        if (row && row.platformJobId !== null) return "already";
        const c = h.state.clubs.get(a.orgId)!;
        const user = c.members.find((m) => m.userId === a.userId);
        const job = `job_${++h.state.jobSeq}`;
        if (!user?.phoneNumber) {
          h.state.notices.set(k, { orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, platformJobId: "skipped:no-phone", createdAt: row?.createdAt ?? new Date() });
          return "no-phone";
        }
        h.state.notices.set(k, { orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, platformJobId: job, createdAt: row?.createdAt ?? new Date() });
        h.state.dms.push({ orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, userId: a.userId, text: a.text({ name: user.name }), sendAfter: a.sendAfter ?? null });
        return "queued";
      },
    ),
  };
});

import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe } from "../stripe-billing-fake";
import { notePaymentProblem, onBillingContactChanged, sendClubFeeTip, flushPendingBillingDms } from "../club-billing-dms";
import { runBillingCron } from "../club-billing-scheduler";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const APPROVED = new Date("2026-10-01T09:00:00Z"); // Thu 1 Oct, 10:00 London
const TRIAL_ENDS = new Date(APPROVED.getTime() + 30 * DAY); // Sat 31 Oct, 09:00 London (GMT)
const DAY21 = new Date("2026-10-22T09:00:00Z"); // Thu 22 Oct, 10:00 BST
const DAY28 = new Date("2026-10-29T10:00:00Z"); // Thu 29 Oct, 10:00 GMT
const NIGHT = (d: Date) => new Date(d.getTime() + 12 * HOUR); // 21:00 or 22:00 London
let fake: FakeBillingStripe;

const OWNER: Member = { userId: "u_owen", role: "OWNER", leftAt: null, name: "Owen", phoneNumber: "+447700900001" };
const ADMIN: Member = { userId: "u_ada", role: "ADMIN", leftAt: null, name: "Ada", phoneNumber: "+447700900002" };
const PLAYER_COLLECTOR: Member = { userId: "u_cole", role: "PLAYER", leftAt: null, name: "Cole", phoneNumber: "+447700900003" };

function club(over: Partial<Club> = {}, billing: Partial<NonNullable<Club["billing"]>> = {}): Club {
  const c: Club = {
    id: "org_1",
    name: "Riverside FC",
    language: "en",
    approvalStatus: "approved",
    approvedAt: APPROVED,
    billingStatus: "trial",
    billingPlan: "standard",
    billingPricePence: null,
    paymentHolderId: null,
    members: [OWNER, ADMIN, PLAYER_COLLECTOR].map((m) => ({ ...m })),
    billing: {
      trialEndsAt: TRIAL_ENDS,
      graceEndsAt: null,
      currentPeriodEnd: null,
      pausedAt: null,
      pausedReason: null,
      paymentFailedAt: null,
      cardHolderUserId: null,
      stripePaymentMethodId: null,
      ...billing,
    },
    ...over,
  };
  h.state.clubs.set(c.id, c);
  return c;
}

const dmsOf = (kind?: string) => h.state.dms.filter((d) => !kind || d.kind === kind);

beforeEach(() => {
  process.env.BILLING_ENABLED = "1";
  process.env.NEXTAUTH_URL = "https://mt.test";
  fake = createFakeBillingStripe();
  setBillingStripeForTests(fake);
  h.state.clubs.clear();
  h.state.notices.clear();
  h.state.dms.length = 0;
  h.state.adminNotices.length = 0;
  h.state.transitions.length = 0;
  h.state.ops.length = 0;
  h.state.beforeTransition = null;
  h.state.refundSweeps = 0;
  h.state.flagStates = [];
  h.state.pendingFlushes.length = 0;
  h.state.tip = { pricePence: 999, perSide: 5, players: 10, games: 4, sharePence: 25, feePence: 800, feePlusPence: 825, feeSource: "example", split: false };
});

// ── The cron: day boundaries and once-only ─────────────────────────────

describe("runBillingCron: the day 21, 28, 30 and 37 steps", () => {
  it("day 21 at 10:00 London: one DM to the money collector with the tip and a 9 day billing link; no state change", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(DAY21);
    expect(dmsOf()).toHaveLength(1);
    const dm = dmsOf("trial-21")[0];
    expect(dm.userId).toBe("u_cole");
    expect(dm.cycleKey).toBe(TRIAL_ENDS.toISOString());
    expect(dm.text).toContain("Hi Cole, Riverside FC's free month on MatchTime ends on Sat 31 Oct.");
    expect(dm.text).toContain("As the person who collects the match fees");
    expect(dm.text).toContain(`https://mt.test/r/u_cole/billing/org_1#ttl=${9 * 24 * 60 * 60}`);
    expect(dm.text).toContain("*25p a player per game*");
    expect(dm.text).not.toContain("make them the money collector");
    expect(dm.sendAfter).toBeNull();
    expect(h.state.transitions).toEqual([]);
  });

  it("the hour before 10:00 on day 21, and at night: nothing", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(new Date(DAY21.getTime() - MIN));
    await runBillingCron(NIGHT(DAY21));
    expect(dmsOf()).toEqual([]);
  });

  it("no collector set: the OWNER gets it, without the collector sentence, with the 'set a money collector' line", async () => {
    club();
    await runBillingCron(DAY21);
    const dm = dmsOf("trial-21")[0];
    expect(dm.userId).toBe("u_owen");
    expect(dm.text).not.toContain("As the person who collects");
    expect(dm.text).toContain("Tip: if someone else collects the match fees, make them the money collector in Settings");
  });

  it("a collector who left the club: falls back to the owner", async () => {
    const c = club({ paymentHolderId: "u_cole" });
    c.members.find((m) => m.userId === "u_cole")!.leftAt = new Date("2026-10-10T00:00:00Z");
    await runBillingCron(DAY21);
    expect(dmsOf("trial-21")[0].userId).toBe("u_owen");
  });

  it("no collector and no owner with a phone: no DM, recorded for /admin/health (never a DM to anyone)", async () => {
    const c = club();
    c.members = c.members.map((m) => ({ ...m, phoneNumber: null }));
    await runBillingCron(DAY21);
    expect(dmsOf()).toEqual([]);
    expect(h.state.ops.map((o) => o.title)).toContain("No billing contact for a club fee message");
  });

  it("once only: hourly runs all of day 21 send one DM", async () => {
    club({ paymentHolderId: "u_cole" });
    for (let i = 0; i < 10; i++) await runBillingCron(new Date(DAY21.getTime() + i * HOUR));
    expect(dmsOf("trial-21")).toHaveLength(1);
  });

  it("day 28: one reminder, no tip (day 21 reached the contact)", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(DAY21);
    await runBillingCron(DAY28);
    const d28 = dmsOf("trial-28");
    expect(d28).toHaveLength(1);
    expect(d28[0].text).toBe(
      "Hi Cole, a quick reminder: Riverside FC's free month ends on Sat 31 Oct. Add a card to keep MatchTime running in the Riverside FC WhatsApp group: " +
        `https://mt.test/r/u_cole/billing/org_1#ttl=${9 * 24 * 60 * 60}`,
    );
  });

  it("the cron was down from day 20 to day 29: day 21 is never sent, day 28 goes once with the tip", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(new Date("2026-10-30T12:00:00Z"));
    await runBillingCron(new Date("2026-10-30T13:00:00Z"));
    expect(dmsOf("trial-21")).toEqual([]);
    expect(dmsOf("trial-28")).toHaveLength(1);
    expect(dmsOf("trial-28")[0].text).toContain("*25p a player per game*");
  });

  it("a collector named on day 25 gets the day 28 reminder (resolved when queued, never stored)", async () => {
    const c = club();
    await runBillingCron(DAY21);
    expect(dmsOf("trial-21")[0].userId).toBe("u_owen");
    c.paymentHolderId = "u_cole";
    await runBillingCron(DAY28);
    expect(dmsOf("trial-28")[0].userId).toBe("u_cole");
  });

  it("day 30: the free month ends ON TIME at 09:00 London; the DM goes in the daytime with the grace date and the collector line for an owner", async () => {
    const c = club();
    await runBillingCron(new Date(TRIAL_ENDS.getTime() - MIN));
    expect(c.billingStatus).toBe("trial");
    await runBillingCron(TRIAL_ENDS);
    expect(c.billingStatus).toBe("grace");
    expect(c.billing!.graceEndsAt!.toISOString()).toBe(new Date(TRIAL_ENDS.getTime() + 7 * DAY).toISOString());
    expect(dmsOf("trial-ended")).toEqual([]); // 09:00 London: not yet daytime
    await runBillingCron(new Date(TRIAL_ENDS.getTime() + HOUR)); // 10:00
    const dm = dmsOf("trial-ended");
    expect(dm).toHaveLength(1);
    expect(dm[0].text).toContain("Hi Owen, Riverside FC's free month has ended. MatchTime will keep running in the Riverside FC WhatsApp group for one more week, until Sat 7 Nov.");
    expect(dm[0].text).toContain("make them the money collector");
  });

  it("a night-time trial end: the state moves at once, the DM waits for 10:00", async () => {
    const approved = new Date("2026-10-05T23:30:00Z"); // 00:30 BST on Tue 6 Oct
    const c = club({ approvedAt: approved }, { trialEndsAt: new Date(approved.getTime() + 30 * DAY) });
    const end = c.billing!.trialEndsAt; // 23:30 GMT on Wed 4 Nov
    await runBillingCron(new Date(end.getTime() + MIN));
    expect(c.billingStatus).toBe("grace");
    expect(dmsOf()).toEqual([]);
    await runBillingCron(new Date("2026-11-05T10:00:00Z"));
    expect(dmsOf("trial-ended")).toHaveLength(1);
  });

  it("day 37: grace ends, the club is paused (no card), one 'paused' DM in the daytime", async () => {
    const c = club({ billingStatus: "grace" }, { graceEndsAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY) });
    const graceEnd = c.billing!.graceEndsAt!;
    await runBillingCron(graceEnd);
    expect(c.billingStatus).toBe("paused");
    expect(c.billing!.pausedReason).toBe("no-card");
    await runBillingCron(new Date(graceEnd.getTime() + HOUR));
    await runBillingCron(new Date(graceEnd.getTime() + 2 * HOUR));
    const dm = dmsOf("paused");
    expect(dm).toHaveLength(1);
    expect(dm[0].text).toContain("Hi Owen, MatchTime is now paused for Riverside FC. I'm still in the Riverside FC WhatsApp group, but I won't post or reply there");
    expect(dm[0].text).toContain("https://mt.test/r/u_owen/billing/org_1");
  });

  it("past due and the 7 day payment grace runs out: paused (payment failed), the 'paused' DM says so", async () => {
    const c = club(
      { billingStatus: "past_due" },
      { graceEndsAt: new Date("2026-12-08T10:00:00Z"), paymentFailedAt: new Date("2026-12-01T10:00:00Z"), cardHolderUserId: "u_owen", stripePaymentMethodId: "pm_owen" },
    );
    await runBillingCron(new Date("2026-12-08T12:00:00Z"));
    expect(c.billingStatus).toBe("paused");
    expect(dmsOf("paused")[0].text).toContain("Hi Owen, we couldn't take the £9.99 for Riverside FC, so MatchTime is now paused.");
  });

  it("a club paused by the webhook (Stripe gave up, or a cancelled plan) at night gets its 'paused' DM at 10:00", async () => {
    club({ billingStatus: "paused" }, { pausedAt: new Date("2026-12-09T02:00:00Z"), pausedReason: "cancelled" });
    await runBillingCron(new Date("2026-12-09T03:00:00Z"));
    expect(dmsOf()).toEqual([]);
    await runBillingCron(new Date("2026-12-09T10:00:00Z"));
    expect(dmsOf("paused")[0].text).toContain("the MatchTime plan for Riverside FC has ended, so MatchTime is now paused");
  });

  it("removed from the group (slice B5): paused with no DM, ever", async () => {
    club({ billingStatus: "paused" }, { pausedAt: new Date("2026-12-09T11:00:00Z"), pausedReason: "removed" });
    await runBillingCron(new Date("2026-12-09T12:00:00Z"));
    expect(dmsOf()).toEqual([]);
  });

  it("Turkish club: the reminders are in Turkish, with Turkish dates", async () => {
    club({ language: "tr", paymentHolderId: "u_cole" });
    await runBillingCron(DAY21);
    const dm = dmsOf("trial-21")[0];
    expect(dm.text).toContain("Merhaba Cole, Riverside FC için MatchTime'daki ücretsiz ay 31 Ekim Cumartesi tarihinde bitiyor.");
    expect(dm.text).toContain("Kulüp ücreti ipucu");
    expect(dm.text).not.toMatch(/[–—]/);
  });
});

// ── Skips ───────────────────────────────────────────────────────────────

describe("runBillingCron: who is never touched", () => {
  it("BILLING_ENABLED off: no transition, no DM (the void sweep still runs: a club set Free is never charged by Stripe's retries)", async () => {
    process.env.BILLING_ENABLED = "0";
    const c = club({}, {});
    await runBillingCron(new Date(TRIAL_ENDS.getTime() + 2 * HOUR));
    expect(c.billingStatus).toBe("trial");
    expect(dmsOf()).toEqual([]);
    expect(h.state.transitions).toEqual([]);
    expect(h.state.refundSweeps).toBe(1);
    // H1: the run records that billing is off (once per change).
    expect(h.state.flagStates).toEqual([false]);
  });

  it("a suspended club, an unapproved club and an exempt club: nothing", async () => {
    club({ id: "org_susp", approvalStatus: "suspended" });
    club({ id: "org_pending", approvalStatus: "pending" });
    club({ id: "org_exempt", billingStatus: "exempt" });
    club({ id: "org_old", approvedAt: null });
    const r = await runBillingCron(new Date(TRIAL_ENDS.getTime() + 2 * HOUR));
    expect(dmsOf()).toEqual([]);
    expect(h.state.transitions.filter((t) => t.result !== "no-change")).toEqual([]);
    expect(r.clubs.filter((x) => x.orgId === "org_susp" || x.orgId === "org_pending")).toEqual([]);
  });
});

// ── Racing the webhook ──────────────────────────────────────────────────

describe("transitions racing webhooks (the one locked writer decides)", () => {
  it("the card lands just before the cron's day 30 step: the cron's transition is refused, no 'trial ended' DM", async () => {
    const c = club();
    h.state.beforeTransition = () => {
      c.billingStatus = "subscribed"; // the webhook's card-added committed first
      c.billing!.cardHolderUserId = "u_owen";
    };
    await runBillingCron(new Date(TRIAL_ENDS.getTime() + 2 * HOUR));
    expect(h.state.transitions).toEqual([{ orgId: "org_1", type: "trial-ended", result: "no-change" }]);
    expect(c.billingStatus).toBe("subscribed");
    expect(dmsOf()).toEqual([]);
  });

  it("a recovered payment lands just before the cron's grace end: not paused, no 'paused' DM", async () => {
    const c = club(
      { billingStatus: "past_due" },
      { graceEndsAt: new Date("2026-12-08T10:00:00Z"), paymentFailedAt: new Date("2026-12-01T10:00:00Z"), stripePaymentMethodId: "pm_cole" },
    );
    h.state.beforeTransition = () => {
      c.billingStatus = "subscribed";
    };
    await runBillingCron(new Date("2026-12-08T12:00:00Z"));
    expect(c.billingStatus).toBe("subscribed");
    expect(dmsOf()).toEqual([]);
  });

  it("a failure in one club does not stop the others", async () => {
    club({ id: "org_a", paymentHolderId: "u_cole" });
    club({ id: "org_b", paymentHolderId: "u_cole" });
    const queue = (await import("../club-billing")).queueBillingDm as unknown as ReturnType<typeof vi.fn>;
    queue.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const r = await runBillingCron(DAY21);
    expect(r.clubs.find((x) => x.orgId === "org_a")?.error ?? r.clubs.find((x) => x.orgId === "org_b")?.error).toContain("db down");
    expect(dmsOf("trial-21")).toHaveLength(1);
  });

  it("every run sweeps unwanted unpaid invoices and flushes pending resumed or plan-billed DMs in the daytime", async () => {
    club();
    await runBillingCron(NIGHT(DAY21));
    expect(h.state.refundSweeps).toBe(1);
    expect(h.state.pendingFlushes).toEqual([]);
    await runBillingCron(DAY21);
    expect(h.state.refundSweeps).toBe(2);
    expect(h.state.flagStates).toEqual([true, true]);
    expect(h.state.pendingFlushes).toEqual(["org_1"]);
  });
});

// ── The club fee tip through the admin channel ─────────────────────────

describe("sendClubFeeTip: the admin channel's tip, once per free month", () => {
  it("one person = the owner, who is also the billing contact (no collector): skipped, the owner already has it in the card DM", async () => {
    club({ adminChannel: { mode: "one-person", channelUserId: null, adminGroupId: null } });
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("skipped-only-contact");
    expect(h.state.adminNotices).toEqual([]);
    // And never re-tried.
    expect(await sendClubFeeTip("org_1", new Date(DAY21.getTime() + HOUR))).toBe("already");
  });

  it("one person = the owner, and a player collector is the contact: sent to the admin channel, without the 'no collector' line", async () => {
    club({ paymentHolderId: "u_cole" });
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("sent");
    expect(h.state.adminNotices).toHaveLength(1);
    const n = h.state.adminNotices[0];
    expect(n.dm).toContain("*25p a player per game*");
    expect(n.dm).not.toContain("Nobody is set as the money collector");
    expect(n.excludeUserId).toBe("u_cole");
  });

  it("each admin, no collector: sent with the 'choose a collector' line pointing at Settings (a signed-in link by DM, the plain URL in a group)", async () => {
    club({ adminChannel: { mode: "each-admin", channelUserId: null, adminGroupId: null } });
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("sent");
    const n = h.state.adminNotices[0];
    expect(n.nextPath).toBe("/admin/settings#payments");
    expect(n.dm).toContain("Nobody is set as the money collector yet. Choose one in Settings: they'll look after the card for the club fee and get this tip too. https://mt.test/r/admin/admin/settings#payments");
    expect(n.group).toContain("https://mt.test/admin/settings#payments");
    expect(n.excludeUserId).toBe("u_owen");
  });

  it("admin group linked: sent (the server cannot see who is in it)", async () => {
    club({ paymentHolderId: "u_owen", adminChannel: { mode: "admin-group", channelUserId: null, adminGroupId: "120363@g.us" } });
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("sent");
  });

  it("a second call, and the day 28 run, send nothing more", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(DAY21);
    await runBillingCron(new Date(DAY21.getTime() + HOUR));
    await runBillingCron(DAY28);
    expect(h.state.adminNotices).toHaveLength(1);
  });

  it("day 21 missed: the tip goes to the admins with day 28", async () => {
    club({ paymentHolderId: "u_cole" });
    await runBillingCron(DAY28);
    expect(h.state.adminNotices).toHaveLength(1);
  });

  it("not before day 21, not at night, not for a Free or exempt club (no tip), not with the flag off", async () => {
    club({ paymentHolderId: "u_cole" });
    expect(await sendClubFeeTip("org_1", new Date(DAY21.getTime() - MIN))).toBe("not-due");
    expect(await sendClubFeeTip("org_1", NIGHT(DAY21))).toBe("not-due");
    h.state.tip = null;
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("no-tip");
    process.env.BILLING_ENABLED = "";
    expect(await sendClubFeeTip("org_1", DAY21)).toBe("off");
    expect(h.state.adminNotices).toEqual([]);
  });
});

// ── The new collector ───────────────────────────────────────────────────

describe("onBillingContactChanged: the 'payer changed' DM from setPaymentHolder", () => {
  const NOON = new Date("2026-10-12T11:00:00Z");

  it("in the free month: one DM to the new collector, 'add a card before' the trial end, with the tip", async () => {
    club({ paymentHolderId: "u_cole" });
    expect(await onBillingContactChanged("org_1", NOON)).toBe("queued");
    const dm = dmsOf("payer-changed")[0];
    expect(dm.userId).toBe("u_cole");
    expect(dm.cycleKey).toBe("u_cole");
    expect(dm.text).toContain("Hi Cole, you're now the money collector for Riverside FC, so you look after MatchTime's £9.99 a month for the group. Add a card before Sat 31 Oct to keep it running:");
    expect(dm.text).toContain("*25p a player per game*");
  });

  it("someone else's card is paying: 'Owen's card keeps paying until you put yours on'", async () => {
    club({ billingStatus: "subscribed", paymentHolderId: "u_cole" }, { cardHolderUserId: "u_owen", stripePaymentMethodId: "pm_owen", currentPeriodEnd: new Date("2026-11-30T09:00:00Z") });
    await onBillingContactChanged("org_1", NOON);
    expect(dmsOf("payer-changed")[0].text).toContain("Owen's card keeps paying until you put yours on, whenever suits you:");
  });

  it("paused: 'Add a card to switch it back on'", async () => {
    club({ billingStatus: "paused", paymentHolderId: "u_cole" }, { pausedAt: new Date("2026-11-07T09:00:00Z"), pausedReason: "no-card" });
    await onBillingContactChanged("org_1", NOON);
    expect(dmsOf("payer-changed")[0].text).toContain("Add a card to switch it back on:");
  });

  it("paused because MatchTime was removed from the group: asks for MatchTime to be added back, not for a card", async () => {
    club({ billingStatus: "paused", paymentHolderId: "u_cole" }, { pausedAt: new Date("2026-11-07T09:00:00Z"), pausedReason: "removed" });
    await onBillingContactChanged("org_1", NOON);
    const text = dmsOf("payer-changed")[0].text;
    expect(text).toContain("MatchTime was taken out of the Riverside FC WhatsApp group, so it is paused. To switch it back on, add MatchTime back to the group.");
    expect(text).not.toContain("Add a card");
  });

  it("changing back and forth never repeats it (claimed by the collector's user id)", async () => {
    const c = club({ paymentHolderId: "u_cole" });
    await onBillingContactChanged("org_1", NOON);
    c.paymentHolderId = "u_ada";
    await onBillingContactChanged("org_1", NOON);
    c.paymentHolderId = "u_cole";
    await onBillingContactChanged("org_1", NOON);
    expect(dmsOf("payer-changed").map((d) => d.userId)).toEqual(["u_cole", "u_ada"]);
  });

  it("a skipped notice never blocks a later, real change to the same person (skipped rows are re-opened; a delivered one is not repeated)", async () => {
    const c = club({ paymentHolderId: "u_ada" });
    await onBillingContactChanged("org_1", new Date("2026-10-12T22:00:00Z")); // pending for Ada
    c.paymentHolderId = "u_cole";
    await flushPendingBillingDms("org_1", new Date("2026-10-13T09:00:00Z")); // Ada's is skipped: not current
    expect(h.state.notices.get(h.key("org_1", "payer-changed", "u_ada"))!.platformJobId).toBe("skipped:not-current");
    c.paymentHolderId = "u_ada"; // Ada really is the collector again, days later
    expect(await onBillingContactChanged("org_1", new Date("2026-10-16T11:00:00Z"))).toBe("queued");
    expect(dmsOf("payer-changed").map((d) => d.userId)).toEqual(["u_ada"]);
    // At night the re-opened row is pending again, with a fresh age.
    c.paymentHolderId = "u_cole";
    h.state.notices.set(h.key("org_1", "payer-changed", "u_cole"), {
      orgId: "org_1", kind: "payer-changed", cycleKey: "u_cole", platformJobId: "skipped:no-phone", createdAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(await onBillingContactChanged("org_1", new Date("2026-10-16T22:00:00Z"))).toBe("pending");
    await flushPendingBillingDms("org_1", new Date("2026-10-17T09:00:00Z"));
    expect(dmsOf("payer-changed").map((d) => d.userId)).toEqual(["u_ada", "u_cole"]);
  });

  it("never on an exempt club, a suspended club, with the flag off, or when the new collector's own card is on file", async () => {
    club({ billingStatus: "exempt", paymentHolderId: "u_cole" });
    expect(await onBillingContactChanged("org_1", NOON)).toBe("skipped:not-billed");
    club({ approvalStatus: "suspended", paymentHolderId: "u_cole" });
    expect(await onBillingContactChanged("org_1", NOON)).toBe("skipped:not-billed");
    club({ billingStatus: "subscribed", paymentHolderId: "u_cole" }, { cardHolderUserId: "u_cole" });
    expect(await onBillingContactChanged("org_1", NOON)).toBe("skipped:own-card");
    process.env.BILLING_ENABLED = "0";
    club({ paymentHolderId: "u_cole" });
    expect(await onBillingContactChanged("org_1", NOON)).toBe("skipped:off");
    expect(dmsOf()).toEqual([]);
  });

  it("at night: kept PENDING, sent by the 10:00 run if the collector is still the same; skipped if they changed again", async () => {
    const c = club({ paymentHolderId: "u_cole" });
    expect(await onBillingContactChanged("org_1", new Date("2026-10-12T22:00:00Z"))).toBe("pending");
    expect(dmsOf()).toEqual([]);
    await flushPendingBillingDms("org_1", new Date("2026-10-13T09:00:00Z"));
    expect(dmsOf("payer-changed").map((d) => d.userId)).toEqual(["u_cole"]);

    c.paymentHolderId = "u_ada";
    await onBillingContactChanged("org_1", new Date("2026-10-13T22:00:00Z"));
    c.paymentHolderId = "u_owen"; // changed again before morning (Owen is an owner, not the pending one)
    await flushPendingBillingDms("org_1", new Date("2026-10-14T09:00:00Z"));
    expect(dmsOf("payer-changed").map((d) => d.userId)).toEqual(["u_cole"]);
    expect(h.state.notices.get(h.key("org_1", "payer-changed", "u_ada"))!.platformJobId).toBe("skipped:not-current");
  });
});

// ── Payment problems from the webhook ───────────────────────────────────

describe("notePaymentProblem + flush: payment failed and 3DS DMs", () => {
  const FAILED_AT = new Date("2026-12-01T11:00:00Z");
  const pastDue = (over: Partial<NonNullable<Club["billing"]>> = {}) =>
    club(
      { billingStatus: "past_due", paymentHolderId: "u_cole" },
      { cardHolderUserId: "u_cole", stripePaymentMethodId: "pm_cole", paymentFailedAt: FAILED_AT, graceEndsAt: new Date(FAILED_AT.getTime() + 7 * DAY), ...over },
    );

  it("payment failed: held 30 minutes (a 3DS event for the same invoice would replace it), then one DM to the contact", async () => {
    pastDue();
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1" });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    expect(dmsOf()).toEqual([]);
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + 10 * MIN));
    expect(dmsOf()).toEqual([]);
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + 31 * MIN));
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + 91 * MIN));
    const dm = dmsOf("payment-failed");
    expect(dm).toHaveLength(1);
    expect(dm[0].cycleKey).toBe("in_1");
    expect(dm[0].text).toBe(
      "Hi Cole, this month's £9.99 for Riverside FC didn't go through. Stripe will try again over the next few days, and MatchTime keeps running meanwhile. " +
        `To update the card: https://mt.test/r/u_cole/billing/org_1#ttl=${9 * 24 * 60 * 60}`,
    );
  });

  it("the failing card is someone else's (collector change in progress): 'To put your own card on instead'", async () => {
    pastDue({ cardHolderUserId: "u_owen" });
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: null });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + HOUR));
    expect(dmsOf("payment-failed")[0].text).toContain("To put your own card on instead:");
  });

  it("3DS in the daytime: sent at once with the invoice's own Stripe page; the 'payment failed' for the same invoice is then never sent", async () => {
    pastDue();
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1" });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-action", hostedUrl: "https://invoice.stripe.com/i/in_1", now: new Date(FAILED_AT.getTime() + MIN) });
    expect(dmsOf("payment-action")).toHaveLength(1);
    expect(dmsOf("payment-action")[0].text).toBe(
      "Hi Cole, your bank wants you to confirm this month's £9.99 for Riverside FC before it can go through. Please confirm it here: https://invoice.stripe.com/i/in_1\nMatchTime keeps running meanwhile.",
    );
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + 2 * HOUR));
    expect(dmsOf("payment-failed")).toEqual([]);
    expect(h.state.notices.get(h.key("org_1", "payment-failed", "in_1"))!.platformJobId).toBe("skipped:superseded");
  });

  it("3DS when the card on file is someone else's (collector change in progress): the contact may confirm it or put their own card on", async () => {
    pastDue({ cardHolderUserId: "u_owen" });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_3", kind: "payment-action", hostedUrl: "https://invoice.stripe.com/i/in_3", now: FAILED_AT });
    const dm = dmsOf("payment-action")[0];
    expect(dm.userId).toBe("u_cole");
    expect(dm.text).toBe(
      "Hi Cole, the card on file for Riverside FC needs the bank to confirm this month's £9.99 before it can go through. " +
        "You can confirm and pay it here: https://invoice.stripe.com/i/in_3\n" +
        `Or put your own card on instead: https://mt.test/r/u_cole/billing/org_1#ttl=${9 * 24 * 60 * 60}\n` +
        "MatchTime keeps running meanwhile.",
    );
  });

  it("3DS at night: pending; the 10:00 run re-reads the invoice and sends its link only if it is still open", async () => {
    pastDue();
    const night = new Date("2026-12-01T23:00:00Z");
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_2", kind: "payment-action", hostedUrl: "https://invoice.stripe.com/i/in_2", now: night });
    expect(dmsOf()).toEqual([]);
    fake.putInvoice({ id: "in_2", status: "paid", hostedInvoiceUrl: "https://invoice.stripe.com/i/in_2" });
    await flushPendingBillingDms("org_1", new Date("2026-12-02T10:00:00Z"));
    expect(dmsOf()).toEqual([]);
    expect(h.state.notices.get(h.key("org_1", "payment-action", "in_2"))!.platformJobId).toBe("skipped:not-current");
  });

  it("paid before the hold ran out, or the club no longer past due: never sent", async () => {
    const c = pastDue();
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: null });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    c.billingStatus = "subscribed"; // invoice.paid on Stripe's retry
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + HOUR));
    expect(dmsOf()).toEqual([]);
  });

  it("once per invoice: the same failure delivered twice, and Stripe's later retries of the same invoice, are one DM", async () => {
    pastDue();
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: null });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: new Date(FAILED_AT.getTime() + 3 * DAY) });
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + HOUR));
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + 2 * HOUR));
    expect(dmsOf("payment-failed")).toHaveLength(1);
  });

  it("not noted at all with the flag off, for an exempt or suspended club, or a club that is not past due", async () => {
    process.env.BILLING_ENABLED = "0";
    pastDue();
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    process.env.BILLING_ENABLED = "1";
    club({ billingStatus: "subscribed" });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_9", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    club({ billingStatus: "past_due", approvalStatus: "suspended" });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_8", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    expect(h.state.notices.size).toBe(0);
  });

  it("a pending DM older than 3 days is never sent", async () => {
    pastDue();
    fake.putInvoice({ id: "in_1", status: "open", hostedInvoiceUrl: null });
    await notePaymentProblem({ orgId: "org_1", invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now: FAILED_AT });
    h.state.notices.get(h.key("org_1", "payment-failed", "in_1"))!.createdAt = new Date(FAILED_AT.getTime() - 4 * DAY);
    await flushPendingBillingDms("org_1", new Date(FAILED_AT.getTime() + HOUR));
    expect(dmsOf()).toEqual([]);
    expect(h.state.notices.get(h.key("org_1", "payment-failed", "in_1"))!.platformJobId).toBe("skipped:expired");
  });
});
