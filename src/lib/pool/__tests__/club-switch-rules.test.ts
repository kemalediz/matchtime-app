/**
 * Where the once-ever "the pool is on" message goes (2026-10-28, Kemal):
 * a club with an admin group (HQ) is told there, through its admin channel,
 * as before; a club with only its players' group is told IN that group,
 * worded for everyone; a club with neither falls back to the admin DMs.
 * The players' group post has its own once-ever key, so a club told by DM
 * before this change still gets the group post next time.
 */
import { describe, expect, it } from "vitest";
import { POOL_ON_GROUP_KIND, POOL_ON_NOTICE_KIND, poolOnGroupKey, poolOnNoticeKey } from "../club-switch-rules";

// The route itself is the shared rule, `club-notice-route-rules.ts`
// (src/lib/__tests__/club-notice-route-rules.test.ts).

describe("the once-ever keys", () => {
  it("the admin channel keeps the existing key; the players' group has its own", () => {
    expect(poolOnNoticeKey("o1")).toBe(`org-o1:${POOL_ON_NOTICE_KIND}`);
    expect(poolOnGroupKey("o1")).toBe(`org-o1:${POOL_ON_GROUP_KIND}`);
    expect(poolOnGroupKey("o1")).not.toBe(poolOnNoticeKey("o1"));
  });
});
