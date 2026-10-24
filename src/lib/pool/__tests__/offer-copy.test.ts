/**
 * The pool offer DM and the messages around it (slice L5a). Approved spec,
 * "Offer": club, venue with address and map link, distance,
 * day/date/kickoff/length, sport and format, casual/competitive/mixed
 * (omitted when unset), club size and how often it plays (counts only),
 * fee ("free" when none), places needed. Never: group name, organiser or
 * member names, phone numbers. Every pool message carries the stop/manage
 * link.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import {
  milesLabel,
  poolAskRefusalText,
  poolOfferLines,
  poolOfferText,
  withPoolOffer,
  poolOrganiserNotice,
  poolPausedText,
  poolPlacedText,
  poolReplyFactsText,
  poolReplyGoneText,
  poolReplyProfileOffText,
  poolReplyReaskText,
  poolReplyStateText,
  poolReplyStoppedText,
  poolReplyTapText,
  poolReplyWhichText,
  regularityOf,
  shortDisplayName,
  turnUpLine,
  type PoolOfferFacts,
} from "../offer-copy";

const KICKOFF = londonDateTimeToUtc("2026-10-30", "20:30");
const FACTS: PoolOfferFacts = {
  club: "FNF",
  places: 1,
  sport: "football",
  format: 7,
  kickoff: KICKOFF,
  durationMins: 60,
  venueName: "Goals North Cheam",
  address: "Cheam Common Rd, Worcester Park KT4 8RH",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=51.37,-0.23",
  distanceMiles: 1.8,
  playStyle: "casual",
  members: 30,
  gamesLast8Weeks: 8,
  fee: { kind: "amount", amount: "£6" },
};
const LINKS = { tapLink: "https://matchtime.ai/play/offer/abc.def", manageLink: "https://matchtime.ai/r/x1" };

describe("the offer DM, EN (the spec's example)", () => {
  it("carries every fact, in order, with the tap link and the manage link", () => {
    expect(poolOfferText("en", FACTS, LINKS)).toBe(
      [
        "⚽ *FNF* needs 1 player for a 7-a-side football game",
        "📅 *Friday 30 October at 20:30* (60 mins)",
        "📍 *Goals North Cheam*, Cheam Common Rd, Worcester Park KT4 8RH. 1.8 miles from you. Map: https://www.google.com/maps/search/?api=1&query=51.37,-0.23",
        "🤝 Casual, friendly game. A regular group of 30 players, playing every week",
        "💷 £6 match fee",
        "",
        "Would you like the place? Reply here, or tap to answer: https://matchtime.ai/play/offer/abc.def",
        "",
        "You get these because you joined the MatchTime player pool. Stop or change them: https://matchtime.ai/r/x1",
      ].join("\n"),
    );
  });

  it("says free when the club takes no fee, and plural places", () => {
    const text = poolOfferText("en", { ...FACTS, places: 2, fee: { kind: "free" } }, LINKS);
    expect(text).toContain("needs 2 players for a 7-a-side");
    expect(text).toContain("💷 Free, no match fee");
  });

  it("leaves a line out when its fact is unknown", () => {
    const text = poolOfferText(
      "en",
      { ...FACTS, address: null, mapUrl: null, distanceMiles: null, playStyle: null, members: 0, gamesLast8Weeks: 0, fee: null, format: null },
      LINKS,
    );
    expect(text).toContain("⚽ *FNF* needs 1 player for a football game");
    expect(text).toContain("📍 *Goals North Cheam*\n");
    expect(text).not.toMatch(/🤝|💷|Map:|from you/);
  });

  it("style alone, size alone, and a club that plays less than weekly", () => {
    expect(poolOfferText("en", { ...FACTS, members: 0, gamesLast8Weeks: 0, playStyle: "competitive" }, LINKS)).toContain("🤝 Competitive game\n");
    expect(poolOfferText("en", { ...FACTS, playStyle: null, gamesLast8Weeks: 3 }, LINKS)).toContain("🤝 A group of 30 players, 3 games in the last 8 weeks\n");
    expect(poolOfferText("en", { ...FACTS, playStyle: "mixed", gamesLast8Weeks: 0 }, LINKS)).toContain("🤝 Mixed levels, everyone welcome. A group of 30 players\n");
  });

  it("basketball 3-a-side", () => {
    expect(poolOfferText("en", { ...FACTS, sport: "basketball", format: 3 }, LINKS)).toContain("for a 3-a-side basketball game");
  });
});

describe("the offer DM, TR", () => {
  it("carries every fact in Turkish", () => {
    const text = poolOfferText("tr", FACTS, LINKS);
    expect(text.split("\n")[0]).toBe("⚽ *FNF*, 7'ye 7 futbol maçı için 1 oyuncu arıyor");
    expect(text).toContain("📅 *30 Ekim Cuma 20:30* (60 dk)");
    expect(text).toContain("sana 1,8 mil. Harita: https://");
    expect(text).toContain("🤝 Keyifli, dostane bir maç. Her hafta oynayan 30 kişilik düzenli bir grup");
    expect(text).toContain("💷 Maç ücreti £6");
    expect(text).toContain("Yeri ister misin? Buradan cevap ver ya da bağlantıya dokun: https://matchtime.ai/play/offer/abc.def");
    expect(text).toContain("Durdur ya da değiştir: https://matchtime.ai/r/x1");
  });
});

describe("privacy: an offer is built from facts only", () => {
  it("has no field for a name or a number, and renders none", () => {
    const keys = Object.keys(FACTS).sort();
    expect(keys).toEqual(
      ["address", "club", "distanceMiles", "durationMins", "fee", "format", "gamesLast8Weeks", "kickoff", "mapUrl", "members", "places", "playStyle", "sport", "venueName"].sort(),
    );
    for (const lang of ["en", "tr"] as const) expect(poolOfferText(lang, FACTS, LINKS)).not.toMatch(/\+?44\s?7\d{3}|07\d{3}\s?\d{6}/);
  });
});

describe("milesLabel and regularityOf", () => {
  it("one decimal, a comma in Turkish, 'mile' for exactly 1", () => {
    expect(milesLabel("en", 1.84)).toEqual({ miles: "1.8", one: false });
    expect(milesLabel("tr", 1.84)).toEqual({ miles: "1,8", one: false });
    expect(milesLabel("en", 1)).toEqual({ miles: "1", one: true });
    expect(milesLabel("en", 0.04)).toEqual({ miles: "0.1", one: false });
  });

  it("weekly from 7 games in 8 weeks, otherwise the count, nothing for none", () => {
    expect(regularityOf(8)).toEqual({ kind: "weekly" });
    expect(regularityOf(7)).toEqual({ kind: "weekly" });
    expect(regularityOf(6)).toEqual({ kind: "games", games: 6 });
    expect(regularityOf(0)).toBeNull();
  });
});

describe("after he says yes", () => {
  const placed = { club: "FNF", kickoff: KICKOFF, venueName: "Goals North Cheam", fee: { kind: "amount" as const, amount: "£6" }, offerLink: LINKS.tapLink, manageLink: LINKS.manageLink };
  it("in: the game, the fee and pay link, how to give it back, the manage link", () => {
    const text = poolPlacedText("en", { ...placed, bench: false });
    expect(text).toContain("✅ You're in: *FNF*, Friday 30 October at 20:30, Goals North Cheam.");
    expect(text).toContain("The match fee is £6. You'll get a pay link after the game.");
    expect(text).toContain(`Give the place back here: ${LINKS.tapLink}`);
    expect(text).toContain(LINKS.manageLink);
  });
  it("bench (organiser-pick club): 'bench', never a waiting list; TR 'yedek'", () => {
    expect(poolPlacedText("en", { ...placed, bench: true })).toMatch(/on the bench for \*FNF\*/);
    expect(poolPlacedText("tr", { ...placed, bench: true })).toMatch(/yedektesin/);
    expect(poolPlacedText("en", { ...placed, bench: true, fee: { kind: "free" } })).not.toMatch(/match fee/);
  });
});

