/**
 * Partner requests, the writer (partner discovery, slice P3, 2026-10-22).
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 3.1 to 3.5.
 *
 * Against an in-memory stand-in for the three tables, with a real mutex
 * for Postgres's transaction-scoped advisory lock, so the 20-a-day cap is
 * tested under concurrency: two sends at once at 19 sent make exactly one
 * more request, and without the lock the test fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  askerOrgId: string;
  partnerOrgId: string;
  status: string;
  origin: string;
  partnerApproval: string;
  askerAcceptedAt: Date | null;
  askerAcceptedBy: string | null;
  partnerAcceptedAt: Date | null;
  partnerAcceptedBy: string | null;
  pausedByOrgId: string | null;
  createdByUserId: string;
  expiresAt: Date | null;
  endedAt: Date | null;
  endedByOrgId: string | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  blocks: [] as Array<{ blockerOrgId: string; blockedOrgId: string; createdByUserId: string }>,
  orgs: new Map<string, Record<string, unknown>>(),
  members: new Map<string, number>(),
  seq: 0,
  lockCalls: [] as string[],
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── A tiny where-matcher for the fields the writer filters on ──
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
      continue;
    }
    const val = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as Record<string, unknown>;
      if ("in" in op && !(op.in as unknown[]).includes(val)) return false;
      if ("not" in op && (op.not === null ? val === null || val === undefined : val === op.not)) return false;
      if ("gte" in op && !(val instanceof Date && val.getTime() >= (op.gte as Date).getTime())) return false;
      if ("lte" in op && !(val instanceof Date && val.getTime() <= (op.lte as Date).getTime())) return false;
      continue;
    }
    if (v instanceof Date) {
      if (!(val instanceof Date) || val.getTime() !== v.getTime()) return false;
      continue;
    }
    if (val !== v && !(v === null && val === undefined)) return false;
  }
  return true;
}

const held = new Map<string, Promise<void>>();
async function acquire(key: string): Promise<() => void> {
  while (held.has(key)) await held.get(key);
  let release!: () => void;
  held.set(key, new Promise<void>((r) => (release = r)));
  return () => {
    held.delete(key);
    release();
  };
}

const partnershipApi = {
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.rows.find((r) => r.id === where.id) ?? null),
  findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
    await tick();
    return store.rows
      .filter((r) => matches(r as unknown as Record<string, unknown>, where))
      .map((r) => ({ ...r, askerOrg: store.orgs.get(r.askerOrgId), partnerOrg: store.orgs.get(r.partnerOrgId) }));
  }),
  count: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
    await tick();
    return store.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where)).length;
  }),
  create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    await tick();
    if (store.rows.some((r) => r.askerOrgId === data.askerOrgId && r.partnerOrgId === data.partnerOrgId)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    const now = new Date();
    const row: Row = {
      id: `p${++store.seq}`,
      status: "proposed",
      origin: "owner",
      partnerApproval: "standing",
      askerAcceptedAt: null,
      askerAcceptedBy: null,
      partnerAcceptedAt: null,
      partnerAcceptedBy: null,
      pausedByOrgId: null,
      createdByUserId: "x",
      expiresAt: null,
      endedAt: null,
      endedByOrgId: null,
      endReason: null,
      createdAt: now,
      updatedAt: now,
      askerOrgId: "",
      partnerOrgId: "",
      ...data,
    } as Row;
    store.rows.push(row);
    return { id: row.id };
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    await tick();
    const hit = store.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  }),
};

const blockApi = {
  findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
    store.blocks
      .filter((b) => matches(b as unknown as Record<string, unknown>, where))
      .map((b) => ({ ...b, blockedOrg: store.orgs.get(b.blockedOrgId) })),
  ),
  findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => store.blocks.find((b) => matches(b as unknown as Record<string, unknown>, where)) ?? null),
  create: vi.fn(async ({ data }: { data: { blockerOrgId: string; blockedOrgId: string; createdByUserId: string } }) => {
    if (store.blocks.some((b) => b.blockerOrgId === data.blockerOrgId && b.blockedOrgId === data.blockedOrgId)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    store.blocks.push(data);
    return data;
  }),
  deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const before = store.blocks.length;
    store.blocks = store.blocks.filter((b) => !matches(b as unknown as Record<string, unknown>, where));
    return { count: before - store.blocks.length };
  }),
};

const dbMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
const hqLogMock = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../admin-group-log", () => hqLogMock);

import { actOnPartnership, blockClub, requestPartnerships, runPartnerRequestExpirySweep, unblockClub, withdrawRequest } from "../club-partnership";

const NOW = new Date("2026-10-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function org(id: string, name: string, over: Record<string, unknown> = {}) {
  store.orgs.set(id, {
    id,
    name,
    language: "en",
    discoverable: true,
    autoAcceptPartnerRequests: false,
    approvalStatus: "approved",
    homeVenue: null,
    activities: [],
    ...over,
  });
}

/** The texts each club was told, by club. */
function told(orgId: string): string[] {
  return noticeMock.sendAdminNotice.mock.calls
    .map((c) => c[0] as { orgId: string; text: string | ((l: string, a: string) => string) })
    .filter((n) => n.orgId === orgId)
    .map((n) => (typeof n.text === "string" ? n.text : n.text("LINK", "dm")));
}

