/**
 * The history diagnostic: what it prints, and above all what it never does.
 *
 * It exists to answer one question from the log alone: when the bot is
 * added to a group, does WhatsApp hand it older messages, and in what
 * form? So the tests pin the three things the reader relies on: the
 * numbers are right, only GROUP chats are named, and nothing a person
 * wrote (or a key to it) can reach the log.
 */
import { describe, it, expect } from "vitest";
import { PROCESSABLE_HISTORY_TYPES, getContentType, proto, type WAMessage } from "baileys";
import { skipReason } from "./inbound.js";
import {
  HISTORY_SYNC_PREFIX,
  SYNC_TYPES_THAT_REACH_THE_EVENT,
  createJoinWatch,
  describeUnreadContent,
  formatHistoryMarkerLine,
  formatHistorySetLines,
  formatHistoryStatusLine,
  formatUnreadContentLine,
  historyMarkerOf,
  summariseHistorySet,
  syncTypeName,
} from "./history-sync.js";

const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const DIRECT = "447700900123@s.whatsapp.net";
const LID = "111222333444@lid";
const SECRET_TEXT = "see you at the pitch on Tuesday";

function histMsg(chat: string, ts: unknown, text = SECRET_TEXT) {
  return {
    key: { remoteJid: chat, fromMe: false, id: `ID${String(ts)}`, participant: DIRECT },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName: "Sam Secret",
  };
}

const T = proto.HistorySync.HistorySyncType;

describe("summariseHistorySet", () => {
  it("counts chats, contacts and messages, and splits groups from everything else", () => {
    const s = summariseHistorySet({
      syncType: T.RECENT,
      isLatest: true,
      progress: 100,
      chunkOrder: 1,
      chats: [{ id: GROUP_A }, { id: GROUP_B }, { id: DIRECT }, { id: LID }],
      contacts: [{}, {}, {}],
      messages: [
        histMsg(GROUP_A, 1_760_000_300),
        histMsg(GROUP_A, 1_760_000_100),
        histMsg(GROUP_A, 1_760_000_200),
        histMsg(DIRECT, 1_760_000_000),
        histMsg(LID, 1_760_000_000),
      ],
    });
    expect(s).toMatchObject({
      syncType: "RECENT(3)",
      chats: 4,
      contacts: 3,
      messages: 5,
      isLatest: true,
      groupChats: 2,
      groupMessages: 3,
      otherMessages: 2,
    });
    expect(s.groups).toEqual([
      { chat: GROUP_A, messages: 3, oldest: 1_760_000_100, newest: 1_760_000_300 },
      // Listed with no messages: "WhatsApp knows the chat, sent nothing for it".
      { chat: GROUP_B, messages: 0, oldest: null, newest: null },
    ]);
  });

  it("names a group that has messages but is missing from the chat list", () => {
    const s = summariseHistorySet({ messages: [histMsg(GROUP_B, 1_760_000_000)] });
    expect(s.groupChats).toBe(1);
    expect(s.groups[0]).toMatchObject({ chat: GROUP_B, messages: 1 });
  });

  it("reads a Long timestamp, and survives a message with none", () => {
    const long = { toNumber: () => 1_760_000_500 };
    const s = summariseHistorySet({ messages: [histMsg(GROUP_A, long), histMsg(GROUP_A, undefined)] });
    expect(s.groups[0]).toEqual({ chat: GROUP_A, messages: 2, oldest: 1_760_000_500, newest: 1_760_000_500 });
  });

  it("does not throw on an empty or missing event", () => {
    expect(summariseHistorySet(undefined)).toMatchObject({ chats: 0, messages: 0, groupChats: 0, syncType: "none" });
    expect(summariseHistorySet({ chats: null, messages: null, contacts: null }).groups).toEqual([]);
  });
});

