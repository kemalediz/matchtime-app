import { beforeAll, describe, expect, it } from "vitest";
import { friendLinkIdFromToken, friendLinkPath, friendLinkToken, FRIEND_LINK_PATH_PREFIX } from "../token";
import { poolOfferToken } from "../../pool/offer-token";

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-friend-link";
});

describe("friend link token", () => {
  it("round trips", () => {
    expect(friendLinkIdFromToken(friendLinkToken("clfriend1"))).toBe("clfriend1");
    expect(friendLinkPath("clfriend1")).toBe(`${FRIEND_LINK_PATH_PREFIX}${friendLinkToken("clfriend1")}`);
    expect(FRIEND_LINK_PATH_PREFIX).toBe("/play/f/");
  });
  it("refuses a tampered token, another id's signature and junk", () => {
    const t = friendLinkToken("clfriend1");
    expect(friendLinkIdFromToken(t.slice(0, -2) + "xx")).toBeNull();
    expect(friendLinkIdFromToken(`clfriend2.${t.split(".")[1]}`)).toBeNull();
    expect(friendLinkIdFromToken("")).toBeNull();
    expect(friendLinkIdFromToken("a.b.c")).toBeNull();
    expect(friendLinkIdFromToken(null as unknown as string)).toBeNull();
  });
  it("a pool offer token never passes as a friend link token", () => {
    expect(friendLinkIdFromToken(poolOfferToken("clfriend1"))).toBeNull();
  });
});
