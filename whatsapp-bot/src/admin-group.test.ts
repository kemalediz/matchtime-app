/**
 * Slice 2a on the Pi: an admin group's messages go to their own route at
 * once and never into the analysis history or batch; only a message shaped
 * like the link command leaves any other group, a silent one included.
 */
import { describe, expect, it, vi } from "vitest";
import {
  looksLikeAdminGroupLink,
  mightBeAdminGroupLink,
  reactionChatId,
  routeAdminGroupInbound,
  type AdminGroupInboundDeps,
} from "./admin-group.js";

const HQ = "120363900000000001@g.us";
const SILENT = "120363900000000002@g.us";

function deps(over: Partial<AdminGroupInboundDeps> = {}, admin: string[] = []) {
  const forwarded: unknown[] = [];
  const linkForwarded: unknown[] = [];
  const replies: string[] = [];
  const added: Array<[string, string]> = [];
  const d: AdminGroupInboundDeps = {
    isAdminGroup: (g) => admin.includes(g),
    addAdminGroup: (g, o) => void added.push([g, o]),
    read: vi.fn(async () => ({
      groupId: HQ,
      messageId: "m1",
      text: "@Match Time admin group K7P3QX",
      botMentioned: true,
      senderPhone: "447700900102",
      timestamp: "2026-09-30T12:00:00.000Z",
    })),
    postAdminGroupMessage: vi.fn(async (m) => {
      forwarded.push(m);
      return { replyText: null };
    }),
    postAdminGroupLink: vi.fn(async (m) => {
      linkForwarded.push(m);
      return { outcome: "linked", replyText: "✅ Linked as the admin group for *Friday FNF*.", adminGroup: { groupId: SILENT, orgId: "org-fnf" } };
    }),
    reply: vi.fn(async (t: string) => void replies.push(t)),
    log: () => {},
    ...over,
  };
  return { d, forwarded, linkForwarded, replies, added };
}

describe("the link-command shape (a copy of the server's)", () => {
  it("reads EN and TR, typed or tagged; refuses chat and wrong lengths", () => {
    expect(looksLikeAdminGroupLink("@Match Time admin group K7P3QX", false)).toBe(true);
    expect(looksLikeAdminGroupLink("@447700900000 admin group K7P3QX", true)).toBe(true);
    expect(looksLikeAdminGroupLink("@Match Time yönetici grubu K7P3QX", false)).toBe(true);
    expect(looksLikeAdminGroupLink("admin group K7P3QX", false)).toBe(false);
    expect(looksLikeAdminGroupLink("@Match Time admin group K7P3Q", false)).toBe(false);
    expect(looksLikeAdminGroupLink("@Match Time admin group K7P3QXZ", false)).toBe(false);
    expect(mightBeAdminGroupLink("in for friday")).toBe(false);
  });
});

