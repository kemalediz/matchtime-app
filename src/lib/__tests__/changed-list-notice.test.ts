/**
 * A YES to a pasted list that was cancelled because its message was edited
 * or deleted (2026-11-15, PR #606 rounds 5-6): MatchTime says so ONCE, in
 * the club's language, but only when the YES is clearly about that list:
 * it quotes MatchTime's proposal message for it, or it comes from the
 * organiser who pasted it with no newer list proposed or applied since.
 * Any other YES behaves as before. Made-up people.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb, row, type Row } from "./fake-message-db";

const T: Record<string, Row[]> = {};
const fake = makeDb(T, ["adminSquadProposal", "sentNotification"]);
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));

import { changedListNotice } from "../admin-group-paste";

const NOW = new Date("2026-11-15T18:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const CHANGED = "That list was changed, so I've dropped it. Paste it again and I'll read it.";
const QUESTION = "Adding: Zara Zest. Say *@Match Time YES* to apply.";

beforeEach(() => {
  T.adminSquadProposal = [];
  T.sentNotification = [];
  T.adminSquadProposal.push(row({ orgId: "org-a", waMessageId: "paste-1", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }));
  T.sentNotification.push(row({ key: "hqreply:org-a:paste-1", kind: "admin-group-reply", text: QUESTION, waMessageId: "3EB0QUESTION0001", createdAt: ago(10) }));
});

describe("changedListNotice", () => {
  it("the organiser who pasted it says YES, nothing newer since: said once, in English and in Turkish", async () => {
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-sam" })).toEqual({ outcome: "paste-source-changed", replyText: CHANGED });
    expect(T.adminSquadProposal[0].outcome).toBe("source-deleted-told");
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-sam" })).toBeNull();
    T.adminSquadProposal[0].outcome = "source-deleted";
    expect((await changedListNotice({ orgId: "org-a", lang: "tr", now: NOW, senderUserId: "u-sam" }))?.replyText).toBe("O liste değiştirildi, bu yüzden bıraktım. Yeniden yapıştırın, okuyayım.");
  });

  it("another organiser's YES that quotes MatchTime's proposal message for that list (by its id, or its words): said", async () => {
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-ali", quoted: { fromMatchTime: true, messageId: "3EB0QUESTION0001", text: "" } })).toMatchObject({ replyText: CHANGED });
    T.adminSquadProposal[0].outcome = "source-deleted";
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-ali", quoted: { fromMatchTime: true, messageId: null, text: QUESTION } })).toMatchObject({ replyText: CHANGED });
  });

  it("an UNRELATED YES (another organiser, quoting nothing or something else): as before, nothing said here", async () => {
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-ali" })).toBeNull();
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-ali", quoted: { fromMatchTime: true, messageId: "3EB0OTHER000001", text: "Teams ready?" } })).toBeNull();
    expect(T.adminSquadProposal[0].outcome).toBe("source-deleted");
  });

  it("a list re-pasted (and applied) since: a later YES from the paster is not about the dropped one", async () => {
    T.adminSquadProposal.push(row({ orgId: "org-a", waMessageId: "paste-2", proposedByUserId: "u-sam", resolvedAt: ago(1), outcome: "applied", createdAt: ago(3) }));
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-sam" })).toBeNull();
  });

  it("nothing for another club, an applied list, or one cancelled a day ago", async () => {
    T.adminSquadProposal = [
      row({ orgId: "org-b", waMessageId: "p1", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }),
      row({ orgId: "org-a", waMessageId: "p3", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "applied", createdAt: ago(10) }),
      row({ orgId: "org-a", waMessageId: "p4", proposedByUserId: "u-sam", resolvedAt: ago(25 * 60), outcome: "source-deleted", createdAt: ago(26 * 60) }),
    ];
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, senderUserId: "u-sam" })).toBeNull();
  });
});
