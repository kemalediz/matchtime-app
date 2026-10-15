/**
 * MatchTime joins a group by INVITE (2026-10-15).
 *
 * WhatsApp refuses to let a stranger add MatchTime ("Can't add MatchTime")
 * and offers "Invite to group", which DMs MatchTime a groupInviteMessage.
 * An organiser may also paste the group's chat.whatsapp.com link. The Pi
 * asks the server whether the sender is a verified organiser and joins
 * only on a yes; never twice; never an expired invite; never a group it is
 * already in. Nothing about the sender, the link or the code is logged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createGroupInviteHandler,
  inviteLinkCode,
  inviteMessageOf,
  inviteSenderOf,
  type GroupInviteDeps,
} from "./group-invite.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const GROUP = "120363400000000123@g.us";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const SENDER_LID = "158055467598961@lid";
const SENDER_PN = "447700900961@s.whatsapp.net";

function inviteMsg(over: Record<string, unknown> = {}, keyOver: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: SENDER_LID, remoteJidAlt: SENDER_PN, id: "INV1", fromMe: false, ...keyOver },
    messageTimestamp: NOW / 1000,
    message: {
      groupInviteMessage: {
        groupJid: GROUP,
        inviteCode: "v4code123",
        inviteExpiration: NOW / 1000 + 3 * 24 * 3600,
        groupName: "FNF Thursday",
        ...over,
      },
    },
  };
}

function deps(over: Partial<GroupInviteDeps> = {}) {
  const lines: string[] = [];
  const d: GroupInviteDeps = {
    check: vi.fn(async () => ({ accept: true })),
    acceptV4: vi.fn(async () => GROUP),
    inviteInfo: vi.fn(async () => ({ id: GROUP })),
    acceptLink: vi.fn(async () => GROUP),
    alreadyIn: vi.fn(async () => false),
    joined: vi.fn(),
    now: () => NOW,
    log: (l: string) => lines.push(l),
    error: (l: string) => lines.push(l),
    ...over,
  };
  return { d, lines };
}

const SENDER = { phone: "447700900961", senderLid: "158055467598961", senderAltPhone: "447700900961", jid: SENDER_LID };

function noLeaks(lines: string[]) {
  const all = lines.join("\n");
  expect(all).not.toMatch(/447700900961|158055467598961/);
  expect(all).not.toContain(CODE);
  expect(all).not.toContain("v4code123");
  expect(all).not.toContain("chat.whatsapp.com");
  expect(all).not.toContain("FNF Thursday");
}

describe("inviteLinkCode", () => {
  it("reads the code from a pasted invite link, with or without a scheme or text around it", () => {
    expect(inviteLinkCode(`https://chat.whatsapp.com/${CODE}`)).toBe(CODE);
    expect(inviteLinkCode(`Follow this link to join my WhatsApp group: https://chat.whatsapp.com/${CODE}`)).toBe(CODE);
    expect(inviteLinkCode(`chat.whatsapp.com/${CODE}?mode=r_c`)).toBe(CODE);
    expect(inviteLinkCode(`http://chat.whatsapp.com/invite/${CODE}`)).toBe(CODE);
  });

  it("is null for anything else", () => {
    expect(inviteLinkCode("IN for Thursday")).toBeNull();
    expect(inviteLinkCode("https://wa.me/447700900961")).toBeNull();
    expect(inviteLinkCode("https://chat.whatsapp.com/")).toBeNull();
    expect(inviteLinkCode("https://evilchat.whatsapp.com.example/abc")).toBeNull();
    expect(inviteLinkCode(undefined)).toBeNull();
  });
});

describe("inviteMessageOf", () => {
  it("reads a groupInviteMessage, unwrapping an ephemeral one", () => {
    expect(inviteMessageOf(inviteMsg() as never)?.groupJid).toBe(GROUP);
    const wrapped = { key: {}, message: { ephemeralMessage: { message: inviteMsg().message } } };
    expect(inviteMessageOf(wrapped as never)?.groupJid).toBe(GROUP);
  });

  it("is null for a text message", () => {
    expect(inviteMessageOf({ key: {}, message: { conversation: "hi" } } as never)).toBeNull();
  });
});

describe("inviteSenderOf", () => {
  it("reads the phone and LID off the envelope", () => {
    expect(inviteSenderOf({ remoteJid: SENDER_LID, remoteJidAlt: SENDER_PN }, null)).toEqual({
      jid: SENDER_LID,
      phone: "447700900961",
      senderLid: "158055467598961",
      senderAltPhone: "447700900961",
    });
  });

  it("uses a phone resolved from the local store when the envelope has none", () => {
    expect(inviteSenderOf({ remoteJid: SENDER_LID }, "447700900961")).toEqual({
      jid: SENDER_LID,
      phone: "447700900961",
      senderLid: "158055467598961",
    });
  });
});

describe("the private invite (Invite to group)", () => {
  it("a verified organiser's invite is accepted with groupAcceptInviteV4 and the join is handed up", async () => {
    const { d, lines } = deps();
    const h = createGroupInviteHandler(d);
    const msg = inviteMsg();
    const out = await h.handleInviteMessage(msg as never, SENDER);
    expect(out).toBe("joined");
    expect(d.check).toHaveBeenCalledWith({
      phone: "447700900961",
      senderLid: "158055467598961",
      senderAltPhone: "447700900961",
      kind: "invite-message",
    });
    expect(d.acceptV4).toHaveBeenCalledWith(msg.key, msg.message.groupInviteMessage);
    expect(d.joined).toHaveBeenCalledWith(GROUP, SENDER, "invite-message");
    noLeaks(lines);
  });

  it("anybody else's invite is ignored, silently, with a one-line reason", async () => {
    const { d, lines } = deps({ check: vi.fn(async () => ({ accept: false, reason: "not-organiser" })) });
    const out = await createGroupInviteHandler(d).handleInviteMessage(inviteMsg() as never, SENDER);
    expect(out).toBe("refused");
    expect(d.acceptV4).not.toHaveBeenCalled();
    expect(d.joined).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not-organiser");
    noLeaks(lines);
  });

  it("an expired invite is logged and ignored without asking the server", async () => {
    const { d, lines } = deps();
    const out = await createGroupInviteHandler(d).handleInviteMessage(
      inviteMsg({ inviteExpiration: NOW / 1000 - 60 }) as never,
      SENDER,
    );
    expect(out).toBe("expired");
    expect(d.check).not.toHaveBeenCalled();
    expect(d.acceptV4).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("expired");
    noLeaks(lines);
  });

  it("an already-used invite (expiration 0, code blanked) is ignored", async () => {
    const { d } = deps();
    const out = await createGroupInviteHandler(d).handleInviteMessage(
      inviteMsg({ inviteExpiration: 0, inviteCode: "" }) as never,
      SENDER,
    );
    expect(out).toBe("expired");
    expect(d.acceptV4).not.toHaveBeenCalled();
  });

  it("the same invite is never accepted twice (a redelivery, or the same invite sent again)", async () => {
    const { d } = deps();
    const h = createGroupInviteHandler(d);
    expect(await h.handleInviteMessage(inviteMsg() as never, SENDER)).toBe("joined");
    expect(await h.handleInviteMessage(inviteMsg() as never, SENDER)).toBe("duplicate");
    expect(await h.handleInviteMessage(inviteMsg({}, { id: "INV2" }) as never, SENDER)).toBe("duplicate");
    expect(d.acceptV4).toHaveBeenCalledTimes(1);
  });

  it("two invites racing for the same group accept once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps({
      acceptV4: vi.fn(async () => {
        await gate;
        return GROUP;
      }),
    });
    const h = createGroupInviteHandler(d);
    const a = h.handleInviteMessage(inviteMsg() as never, SENDER);
    const b = h.handleInviteMessage(inviteMsg({}, { id: "INV2" }) as never, SENDER);
    release();
    expect([await a, await b].sort()).toEqual(["duplicate", "joined"]);
    expect(d.acceptV4).toHaveBeenCalledTimes(1);
  });

  it("does nothing when MatchTime is already in the group", async () => {
    const { d } = deps({ alreadyIn: vi.fn(async () => true) });
    const out = await createGroupInviteHandler(d).handleInviteMessage(inviteMsg() as never, SENDER);
    expect(out).toBe("already-in");
    expect(d.check).not.toHaveBeenCalled();
    expect(d.acceptV4).not.toHaveBeenCalled();
  });

  it("a server that cannot be reached is not a yes, and the invite may be tried again", async () => {
    const check = vi.fn(async () => null);
    const { d } = deps({ check });
    const h = createGroupInviteHandler(d);
    expect(await h.handleInviteMessage(inviteMsg() as never, SENDER)).toBe("no-answer");
    expect(d.acceptV4).not.toHaveBeenCalled();
    check.mockResolvedValueOnce({ accept: true } as never);
    expect(await h.handleInviteMessage(inviteMsg() as never, SENDER)).toBe("joined");
  });

  it("a failed accept is logged, does not throw, and does not hand up a join", async () => {
    const { d, lines } = deps({
      acceptV4: vi.fn(async () => {
        throw new Error(`not-authorized for ${SENDER_PN}`);
      }),
    });
    const out = await createGroupInviteHandler(d).handleInviteMessage(inviteMsg() as never, SENDER);
    expect(out).toBe("failed");
    expect(d.joined).not.toHaveBeenCalled();
    noLeaks(lines);
  });

  it("our own invite message and a group-chat invite are not handled", async () => {
    const { d } = deps();
    const h = createGroupInviteHandler(d);
    expect(await h.handleInviteMessage(inviteMsg({}, { fromMe: true }) as never, SENDER)).toBe("not-a-dm-invite");
    expect(await h.handleInviteMessage(inviteMsg({}, { remoteJid: "120363999@g.us" }) as never, SENDER)).toBe(
      "not-a-dm-invite",
    );
    expect(await h.handleInviteMessage(inviteMsg({ groupJid: "nonsense" }) as never, SENDER)).toBe("not-a-dm-invite");
    expect(d.check).not.toHaveBeenCalled();
  });
});

describe("a pasted invite link", () => {
  it("a verified organiser's link is joined with groupAcceptInvite(code) and the join is handed up", async () => {
    const { d, lines } = deps();
    const out = await createGroupInviteHandler(d).handleInviteLink(CODE, SENDER);
    expect(out).toBe("joined");
    expect(d.check).toHaveBeenCalledWith({
      phone: "447700900961",
      senderLid: "158055467598961",
      senderAltPhone: "447700900961",
      kind: "invite-link",
    });
    expect(d.inviteInfo).toHaveBeenCalledWith(CODE);
    expect(d.acceptLink).toHaveBeenCalledWith(CODE);
    expect(d.joined).toHaveBeenCalledWith(GROUP, SENDER, "invite-link");
    noLeaks(lines);
  });

  it("asks the server BEFORE touching WhatsApp: a stranger's link is never looked up", async () => {
    const { d, lines } = deps({ check: vi.fn(async () => ({ accept: false, reason: "not-organiser" })) });
    const out = await createGroupInviteHandler(d).handleInviteLink(CODE, SENDER);
    expect(out).toBe("refused");
    expect(d.inviteInfo).not.toHaveBeenCalled();
    expect(d.acceptLink).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    noLeaks(lines);
  });

  it("an invalid, revoked or expired link is logged and ignored", async () => {
    const { d, lines } = deps({
      inviteInfo: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    const out = await createGroupInviteHandler(d).handleInviteLink(CODE, SENDER);
    expect(out).toBe("invalid-link");
    expect(d.acceptLink).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/invalid, revoked or expired/);
    noLeaks(lines);
  });

  it("does nothing when MatchTime is already in that group", async () => {
    const { d } = deps({ alreadyIn: vi.fn(async () => true) });
    const out = await createGroupInviteHandler(d).handleInviteLink(CODE, SENDER);
    expect(out).toBe("already-in");
    expect(d.acceptLink).not.toHaveBeenCalled();
    expect(d.joined).not.toHaveBeenCalled();
  });

  it("the same link is never joined twice", async () => {
    const { d } = deps();
    const h = createGroupInviteHandler(d);
    expect(await h.handleInviteLink(CODE, SENDER)).toBe("joined");
    expect(await h.handleInviteLink(CODE, SENDER)).toBe("duplicate");
    expect(d.acceptLink).toHaveBeenCalledTimes(1);
  });

  it("a link for the group a private invite already joined is not joined again", async () => {
    const { d } = deps();
    const h = createGroupInviteHandler(d);
    expect(await h.handleInviteMessage(inviteMsg() as never, SENDER)).toBe("joined");
    expect(await h.handleInviteLink(CODE, SENDER)).toBe("duplicate");
    expect(d.acceptLink).not.toHaveBeenCalled();
  });

  it("a failed join is logged and does not throw", async () => {
    const { d, lines } = deps({
      acceptLink: vi.fn(async () => {
        throw new Error("conflict");
      }),
    });
    expect(await createGroupInviteHandler(d).handleInviteLink(CODE, SENDER)).toBe("failed");
    expect(d.joined).not.toHaveBeenCalled();
    noLeaks(lines);
  });
});