describe("routeAdminGroupInbound", () => {
  it("an admin-group message is forwarded at once to the admin-group route, and is never a link command", async () => {
    const { d, forwarded, linkForwarded } = deps({}, [HQ]);
    expect(await routeAdminGroupInbound(d, { from: HQ, body: "2" })).toBe("admin-group");
    expect(forwarded).toHaveLength(1);
    expect(linkForwarded).toHaveLength(0);
  });

  it("the server's reply to an admin-group message is posted in that group", async () => {
    const { d, replies } = deps({ postAdminGroupMessage: async () => ({ replyText: "✅ Done" }) }, [HQ]);
    await routeAdminGroupInbound(d, { from: HQ, body: "2" });
    expect(replies).toEqual(["✅ Done"]);
  });

  it("a reply the server claimed is acked with its sent id (slice S4 review), so an HQ YES quoting it is decided by the id", async () => {
    const acked: unknown[] = [];
    const { d } = deps(
      {
        postAdminGroupMessage: async () => ({ replyText: "Is that YES to the proposed teams?", replyKey: "hqreply:org-fnf:m1" }),
        reply: vi.fn(async () => ({ id: { _serialized: "true_hq@g.us_3EB0ASK" } })),
        ackReply: vi.fn(async (key: string, kind: string, sent: unknown) => void acked.push([key, kind, sent])),
      },
      [HQ],
    );
    await routeAdminGroupInbound(d, { from: HQ, body: "yes" });
    expect(acked).toEqual([["hqreply:org-fnf:m1", "admin-group-reply", { id: { _serialized: "true_hq@g.us_3EB0ASK" } }]]);
  });

  it("an unclaimed reply is not acked", async () => {
    const ackReply = vi.fn(async () => {});
    const { d } = deps({ postAdminGroupMessage: async () => ({ replyText: "✅ Done" }), ackReply }, [HQ]);
    await routeAdminGroupInbound(d, { from: HQ, body: "2" });
    expect(ackReply).not.toHaveBeenCalled();
  });

  it("in a silent group, only a link-shaped message leaves the Pi; the answer links it here at once and is posted", async () => {
    const { d, linkForwarded, replies, added } = deps();
    expect(await routeAdminGroupInbound(d, { from: SILENT, body: "in for friday" })).toBe("not-handled");
    expect(d.read).not.toHaveBeenCalled();
    expect(await routeAdminGroupInbound(d, { from: SILENT, body: "@447700900000 admin group K7P3QX" })).toBe("link-command");
    expect(linkForwarded).toHaveLength(1);
    expect(added).toEqual([[SILENT, "org-fnf"]]);
    expect(replies).toEqual(["✅ Linked as the admin group for *Friday FNF*."]);
  });

  it("a link-shaped message the server does not answer: nothing posted, nothing linked", async () => {
    const { d, replies, added } = deps({ postAdminGroupLink: async () => null });
    expect(await routeAdminGroupInbound(d, { from: SILENT, body: "@Match Time admin group K7P3QX" })).toBe("link-command");
    expect(replies).toEqual([]);
    expect(added).toEqual([]);
  });

  it("an answer naming a DIFFERENT group never turns this one into an admin group", async () => {
    const { d, added } = deps({ postAdminGroupLink: async () => ({ adminGroup: { groupId: "other@g.us", orgId: "o" } }) });
    await routeAdminGroupInbound(d, { from: SILENT, body: "@Match Time admin group K7P3QX" });
    expect(added).toEqual([]);
  });

  it("the words without MatchTime being addressed are chat, not a command", async () => {
    const { d, linkForwarded } = deps({
      read: async () => ({ groupId: SILENT, messageId: "m2", text: "our admin group K7P3QX", botMentioned: false, senderPhone: "", timestamp: "t" }),
    });
    expect(await routeAdminGroupInbound(d, { from: SILENT, body: "our admin group K7P3QX" })).toBe("not-handled");
    expect(linkForwarded).toHaveLength(0);
  });

  // "It should put a tick if it recognises a command" (Kemal, 2026-10-16).
  describe("the server's ✅ on an admin's message", () => {
    const reacting = (answer: Record<string, unknown> | null, outcome: { ok: true } | { ok: false; reason: "message-not-found" } = { ok: true }) => {
      const reacts: Array<[string, string]> = [];
      const sendReaction = vi.fn(async (id: string, emoji: string) => {
        reacts.push([id, emoji]);
        return outcome;
      });
      const { d, replies } = deps(
        {
          postAdminGroupMessage: async () => answer,
          sendReaction,
          read: async () => ({ groupId: HQ, messageId: `false_${HQ}_3EB0ABC_1@lid`, text: "@Match Time swap Sam and Alex", botMentioned: true, senderPhone: "", timestamp: "t" }),
        },
        [HQ],
      );
      return { d, replies, reacts };
    };

    it("is placed on the admin's own message, by the id the server was sent, through the shared reaction path", async () => {
      const { d, reacts, replies } = reacting({ replyText: "✅ *Final teams*", react: "✅" });
      await routeAdminGroupInbound(d, { from: HQ, body: "@Match Time swap Sam and Alex" });
      expect(reacts).toEqual([[`false_${HQ}_3EB0ABC_1@lid`, "✅"]]);
      expect(replies).toEqual(["✅ *Final teams*"]);
    });

    it("with no reply at all (a graphic queued): still the tick", async () => {
      const { d, reacts, replies } = reacting({ replyText: null, react: "✅" });
      await routeAdminGroupInbound(d, { from: HQ, body: "x" });
      expect(reacts).toHaveLength(1);
      expect(replies).toEqual([]);
    });

    it("no react in the answer (ignored chat, an older server, no answer): no tick", async () => {
      for (const answer of [{ replyText: null }, { replyText: null, react: null }, null]) {
        const { d, reacts } = reacting(answer);
        await routeAdminGroupInbound(d, { from: HQ, body: "x" });
        expect(reacts).toEqual([]);
      }
    });

    it("a reaction WhatsApp refuses is logged, never posted as words, and the reply still goes", async () => {
      const lines: string[] = [];
      const { d, replies } = reacting({ replyText: "Done.", react: "✅" }, { ok: false, reason: "message-not-found" });
      d.log = (l) => void lines.push(l);
      await routeAdminGroupInbound(d, { from: HQ, body: "x" });
      expect(replies).toEqual(["Done."]);
      expect(lines.some((l) => l.includes("react") && l.includes("message-not-found"))).toBe(true);
    });

    it("a synthetic id (the real one was unreadable) is never sent to WhatsApp", async () => {
      const { d, reacts } = reacting({ replyText: null, react: "✅" });
      d.read = async () => ({ groupId: HQ, messageId: "synthetic:abc", text: "x", botMentioned: false, senderPhone: "", timestamp: "t" });
      await routeAdminGroupInbound(d, { from: HQ, body: "x" });
      expect(reacts).toEqual([]);
    });
  });

  it("a DM is never handled here", async () => {
    const { d } = deps({}, [HQ]);
    expect(await routeAdminGroupInbound(d, { from: "447700900102@c.us", body: "@Match Time admin group K7P3QX" })).toBe("not-handled");
  });
});

describe("reactionChatId", () => {
  it("reads the chat from msgId.remote or the serialised id", () => {
    expect(reactionChatId({ msgId: { remote: HQ } })).toBe(HQ);
    expect(reactionChatId({ msgId: { _serialized: `true_${HQ}_3EB0ABC` } })).toBe(HQ);
    expect(reactionChatId({})).toBeNull();
    expect(
      reactionChatId({
        get msgId() {
          throw new Error("r: r");
        },
      }),
    ).toBeNull();
  });
});
