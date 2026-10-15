/**
 * Group invites through the whole driver, against the fake socket
 * (2026-10-15). The rules are pinned in baileys/group-invite.test.ts; here:
 *
 *   - a private invite from a verified organiser is accepted with
 *     `groupAcceptInviteV4`, and the bot-added flow gets ONE self-join with
 *     the inviter as its author, whether or not rc14's own participants
 *     update (which it emits for a v4 accept) arrives as well;
 *   - a pasted link from a verified organiser is joined with
 *     `groupAcceptInvite`, which emits nothing locally, and the self-join
 *     is still handed up; the DM itself is not;
 *   - a stranger's invite is never accepted and its link DM is handed up
 *     exactly as before;
 *   - the server-side groupadd privacy value is checked on the first open
 *     only;
 *   - the per-message log line carries no whole number, LID or name.
 */
import { describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import type { GroupMembershipEvent, InboundMessage } from "../driver.js";
import { FakeSocket, FAKE_ME_LID, FAKE_ME_PN, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { createGroupAddPrivacyCheck } from "../baileys/group-add-privacy.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363400000000123@g.us";
const ORGANISER_LID = "158055467598961@lid";
const ORGANISER_PN = "447700900961@s.whatsapp.net";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const NOW = Date.parse("2026-10-15T12:00:00Z");

const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

type Check = (body: Record<string, unknown>) => Promise<{ accept: boolean; reason?: string } | null>;

function inviteSock(s: FakeSocket) {
  const calls = { v4: [] as unknown[][], info: [] as string[], link: [] as string[], privacyReads: 0, privacySets: [] as string[] };
  const ext = s as FakeSocket & Record<string, unknown>;
  ext.groupAcceptInviteV4 = async (key: { remoteJid: string }, invite: { groupJid: string }) => {
    calls.v4.push([key, invite]);
    // What rc14 does: upsert a GROUP_PARTICIPANT_ADD stub, which
    // processMessage turns into this participants update.
    s.emit("group-participants.update", {
      id: invite.groupJid,
      author: key.remoteJid,
      participants: [{ id: FAKE_ME_PN, lid: FAKE_ME_LID }],
      action: "add",
    });
    return invite.groupJid;
  };
  ext.groupGetInviteInfo = async (code: string) => {
    calls.info.push(code);
    return { id: GROUP };
  };
  ext.groupAcceptInvite = async (code: string) => {
    calls.link.push(code);
    return GROUP;
  };
  ext.fetchPrivacySettings = async () => {
    calls.privacyReads++;
    return { groupadd: "contacts", last: "all" };
  };
  ext.updateGroupsAddPrivacy = async (v: string) => {
    calls.privacySets.push(v);
  };
  return calls;
}

function setup(check: Check | null) {
  const sockets: FakeSocket[] = [];
  const callsBySock: Array<ReturnType<typeof inviteSock>> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      callsBySock.push(inviteSock(s));
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: () => {},
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  const driver = makeBaileysDriver({
    connection: connection as never,
    now: () => NOW,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
    groupInviteCheck: check ? (b) => check(b as Record<string, unknown>) : undefined,
    privacyCheck: createGroupAddPrivacyCheck({ enabled: true, log: (l) => logs.push(l), error: (l) => errors.push(l) }),
  });
  const joins: GroupMembershipEvent[] = [];
  const messages: InboundMessage[] = [];
  driver.onGroupJoin((e) => void joins.push(e));
  driver.onMessage((m) => void messages.push(m));
  return { driver, sockets, calls: () => callsBySock[callsBySock.length - 1], logs, errors, joins, messages };
}

async function started(check: Check | null) {
  const t = setup(check);
  await t.driver.start();
  t.sockets[0].open();
  await settle();
  return t;
}

function inviteDm(id = "INV1"): WAMessage {
  return {
    key: { remoteJid: ORGANISER_LID, remoteJidAlt: ORGANISER_PN, id, fromMe: false },
    messageTimestamp: NOW / 1000,
    pushName: "Fikret",
    message: {
      groupInviteMessage: {
        groupJid: GROUP,
        inviteCode: "v4code123",
        inviteExpiration: NOW / 1000 + 3 * 24 * 3600,
        groupName: "FNF Thursday",
      },
    },
  } as unknown as WAMessage;
}

function textDm(text: string, id = "TXT1"): WAMessage {
  return {
    key: { remoteJid: ORGANISER_LID, remoteJidAlt: ORGANISER_PN, id, fromMe: false },
    messageTimestamp: NOW / 1000,
    pushName: "Fikret",
    message: { conversation: text },
  } as unknown as WAMessage;
}

const yes: Check = async () => ({ accept: true });
const no: Check = async () => ({ accept: false, reason: "not-organiser" });

describe("a private invite (Invite to group)", () => {
  it("from a verified organiser: accepted, and ONE self-join is handed up with the inviter as author", async () => {
    const check = vi.fn(yes);
    const t = await started(check);
    t.sockets[0].emit("messages.upsert", { messages: [inviteDm()], type: "notify" });
    await settle();

    expect(check).toHaveBeenCalledWith({
      phone: "447700900961",
      senderLid: "158055467598961",
      senderAltPhone: "447700900961",
      kind: "invite-message",
    });
    expect(t.calls().v4).toHaveLength(1);
    expect(t.joins).toHaveLength(1);
    expect(t.joins[0]).toMatchObject({
      chatId: GROUP,
      recipientIds: ["447700900001@c.us"],
      author: "447700900961@c.us",
      authorLid: "158055467598961",
    });
    // Not a chat message: never handed to onMessage.
    expect(t.messages).toHaveLength(0);
  });

  it("from anybody else: nothing accepted, nothing handed up", async () => {
    const t = await started(no);
    t.sockets[0].emit("messages.upsert", { messages: [inviteDm()], type: "notify" });
    await settle();
    expect(t.calls().v4).toHaveLength(0);
    expect(t.joins).toHaveLength(0);
    expect(t.messages).toHaveLength(0);
  });

  it("a redelivered invite is not accepted again", async () => {
    const t = await started(yes);
    t.sockets[0].emit("messages.upsert", { messages: [inviteDm()], type: "notify" });
    await settle();
    t.sockets[0].emit("messages.upsert", { messages: [inviteDm()], type: "append" });
    await settle();
    expect(t.calls().v4).toHaveLength(1);
    expect(t.joins).toHaveLength(1);
  });

  it("without a server check wired, an invite is never accepted", async () => {
    const t = await started(null);
    t.sockets[0].emit("messages.upsert", { messages: [inviteDm()], type: "notify" });
    await settle();
    expect(t.calls().v4).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("a group invite (invites are not handled by this process)"))).toBe(true);
  });
});

