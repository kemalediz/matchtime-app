/**
 * A YES to a pasted list that was cancelled because its message was edited
 * or deleted (2026-11-15, PR #606 round 5): MatchTime says so ONCE, in the
 * club's language, instead of staying silent. Made-up people.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb, row, type Row } from "./fake-message-db";

const T: Record<string, Row[]> = {};
const fake = makeDb(T, ["adminSquadProposal"]);
vi.mock("@/lib/db", () => ({
  get db() {
    return fake.db;
  },
}));

import { changedListNotice } from "../admin-group-paste";

const NOW = new Date("2026-11-15T18:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

beforeEach(() => {
  T.adminSquadProposal = [];
});

describe("changedListNotice", () => {
  it("a list cancelled by its message's edit or delete: said once, in English and in Turkish", async () => {
    T.adminSquadProposal.push(row({ orgId: "org-a", waMessageId: "m1", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }));
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW })).toEqual({
      outcome: "paste-source-changed",
      replyText: "That list was changed, so I've dropped it. Paste it again and I'll read it.",
    });
    expect(T.adminSquadProposal[0].outcome).toBe("source-deleted-told");
    // Once: the next YES is about nothing.
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW })).toBeNull();

    T.adminSquadProposal.push(row({ orgId: "org-a", waMessageId: "m2", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }));
    expect((await changedListNotice({ orgId: "org-a", lang: "tr", now: NOW }))?.replyText).toBe("O liste değiştirildi, bu yüzden bıraktım. Yeniden yapıştırın, okuyayım.");
  });

  it("nothing for another club, another member's list (a member's own YES), an applied list, or one cancelled a day ago", async () => {
    T.adminSquadProposal.push(
      row({ orgId: "org-b", waMessageId: "m1", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }),
      row({ orgId: "org-a", waMessageId: "m2", proposedByUserId: "u-ali", resolvedAt: ago(5), outcome: "source-deleted", createdAt: ago(10) }),
      row({ orgId: "org-a", waMessageId: "m3", proposedByUserId: "u-sam", resolvedAt: ago(5), outcome: "applied", createdAt: ago(10) }),
      row({ orgId: "org-a", waMessageId: "m4", proposedByUserId: "u-sam", resolvedAt: ago(25 * 60), outcome: "source-deleted", createdAt: ago(26 * 60) }),
    );
    expect(await changedListNotice({ orgId: "org-a", lang: "en", now: NOW, proposedBy: "u-sam" })).toBeNull();
  });
});