describe("formatHistorySetLines", () => {
  const evt = {
    syncType: T.ON_DEMAND,
    isLatest: undefined,
    peerDataRequestSessionId: "REQ123",
    chats: [{ id: GROUP_A }, { id: DIRECT }],
    contacts: [{ id: DIRECT, name: "Sam Secret" }],
    messages: [histMsg(GROUP_A, 1_760_000_100), histMsg(GROUP_A, 1_760_000_300), histMsg(DIRECT, 1_760_000_000)],
  };

  it("prints one header and one line per group chat", () => {
    expect(formatHistorySetLines(evt)).toEqual([
      "[baileys][history-sync] messaging-history.set syncType=ON_DEMAND(6) chats=2 contacts=1 messages=3 " +
        "isLatest=n/a progress=n/a chunkOrder=n/a onDemandRequest=REQ123 groupChats=1 groupMessages=2 otherMessages=1",
      `[baileys][history-sync]   group ${GROUP_A} messages=2 oldest=2025-10-09T08:55:00Z newest=2025-10-09T08:58:20Z`,
    ]);
  });

  it("never prints text, a name, or the id of a chat that is not a group", () => {
    const out = formatHistorySetLines(evt).join("\n");
    expect(out).not.toContain(SECRET_TEXT);
    expect(out).not.toContain("Sam");
    expect(out).not.toContain("447700900123");
    expect(out).not.toContain("@s.whatsapp.net");
  });

  it("caps the group lines and says how many were left out", () => {
    const chats = Array.from({ length: 5 }, (_, i) => ({ id: `12036300000000001${i}@g.us` }));
    const lines = formatHistorySetLines({ chats, messages: [], contacts: [] }, { maxGroups: 2 });
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("[baileys][history-sync]   and 3 more group chat(s) not listed");
  });

  it("every line carries the prefix the runbook greps for", () => {
    for (const l of formatHistorySetLines(evt)) expect(l.startsWith(HISTORY_SYNC_PREFIX)).toBe(true);
  });

  it("an unreadable event is reported, not thrown", () => {
    const bad = { get chats(): never { throw new Error("boom"); } };
    const lines = formatHistorySetLines(bad as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not be summarised");
  });
});

describe("formatHistoryStatusLine", () => {
  it("names the sync phase and how it ended", () => {
    expect(formatHistoryStatusLine({ syncType: T.RECENT, status: "complete", explicit: true })).toBe(
      "[baileys][history-sync] messaging-history.status syncType=RECENT(3) status=complete explicit=true",
    );
  });
});

describe("the sync types that reach messaging-history.set", () => {
  it("is exactly what the installed Baileys processes, minus FULL (its default refuses FULL)", () => {
    const expected = new Set(PROCESSABLE_HISTORY_TYPES.filter((t) => t !== T.FULL));
    expect(new Set(SYNC_TYPES_THAT_REACH_THE_EVENT)).toEqual(expected);
  });

  it("names the notification-only types Baileys has no handling for", () => {
    expect(syncTypeName(7)).toBe("NO_HISTORY(7)");
    expect(syncTypeName(8)).toBe("MESSAGE_ACCESS_STATUS(8)");
    expect(syncTypeName(99)).toBe("unknown(99)");
  });
});

function upsert(chat: string, message: proto.IMessage | null, extra: Record<string, unknown> = {}): WAMessage {
  return {
    key: { remoteJid: chat, fromMe: false, id: "MSG1", participant: DIRECT },
    message: message ? proto.Message.fromObject(message) : undefined,
    messageTimestamp: 1_760_000_000,
    ...extra,
  } as WAMessage;
}

const P = proto.Message.ProtocolMessage.Type;

describe("historyMarkerOf", () => {
  it("is null for an ordinary message, an edit, a delete and a key share", () => {
    expect(historyMarkerOf(upsert(GROUP_A, { conversation: SECRET_TEXT }))).toBeNull();
    expect(historyMarkerOf(upsert(GROUP_A, { protocolMessage: { type: P.REVOKE } }))).toBeNull();
    expect(historyMarkerOf(upsert(GROUP_A, { protocolMessage: { type: P.MESSAGE_EDIT } }))).toBeNull();
    expect(historyMarkerOf(upsert(DIRECT, { protocolMessage: { type: P.APP_STATE_SYNC_KEY_SHARE } }))).toBeNull();
    expect(historyMarkerOf(null)).toBeNull();
    expect(historyMarkerOf({} as WAMessage)).toBeNull();
  });

  it("names a history sync notification and says a set line should follow", () => {
    const m = upsert(DIRECT, {
      protocolMessage: {
        type: P.HISTORY_SYNC_NOTIFICATION,
        historySyncNotification: {
          syncType: proto.Message.HistorySyncType.RECENT,
          chunkOrder: 2,
          progress: 40,
          oldestMsgInChunkTimestampSec: 1_760_000_000,
          mediaKey: Buffer.from("super-secret-media-key"),
          directPath: "/v/secret-path",
        },
      },
    });
    const line = formatHistoryMarkerLine(m, "notify")!;
    expect(line).toBe(
      "[baileys][history-sync] upsert=notify chat=(not a group) id=MSG1 is a history sync notification " +
        "syncType=RECENT(3) chunkOrder=2 progress=40 oldestInChunk=2025-10-09T08:53:20Z inline=no " +
        "onDemandRequest=none (Baileys processes this type: a messaging-history.set line should follow)",
    );
    expect(line).not.toContain("secret");
    // The chat is our own number: it is not printed.
    expect(line).not.toContain("447700900123");
  });

  it("says when Baileys will NOT turn a notification into an event", () => {
    for (const syncType of [proto.Message.HistorySyncType.FULL, 7, 8]) {
      const m = upsert(DIRECT, {
        protocolMessage: { type: P.HISTORY_SYNC_NOTIFICATION, historySyncNotification: { syncType } },
      });
      expect(historyMarkerOf(m)).toContain("no messaging-history.set follows");
    }
  });

  it("names a peer data request and its response by type and result kinds only", () => {
    const req = upsert(DIRECT, {
      protocolMessage: {
        type: P.PEER_DATA_OPERATION_REQUEST_MESSAGE,
        peerDataOperationRequestMessage: {
          peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
        },
      },
    });
    expect(historyMarkerOf(req)).toBe("a peer data request to our own phone type=HISTORY_SYNC_ON_DEMAND(3)");

    const res = upsert(DIRECT, {
      protocolMessage: {
        type: P.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
        peerDataOperationRequestResponseMessage: {
          peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
          peerDataOperationResult: [
            { placeholderMessageResendResponse: { webMessageInfoBytes: Buffer.from(SECRET_TEXT) } },
          ],
        },
      },
    });
    const text = historyMarkerOf(res)!;
    expect(text).toContain("type=PLACEHOLDER_MESSAGE_RESEND(4) results=1 kinds=[placeholderMessageResendResponse]");
    expect(text).not.toContain(SECRET_TEXT);
  });

  it("names WhatsApp's group history bundle, by its metadata only", () => {
    const m = upsert(GROUP_A, {
      messageHistoryBundle: {
        mimetype: "application/x-protobuf",
        mediaKey: Buffer.from("super-secret-media-key"),
        directPath: "/v/secret-path",
        messageHistoryMetadata: {
          historyReceivers: [DIRECT, LID],
          oldestMessageTimestamp: 1_760_000_000,
          messageCount: 37,
        },
      },
    });
    const line = formatHistoryMarkerLine(m, "notify")!;
    expect(line).toBe(
      `[baileys][history-sync] upsert=notify chat=${GROUP_A} id=MSG1 is a group history BUNDLE ` +
        "(messageCount=37 oldest=2025-10-09T08:53:20Z receivers=2 mimetype=application/x-protobuf " +
        "downloadable=yes); Baileys 7.0.0-rc14 does not unpack it",
    );
    expect(line).not.toContain("secret");
    expect(line).not.toContain("447700900123");
    expect(line).not.toContain("111222333444");
  });

  it("names a history notice, a bundled message, and the sharing-mode notice", () => {
    expect(
      historyMarkerOf(upsert(GROUP_A, { messageHistoryNotice: { messageHistoryMetadata: { messageCount: 5 } } })),
    ).toBe("a group history NOTICE (messageCount=5 oldest=? receivers=0)");

    const bundled = upsert(GROUP_A, { conversation: SECRET_TEXT }, { isGroupHistoryMessage: true });
    expect(historyMarkerOf(bundled)).toBe("flagged isGroupHistoryMessage");

    const stub = upsert(GROUP_A, null, {
      messageStubType: proto.WebMessageInfo.StubType.GROUP_MEMBER_SHARE_GROUP_HISTORY_MODE,
      messageStubParameters: [DIRECT],
    });
    const text = historyMarkerOf(stub)!;
    expect(text).toContain("stub type 221, 1 parameter(s)");
    expect(text).not.toContain("447700900123");
  });

  it("sees a bundle through an ephemeral wrapper", () => {
    const m = upsert(GROUP_A, {
      ephemeralMessage: { message: { messageHistoryBundle: { messageHistoryMetadata: { messageCount: 3 } } } },
    });
    expect(historyMarkerOf(m)).toContain("a group history BUNDLE (messageCount=3");
  });
});

describe("why the driver calls a history bundle 'no content type' (Baileys 7.0.0-rc14)", () => {
  // Measured on the Pi, 2026-10-07: with "send recent messages to the
  // selected member" ON, two `notify` messages followed the join notice and
  // were both skipped as "no content type". These pin what the installed
  // library does with the two candidates, so the next reading can be read.
  it("the installed protobuf DOES decode the bundle field off the wire", () => {
    const bytes = proto.Message.encode(
      proto.Message.fromObject({ messageHistoryBundle: { messageHistoryMetadata: { messageCount: 9 } } }),
    ).finish();
    const back = proto.Message.decode(bytes);
    expect(toNum(back.messageHistoryBundle?.messageHistoryMetadata?.messageCount)).toBe(9);
  });

  it("but getContentType only knows keys containing 'Message', so the bundle and the notice have no type", () => {
    const bundle = upsert(GROUP_A, { messageHistoryBundle: { mimetype: "x" } });
    const notice = upsert(GROUP_A, { messageHistoryNotice: {} });
    expect(getContentType(bundle.message!)).toBeUndefined();
    expect(getContentType(notice.message!)).toBeUndefined();
    expect(skipReason(bundle)).toBe("no content type");
    expect(skipReason(notice)).toBe("no content type");
  });

  it("a bare group-key hand-over is ALSO 'no content type', so the field list is what tells them apart", () => {
    const skdm = upsert(GROUP_A, {
      senderKeyDistributionMessage: { groupId: GROUP_A, axolotlSenderKeyDistributionMessage: Buffer.from("k") },
    });
    expect(skipReason(skdm)).toBe("no content type");
    expect(describeUnreadContent(skdm)).toContain("fields=[senderKeyDistributionMessage]");
    expect(describeUnreadContent(skdm)).toContain("only a group encryption key hand-over");
  });
});

function toNum(v: unknown): number {
  return typeof v === "number" ? v : Number((v as { toNumber?: () => number })?.toNumber?.() ?? v);
}

describe("describeUnreadContent", () => {
  it("lists field names, never values, and the bundle's non-secret metadata", () => {
    const m = upsert(GROUP_A, {
      messageContextInfo: { messageSecret: Buffer.from("super-secret-bytes") },
      senderKeyDistributionMessage: { groupId: GROUP_A, axolotlSenderKeyDistributionMessage: Buffer.from("k") },
      messageHistoryBundle: {
        mimetype: "application/x-protobuf",
        fileSha256: Buffer.from("hash-hash"),
        fileEncSha256: Buffer.from("hash-hash"),
        mediaKey: Buffer.from("super-secret-media-key"),
        directPath: "/v/secret-path",
        messageHistoryMetadata: { historyReceivers: [DIRECT], oldestMessageTimestamp: 1_760_000_000, messageCount: 12 },
      },
    });
    const line = formatUnreadContentLine(m, "notify");
    expect(line).toBe(
      `[baileys][history-sync] upsert=notify chat=${GROUP_A} id=MSG1 has no content type: ` +
        "fields=[messageContextInfo, messageHistoryBundle, senderKeyDistributionMessage] wrappers=[] " +
        "messageContextInfo=present fromMe=no participant=present stubType=none " +
        "messageHistoryBundle{messageCount=12 oldest=2025-10-09T08:53:20Z receivers=1 mimetype=application/x-protobuf}",
    );
    for (const secret of ["secret", "hash-hash", "/v/", "447700900123", "c3VwZXI"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("peels the wrappers and names them", () => {
    const m = upsert(GROUP_A, {
      deviceSentMessage: { message: { ephemeralMessage: { message: { messageHistoryNotice: {} } } } },
    });
    const text = describeUnreadContent(m);
    expect(text).toContain("fields=[messageHistoryNotice]");
    expect(text).toContain("wrappers=[deviceSentMessage, ephemeralMessage]");
    expect(text).toContain("messageHistoryNotice{no metadata}");
  });

  it("says so when the message decoded to nothing (a field this protobuf does not know)", () => {
    const empty = upsert(GROUP_A, {});
    expect(describeUnreadContent(empty)).toContain("fields=[]");
    expect(describeUnreadContent(empty)).toContain("decoded to an empty message");
  });

  it("reports the key flags and a stub type, and survives nothing at all", () => {
    const own = {
      key: { remoteJid: GROUP_A, fromMe: true, id: "X" },
      messageStubType: 20,
    } as unknown as WAMessage;
    expect(describeUnreadContent(own)).toBe(
      "fields=[] (no message object) fromMe=yes participant=absent stubType=20",
    );
    expect(describeUnreadContent(null)).toContain("fields=[]");
  });

  it("does not name a chat that is not a group", () => {
    const line = formatUnreadContentLine(upsert(DIRECT, { messageHistoryNotice: {} }), "append");
    expect(line).toContain("chat=(not a group)");
    expect(line).not.toContain("447700900123");
  });
});

describe("createJoinWatch", () => {
  const JOINED = 1_760_000_000;

  function watch(windowMs = 300_000, maxGroups?: number) {
    let clock = JOINED * 1000;
    const w = createJoinWatch({ now: () => clock, windowMs, maxGroups });
    return { w, advance: (ms: number) => (clock += ms) };
  }

  it("tallies what arrives by age, upsert type and what the driver did with it", () => {
    const { w, advance } = watch();
    expect(w.opened(GROUP_A, JOINED)).toBe(true);
    w.note(GROUP_A, { upsertType: "append", sentAtSec: JOINED, outcome: "skipped: a system notice (stub type 20)" });
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: JOINED + 1, outcome: "skipped: no content type" });
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: JOINED + 1, outcome: "skipped: no content type" });
    w.note(GROUP_A, { upsertType: "append", sentAtSec: JOINED - 3600, outcome: "handed up (chat)" });
    w.note(GROUP_A, { upsertType: "append", sentAtSec: JOINED - 7200, outcome: "handed up (chat)" });
    w.note(GROUP_A, { upsertType: "append", sentAtSec: JOINED - 60, outcome: 'could not be decrypted ("No session")' });

    expect(w.flush()).toEqual([]); // the window is still open
    advance(300_000);
    expect(w.flush()).toEqual([
      `[baileys][history-sync] after-join ${GROUP_A}: in the 300s after we were added, 6 message(s) arrived, ` +
        "3 of them sent BEFORE the add",
      "[baileys][history-sync]   2 x at-or-after-add upsert=notify skipped: no content type",
      "[baileys][history-sync]   2 x older-than-add upsert=append handed up (chat)",
      "[baileys][history-sync]   1 x at-or-after-add upsert=append skipped: a system notice (stub type 20)",
      '[baileys][history-sync]   1 x older-than-add upsert=append could not be decrypted ("No session")',
    ]);
    // Summarised once, then forgotten.
    expect(w.flush()).toEqual([]);
    expect(w.watching(GROUP_A)).toBe(false);
  });

  it("reports a group where nothing arrived, which is itself the answer", () => {
    const { w, advance } = watch();
    w.opened(GROUP_A, JOINED);
    advance(300_000);
    expect(w.flush()).toEqual([
      `[baileys][history-sync] after-join ${GROUP_A}: in the 300s after we were added, 0 message(s) arrived, ` +
        "0 of them sent BEFORE the add",
    ]);
  });

  it("only watches groups, only the ones opened, and only inside the window", () => {
    const { w, advance } = watch();
    expect(w.opened(DIRECT, JOINED)).toBe(false);
    expect(w.opened(null)).toBe(false);
    w.opened(GROUP_A, JOINED);
    w.note(GROUP_B, { upsertType: "notify", sentAtSec: JOINED, outcome: "handed up (chat)" });
    w.note(null, { upsertType: "notify", sentAtSec: JOINED, outcome: "handed up (chat)" });
    advance(300_000);
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: JOINED, outcome: "handed up (chat)" });
    expect(w.flush()[0]).toContain("0 message(s) arrived");
  });

  it("a second join notice inside the window does not reset the tally", () => {
    const { w, advance } = watch();
    w.opened(GROUP_A, JOINED);
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: JOINED, outcome: "handed up (chat)" });
    expect(w.opened(GROUP_A, JOINED + 5)).toBe(false);
    advance(300_000);
    expect(w.flush()[0]).toContain("1 message(s) arrived");
  });

  it("is bounded: it will not watch more groups than its cap", () => {
    const { w } = watch(300_000, 2);
    expect(w.opened(GROUP_A)).toBe(true);
    expect(w.opened(GROUP_B)).toBe(true);
    expect(w.opened("120363000000000003@g.us")).toBe(false);
  });

  it("uses the clock when the join time is unknown, and treats an undated message as not older", () => {
    const { w, advance } = watch();
    w.opened(GROUP_A);
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: 0, outcome: "skipped: no content type" });
    w.note(GROUP_A, { upsertType: "notify", sentAtSec: JOINED - 1, outcome: "handed up (chat)" });
    advance(300_000);
    expect(w.flush()[0]).toContain("2 message(s) arrived, 1 of them sent BEFORE the add");
  });
});