/** Rows as if sent earlier today by FNF, to fill the day's allowance. */
function sentEarlier(n: number) {
  for (let i = 0; i < n; i++) {
    org(`old${i}`, `Old ${i}`);
    store.rows.push({
      id: `old-${i}`,
      askerOrgId: "fnf",
      partnerOrgId: `old${i}`,
      status: "ended",
      origin: "request",
      partnerApproval: "standing",
      askerAcceptedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      askerAcceptedBy: "u1",
      partnerAcceptedAt: null,
      partnerAcceptedBy: null,
      pausedByOrgId: null,
      createdByUserId: "u1",
      expiresAt: null,
      endedAt: NOW,
      endedByOrgId: "fnf",
      endReason: "withdrawn",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [];
  store.blocks = [];
  store.orgs.clear();
  store.seq = 0;
  store.lockCalls = [];
  held.clear();
  Object.assign(dbMock, {
    clubPartnership: partnershipApi,
    clubBlock: blockApi,
    organisation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.orgs.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => store.orgs.get(id)).filter(Boolean)),
    },
    membership: { count: vi.fn(async ({ where }: { where: { orgId: string } }) => store.members.get(where.orgId) ?? 0) },
    user: { findUnique: vi.fn(async () => ({ name: "Ayse" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = {
        ...dbMock,
        $executeRaw: async (_s: TemplateStringsArray, key: string) => {
          store.lockCalls.push(key);
          releases.push(await acquire(key));
          return 1;
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const r of releases) r();
      }
    }),
  });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  org("fnf", "FNF", {
    homeVenue: null,
    activities: [{ isActive: true, dayOfWeek: 2, time: "20:00", venueRef: { lat: 51.36, lng: -0.19 }, sport: { playersPerTeam: 7 } }],
  });
  store.members.set("fnf", 24);
  org("sutton", "Sutton FC", { activities: [{ isActive: true, dayOfWeek: 4, time: "19:00", venueRef: { lat: 51.39, lng: -0.2 }, sport: { playersPerTeam: 9 } }] });
  org("cheam", "Cheam Lads", { language: "tr" });
});

const send = (ids: string[], over: Record<string, unknown> = {}) =>
  requestPartnerships({ askerOrgId: "fnf", userId: "u1", role: "ADMIN", partnerOrgIds: ids, now: NOW, ...over });

describe("sending", () => {
  it("one row per club, asking club's consent on it, 14 days to answer, asks posted without asking by default", async () => {
    const r = await send(["sutton", "cheam"]);
    expect(r.results.map((x) => [x.partnerOrgId, x.outcome])).toEqual([
      ["sutton", "sent"],
      ["cheam", "sent"],
    ]);
    expect(r.capped).toBe(false);
    const row = store.rows.find((x) => x.partnerOrgId === "sutton")!;
    expect(row).toMatchObject({
      askerOrgId: "fnf",
      status: "proposed",
      origin: "request",
      partnerApproval: "standing",
      askerAcceptedAt: NOW,
      askerAcceptedBy: "u1",
      partnerAcceptedAt: null,
      createdByUserId: "u1",
      expiresAt: new Date(NOW.getTime() + 14 * DAY),
    });
  });

  it("the other club's organisers get the request notice, tagged for a reply, with the card and the unchanged ending", async () => {
    await send(["sutton", "cheam"]);
    const sutton = store.rows.find((x) => x.partnerOrgId === "sutton")!;
    const call = noticeMock.sendAdminNotice.mock.calls.find((c) => c[0].orgId === "sutton")![0];
    expect(call.aboutKey).toBe(`pairing:${sutton.id}:sutton`);
    expect(call.nextPath).toBe("/admin/settings#partner-clubs");
    const text = told("sutton")[0];
    expect(text).toContain("*FNF* (");
    expect(text).toContain("miles away");
    expect(text).toContain("Tuesdays 20:00, 7-a-side");
    expect(text).toContain("24 members");
    expect(text).toContain("would like to ask *Sutton FC* for players when they are short");
    expect(text.endsWith("Reply *1* to accept or *2* to decline, or open LINK")).toBe(true);
    // In the club's own language, with no distance when it has no venue.
    const tr = told("cheam")[0];
    expect(tr).toContain("Salı günleri 20:00");
    expect(tr).not.toContain("mil uzakta");
    expect(tr).toContain("Kabul etmek için *1*, reddetmek için *2* yazın ya da şunu açın: LINK");
    // The asking club is not told it sent something.
    expect(told("fnf")).toEqual([]);
    // Never a phone number in the card.
    expect(text).not.toMatch(/\+?\d{10,}/);
  });

  it("in an admin group the notice is logged as MatchTime's question, so a reply quoting it is about it", async () => {
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "admin-group", queued: 1, groupText: "GROUP TEXT" });
    await send(["sutton"]);
    expect(hqLogMock.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ orgId: "sutton", text: "GROUP TEXT", askRef: expect.stringMatching(/^pairing:p\d+:sutton$/) }));
  });

  it("each refusal is reported per club and writes nothing", async () => {
    org("blocker", "Blocker FC");
    store.blocks.push({ blockerOrgId: "blocker", blockedOrgId: "fnf", createdByUserId: "x" });
    org("hidden", "Hidden FC", { discoverable: false });
    org("decliner", "Decliner FC");
    store.rows.push({ ...store.rows[0], ...({} as Row), id: "d1", askerOrgId: "fnf", partnerOrgId: "decliner", status: "ended", origin: "request", partnerApproval: "standing", askerAcceptedAt: new Date(NOW.getTime() - 3 * DAY), askerAcceptedBy: "u1", partnerAcceptedAt: null, partnerAcceptedBy: null, pausedByOrgId: null, createdByUserId: "u1", expiresAt: null, endedAt: new Date(NOW.getTime() - 2 * DAY), endedByOrgId: "decliner", endReason: "declined", createdAt: NOW, updatedAt: NOW });
    const r = await send(["blocker", "hidden", "decliner", "nowhere", "fnf"]);
    expect(Object.fromEntries(r.results.map((x) => [x.partnerOrgId, x.outcome === "refused" ? x.refusal : x.outcome]))).toEqual({
      blocker: "blocked",
      hidden: "not-listed",
      decliner: "cooldown",
      nowhere: "no-club",
      fnf: "same-club",
    });
    expect(store.rows.filter((x) => x.status === "proposed")).toEqual([]);
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a second request to the same club is refused as pending; after 30 days a declined one reopens", async () => {
    await send(["sutton"]);
    expect((await send(["sutton"])).results[0]).toMatchObject({ outcome: "refused", refusal: "already-pending" });
    const row = store.rows.find((x) => x.partnerOrgId === "sutton")!;
    Object.assign(row, { status: "ended", endReason: "declined", endedByOrgId: "sutton", endedAt: new Date(NOW.getTime() - 31 * DAY), askerAcceptedAt: new Date(NOW.getTime() - 32 * DAY) });
    const again = await send(["sutton"]);
    expect(again.results[0].outcome).toBe("sent");
    expect(store.rows.filter((x) => x.partnerOrgId === "sutton")).toHaveLength(1);
    expect(row).toMatchObject({ status: "proposed", endReason: null, endedAt: null, endedByOrgId: null, askerAcceptedAt: NOW, partnerApproval: "standing" });
  });

  it("a PLAYER cannot send", async () => {
    const r = await send(["sutton"], { role: "PLAYER" });
    expect(r.results[0]).toMatchObject({ outcome: "refused", refusal: "not-admin" });
    expect(store.rows).toEqual([]);
  });

  it("'select all' past the day's 20: the first (nearest) ones go, the rest are refused, and it says so", async () => {
    sentEarlier(18);
    const r = await send(["sutton", "cheam", "x3"].map((id) => (id === "x3" ? (org("x3", "X3"), id) : id)));
    expect(r.results.map((x) => x.outcome)).toEqual(["sent", "sent", "refused"]);
    expect(r.results[2]).toMatchObject({ refusal: "daily-cap" });
    expect(r.capped).toBe(true);
    expect(r.sent).toBe(2);
  });

  it("50 waiting: refused as pending-cap", async () => {
    for (let i = 0; i < 50; i++) {
      org(`w${i}`, `W ${i}`);
      store.rows.push({ ...({} as Row), id: `w-${i}`, askerOrgId: "fnf", partnerOrgId: `w${i}`, status: "proposed", origin: "request", partnerApproval: "standing", askerAcceptedAt: new Date(NOW.getTime() - 2 * DAY), askerAcceptedBy: "u1", partnerAcceptedAt: null, partnerAcceptedBy: null, pausedByOrgId: null, createdByUserId: "u1", expiresAt: NOW, endedAt: null, endedByOrgId: null, endReason: null, createdAt: NOW, updatedAt: NOW });
    }
    expect((await send(["sutton"])).results[0]).toMatchObject({ outcome: "refused", refusal: "pending-cap" });
  });

  it("THE CAP UNDER CONCURRENCY: two sends at once with 19 sent today make exactly one more request", async () => {
    sentEarlier(19);
    const [a, b] = await Promise.all([send(["sutton"]), send(["cheam"], { userId: "u2" })]);
    const sent = [...a.results, ...b.results].filter((x) => x.outcome === "sent");
    expect(sent).toHaveLength(1);
    expect(store.rows.filter((x) => x.status === "proposed")).toHaveLength(1);
    // Serialised by one lock per asking club.
    expect(store.lockCalls).toEqual(["club-request:fnf", "club-request:fnf"]);
  });
});

