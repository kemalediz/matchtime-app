/**
 * Slice 2a, the admin channel: the pure rules.
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.2 to 2.4.
 *
 * Who an admin-only notice goes to, when an add to a group is an admin
 * group waiting for its code rather than a new club, and the link code
 * itself. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_GROUP_CODE_ALPHABET,
  ADMIN_GROUP_CODE_LENGTH,
  generateAdminGroupLinkCode,
  isAdminGroupCandidate,
  normaliseAdminChannelMode,
  parseAdminGroupLinkMessage,
  resolveAdminNoticeTargets,
  type ChannelAdmin,
} from "../admin-channel-rules";

const OWNER: ChannelAdmin = { id: "u-owner", name: "Hamzah", role: "OWNER", phoneNumber: "+447700900101" };
const RAIHAN: ChannelAdmin = { id: "u-raihan", name: "Raihan", role: "ADMIN", phoneNumber: "+447700900102" };
const WASIM: ChannelAdmin = { id: "u-wasim", name: "Wasim", role: "ADMIN", phoneNumber: "+447700900103" };
const NOPHONE: ChannelAdmin = { id: "u-nophone", name: "Nophone", role: "ADMIN", phoneNumber: null };
const ADMINS = [RAIHAN, WASIM, NOPHONE, OWNER];
const GROUP = "120363900000000001@g.us";
const CAPS = { adminGroup: true };
const NO_CAPS = { adminGroup: false };

const ids = (t: ReturnType<typeof resolveAdminNoticeTargets>) => (t.kind === "dm" ? t.users.map((u) => u.id) : t.groupId);

describe("normaliseAdminChannelMode", () => {
  it("keeps the three modes and reads anything else as today's each-admin", () => {
    expect(normaliseAdminChannelMode("one-person")).toBe("one-person");
    expect(normaliseAdminChannelMode("admin-group")).toBe("admin-group");
    expect(normaliseAdminChannelMode("each-admin")).toBe("each-admin");
    expect(normaliseAdminChannelMode("owner")).toBe("each-admin");
    expect(normaliseAdminChannelMode(null)).toBe("each-admin");
  });
});

describe("resolveAdminNoticeTargets", () => {
  it("each-admin is exactly today's findOrgAdminsWithPhone: every admin with a phone, in order", () => {
    const t = resolveAdminNoticeTargets({ mode: "each-admin", channelUserId: null, adminGroupId: null }, ADMINS, NO_CAPS);
    expect(t.kind).toBe("dm");
    expect(ids(t)).toEqual(["u-raihan", "u-wasim", "u-owner"]);
    expect(t.kind === "dm" && t.via).toBe("each-admin");
  });

  it("each-admin ignores a linked group and the Pi's capability", () => {
    const t = resolveAdminNoticeTargets({ mode: "each-admin", channelUserId: "u-wasim", adminGroupId: GROUP }, ADMINS, CAPS);
    expect(ids(t)).toEqual(["u-raihan", "u-wasim", "u-owner"]);
  });

  it("one-person with no one chosen is the owner", () => {
    const t = resolveAdminNoticeTargets({ mode: "one-person", channelUserId: null, adminGroupId: null }, ADMINS, CAPS);
    expect(ids(t)).toEqual(["u-owner"]);
    expect(t.kind === "dm" && t.via).toBe("one-person");
  });

  it("one-person goes to the chosen admin", () => {
    const t = resolveAdminNoticeTargets({ mode: "one-person", channelUserId: "u-wasim", adminGroupId: null }, ADMINS, CAPS);
    expect(ids(t)).toEqual(["u-wasim"]);
  });

  it("one-person falls back to the owner when the chosen person is no longer an admin, left, or has no phone", () => {
    for (const chosen of ["u-gone", "u-nophone"]) {
      const t = resolveAdminNoticeTargets({ mode: "one-person", channelUserId: chosen, adminGroupId: null }, ADMINS, CAPS);
      expect(ids(t)).toEqual(["u-owner"]);
      expect(t.kind === "dm" && t.via).toBe("owner-fallback");
    }
  });

  it("one-person falls back to each admin when the owner has no phone either", () => {
    const owner = { ...OWNER, phoneNumber: null };
    const t = resolveAdminNoticeTargets({ mode: "one-person", channelUserId: null, adminGroupId: null }, [RAIHAN, WASIM, owner], CAPS);
    expect(ids(t)).toEqual(["u-raihan", "u-wasim"]);
    expect(t.kind === "dm" && t.via).toBe("each-admin-fallback");
  });

  it("admin-group posts once in the linked group when the Pi can send there", () => {
    const t = resolveAdminNoticeTargets({ mode: "admin-group", channelUserId: null, adminGroupId: GROUP }, ADMINS, CAPS);
    expect(t).toEqual({ kind: "group", groupId: GROUP });
  });

  it("admin-group falls back to the owner by DM without the Pi capability (a rolled-back Pi never swallows a notice)", () => {
    const t = resolveAdminNoticeTargets({ mode: "admin-group", channelUserId: "u-wasim", adminGroupId: GROUP }, ADMINS, NO_CAPS);
    expect(ids(t)).toEqual(["u-owner"]);
    expect(t.kind === "dm" && t.via).toBe("owner-fallback");
  });

  it("admin-group falls back to the owner when no group is linked", () => {
    const t = resolveAdminNoticeTargets({ mode: "admin-group", channelUserId: null, adminGroupId: null }, ADMINS, CAPS);
    expect(ids(t)).toEqual(["u-owner"]);
  });

  it("no admin has a phone: nobody, never a throw", () => {
    const t = resolveAdminNoticeTargets({ mode: "one-person", channelUserId: null, adminGroupId: null }, [NOPHONE], CAPS);
    expect(ids(t)).toEqual([]);
  });
});

describe("isAdminGroupCandidate", () => {
  const NOW = new Date("2026-09-30T12:00:00Z");
  const later = new Date(NOW.getTime() + 3_600_000);
  const earlier = new Date(NOW.getTime() - 1);

  it("an adder who is an owner or admin of an approved club", () => {
    expect(isAdminGroupCandidate({ adderIsApprovedClubAdmin: true, openCodes: [], participantAdminOrgIds: [], now: NOW })).toBe(true);
  });

  it("an unknown adder, with an open code and one of that club's admins in the group", () => {
    expect(
      isAdminGroupCandidate({
        adderIsApprovedClubAdmin: false,
        openCodes: [{ orgId: "org-a", expiresAt: later }],
        participantAdminOrgIds: ["org-a"],
        now: NOW,
      }),
    ).toBe(true);
  });

  it("an open code, but no admin of THAT club among the members, is not a candidate", () => {
    expect(
      isAdminGroupCandidate({
        adderIsApprovedClubAdmin: false,
        openCodes: [{ orgId: "org-a", expiresAt: later }],
        participantAdminOrgIds: ["org-b"],
        now: NOW,
      }),
    ).toBe(false);
  });

  it("an expired code does not count", () => {
    expect(
      isAdminGroupCandidate({
        adderIsApprovedClubAdmin: false,
        openCodes: [{ orgId: "org-a", expiresAt: earlier }],
        participantAdminOrgIds: ["org-a"],
        now: NOW,
      }),
    ).toBe(false);
  });

  it("a player-only adder with no code is a new club, today's path", () => {
    expect(isAdminGroupCandidate({ adderIsApprovedClubAdmin: false, openCodes: [], participantAdminOrgIds: ["org-a"], now: NOW })).toBe(false);
  });
});

describe("the link code", () => {
  it("is 6 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateAdminGroupLinkCode();
      expect(code).toHaveLength(ADMIN_GROUP_CODE_LENGTH);
      for (const ch of code) expect(ADMIN_GROUP_CODE_ALPHABET).toContain(ch);
    }
    expect(ADMIN_GROUP_CODE_ALPHABET).not.toMatch(/[01ILO]/);
  });

  it("uses the injected randomness", () => {
    expect(generateAdminGroupLinkCode(() => 0)).toBe("AAAAAA");
  });
});

describe("parseAdminGroupLinkMessage", () => {
  it("reads the English command, typed or with a real tag", () => {
    expect(parseAdminGroupLinkMessage("@Match Time admin group K7P3QX")).toBe("K7P3QX");
    expect(parseAdminGroupLinkMessage("@447700900000 admin group k7p3qx", { botMentioned: true })).toBe("K7P3QX");
    expect(parseAdminGroupLinkMessage("@MatchTime Admin Group: K7P3QX")).toBe("K7P3QX");
    expect(parseAdminGroupLinkMessage("@Match Time admin group K7P3QX thanks!")).toBe("K7P3QX");
  });

  it("reads the Turkish command", () => {
    expect(parseAdminGroupLinkMessage("@Match Time yönetici grubu K7P3QX")).toBe("K7P3QX");
    expect(parseAdminGroupLinkMessage("@Match Time YÖNETİCİ GRUBU k7p3qx")).toBe("K7P3QX");
    expect(parseAdminGroupLinkMessage("@447700900000 yonetici grubu K7P3QX", { botMentioned: true })).toBe("K7P3QX");
  });

  it("needs MatchTime to be addressed", () => {
    expect(parseAdminGroupLinkMessage("admin group K7P3QX")).toBeNull();
    expect(parseAdminGroupLinkMessage("@447700900000 admin group K7P3QX")).toBeNull();
  });

  it("refuses a missing code, and 5 or 7 characters", () => {
    expect(parseAdminGroupLinkMessage("@Match Time admin group")).toBeNull();
    expect(parseAdminGroupLinkMessage("@Match Time admin group K7P3Q")).toBeNull();
    expect(parseAdminGroupLinkMessage("@Match Time admin group K7P3QXZ")).toBeNull();
  });

  it("is not fooled by chat that mentions the admin group", () => {
    expect(parseAdminGroupLinkMessage("@Match Time is the admin group ready")).toBeNull();
  });
});

describe("parsePiCaps and the waking-hours gate", () => {
  it("reads the admin-group capability from the header, and nothing from an older Pi", async () => {
    const { parsePiCaps } = await import("../admin-channel-rules");
    expect(parsePiCaps("admin-group")).toEqual({ adminGroup: true });
    expect(parsePiCaps(" something, Admin-Group ")).toEqual({ adminGroup: true });
    expect(parsePiCaps(null)).toEqual({ adminGroup: false });
    expect(parsePiCaps("")).toEqual({ adminGroup: false });
  });

  it("08:00 to 21:59 London, across the clock change", async () => {
    const { isAdminGroupPostHour } = await import("../admin-channel-rules");
    expect(isAdminGroupPostHour(new Date("2026-09-30T06:59:00Z"))).toBe(false); // 07:59 BST
    expect(isAdminGroupPostHour(new Date("2026-09-30T07:00:00Z"))).toBe(true); // 08:00 BST
    expect(isAdminGroupPostHour(new Date("2026-09-30T20:59:00Z"))).toBe(true); // 21:59 BST
    expect(isAdminGroupPostHour(new Date("2026-09-30T21:00:00Z"))).toBe(false); // 22:00 BST
    expect(isAdminGroupPostHour(new Date("2026-11-02T08:00:00Z"))).toBe(true); // 08:00 GMT
    expect(isAdminGroupPostHour(new Date("2026-11-02T07:59:00Z"))).toBe(false);
  });
});
