import { beforeAll, describe, expect, it } from "vitest";
import {
  PARTNER_INVITE_LINK_TTL_DAYS,
  PARTNER_INVITE_PATH_PREFIX,
  partnerInvitePath,
  partnerInviteToken,
  readPartnerInviteToken,
} from "../partner-invite-token";
import { poolOfferToken } from "../offer-token";
import { friendLinkToken } from "../../friend-link/token";

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-partner-invite";
});

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;

describe("the partner pool invite token", () => {
  it("names his user id until it runs out, 14 days after it was made", () => {
    expect(PARTNER_INVITE_LINK_TTL_DAYS).toBe(14);
    const t = partnerInviteToken("cluser1", NOW);
    expect(readPartnerInviteToken(t, NOW)).toEqual({ kind: "ok", userId: "cluser1" });
    expect(readPartnerInviteToken(t, new Date(NOW.getTime() + 14 * DAY - 1000))).toEqual({ kind: "ok", userId: "cluser1" });
    expect(readPartnerInviteToken(t, new Date(NOW.getTime() + 14 * DAY))).toEqual({ kind: "expired" });
  });

  it("the path is /play/j/<token>", () => {
    expect(PARTNER_INVITE_PATH_PREFIX).toBe("/play/j/");
    expect(partnerInvitePath("cluser1", NOW)).toBe(`/play/j/${partnerInviteToken("cluser1", NOW)}`);
  });

  it("refuses a tampered token: another user, a later expiry, another signature, junk", () => {
    const [id, exp, sig] = partnerInviteToken("cluser1", NOW).split(".");
    const later = (Number.parseInt(exp, 36) + 30 * DAY).toString(36);
    expect(readPartnerInviteToken(`cluser2.${exp}.${sig}`, NOW)).toEqual({ kind: "invalid" });
    expect(readPartnerInviteToken(`${id}.${later}.${sig}`, NOW)).toEqual({ kind: "invalid" });
    expect(readPartnerInviteToken(`${id}.${exp}.${sig.slice(0, -2)}xx`, NOW)).toEqual({ kind: "invalid" });
    for (const junk of ["", "a.b", "a.b.c.d", "../x.y.z", null, undefined, 42]) {
      expect(readPartnerInviteToken(junk as unknown as string, NOW)).toEqual({ kind: "invalid" });
    }
  });

  it("an expired token says nothing about whose it was", () => {
    const t = partnerInviteToken("cluser1", new Date(NOW.getTime() - 20 * DAY));
    expect(readPartnerInviteToken(t, NOW)).toEqual({ kind: "expired" });
  });

  it("single-purpose: an offer or friend link token never passes, and this one passes as neither", () => {
    expect(readPartnerInviteToken(poolOfferToken("cluser1"), NOW)).toEqual({ kind: "invalid" });
    expect(readPartnerInviteToken(friendLinkToken("cluser1"), NOW)).toEqual({ kind: "invalid" });
  });
});
