/**
 * THE DAILY "NEW PLAYERS TO REVIEW" NOTICE says how each player got on the
 * list (2026-10-14, the FNF rehearsal). It used to say every one of them was
 * "auto-added after posting in the group", also a player an organiser had
 * pasted into a list who never wrote a word. Now:
 *
 *   posted in the group                 they wrote in the players' group;
 *   added by name                       from a pasted list, or from someone
 *                                       else's message naming them.
 *
 * English and Turkish, a DM (with the personal link and the plain URL) and
 * an admin-group post (the plain URL only).
 */
import { describe, it, expect } from "vitest";
import { buildProvisionalReviewNotice } from "../provisional-review-copy";

const URL = "https://matchtime.example/admin/players";

describe("buildProvisionalReviewNotice", () => {
  it("one player who posted in the group, by DM", () => {
    expect(
      buildProvisionalReviewNotice({ posted: ["Hamzah Khan"], listed: [], link: "LINK", audience: "dm", plainUrl: URL, lang: "en" }),
    ).toBe(
      "✨ *New players to review*: 1 person was added automatically.\n\n" +
        "Posted in the group: Hamzah Khan\n\n" +
        "Tap to review and set phone, position and rating, or remove:\nLINK\n\n" +
        `Or open: ${URL}`,
    );
  });

  it("players added from an organiser's list never read 'after posting in the group'", () => {
    const text = buildProvisionalReviewNotice({
      posted: [],
      listed: ["Raihan Ahmed", "Wasim Ali"],
      link: URL,
      audience: "group",
      plainUrl: URL,
      lang: "en",
    });
    expect(text).toBe(
      "✨ *New players to review*: 2 people were added automatically.\n\n" +
        "Added by name, from a list or someone else's message: Raihan Ahmed, Wasim Ali\n\n" +
        `Review them and set phone, position and rating, or remove them:\n${URL}`,
    );
    expect(text).not.toContain("posting in the group");
  });

  it("both kinds, each line capped at five names", () => {
    const listed = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
    const text = buildProvisionalReviewNotice({ posted: ["P1"], listed, link: URL, audience: "group", plainUrl: URL, lang: "en" });
    expect(text).toContain("8 people were added automatically.");
    expect(text).toContain("Posted in the group: P1\nAdded by name, from a list or someone else's message: A1, A2, A3, A4, A5 (+2 more)");
  });

  it("Turkish", () => {
    expect(
      buildProvisionalReviewNotice({ posted: ["Ali"], listed: ["Can", "Ece"], link: "LINK", audience: "dm", plainUrl: URL, lang: "tr" }),
    ).toBe(
      "✨ *İncelenecek yeni oyuncular*: 3 kişi otomatik eklendi.\n\n" +
        "Grupta yazdı: Ali\n" +
        "Bir listeden ya da başkasının mesajından adıyla eklendi: Can, Ece\n\n" +
        "İncelemek, telefon, mevki ve puanı ayarlamak ya da kaldırmak için dokunun:\nLINK\n\n" +
        `Ya da açın: ${URL}`,
    );
    expect(
      buildProvisionalReviewNotice({ posted: [], listed: ["A1", "A2", "A3", "A4", "A5", "A6"], link: URL, audience: "group", plainUrl: URL, lang: "tr" }),
    ).toContain("A1, A2, A3, A4, A5 (+1 kişi daha)");
  });
});
