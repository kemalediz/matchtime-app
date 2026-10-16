/**
 * `adminGroupPost` (2026-10-16): a scheduled post that belongs in the
 * club's admin group when it has one MatchTime can post in, and in the
 * caller's own place otherwise (never a DM). The "what was the final
 * score?" ask uses it: HQ for an admin-group club, the players' group for
 * every other club. Same key either way, so it is asked once.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { adminGroupPost, type LoadedAdminChannel } from "../admin-channel";
import { organisersContext } from "../admin-group-context";

const GROUP = "120363900000000001@g.us";
const NOON = new Date("2026-10-16T11:00:00Z");
const NIGHT = new Date("2026-10-16T22:30:00Z");

function ch(over: Partial<LoadedAdminChannel["cfg"]> = {}, rest: Partial<LoadedAdminChannel> = {}): LoadedAdminChannel {
  return {
    orgId: "org-1",
    orgName: "FNF",
    language: "en",
    cfg: { mode: "admin-group", channelUserId: null, adminGroupId: GROUP, ...over },
    admins: [{ id: "u-owner", name: "Hamzah", role: "OWNER", phoneNumber: "+447700900101" }],
    ...rest,
  };
}
const post = (channel: LoadedAdminChannel | null, piCaps = { adminGroup: true }, now = NOON) =>
  adminGroupPost({ channel, piCaps, now, key: "m1:ask-score", matchId: "m1", text: "what was the score?" });

describe("adminGroupPost", () => {
  it("an admin-group club: one post in HQ, with the caller's key", () => {
    expect(post(ch())).toEqual({
      to: "admin-group",
      instruction: { kind: "admin-group-message", key: "m1:ask-score", matchId: "m1", groupId: GROUP, text: "what was the score?" },
    });
  });

  it("outside HQ's posting hours: held, and not posted anywhere else", () => {
    expect(post(ch(), { adminGroup: true }, NIGHT)).toEqual({ to: "admin-group", instruction: null });
  });

  it.each([
    ["no admin channel", null, { adminGroup: true }],
    ["each-admin mode", ch({ mode: "each-admin" }), { adminGroup: true }],
    ["one-person mode", ch({ mode: "one-person" }), { adminGroup: true }],
    ["admin-group mode, no group linked", ch({ adminGroupId: null }), { adminGroup: true }],
    ["a Pi that cannot post in admin groups", ch(), { adminGroup: false }],
    ["an admin group MatchTime cannot post in", ch({}, { adminGroupPostable: false }), { adminGroup: true }],
  ])("%s: elsewhere (the caller's own post), never a DM", (_label, channel, caps) => {
    expect(post(channel, caps)).toEqual({ to: "elsewhere" });
  });
});

describe("the score the organisers' router is told MatchTime is waiting for", () => {
  const base = { pending: [], quoted: null, quotedIsMatchTime: false, recent: [] };
  it("an unscored played match", () => {
    expect(organisersContext({ ...base, score: { kind: "result", day: "Thu 15 Oct", labels: ["Red", "Yellow"] } })).toEqual([
      "WAITING: the final score of Thu 15 Oct's match, Red against Yellow.",
    ]);
  });
  it('an open "which team won?"', () => {
    expect(
      organisersContext({ ...base, score: { kind: "which-team", first: 7, second: 4, labels: ["Red", "Yellow"], askedAt: NOON } }),
    ).toEqual(["WAITING: which team won 7-4, Red or Yellow, asked at 12:00."]);
  });
  it("nothing waiting at all, as before", () => {
    expect(organisersContext(base)).toEqual(["WAITING: nothing."]);
  });
});
