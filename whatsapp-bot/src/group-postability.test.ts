/**
 * Can MatchTime post in this group? (2026-10-14)
 *
 * WhatsApp lets a group be set so only admins can send ("announce"), and a
 * community's announcements group is admin-only by design. A post from a
 * member who is not an admin there goes nowhere. These tests pin the one
 * decision and the tracker that keeps it current from Baileys' metadata
 * reads, `groups.update` and promote/demote events.
 */
import { describe, expect, it } from "vitest";
import {
  createPostabilityTracker,
  decidePostability,
  postabilityFromMetadata,
  type GroupPostability,
} from "./group-postability.js";

const GROUP = "120363000000000000@g.us";
const ME_LID = "158000000000001@lid";
const ME_PN = "447700900001@s.whatsapp.net";
const SELF = new Set(["447700900001@c.us", "158000000000001@lid"]);

function meta(over: Record<string, unknown> = {}, meAdmin: string | null = null) {
  return {
    id: GROUP,
    announce: false,
    isCommunityAnnounce: false,
    participants: [
      { id: ME_LID, phoneNumber: ME_PN, admin: meAdmin },
      { id: "158055467598020@lid", phoneNumber: "447700900123@s.whatsapp.net", admin: "superadmin" },
    ],
    ...over,
  };
}

describe("decidePostability", () => {
  it("an ordinary group: everyone can post", () => {
    expect(decidePostability({ announce: false, communityAnnounce: false, botIsAdmin: false })).toEqual({
      announce: false,
      communityAnnounce: false,
      botIsAdmin: false,
      canPost: true,
      reason: "ok",
    });
  });

  it("only admins can send and MatchTime is not one: cannot post", () => {
    const p = decidePostability({ announce: true, communityAnnounce: false, botIsAdmin: false });
    expect(p.canPost).toBe(false);
    expect(p.reason).toBe("admin-only");
  });

  it("a community announcements group is named as such", () => {
    const p = decidePostability({ announce: true, communityAnnounce: true, botIsAdmin: false });
    expect(p.canPost).toBe(false);
    expect(p.reason).toBe("community-announce");
  });

  it("a community announcements group is admin-only even if the announce flag did not come through", () => {
    expect(decidePostability({ announce: false, communityAnnounce: true, botIsAdmin: false }).canPost).toBe(false);
  });

  it("MatchTime as an admin can post in either", () => {
    expect(decidePostability({ announce: true, communityAnnounce: false, botIsAdmin: true }).canPost).toBe(true);
    expect(decidePostability({ announce: true, communityAnnounce: true, botIsAdmin: true }).canPost).toBe(true);
  });
});

describe("postabilityFromMetadata", () => {
  it("reads announce, isCommunityAnnounce and MatchTime's own admin flag", () => {
    expect(postabilityFromMetadata(meta({ announce: true }), SELF)?.reason).toBe("admin-only");
    expect(postabilityFromMetadata(meta({ announce: true }, "admin"), SELF)?.canPost).toBe(true);
    expect(postabilityFromMetadata(meta({ announce: true }, "superadmin"), SELF)?.botIsAdmin).toBe(true);
    expect(postabilityFromMetadata(meta({ announce: true, isCommunityAnnounce: true }), SELF)?.reason).toBe(
      "community-announce",
    );
  });

  it("finds MatchTime by its phone id too (a phone-addressed group)", () => {
    const m = meta({ announce: true });
    m.participants[0] = { id: ME_PN, phoneNumber: undefined as never, admin: "admin" };
    expect(postabilityFromMetadata(m, SELF)?.canPost).toBe(true);
  });

  it("UNKNOWN (null) when MatchTime is not in the roster: never blocks on a guess", () => {
    const m = meta({ announce: true });
    m.participants = m.participants.slice(1);
    expect(postabilityFromMetadata(m, SELF)).toBeNull();
  });

  it("UNKNOWN when we do not know our own ids yet", () => {
    expect(postabilityFromMetadata(meta({ announce: true }), new Set())).toBeNull();
  });
});

