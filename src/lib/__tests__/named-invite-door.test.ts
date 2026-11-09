/**
 * `dmNamedPeople`, the one door both groups use (2026-11-09), with its
 * store and the invite mocked: which message's tags it reads, and that a
 * failure still answers the organiser (review #1, #5, #10).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mentionsOfQuoted = vi.fn();
const mentionsAbove = vi.fn();
const inviteNamedPeople = vi.fn();
vi.mock("@/lib/group-mentions", async (orig) => ({
  ...(await orig<typeof import("@/lib/group-mentions")>()),
  mentionsOfQuoted: (...a: unknown[]) => mentionsOfQuoted(...a),
  mentionsAbove: (...a: unknown[]) => mentionsAbove(...a),
}));
vi.mock("@/lib/recruit", () => ({ inviteNamedPeople: (...a: unknown[]) => inviteNamedPeople(...a) }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { dmNamedPeople } from "@/lib/named-invite";

const AT = new Date("2026-11-09T17:30:00Z");
const BOT = "999000111222333@lid";
const base = { orgId: "org-1", chatId: "g@g.us", lang: "en", requesterUserId: "u-kemal" };
const done = { kind: "done", matchName: "M", when: "W", matchId: "m1", plan: { invite: [{ userId: "u1", name: "x", phone: "1", label: "Ali", member: true }], alreadyInvited: [], answered: [], optedOut: [], notHere: [], overCap: [], unknown: [], unknownUnlabelled: 0, unidentified: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  mentionsOfQuoted.mockResolvedValue(null);
  mentionsAbove.mockResolvedValue(null);
  inviteNamedPeople.mockResolvedValue(done);
});

describe("dmNamedPeople", () => {
  it("a request that tagged someone the Pi could not name never falls back to the message above (review #1)", async () => {
    mentionsAbove.mockResolvedValue({ mentions: [{ jid: "1234567@lid", name: "John" }], unidentified: 0, senderName: "Shane", sentAt: new Date("2026-11-09T17:00:00Z") });
    inviteNamedPeople.mockResolvedValue({ ...done, plan: { ...done.plan, invite: [], unidentified: 1 } });
    const r = await dmNamedPeople({ ...base, message: { waMessageId: "w2", sentAt: AT, botMentioned: true, mentions: [BOT, "55555555555@lid"] } });
    expect(mentionsAbove).not.toHaveBeenCalled();
    expect(inviteNamedPeople).toHaveBeenCalledWith("org-1", { mentions: [], unidentified: 1 }, expect.anything());
    expect(r.replyText).toBe("I couldn't tell who 1 of the people tagged is, so I didn't message them.");
  });

  it("the message above: an earlier one in the same flush beats an older stored one, and the reply says whose (review #5)", async () => {
    mentionsAbove.mockResolvedValue({ mentions: [{ jid: "1234567@lid" }], unidentified: 0, senderName: "Old", sentAt: new Date("2026-11-09T17:00:00Z") });
    const r = await dmNamedPeople({
      ...base,
      message: { waMessageId: "w2", sentAt: AT, botMentioned: true },
      batchBefore: [{ waMessageId: "w1", timestamp: AT.toISOString(), authorName: "Shane", mentions: ["7654321@lid"], mentionNames: [{ jid: "7654321@lid", name: "Dan" }] }],
    });
    expect(mentionsAbove).toHaveBeenCalledWith({ orgId: "org-1", chatId: "g@g.us", before: AT, excludeWaMessageIds: ["w2", "w1"] });
    expect(inviteNamedPeople.mock.calls[0][1]).toEqual({ mentions: [{ jid: "7654321@lid", name: "Dan" }], unidentified: 0 });
    expect(r.replyText.split("\n")[0]).toBe("📨 From Shane's message:");
    expect(r.from).toBe("above");
  });

  it("a reply reads only the quoted message", async () => {
    mentionsOfQuoted.mockResolvedValue({ mentions: [{ jid: "1234567@lid" }], unidentified: 0, senderName: "Shane", sentAt: AT });
    await dmNamedPeople({ ...base, message: { waMessageId: "w2", sentAt: AT, botMentioned: true, quotedMessageId: "3EB0" } });
    expect(mentionsOfQuoted).toHaveBeenCalledWith("org-1", "3EB0");
    expect(mentionsAbove).not.toHaveBeenCalled();
  });

  it("the invite throws: a short reply, never silence (review #10)", async () => {
    mentionsOfQuoted.mockResolvedValue({ mentions: [{ jid: "1234567@lid" }], unidentified: 0, senderName: null, sentAt: AT });
    inviteNamedPeople.mockRejectedValue(new Error("db down"));
    const r = await dmNamedPeople({ ...base, message: { waMessageId: "w2", sentAt: AT, botMentioned: true, quotedMessageId: "3EB0" } });
    expect(r).toMatchObject({ outcome: "named-failed", invited: 0, replyText: "Something went wrong, so I haven't messaged anyone. Please try again in a minute." });
  });
});
