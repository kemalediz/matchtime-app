import { describe, expect, it } from "vitest";
import { groupInviteLinkFromCode, inviteLinkSource, isGroupInviteCodeJobsOn, parseGroupInviteLink } from "../invite-link";

const CODE = "Fh3kQ9zLmP2xW7vB1nR4tY";

describe("parseGroupInviteLink: a pasted group link, validated", () => {
  it("takes the plain link and keeps it canonical", () => {
    expect(parseGroupInviteLink(`https://chat.whatsapp.com/${CODE}`)).toEqual({ ok: true, link: `https://chat.whatsapp.com/${CODE}` });
  });

  it("forgives spacing, no scheme, http, a trailing query and the invite/ path", () => {
    for (const v of [`  chat.whatsapp.com/${CODE} `, `http://chat.whatsapp.com/${CODE}`, `https://chat.whatsapp.com/${CODE}?mode=ems_copy_t`, `https://chat.whatsapp.com/invite/${CODE}`, `HTTPS://CHAT.WHATSAPP.COM/${CODE}`]) {
      expect(parseGroupInviteLink(v), v).toEqual({ ok: true, link: `https://chat.whatsapp.com/${CODE}` });
    }
  });

  it("refuses anything else", () => {
    for (const v of ["", null, 42, "hello", `https://evil.com/${CODE}`, `https://chat.whatsapp.com.evil.com/${CODE}`, "https://chat.whatsapp.com/", "https://chat.whatsapp.com/abc", `https://wa.me/447700900000`, `https://chat.whatsapp.com/${CODE} and https://chat.whatsapp.com/${CODE}x`, `https://chat.whatsapp.com/${CODE}/extra`]) {
      expect(parseGroupInviteLink(v).ok, String(v)).toBe(false);
    }
  });

  it("an empty value is a clear, not an error, when asked to allow it", () => {
    expect(parseGroupInviteLink("  ", { allowEmpty: true })).toEqual({ ok: true, link: null });
  });
});

describe("groupInviteLinkFromCode: what the Pi hands back", () => {
  it("builds the link from a plausible code only", () => {
    expect(groupInviteLinkFromCode(CODE)).toBe(`https://chat.whatsapp.com/${CODE}`);
    expect(groupInviteLinkFromCode("bad code")).toBeNull();
    expect(groupInviteLinkFromCode("")).toBeNull();
    expect(groupInviteLinkFromCode(undefined)).toBeNull();
    expect(groupInviteLinkFromCode("x".repeat(80))).toBeNull();
  });
});

describe("inviteLinkSource: A (MatchTime is group admin) is preferred, else B (pasted)", () => {
  const base = { groupId: "1203@g.us", botIsAdmin: true, codeJobsOn: true, pastedLink: `https://chat.whatsapp.com/${CODE}` };

  it("A when MatchTime is admin of the group and the Pi can make links", () => {
    expect(inviteLinkSource(base)).toEqual({ kind: "bot", groupId: "1203@g.us", fallback: base.pastedLink });
  });

  it("B when MatchTime is not admin, or the Pi job is not switched on yet", () => {
    expect(inviteLinkSource({ ...base, botIsAdmin: false })).toEqual({ kind: "pasted", link: base.pastedLink });
    expect(inviteLinkSource({ ...base, codeJobsOn: false })).toEqual({ kind: "pasted", link: base.pastedLink });
  });

  it("none when neither is possible", () => {
    expect(inviteLinkSource({ ...base, botIsAdmin: false, pastedLink: null })).toEqual({ kind: "none" });
    expect(inviteLinkSource({ ...base, groupId: null, pastedLink: null })).toEqual({ kind: "none" });
    expect(inviteLinkSource({ ...base, groupId: null })).toEqual({ kind: "pasted", link: base.pastedLink });
  });

  it("A with no pasted link has no fallback", () => {
    expect(inviteLinkSource({ ...base, pastedLink: null })).toEqual({ kind: "bot", groupId: "1203@g.us", fallback: null });
  });
});

describe("the Pi job switch", () => {
  it("is off unless set", () => {
    expect(isGroupInviteCodeJobsOn({})).toBe(false);
    expect(isGroupInviteCodeJobsOn({ GROUP_INVITE_CODE_JOBS: "0" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", "TRUE"]) expect(isGroupInviteCodeJobsOn({ GROUP_INVITE_CODE_JOBS: v })).toBe(true);
  });
});