describe("accepting automatically", () => {
  it("auto-accept on: active at once, the club's organisers told who joined, the asking club told it was accepted", async () => {
    org("sutton", "Sutton FC", { autoAcceptPartnerRequests: true });
    const r = await send(["sutton"]);
    expect(r.results[0].outcome).toBe("active");
    const row = store.rows[0];
    expect(row).toMatchObject({ status: "active", partnerAcceptedAt: NOW, expiresAt: null, partnerApproval: "standing" });
    expect(told("sutton")).toEqual([expect.stringContaining("*FNF* is now a partner club of *Sutton FC*")]);
    // Not tagged as a question: nothing is waiting for an answer.
    expect(noticeMock.sendAdminNotice.mock.calls.find((c) => c[0].orgId === "sutton")![0].aboutKey).toBeUndefined();
    expect(told("fnf")).toEqual([expect.stringContaining("*Sutton FC* accepted *FNF*'s request")]);
  });
});

describe("answering", () => {
  beforeEach(async () => {
    await send(["sutton"]);
    vi.clearAllMocks();
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  });
  const id = () => store.rows[0].id;

  it("an ADMIN of the club accepts: active in one step with the chosen per-ask choice; the asking club and the owners are told", async () => {
    const r = await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u9", role: "ADMIN", action: "accept", approval: "each-ask", now: NOW });
    expect(r).toEqual({ ok: true, status: "active" });
    expect(store.rows[0]).toMatchObject({ status: "active", partnerAcceptedBy: "u9", partnerApproval: "each-ask" });
    expect(told("fnf")).toEqual([expect.stringContaining("*Sutton FC* accepted *FNF*'s request")]);
    const own = noticeMock.sendAdminNotice.mock.calls.find((c) => c[0].orgId === "sutton")![0];
    expect(own.excludeUserId).toBe("u9");
    expect(told("sutton")).toEqual([expect.stringContaining("Ayse accepted *FNF*'s request")]);
  });

  it("an OWNER accepts: the asking club is told; no notice to the owners about themselves", async () => {
    await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u8", role: "OWNER", action: "accept", now: NOW });
    expect(store.rows[0]).toMatchObject({ status: "active", partnerApproval: "standing" });
    expect(told("fnf")).toHaveLength(1);
    expect(told("sutton")).toEqual([]);
  });

  it("a decline records why, so the 30-day wait works, and the asking club is told", async () => {
    await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u8", role: "ADMIN", action: "decline", now: NOW });
    expect(store.rows[0]).toMatchObject({ status: "ended", endReason: "declined", endedByOrgId: "sutton", endedAt: NOW });
    expect(told("fnf")).toEqual(["*Sutton FC* is not taking requests right now."]);
    expect((await send(["sutton"])).results[0]).toMatchObject({ outcome: "refused", refusal: "cooldown" });
  });

  it("a PLAYER cannot accept", async () => {
    expect(await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u7", role: "PLAYER", action: "accept", now: NOW })).toEqual({ ok: false, refusal: "admin-only" });
  });

  it("the asking club withdraws: ended as withdrawn, and the other club is not messaged", async () => {
    expect(await withdrawRequest({ partnershipId: id(), orgId: "fnf", userId: "u1", role: "ADMIN", now: NOW })).toEqual({ ok: true, status: "ended" });
    expect(store.rows[0]).toMatchObject({ status: "ended", endReason: "withdrawn" });
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
    // No wait after a withdrawal.
    expect((await send(["sutton"])).results[0].outcome).toBe("sent");
  });

  it("once active, the partner ending it makes the asking club wait 30 days; the asking club ending it does not", async () => {
    await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u8", role: "OWNER", action: "accept", now: NOW });
    await actOnPartnership({ partnershipId: id(), orgId: "sutton", userId: "u8", role: "ADMIN", action: "end", now: NOW });
    expect((await send(["sutton"])).results[0]).toMatchObject({ refusal: "cooldown" });
  });
});

describe("blocking", () => {
  it("the club blocks the asker from the request: the request ends as blocked and no new one can be sent; unblock lets it send again", async () => {
    await send(["sutton"]);
    expect(await blockClub({ blockerOrgId: "sutton", blockedOrgId: "fnf", userId: "u8", role: "ADMIN", now: NOW })).toEqual({ ok: true });
    expect(store.blocks).toEqual([{ blockerOrgId: "sutton", blockedOrgId: "fnf", createdByUserId: "u8" }]);
    expect(store.rows[0]).toMatchObject({ status: "ended", endReason: "blocked", endedByOrgId: "sutton" });
    expect((await send(["sutton"])).results[0]).toMatchObject({ refusal: "blocked" });
    // Blocking twice is fine.
    expect(await blockClub({ blockerOrgId: "sutton", blockedOrgId: "fnf", userId: "u8", role: "ADMIN", now: NOW })).toEqual({ ok: true });
    expect(await unblockClub({ blockerOrgId: "sutton", blockedOrgId: "fnf", role: "OWNER" })).toEqual({ ok: true });
    expect((await send(["sutton"])).results[0].outcome).toBe("sent");
  });

  it("a PLAYER cannot block, and a club cannot block itself", async () => {
    expect(await blockClub({ blockerOrgId: "sutton", blockedOrgId: "fnf", userId: "u", role: "PLAYER", now: NOW })).toEqual({ ok: false, refusal: "not-admin" });
    expect(await blockClub({ blockerOrgId: "sutton", blockedOrgId: "sutton", userId: "u", role: "OWNER", now: NOW })).toEqual({ ok: false, refusal: "same-club" });
    expect(await unblockClub({ blockerOrgId: "sutton", blockedOrgId: "fnf", role: "PLAYER" })).toEqual({ ok: false, refusal: "not-admin" });
  });
});

describe("expiry", () => {
  it("after 14 days the request ends as expired and the asking club is told ONCE, however many sweeps run", async () => {
    await send(["sutton"]);
    vi.clearAllMocks();
    noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
    const later = new Date(NOW.getTime() + 14 * DAY + 1000);
    expect(await runPartnerRequestExpirySweep(new Date(NOW.getTime() + 13 * DAY))).toEqual({ considered: 0, expired: 0 });
    const [a, b] = await Promise.all([runPartnerRequestExpirySweep(later), runPartnerRequestExpirySweep(later)]);
    expect(a.expired + b.expired).toBe(1);
    expect(await runPartnerRequestExpirySweep(later)).toEqual({ considered: 0, expired: 0 });
    expect(store.rows[0]).toMatchObject({ status: "ended", endReason: "expired", endedByOrgId: null });
    expect(told("fnf")).toEqual([expect.stringContaining("Your request to *Sutton FC* had no answer in 14 days")]);
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].nextPath).toBe("/admin/partners/find");
    expect(told("sutton")).toEqual([]);
    // No wait after an expiry.
    expect((await send(["sutton"], { now: later })).results[0].outcome).toBe("sent");
  });
});
