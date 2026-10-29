/**
 * Where a club hears something the whole club should know (Kemal,
 * 2026-10-28 for the pool switching on; 2026-10-29 for a pool player
 * joining or leaving a game): a club with an admin group (HQ) hears it
 * there, through its admin channel; a club whose only group is its players'
 * group hears it IN that group, worded for everyone, and no admin is DMed;
 * a club with no postable group falls back to the admin channel's DMs.
 */
import { describe, expect, it } from "vitest";
import { clubNoticeRoute } from "../club-notice-route-rules";

const base = { adminGroupId: null, whatsappGroupId: "g@g.us", whatsappBotEnabled: true, playersGroupPostable: true };

describe("clubNoticeRoute", () => {
  it("a linked admin group (HQ): the admin channel, whatever the players' group", () => {
    expect(clubNoticeRoute({ ...base, adminGroupId: "hq@g.us" })).toBe("admin-channel");
    expect(clubNoticeRoute({ ...base, adminGroupId: "hq@g.us", whatsappGroupId: null })).toBe("admin-channel");
  });

  it("no admin group and a postable players' group: the players' group", () => {
    expect(clubNoticeRoute(base)).toBe("players-group");
  });

  it("no admin group and no postable players' group: the admin channel (DMs)", () => {
    expect(clubNoticeRoute({ ...base, whatsappGroupId: null })).toBe("admin-channel");
    expect(clubNoticeRoute({ ...base, whatsappBotEnabled: false })).toBe("admin-channel");
    expect(clubNoticeRoute({ ...base, playersGroupPostable: false })).toBe("admin-channel");
  });
});
