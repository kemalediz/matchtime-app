/**
 * Self-join slice 4: issuing a connect code (plan sections 4.2, 5.2 and
 * cap 5 of section 7: 1 live per club, 60 minutes, 3 a day), and the
 * server-only MatchTime number.
 *
 * db is mocked (the transaction hands back the same mock). No network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  organisation: { findUnique: vi.fn() },
  clubConnect: {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    ...tx,
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

import { issueConnectCode, matchtimeWaNumber } from "../club-connect";
import { CONNECT_CODE_TTL_MS } from "../club-connect-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const ARGS = { orgId: "org-1", userId: "user-1", phone: "+447700900123", now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  tx.organisation.findUnique.mockResolvedValue({ approvalStatus: "draft" });
  tx.clubConnect.updateMany.mockResolvedValue({ count: 0 });
  tx.clubConnect.findFirst.mockResolvedValue(null);
  tx.clubConnect.count.mockResolvedValue(0);
  tx.clubConnect.create.mockImplementation(async ({ data }: { data: { code: string } }) => ({ id: "cc-1", ...data }));
});

describe("issueConnectCode", () => {
  it("issues a fresh 4-character code for 60 minutes, bound to the organiser's digits", async () => {
    const res = await issueConnectCode(ARGS);
    expect(res).toMatchObject({ ok: true, reused: false });
    const data = tx.clubConnect.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ orgId: "org-1", userId: "user-1", phone: "447700900123", status: "issued" });
    expect(data.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(data.issuedAt).toEqual(NOW);
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + CONNECT_CODE_TTL_MS));
    if (res.ok) expect(res.code).toBe(data.code);
  });

  it("serialises per club with an advisory lock, so two taps cannot make two live codes", async () => {
    await issueConnectCode(ARGS);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("expires stale rows first: issued past 60 minutes, and DM-verified past the 24-hour add window", async () => {
    await issueConnectCode(ARGS);
    const wheres = tx.clubConnect.updateMany.mock.calls.map((c) => c[0]);
    expect(wheres).toContainEqual({
      where: { orgId: "org-1", status: "issued", expiresAt: { lte: NOW } },
      data: { status: "expired" },
    });
    expect(wheres).toContainEqual({
      where: { orgId: "org-1", status: "dm_verified", addWindowEndsAt: { lte: NOW } },
      data: { status: "expired" },
    });
  });

  it("one live code per club: a second tap reuses it and does not count against the day", async () => {
    tx.clubConnect.findFirst.mockResolvedValue({ status: "issued", code: "7KQ2" });
    expect(await issueConnectCode(ARGS)).toEqual({ ok: true, code: "7KQ2", reused: true });
    expect(tx.clubConnect.create).not.toHaveBeenCalled();
  });

  it("already connected by DM: no new code", async () => {
    tx.clubConnect.findFirst.mockResolvedValue({ status: "dm_verified", code: "7KQ2" });
    expect(await issueConnectCode(ARGS)).toEqual({ ok: false, reason: "already-connected" });
    expect(tx.clubConnect.create).not.toHaveBeenCalled();
  });

  it("3 codes a day per club (London day): the fourth is refused", async () => {
    tx.clubConnect.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "issuedAt" in where ? 3 : 0,
    );
    expect(await issueConnectCode(ARGS)).toEqual({ ok: false, reason: "code-cap" });
    const dayWhere = tx.clubConnect.count.mock.calls.find((c) => "issuedAt" in c[0].where)![0].where;
    expect(dayWhere).toEqual({ orgId: "org-1", issuedAt: { gte: new Date("2026-09-28T23:00:00.000Z") } });
    expect(tx.clubConnect.create).not.toHaveBeenCalled();
  });

  it("two codes today is fine", async () => {
    tx.clubConnect.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "issuedAt" in where ? 2 : 0,
    );
    expect(await issueConnectCode(ARGS)).toMatchObject({ ok: true });
  });

  it("a code is unique among live requests: a clash is re-rolled", async () => {
    let clashes = 2;
    tx.clubConnect.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "code" in where ? (clashes-- > 0 ? 1 : 0) : 0,
    );
    expect(await issueConnectCode(ARGS)).toMatchObject({ ok: true });
    const codeChecks = tx.clubConnect.count.mock.calls.filter((c) => "code" in c[0].where);
    expect(codeChecks).toHaveLength(3);
    expect(codeChecks[0][0].where.status).toEqual({ in: ["issued", "dm_verified", "group_linked"] });
  });

  it("only a draft club gets a code", async () => {
    for (const approvalStatus of ["pending", "approved", "rejected", "suspended"]) {
      tx.organisation.findUnique.mockResolvedValue({ approvalStatus });
      expect(await issueConnectCode(ARGS)).toEqual({ ok: false, reason: "not-draft" });
    }
    tx.organisation.findUnique.mockResolvedValue(null);
    expect(await issueConnectCode(ARGS)).toEqual({ ok: false, reason: "not-draft" });
    expect(tx.clubConnect.create).not.toHaveBeenCalled();
  });

  it("an organiser with no usable phone gets no code", async () => {
    expect(await issueConnectCode({ ...ARGS, phone: null })).toEqual({ ok: false, reason: "no-phone" });
    expect(await issueConnectCode({ ...ARGS, phone: "not a phone" })).toEqual({ ok: false, reason: "no-phone" });
  });
});

describe("matchtimeWaNumber: server-only, digits only", () => {
  it("reads MATCHTIME_WA_NUMBER and strips everything but digits", () => {
    expect(matchtimeWaNumber({ MATCHTIME_WA_NUMBER: "+44 7700 900777" })).toBe("447700900777");
  });
  it("null when unset or not a plausible number", () => {
    expect(matchtimeWaNumber({})).toBeNull();
    expect(matchtimeWaNumber({ MATCHTIME_WA_NUMBER: "" })).toBeNull();
    expect(matchtimeWaNumber({ MATCHTIME_WA_NUMBER: "12345" })).toBeNull();
  });
  it("never reads a NEXT_PUBLIC_ variant", () => {
    expect(matchtimeWaNumber({ NEXT_PUBLIC_MATCHTIME_WA_NUMBER: "447700900777" })).toBeNull();
  });
});