describe("a pasted invite link", () => {
  it("from a verified organiser: joined with groupAcceptInvite, a self-join handed up, the DM swallowed", async () => {
    const t = await started(yes);
    t.sockets[0].emit("messages.upsert", {
      messages: [textDm(`Follow this link to join my WhatsApp group: https://chat.whatsapp.com/${CODE}`)],
      type: "notify",
    });
    await settle();
    expect(t.calls().info).toEqual([CODE]);
    expect(t.calls().link).toEqual([CODE]);
    expect(t.joins).toHaveLength(1);
    expect(t.joins[0]).toMatchObject({ chatId: GROUP, author: "447700900961@c.us", authorLid: "158055467598961" });
    expect(t.messages).toHaveLength(0);
  });

  it("from anybody else: not joined, and the DM is handed up as it always was", async () => {
    const t = await started(no);
    t.sockets[0].emit("messages.upsert", { messages: [textDm(`https://chat.whatsapp.com/${CODE}`)], type: "notify" });
    await settle();
    expect(t.calls().info).toHaveLength(0);
    expect(t.calls().link).toHaveLength(0);
    expect(t.joins).toHaveLength(0);
    expect(t.messages).toHaveLength(1);
  });

  it("a link pasted in a GROUP is never acted on", async () => {
    const check = vi.fn(yes);
    const t = await started(check);
    t.sockets[0].emit("messages.upsert", {
      messages: [
        {
          key: { remoteJid: "120363000000000777@g.us", participant: ORGANISER_PN, id: "G1", fromMe: false },
          messageTimestamp: NOW / 1000,
          message: { conversation: `https://chat.whatsapp.com/${CODE}` },
        },
      ],
      type: "notify",
    });
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(t.messages).toHaveLength(1);
  });
});

describe("the groupadd privacy check", () => {
  it("runs on the first open only, and sets the value to all", async () => {
    const t = await started(null);
    expect(t.calls().privacyReads).toBe(1);
    expect(t.calls().privacySets).toEqual(["all"]);
    expect(t.logs).toContain("[baileys][privacy] groupadd=contacts");
    // Another open (what every reconnect is): the check does not run again.
    t.sockets[0].open();
    await settle();
    t.sockets[0].open();
    await settle();
    expect(t.calls().privacyReads).toBe(1);
    expect(t.calls().privacySets).toEqual(["all"]);
  });
});

describe("log hygiene", () => {
  it("the per-message line masks the chat, the sender and the phone, and never names the sender", async () => {
    const t = await started(no);
    t.sockets[0].emit("messages.upsert", { messages: [textDm("hello there")], type: "notify" });
    await settle();
    const all = [...t.logs, ...t.errors].join("\n");
    expect(all).toContain("[baileys][msg] upsert=notify chat=***961@lid");
    expect(all).not.toMatch(/447700900961|158055467598961/);
    expect(all).not.toContain("Fikret");
  });
});