describe("the tracker", () => {
  function tracked() {
    const t = createPostabilityTracker();
    const changes: Array<{ gid: string; p: GroupPostability; prev: GroupPostability | undefined }> = [];
    t.onChange((gid, p, prev) => changes.push({ gid, p, prev }));
    return { t, changes };
  }

  it("reports the first reading, then only real changes", () => {
    const { t, changes } = tracked();
    t.applyMetadata(meta(), SELF);
    t.applyMetadata(meta(), SELF);
    expect(changes).toHaveLength(1);
    expect(changes[0].p.canPost).toBe(true);
    expect(t.get(GROUP)?.canPost).toBe(true);
  });

  it("the group switched to admin-only (groups.update announce=true): blocked", () => {
    const { t, changes } = tracked();
    t.applyMetadata(meta(), SELF);
    t.applyGroupUpdate({ id: GROUP, announce: true });
    expect(t.get(GROUP)?.reason).toBe("admin-only");
    expect(changes.map((c) => c.p.canPost)).toEqual([true, false]);
    t.applyGroupUpdate({ id: GROUP, announce: false });
    expect(t.get(GROUP)?.canPost).toBe(true);
    expect(changes).toHaveLength(3);
  });

  it("a groups.update without announce changes nothing", () => {
    const { t, changes } = tracked();
    t.applyMetadata(meta({ announce: true }), SELF);
    t.applyGroupUpdate({ id: GROUP, subject: "New name" } as never);
    expect(changes).toHaveLength(1);
  });

  it("MatchTime promoted, then demoted, in an admin-only group", () => {
    const { t, changes } = tracked();
    t.applyMetadata(meta({ announce: true }), SELF);
    t.applyParticipants({ id: GROUP, action: "promote", participants: [{ id: ME_LID, phoneNumber: ME_PN }] }, SELF);
    expect(t.get(GROUP)?.canPost).toBe(true);
    t.applyParticipants({ id: GROUP, action: "demote", participants: [ME_LID] }, SELF);
    expect(t.get(GROUP)?.canPost).toBe(false);
    expect(changes.map((c) => c.p.canPost)).toEqual([false, true, false]);
  });

  it("somebody else promoted: nothing changes", () => {
    const { t, changes } = tracked();
    t.applyMetadata(meta({ announce: true }), SELF);
    t.applyParticipants({ id: GROUP, action: "promote", participants: ["158055467598020@lid"] }, SELF);
    expect(changes).toHaveLength(1);
    expect(t.get(GROUP)?.canPost).toBe(false);
  });

  it("an update for a group never read is ignored: admin status unknown", () => {
    const { t, changes } = tracked();
    t.applyGroupUpdate({ id: GROUP, announce: true });
    t.applyParticipants({ id: GROUP, action: "promote", participants: [ME_LID] }, SELF);
    expect(changes).toHaveLength(0);
    expect(t.get(GROUP)).toBeUndefined();
  });

  it("MatchTime removed: forgotten, so nothing is gated on a stale reading", () => {
    const { t } = tracked();
    t.applyMetadata(meta({ announce: true }), SELF);
    t.applyParticipants({ id: GROUP, action: "remove", participants: [ME_LID] }, SELF);
    expect(t.get(GROUP)).toBeUndefined();
  });

  it("a roster without MatchTime in it leaves the last reading alone", () => {
    const { t } = tracked();
    t.applyMetadata(meta({ announce: true }), SELF);
    const m = meta({ announce: false });
    m.participants = m.participants.slice(1);
    t.applyMetadata(m, SELF);
    expect(t.get(GROUP)?.canPost).toBe(false);
  });

  it("a throwing listener does not break the tracker", () => {
    const t = createPostabilityTracker();
    t.onChange(() => {
      throw new Error("boom");
    });
    expect(() => t.applyMetadata(meta(), SELF)).not.toThrow();
    expect(t.get(GROUP)?.canPost).toBe(true);
  });
});