describe("one-line replies and the pause DM carry the manage link", () => {
  it("tap the link / that place has gone / paused", () => {
    expect(poolReplyTapText("en", { tapLink: LINKS.tapLink, manageLink: LINKS.manageLink })).toBe(
      `To answer the offer, tap the link: ${LINKS.tapLink}\n\nYou get these because you joined the MatchTime player pool. Stop or change them: ${LINKS.manageLink}`,
    );
    expect(poolReplyGoneText("tr", { club: "FNF", manageLink: LINKS.manageLink })).toContain("FNF maçındaki o yer doldu");
    expect(poolPausedText("en", { n: 3, manageLink: LINKS.manageLink })).toContain(`the last 3 went unanswered. Want them again? Tap here: ${LINKS.manageLink}`);
  });
});

describe("the organisers' notice: first name and last initial, the turn-up line, never a number", () => {
  it("short names", () => {
    expect(shortDisplayName("Ali Kaya")).toBe("Ali K");
    expect(shortDisplayName("  ali   kaya  smith ")).toBe("ali S");
    expect(shortDisplayName("Ali")).toBe("Ali");
    expect(shortDisplayName("Ali K")).toBe("Ali K");
  });
  it("turn-up lines", () => {
    expect(turnUpLine("en", { played: 0, missed: 0 })).toBe("New to MatchTime.");
    expect(turnUpLine("en", { played: 6, missed: 0 })).toBe("Played 6 MatchTime games, turned up to all of them.");
    expect(turnUpLine("en", { played: 1, missed: 0 })).toBe("Played 1 MatchTime game and turned up to it.");
    expect(turnUpLine("en", { played: 4, missed: 1 })).toBe("Turned up to 4 of 5 MatchTime games.");
    expect(turnUpLine("tr", { played: 0, missed: 0 })).toBe("MatchTime'da yeni.");
  });
  it("in and bench, EN and TR", () => {
    const day = "Tue 27 Oct";
    expect(poolOrganiserNotice("en", { name: "Ali K", day, bench: false, record: { played: 6, missed: 0 } })).toBe(
      "🙋 Ali K from the MatchTime player pool took a place for Tue 27 Oct. Played 6 MatchTime games, turned up to all of them.",
    );
    expect(poolOrganiserNotice("en", { name: "Ali K", day, bench: true, record: { played: 0, missed: 0 } })).toMatch(/on the bench for Tue 27 Oct, for you to pick\. New to MatchTime\.$/);
    expect(poolOrganiserNotice("tr", { name: "Ali K", day: "27 Eki Sal", bench: false, record: { played: 0, missed: 0 } })).toContain("MatchTime oyuncu havuzundan Ali K");
  });
});

