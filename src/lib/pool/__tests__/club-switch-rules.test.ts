/**
 * Where the once-ever "the pool is on" message goes (2026-10-28, Kemal):
 * a club with an admin group (HQ) is told there, through its admin channel,
 * as before; a club with only its players' group is told IN that group,
 * worded for everyone; a club with neither falls back to the admin DMs.
 * The players' group post has its own once-ever key, so a club told by DM
 * before this change still gets the group post next time.
 */
import { describe, expect, it } from "vitest";
import { POOL_ON_GROUP_KIND, POOL_ON_NOTICE_KIND, poolOnGroupKey, poolOnNoticeKey, poolOnRoute } from "../club-switch-rules";

const base = { adminGroupId: null, whatsappGroupId: "g@g.us", whatsappBotEnabled: true, playersGroupPostable: true };

describe("poolOnRoute", () => {
  it("a linked admin group: the admin channel, whatever the players' group", () => {
    expect(poolOnRoute({ ...base, adminGroupId: "hq@g.us" })).toBe("admin-channel");
    expect(poolOnRoute({ ...base, adminGroupId: "hq@g.us", whatsappGroupId: null })).toBe("admin-channel");
  });

  it("no admin group and a postable players' group: the players' group", () => {
    expect(poolOnRoute(base)).toBe("players-group");
  });

  it("no admin group and no postable players' group: the admin channel (DMs)", () => {
    expect(poolOnRoute({ ...base, whatsappGroupId: null })).toBe("admin-channel");
    expect(poolOnRoute({ ...base, whatsappBotEnabled: false })).toBe("admin-channel");
    expect(poolOnRoute({ ...base, playersGroupPostable: false })).toBe("admin-channel");
  });
});

describe("the once-ever keys", () => {
  it("the admin channel keeps the existing key; the players' group has its own", () => {
    expect(poolOnNoticeKey("o1")).toBe(`org-o1:${POOL_ON_NOTICE_KIND}`);
    expect(poolOnGroupKey("o1")).toBe(`org-o1:${POOL_ON_GROUP_KIND}`);
    expect(poolOnGroupKey("o1")).not.toBe(poolOnNoticeKey("o1"));
  });
});
