/**
 * SELF-JOIN SLICE 7 ("Decisions"): `decideClub`, the owner's WhatsApp
 * reply (`handleApproverDm`) and leaving an unsolicited group, against a
 * mocked database. Plan: MDs/self-join-and-approval-plan-2026-09-28.md,
 * sections 4.1, 5.4, 6.2, 6.3, 6.4.
 *
 * Deterministic: no model anywhere (the Anthropic SDK is mocked and its
 * calls counted). The real-Postgres checks (the CHECK constraint, two
 * decisions racing) are in e2e/api/self-join-decisions.spec.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const anthropicCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: () => {
        anthropicCalls.n++;
        throw new Error("no model in the decision path");
      },
    };
  },
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    clubConnect: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    unsolicitedGroup: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    botJob: { create: vi.fn() },
    platformJob: { findFirst: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

const importMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/participant-sync", () => ({ importParticipants: importMock }));

// The organiser's signed-in links (2026-10-01): one per page, for the
// organiser's own user, pinned to the club. A fake that shows all three.
const adminLinkMock = vi.hoisted(() =>
  vi.fn(async (a: { userId: string; orgId: string; nextPath: string }) => `https://mt.link/${a.userId}/${a.orgId}${a.nextPath}`),
);
vi.mock("@/lib/admin-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-link")>()),
  buildAdminLink: adminLinkMock,
}));

// Club fee billing, slice B2: approval starts the free month (flag on) and
// the "you're live" DM carries the club fee tip for a billed club. The
// writer and the tip loader are faked here; their own tests are
// club-billing.test.ts and club-billing-b2.test.ts.
const billingMock = vi.hoisted(() => ({ setBillingState: vi.fn(), loadClubFeeTip: vi.fn() }));
vi.mock("@/lib/club-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/club-billing")>()),
  setBillingState: billingMock.setBillingState,
  loadClubFeeTip: billingMock.loadClubFeeTip,
}));

// Review fix 11: a suspension cancels the club's live club fee subscription
// (plan 4.2, decision 7). The Stripe side is club-billing-stripe.test.ts.
const suspendCancelMock = vi.hoisted(() => vi.fn(async () => ({ waived: 1 })));
vi.mock("@/lib/club-billing-stripe", () => ({ onClubSuspended: suspendCancelMock }));

import { decideClub, handleApproverDm, leaveUnsolicitedGroup } from "../club-approval";

const NOW = new Date("2026-09-29T12:00:00Z");
const GROUP = "120363400000000001@g.us";
const SUTTON_GROUP = "120363000000000001@g.us";
const ALI = "447700900123";
const APPROVER = "447700900444";
const ENV = { ...process.env };

type Org = {
  id: string;
  name: string;
  language: string;
  approvalStatus: string;
  approvedAt: Date | null;
  approvalDecidedAt: Date | null;
  whatsappGroupId: string | null;
};
let orgs: Record<string, Org>;

const riverside = (over: Partial<Org> = {}): Org => ({
  id: "org-riverside",
  name: "Riverside FC",
  language: "en",
  approvalStatus: "pending",
  approvedAt: null,
  approvalDecidedAt: null,
  whatsappGroupId: null,
  ...over,
});
const sutton = (): Org => ({
  id: "org-sutton",
  name: "Sutton FC",
  language: "en",
  approvalStatus: "approved",
  approvedAt: null,
  approvalDecidedAt: null,
  whatsappGroupId: SUTTON_GROUP,
});

const link = (over: Record<string, unknown> = {}) => ({
  id: "cc-ali",
  orgId: "org-riverside",
  userId: "u-ali",
  code: "7KQ2",
  phone: ALI,
  groupId: GROUP,
  groupSubject: "Riverside Tuesday 5s",
  participants: [
    { phone: ALI, pushname: "Ali" },
    { phone: "447700900972", pushname: "Ben" },
  ],
  ...over,
});

const created = (model: "botJob" | "platformJob") =>
  (dbMock[model].create.mock.calls as Array<[{ data: Record<string, unknown> }]>).map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  anthropicCalls.n = 0;
  process.env.SELF_JOIN_APPROVER_PHONES = `+${APPROVER}`;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  orgs = { "org-riverside": riverside(), "org-sutton": sutton() };

  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  dbMock.$executeRaw.mockResolvedValue(1);
  dbMock.organisation.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => orgs[where.id] ?? null);
  // The "another approved club owns this group" check, and the leave guard.
  dbMock.organisation.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const hit = Object.values(orgs).find(
      (o) =>
        o.approvalStatus === "approved" &&
        o.whatsappGroupId === where.whatsappGroupId &&
        !(where.id && typeof where.id === "object" && (where.id as { not: string }).not === o.id),
    );
    return hit ? { id: hit.id, name: hit.name } : null;
  });
  // A compare-and-set against the in-memory orgs.
  dbMock.organisation.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const o = orgs[where.id as string];
      if (!o) return { count: 0 };
      if (where.approvalStatus !== undefined && o.approvalStatus !== where.approvalStatus) return { count: 0 };
      if (where.approvedAt && o.approvedAt === null) return { count: 0 };
      Object.assign(o, data);
      return { count: 1 };
    },
  );
  dbMock.clubConnect.findFirst.mockResolvedValue(link());
  dbMock.clubConnect.findMany.mockResolvedValue([]);
  dbMock.clubConnect.updateMany.mockResolvedValue({ count: 1 });
  dbMock.user.findUnique.mockResolvedValue({ name: "Ali Demir" });
  dbMock.user.findFirst.mockResolvedValue({ id: "u-ali" });
  dbMock.botJob.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "bj-1", ...data }));
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "pj-1", ...data }));
  importMock.mockResolvedValue({ added: 2, alreadyKnown: 0, skippedNoPhone: 0, restoredMembership: 0, total: 2 });
  delete process.env.BILLING_ENABLED;
  billingMock.setBillingState.mockResolvedValue({ ok: false, reason: "no-change" });
  billingMock.loadClubFeeTip.mockResolvedValue(null);
});

afterAll(() => {
  process.env = ENV;
});

describe("decideClub: approve", () => {
  it("switches the club on, links the group, imports the roster, queues the hello and the organiser's DM", async () => {
    const r = await decideClub("org-riverside", "approve", `whatsapp:${APPROVER}`, { now: NOW });
    expect(r).toMatchObject({ ok: true, decision: "approve", club: "Riverside FC", code: "7KQ2" });

    const o = orgs["org-riverside"];
    expect(o).toMatchObject({
      approvalStatus: "approved",
      approvedAt: NOW,
      approvalDecidedAt: NOW,
      approvalDecidedBy: `whatsapp:${APPROVER}`,
      whatsappBotEnabled: true,
      whatsappGroupId: GROUP,
    });
    // Compare-and-set on pending.
    expect(dbMock.organisation.updateMany.mock.calls[0][0].where).toEqual({ id: "org-riverside", approvalStatus: "pending" });
    // The request is closed.
    expect(dbMock.clubConnect.updateMany).toHaveBeenCalledWith({
      where: { id: "cc-ali", status: "group_linked" },
      data: { status: "closed" },
    });
    // The roster from the add's snapshot.
    expect(importMock).toHaveBeenCalledWith("org-riverside", [
      { phone: ALI, lidId: null, pushname: "Ali" },
      { phone: "447700900972", lidId: null, pushname: "Ben" },
    ]);
    // The hello, a normal group BotJob, in the club's language, naming the organiser.
    const [hello] = created("botJob");
    expect(hello).toMatchObject({ orgId: "org-riverside", kind: "group" });
    expect(hello.text).toContain("Ali has set me up to run this group's games.");
    expect(hello.text).toContain("*In*");
    // The organiser's DM, once, on the platform channel.
    const dms = created("platformJob");
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({ kind: "dm", phone: ALI, purpose: "organiser-decision", refId: "cc-ali:approved" });
    expect(dms[0].text).toBe(
      'Good news: Riverside FC is live. I\'ve said hello in "Riverside Tuesday 5s".\n\n' +
        "A few things to set up when you have a minute:\n\n" +
        "📅 *Your weekly game:* check the day, time and venue, or change them:\nhttps://mt.link/u-ali/org-riverside/admin/activities\n\n" +
        "⭐ *Starting ratings:* give each player a rough score out of 10 so the first teams are fair:\nhttps://mt.link/u-ali/org-riverside/admin/players/ratings\n\n" +
        "⚙️ *Settings:* switch on payments, rolling squad, weekly deadlines, admin messages, organiser picks and badge announcements:\nhttps://mt.link/u-ali/org-riverside/admin/settings\n\n" +
        "❓ *Help any time:* message me here, for example *help payments* or *help badges*.\n\n" +
        "Your first month is free.",
    );
    // Each link signs in the organiser (the DM goes to their own phone), in this club.
    expect(adminLinkMock.mock.calls.map((c) => c[0])).toEqual([
      { userId: "u-ali", orgId: "org-riverside", nextPath: "/admin/activities" },
      { userId: "u-ali", orgId: "org-riverside", nextPath: "/admin/players/ratings" },
      { userId: "u-ali", orgId: "org-riverside", nextPath: "/admin/settings" },
    ]);
    expect(anthropicCalls.n).toBe(0);
  });

  it("speaks Turkish to a Turkish club", async () => {
    orgs["org-riverside"].language = "tr";
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(created("botJob")[0].text).toContain("*VARIM*");
    expect(created("platformJob")[0].text).toMatch(/^Güzel haber: Riverside FC artık aktif\./);
  });

  it("the hello is the full feature intro: In, bench, remind me, teams, MoM, stats, fees, help", async () => {
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    const hello = String(created("botJob")[0].text);
    for (const f of ["*In*", "bench", "remind me", "teams", "Man of the Match", "ratings", "Stats", "Match fees", "*@Match Time help*"]) {
      expect(hello).toContain(f);
    }
  });

  it("a link that cannot be minted falls back to the plain page address; the DM still goes", async () => {
    adminLinkMock.mockRejectedValueOnce(new Error("short link table down"));
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    const text = String(created("platformJob")[0].text);
    expect(text).toContain("\nhttps://matchtime.ai/admin/activities\n");
    expect(text).toContain("https://mt.link/u-ali/org-riverside/admin/players/ratings");
  });

  it("an approval still stands when the roster import fails (it is logged)", async () => {
    importMock.mockRejectedValueOnce(new Error("db hiccup"));
    const r = await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(r.ok).toBe(true);
    expect(orgs["org-riverside"].approvalStatus).toBe("approved");
  });

  it("a second decision loses the compare-and-set: nothing is queued twice", async () => {
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    vi.clearAllMocks();
    const again = await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(again).toMatchObject({ ok: false, reason: "not-pending", status: "approved" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("refuses when another approved club already owns the group, and writes nothing", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(link({ groupId: SUTTON_GROUP }));
    const r = await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "group-taken", takenBy: "Sutton FC" });
    expect(orgs["org-riverside"].approvalStatus).toBe("pending");
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("refuses a pending club with no linked group", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    const r = await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "no-linked-group" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("cannot touch Sutton FC (approved, never through self-join)", async () => {
    for (const d of ["approve", "reject"] as const) {
      const r = await decideClub("org-sutton", d, "u-kemal", { now: NOW });
      expect(r).toMatchObject({ ok: false, reason: "not-pending", status: "approved" });
    }
    expect(orgs["org-sutton"]).toEqual(sutton());
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("decideClub: approve starts the free month (club fee billing, slice B2)", () => {
  const TIP = {
    pricePence: 999,
    perSide: 5,
    players: 10,
    games: 4,
    perGamePence: 250,
    sharePence: 25,
    feePence: 800,
    feePlusPence: 825,
    feeSource: "example" as const,
    split: false,
  };
  const FREE = "Your first month is free.";

  it("BILLING_ENABLED off: no free month starts and the DM is exactly today's", async () => {
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(billingMock.setBillingState).not.toHaveBeenCalled();
    const text = String(created("platformJob")[0].text);
    expect(text.endsWith(FREE)).toBe(true);
    expect(text).not.toMatch(/£|Club fee/);
  });

  it("flag on: the free month starts through the one writer, and the DM ends with the tip after the free sentence", async () => {
    process.env.BILLING_ENABLED = "1";
    billingMock.setBillingState.mockResolvedValue({ ok: true, from: "exempt", to: "trial", resumed: false });
    billingMock.loadClubFeeTip.mockResolvedValue(TIP);
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(billingMock.setBillingState).toHaveBeenCalledWith("org-riverside", { type: "approved" }, NOW);
    const text = String(created("platformJob")[0].text);
    expect(text).toContain(
      `${FREE}\n\n💷 *Club fee tip:* after that MatchTime only charges for the games you play, up to £9.99 a month for the group, paid by card by whoever collects the match fees. ` +
        "Each game played costs at most £2.50, about *25p a player per game* with 10 players, so a £8 game could be charged at *£8.25*.",
    );
  });

  it("flag on, in Turkish", async () => {
    process.env.BILLING_ENABLED = "1";
    orgs["org-riverside"].language = "tr";
    billingMock.setBillingState.mockResolvedValue({ ok: true, from: "exempt", to: "trial", resumed: false });
    billingMock.loadClubFeeTip.mockResolvedValue(TIP);
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(String(created("platformJob")[0].text)).toContain("İlk ayınız ücretsiz.\n\n💷 *Kulüp ücreti ipucu:*");
  });

  it("flag on but no free month started (plan Free): no tip", async () => {
    process.env.BILLING_ENABLED = "1";
    billingMock.loadClubFeeTip.mockResolvedValue(TIP);
    await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(billingMock.setBillingState).toHaveBeenCalledTimes(1);
    expect(String(created("platformJob")[0].text).endsWith(FREE)).toBe(true);
  });

  it("a billing failure never undoes the approval; the DM goes without the tip", async () => {
    process.env.BILLING_ENABLED = "1";
    billingMock.setBillingState.mockRejectedValue(new Error("lock timeout"));
    const r = await decideClub("org-riverside", "approve", "u-kemal", { now: NOW });
    expect(r.ok).toBe(true);
    expect(orgs["org-riverside"].approvalStatus).toBe("approved");
    expect(String(created("platformJob")[0].text).endsWith(FREE)).toBe(true);
  });

  it("reject and suspend never touch billing", async () => {
    process.env.BILLING_ENABLED = "1";
    await decideClub("org-riverside", "reject", "u-kemal", { now: NOW });
    orgs["org-riverside"] = riverside({ approvalStatus: "approved", approvedAt: NOW, whatsappGroupId: GROUP });
    await decideClub("org-riverside", "suspend", "u-kemal", { now: NOW, confirmName: "Riverside FC" });
    expect(billingMock.setBillingState).not.toHaveBeenCalled();
  });
});

describe("decideClub: reject", () => {
  it("rejects, leaves the group, and DMs the organiser once; the bot stays off", async () => {
    const r = await decideClub("org-riverside", "reject", `whatsapp:${APPROVER}`, { now: NOW });
    expect(r).toMatchObject({ ok: true, decision: "reject" });
    const o = orgs["org-riverside"] as Org & { whatsappBotEnabled?: boolean };
    expect(o.approvalStatus).toBe("rejected");
    expect(o.whatsappBotEnabled).toBeUndefined();
    expect(o.whatsappGroupId).toBeNull();

    const jobs = created("platformJob");
    expect(jobs.find((j) => j.kind === "leave-group")).toMatchObject({ groupId: GROUP, refId: "cc-ali" });
    const dm = jobs.find((j) => j.kind === "dm");
    expect(dm).toMatchObject({ phone: ALI, purpose: "organiser-decision", refId: "cc-ali:rejected" });
    expect(dm?.text).toBe(
      'Thanks for trying MatchTime. We can\'t take "Riverside Tuesday 5s" on right now, so I\'ve left the group. We\'ll be in touch if that changes.',
    );
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(importMock).not.toHaveBeenCalled();
  });
});

describe("decideClub: suspend (the off switch)", () => {
  beforeEach(() => {
    orgs["org-riverside"] = riverside({
      approvalStatus: "approved",
      approvedAt: new Date("2026-09-20T10:00:00Z"),
      whatsappGroupId: GROUP,
    });
  });

  it("turns an approved self-join club off, then leaves its group; nothing is said anywhere", async () => {
    const r = await decideClub("org-riverside", "suspend", "u-kemal", { now: NOW, confirmName: "riverside fc" });
    expect(r).toMatchObject({ ok: true, decision: "suspend" });
    expect(orgs["org-riverside"]).toMatchObject({ approvalStatus: "suspended", whatsappBotEnabled: false });
    // CAS on approved AND self-join.
    expect(dbMock.organisation.updateMany.mock.calls[0][0].where).toEqual({
      id: "org-riverside",
      approvalStatus: "approved",
      approvedAt: { not: null },
    });
    const jobs = created("platformJob");
    expect(jobs).toEqual([expect.objectContaining({ kind: "leave-group", groupId: GROUP })]);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("slice P2 (decision 7 under games played): a suspension waives the club's open club fee month (after it is committed)", async () => {
    await decideClub("org-riverside", "suspend", "u-kemal", { now: NOW, confirmName: "riverside fc" });
    expect(suspendCancelMock).toHaveBeenCalledWith("org-riverside", NOW);
  });

  it("a failure there never undoes the suspension", async () => {
    suspendCancelMock.mockRejectedValueOnce(new Error("stripe down"));
    const r = await decideClub("org-riverside", "suspend", "u-kemal", { now: NOW, confirmName: "riverside fc" });
    expect(r).toMatchObject({ ok: true, decision: "suspend" });
    expect(orgs["org-riverside"].approvalStatus).toBe("suspended");
  });

  it("approve and reject never touch the billing months", async () => {
    orgs["org-riverside"] = riverside();
    await decideClub("org-riverside", "reject", "u-kemal", { now: NOW });
    expect(suspendCancelMock).not.toHaveBeenCalled();
  });

  it("refuses without the club's name typed", async () => {
    const r = await decideClub("org-riverside", "suspend", "u-kemal", { now: NOW, confirmName: "Riverside" });
    expect(r).toMatchObject({ ok: false, reason: "confirm-mismatch" });
    expect(orgs["org-riverside"].approvalStatus).toBe("approved");
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("SUTTON FC CANNOT BE TURNED OFF OR LEFT FROM HERE, even with its name typed", async () => {
    const r = await decideClub("org-sutton", "suspend", "u-kemal", { now: NOW, confirmName: "Sutton FC" });
    expect(r).toMatchObject({ ok: false, reason: "not-self-join" });
    expect(orgs["org-sutton"]).toEqual(sutton());
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("leaveUnsolicitedGroup (the owner page's Leave button)", () => {
  it("queues a leave for an unsolicited group nobody owns", async () => {
    dbMock.unsolicitedGroup.findUnique.mockResolvedValue({ id: "ug-1", groupId: GROUP, leftAt: null });
    const r = await leaveUnsolicitedGroup("ug-1");
    expect(r).toEqual({ ok: true });
    expect(created("platformJob")).toEqual([expect.objectContaining({ kind: "leave-group", groupId: GROUP, refId: "ug-1" })]);
  });

  it("refuses when an approved club owns the group (a stale row naming Sutton FC's group)", async () => {
    dbMock.unsolicitedGroup.findUnique.mockResolvedValue({ id: "ug-2", groupId: SUTTON_GROUP, leftAt: null });
    const r = await leaveUnsolicitedGroup("ug-2");
    expect(r).toEqual({ ok: false, reason: "approved-club-group" });
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("refuses a row already left, or unknown", async () => {
    dbMock.unsolicitedGroup.findUnique.mockResolvedValue({ id: "ug-3", groupId: GROUP, leftAt: NOW });
    expect(await leaveUnsolicitedGroup("ug-3")).toEqual({ ok: false, reason: "already-left" });
    dbMock.unsolicitedGroup.findUnique.mockResolvedValue(null);
    expect(await leaveUnsolicitedGroup("nope")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("handleApproverDm: APPROVE / REJECT by WhatsApp", () => {
  const waiting = (rows: Array<{ code: string; orgId: string; name: string }>) =>
    rows.map((r) => ({ code: r.code, orgId: r.orgId, org: { name: r.name } }));

  beforeEach(() => {
    // Waiting clubs (group_linked, pending), then decided rows for a ref.
    dbMock.clubConnect.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.status === "group_linked" ? waiting([{ code: "7KQ2", orgId: "org-riverside", name: "Riverside FC" }]) : [],
    );
  });

  const dm = (text: string, over: Record<string, unknown> = {}) =>
    handleApproverDm({ text, phone: APPROVER, waMessageId: "wa-1", now: NOW, ...over });
  const ownerJobs = () => created("platformJob").filter((j) => j.purpose === "owner-ack");

  it("APPROVE <ref> from the approver approves and acks once", async () => {
    const r = await dm("approve 7kq2");
    expect(r).toMatchObject({ handled: "approver-dm", result: "approved" });
    expect(orgs["org-riverside"].approvalStatus).toBe("approved");
    expect(ownerJobs()).toEqual([
      expect.objectContaining({
        phone: APPROVER,
        refId: "dm:wa-1",
        text: "Approved Riverside FC. The hello goes out in the group within a few minutes.",
      }),
    ]);
    expect(dbMock.organisation.updateMany.mock.calls[0][0].data.approvalDecidedBy).toBe(`whatsapp:${APPROVER}`);
    expect(anthropicCalls.n).toBe(0);
  });

  it("REJECT <ref> rejects and acks", async () => {
    const r = await dm("REJECT 7KQ2");
    expect(r).toMatchObject({ result: "rejected" });
    expect(orgs["org-riverside"].approvalStatus).toBe("rejected");
    expect(ownerJobs()[0].text).toBe("Rejected Riverside FC. Leaving the group now.");
  });

  it("a bare APPROVE with one club waiting decides it; with two, it asks for the ref and decides nothing", async () => {
    expect(await dm("APPROVE")).toMatchObject({ result: "approved" });

    orgs["org-riverside"] = riverside();
    vi.clearAllMocks();
    dbMock.clubConnect.findMany.mockResolvedValue(
      waiting([
        { code: "7KQ2", orgId: "org-riverside", name: "Riverside FC" },
        { code: "9XT4", orgId: "org-hackney", name: "Hackney Weds" },
      ]),
    );
    const r = await dm("APPROVE", { waMessageId: "wa-2" });
    expect(r).toMatchObject({ result: "ambiguous" });
    expect(orgs["org-riverside"].approvalStatus).toBe("pending");
    expect(ownerJobs()[0].text).toBe("Two clubs are waiting: 7KQ2 Riverside FC, 9XT4 Hackney Weds. Reply APPROVE and the ref.");
  });

  it("an unknown ref decides nothing and lists what is waiting", async () => {
    const r = await dm("APPROVE ZZZZ");
    expect(r).toMatchObject({ result: "unknown-ref" });
    expect(orgs["org-riverside"].approvalStatus).toBe("pending");
    expect(ownerJobs()[0].text).toBe("No club waiting with ref ZZZZ. Waiting now: 7KQ2 Riverside FC.");
  });

  it("a ref already decided says when", async () => {
    dbMock.clubConnect.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.status === "group_linked"
        ? []
        : [
            {
              code: "7KQ2",
              org: { name: "Riverside FC", approvalStatus: "approved", approvalDecidedAt: new Date("2026-09-28T18:04:00Z") },
            },
          ],
    );
    const r = await dm("APPROVE 7KQ2");
    expect(r).toMatchObject({ result: "already" });
    expect(ownerJobs()[0].text).toBe("Riverside FC was already approved on 28 Sept at 19:04.");
  });

  it("the same WhatsApp message forwarded twice acks once", async () => {
    await dm("APPROVE 7KQ2");
    dbMock.platformJob.findFirst.mockResolvedValue({ id: "pj-1" });
    const before = ownerJobs().length;
    const again = await dm("APPROVE 7KQ2");
    expect(again).toMatchObject({ result: "already" });
    expect(ownerJobs().length).toBe(before);
  });

  it("the approver's alt phone counts when the chat id was a LID", async () => {
    const r = await dm("APPROVE 7KQ2", { phone: null, senderAltPhone: APPROVER });
    expect(r).toMatchObject({ result: "approved" });
  });

  it("A NON-APPROVER'S 'APPROVE 7KQ2' IS SWALLOWED: nothing decided, nothing sent, no model", async () => {
    for (const phone of [ALI, "447700900445", null]) {
      const r = await dm("APPROVE 7KQ2", { phone, senderAltPhone: null });
      expect(r).toEqual({ handled: "approver-dm", result: "not-approver" });
    }
    expect(orgs["org-riverside"].approvalStatus).toBe("pending");
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
    expect(anthropicCalls.n).toBe(0);
  });

  it("a non-approver's bare word, and anything that is not a command, is not this handler's", async () => {
    expect(await dm("approve", { phone: ALI })).toBeNull();
    expect(await dm("IN")).toBeNull();
    expect(await dm("please approve 7KQ2")).toBeNull();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("with no approver configured, nobody is an approver", async () => {
    delete process.env.SELF_JOIN_APPROVER_PHONES;
    expect(await dm("APPROVE 7KQ2")).toEqual({ handled: "approver-dm", result: "not-approver" });
    expect(orgs["org-riverside"].approvalStatus).toBe("pending");
  });
});