describe("the organisers' side: the notice line and refusals, a band never a list", () => {
  it("the short-squad notice gains one line, only with a band", () => {
    expect(withPoolOffer("Squad short.", null, "https://m/1", "en")).toBe("Squad short.");
    expect(withPoolOffer("Squad short.", "few", "https://m/1", "en")).toBe(
      "Squad short.\n\n🔎 Or ask nearby players from the MatchTime pool (a few near you). Open the match page: https://m/1",
    );
    expect(withPoolOffer("Kadro eksik.", "5+", "https://m/1", "tr")).toContain("yakınınızda 5+ kişi");
  });
  it("in the admin group (L10) the line invites a YES there, the match page still linked; a DM is unchanged", () => {
    expect(withPoolOffer("Squad short.", "few", "https://m/1", "en", { inHq: true })).toBe(
      "Squad short.\n\n🔎 Or I can ask nearby players from the MatchTime pool (a few near you): reply YES here, or open the match page: https://m/1",
    );
    expect(withPoolOffer("Kadro eksik.", "few", "https://m/1", "tr", { inHq: true })).toBe(
      "Kadro eksik.\n\n🔎 Ya da MatchTime havuzundan yakındaki oyunculara sorayım (yakınınızda birkaç kişi): burada EVET yazın ya da maç sayfasını açın: https://m/1",
    );
    expect(withPoolOffer("Squad short.", "few", "https://m/1", "en", { inHq: false })).toBe(withPoolOffer("Squad short.", "few", "https://m/1", "en"));
    expect(withPoolOffer("Squad short.", null, "https://m/1", "en", { inHq: true })).toBe("Squad short.");
  });
  it("every refusal has its words, EN and TR", () => {
    for (const r of ["pool-closed", "no-venue", "too-late", "round-open", "club-week-cap", "no-places", "bad-number", "none-near", "not-found"]) {
      expect(poolAskRefusalText("en", r, 3)).toBeTruthy();
      expect(poolAskRefusalText("tr", r, 3)).not.toBe(poolAskRefusalText("en", r, 3));
    }
    expect(poolAskRefusalText("en", "bad-number", 2)).toBe("Choose between 1 and 2 players.");
  });
  it("the page shows the same fact lines as the DM", () => {
    expect(poolOfferText("en", FACTS, LINKS).startsWith(poolOfferLines("en", FACTS).join("\n"))).toBe(true);
  });
});

