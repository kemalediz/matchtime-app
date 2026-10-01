/**
 * Door 1 of organiser pick (slice 2b, plan 2.8): a DM engages only for a
 * sender who, BY PHONE, is an owner or admin of an organiser-pick club and
 * was asked on an open round. Everything else returns null and the DM
 * falls through to its other handlers untouched. Nothing here reaches a
 * model. The end-to-end reading of the reply is in
 * e2e/api/organiser-pick.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openRound: null as null | { id: string },
  users: [] as Array<{ id: string; phoneNumber: string }>,
  memberships: [] as Array<{ orgId: string }>,
  calls: [] as string[],
}));

vi.mock("../db", () => ({
  db: {
    organiserPickRound: {
      findFirst: async () => {
        h.calls.push("organiserPickRound.findFirst");
        return h.openRound;
      },
      findMany: async () => [],
    },
    user: {
      findMany: async ({ where }: { where: { phoneNumber: { in: string[] } } }) => {
        h.calls.push(`user.findMany:${where.phoneNumber.in.join(",")}`);
        return h.users.filter((u) => where.phoneNumber.in.includes(u.phoneNumber));
      },
    },
    membership: {
      findMany: async () => {
        h.calls.push("membership.findMany");
        return h.memberships;
      },
    },
    organisation: { findUnique: async () => ({ id: "org1", benchPickMode: "organiser", language: "en" }) },
    sentNotification: { create: async () => ({}), deleteMany: async () => ({ count: 1 }) },
  },
}));

import { handleOrganiserPickDm } from "../organiser-pick";

beforeEach(() => {
  h.openRound = { id: "r1" };
  h.users = [{ id: "u-hamzah", phoneNumber: "+447700940001" }];
  h.memberships = [];
  h.calls = [];
});

describe("handleOrganiserPickDm", () => {
  it("no phone (a pushname is never an identity): null, and no lookup", async () => {
    expect(await handleOrganiserPickDm({ phone: null, text: "2", waMessageId: "m1" })).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("no round open anywhere: null after one cheap read", async () => {
    h.openRound = null;
    expect(await handleOrganiserPickDm({ phone: "447700940001", text: "2", waMessageId: "m1" })).toBeNull();
    expect(h.calls).toEqual(["organiserPickRound.findFirst"]);
  });

  it("a phone that is nobody's: null", async () => {
    expect(await handleOrganiserPickDm({ phone: "447700999999", text: "2", waMessageId: "m1" })).toBeNull();
  });

  it("a known player who is not an admin of an organiser-pick club: null (the digits fall through)", async () => {
    h.memberships = [];
    expect(await handleOrganiserPickDm({ phone: "447700940001", text: "2", waMessageId: "m1" })).toBeNull();
    expect(h.calls).toContain("user.findMany:+447700940001");
  });

  it("an admin not asked on any open round: falls through (the round lookup finds nothing for them)", async () => {
    h.memberships = [{ orgId: "org1" }];
    expect(await handleOrganiserPickDm({ phone: "447700940001", text: "2", waMessageId: "m1" })).toBeNull();
  });
});