describe("replies in words (slice L6): one short line each, the manage link last, nothing invented", () => {
  const M = "https://matchtime.ai/r/x1";
  it("a question gets the offer's own facts and the way to answer, nothing else", () => {
    const text = poolReplyFactsText("en", FACTS, { state: "open", tapLink: LINKS.tapLink, manageLink: M });
    expect(text).toBe(
      ["Here's everything I know about this game:", poolOfferLines("en", FACTS).join("\n"), "", "Would you like the place? Reply here, or tap to answer: https://matchtime.ai/play/offer/abc.def", "", `You get these because you joined the MatchTime player pool. Stop or change them: ${M}`].join("\n"),
    );
  });
  it("a question about a place he holds ends with how to give it back", () => {
    const text = poolReplyFactsText("en", FACTS, { state: "taken", tapLink: LINKS.tapLink, manageLink: M });
    expect(text).toContain("Can't make it after all? Give the place back here: https://matchtime.ai/play/offer/abc.def");
    expect(text).not.toContain("Would you like the place?");
    expect(poolReplyFactsText("tr", FACTS, { state: "open", tapLink: LINKS.tapLink, manageLink: M })).toMatch(/^Bu maç hakkında bildiklerim:\n⚽ \*FNF\*/);
  });
  it("the one re-ask below the floor, EN and TR", () => {
    expect(poolReplyReaskText("en", { tapLink: LINKS.tapLink, manageLink: M })).toBe(
      `Sorry, I didn't quite get that. Would you like the place? Reply yes or no, or tap to answer: ${LINKS.tapLink}\n\nYou get these because you joined the MatchTime player pool. Stop or change them: ${M}`,
    );
    expect(poolReplyReaskText("tr", { tapLink: LINKS.tapLink, manageLink: M })).toMatch(/^Kusura bakma, tam anlayamadım\./);
  });
  it("two open offers: which one, each with its own link, never a guess", () => {
    const text = poolReplyWhichText("en", {
      offers: [
        { club: "FNF", kickoff: KICKOFF, tapLink: "https://m/a" },
        { club: "Sutton FC", kickoff: KICKOFF, tapLink: "https://m/b" },
      ],
      manageLink: M,
    });
    expect(text).toMatch(/^You have 2 game offers open\. Which one do you mean\? Swipe-reply to its message, or tap its link:\n1\. \*FNF\*, Friday 30 October at 20:30: https:\/\/m\/a\n2\. \*Sutton FC\*, .*: https:\/\/m\/b\n\n/);
  });
  it("stopped by words, offers off, and every answer state, EN and TR", () => {
    expect(poolReplyStoppedText("en", M)).toBe(`Done, I've stopped game offers. You can start them again here: ${M}`);
    expect(poolReplyStoppedText("tr", M)).toContain(M);
    expect(poolReplyProfileOffText("en", M)).toBe(`Your game offers are switched off, so I haven't booked anything. You can switch them back on here: ${M}`);
    for (const s of ["declined", "gone", "expired", "off", "busy", "withdrawn", "open", "invalid"] as const) {
      const en = poolReplyStateText("en", s, M);
      expect(en).toContain(M);
      expect(poolReplyStateText("tr", s, M)).not.toBe(en);
    }
    expect(poolReplyStateText("en", "declined", M)).toMatch(/^Thanks for letting us know\./);
    expect(poolReplyStateText("en", "withdrawn", M)).toMatch(/^Done, your place is free again\./);
  });
});
