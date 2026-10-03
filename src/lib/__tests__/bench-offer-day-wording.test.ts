/**
 * THE BENCH OFFER SAYS WHICH DAY, AND "TONIGHT" ONLY ON THE DAY.
 *
 * Sutton FC, Saturday 3 October 2026, 13:33 London. Raihan dropped out
 * of the Tuesday 6 October 7-a-side and MatchTime posted:
 *
 *   "🎟 A slot just opened for *Tuesday 7-a-side* tonight. ..."
 *
 * on a Saturday, for a Tuesday match. Every bench-offer context clause
 * (group post and its DM twin) hard-coded "tonight", in English and in
 * Turkish ("bu akşamki"), and so did the bench DM's clarification and
 * its "you're in" ack. The clause now says "tonight" only when the match
 * is TODAY in London, and the match's day otherwise.
 */
import { describe, it, expect } from "vitest";
import { buildBenchOfferContext } from "../scheduler-copy";
import { buildBenchOfferGroupPost, buildBenchOfferDm } from "../bench-offer-copy";
import { buildBenchDmAck, buildBenchDmUnclear } from "../dm-copy";

/** Tuesday 6 October 2026, 21:30 BST. */
const MATCH = new Date("2026-10-06T20:30:00.000Z");
/** Saturday 3 October 2026, 13:33 BST: the incident. */
const SATURDAY = new Date("2026-10-03T12:33:00.000Z");
/** Tuesday 6 October 2026, 13:00 BST: match day. */
const MATCH_DAY = new Date("2026-10-06T12:00:00.000Z");
/** Monday 5 October, 23:30 BST: the evening before, still not "tonight". */
const EVE_BEFORE = new Date("2026-10-05T22:30:00.000Z");
/** Tuesday 6 October, 00:30 BST: past midnight London, so it IS match day,
 *  although UTC still says Monday. */
const AFTER_MIDNIGHT = new Date("2026-10-05T23:30:00.000Z");

const DASHES = /[–—]/;
const fixture = { activityName: "Tuesday 7-a-side", team: null, matchDate: MATCH } as const;
const withTeam = {
  activityName: "Tuesday 7-a-side",
  team: { teamLabel: "Reds", replacingName: "Raihan" },
  matchDate: MATCH,
} as const;

describe("bench offer context: the day, in English", () => {
  it("THE INCIDENT: a Saturday offer for a Tuesday match names the day, never 'tonight'", () => {
    const c = buildBenchOfferContext({ ...fixture, now: SATURDAY, lang: "en" });
    expect(c.group).toBe("for *Tuesday 7-a-side* on Tue 6 Oct");
    expect(c.plain).toBe("for Tuesday 7-a-side on Tue 6 Oct");
  });

  it("with a team and the replaced player", () => {
    const c = buildBenchOfferContext({ ...withTeam, now: SATURDAY, lang: "en" });
    expect(c.group).toBe("on *Reds* (replacing Raihan) for *Tuesday 7-a-side* on Tue 6 Oct");
    expect(c.plain).toBe("on Reds (replacing Raihan) for Tuesday 7-a-side on Tue 6 Oct");
  });

  it("on match day it still says 'tonight', byte for byte as before", () => {
    expect(buildBenchOfferContext({ ...fixture, now: MATCH_DAY, lang: "en" }).group).toBe(
      "for *Tuesday 7-a-side* tonight",
    );
    expect(buildBenchOfferContext({ ...withTeam, now: MATCH_DAY, lang: "en" }).plain).toBe(
      "on Reds (replacing Raihan) for Tuesday 7-a-side tonight",
    );
  });

  it("the day is the LONDON calendar day, not the UTC one, and not a 24h window", () => {
    expect(buildBenchOfferContext({ ...fixture, now: EVE_BEFORE, lang: "en" }).group).toBe(
      "for *Tuesday 7-a-side* on Tue 6 Oct",
    );
    expect(buildBenchOfferContext({ ...fixture, now: AFTER_MIDNIGHT, lang: "en" }).group).toBe(
      "for *Tuesday 7-a-side* tonight",
    );
  });

  it("the whole group post and DM for the incident read right and carry no dashes", () => {
    const c = buildBenchOfferContext({ ...fixture, now: SATURDAY, lang: "en" });
    const post = buildBenchOfferGroupPost({ context: c.group, tagList: "@447700900001", lang: "en" });
    expect(post.startsWith("🎟 A slot just opened for *Tuesday 7-a-side* on Tue 6 Oct. *First to claim it plays.*")).toBe(true);
    const dm = buildBenchOfferDm({ firstName: "Ozgur", context: c.plain, lang: "en" });
    expect(dm.startsWith("👋 Hi Ozgur, a slot just opened for Tuesday 7-a-side on Tue 6 Oct and you're on the bench.")).toBe(true);
    for (const text of [post, dm]) {
      expect(text).not.toMatch(/tonight/i);
      expect(text).not.toMatch(DASHES);
    }
  });
});

describe("bench offer context: the day, in Turkish", () => {
  it("a Saturday offer for a Tuesday match names the day, never 'bu akşam'", () => {
    const c = buildBenchOfferContext({ ...fixture, now: SATURDAY, lang: "tr" });
    expect(c.group).toBe("6 Ekim Salı günkü *Tuesday 7-a-side* için");
    expect(c.plain).toBe("6 Ekim Salı günkü Tuesday 7-a-side için");
    const t = buildBenchOfferContext({ ...withTeam, now: SATURDAY, lang: "tr" });
    expect(t.group).toBe("6 Ekim Salı günkü *Tuesday 7-a-side* için, *Reds* takımında (Raihan yerine)");
    expect(t.plain).toBe("6 Ekim Salı günkü Tuesday 7-a-side için, Reds takımında (Raihan yerine)");
  });

  it("on match day it still says 'bu akşamki', byte for byte as before", () => {
    expect(buildBenchOfferContext({ ...fixture, now: MATCH_DAY, lang: "tr" }).group).toBe(
      "bu akşamki *Tuesday 7-a-side* için",
    );
    expect(buildBenchOfferContext({ ...withTeam, now: MATCH_DAY, lang: "tr" }).plain).toBe(
      "bu akşamki Tuesday 7-a-side için, Reds takımında (Raihan yerine)",
    );
  });

  it("the whole group post and DM carry no 'bu akşam' and no dashes", () => {
    const c = buildBenchOfferContext({ ...fixture, now: SATURDAY, lang: "tr" });
    const post = buildBenchOfferGroupPost({ context: c.group, tagList: "@447700900001", lang: "tr" });
    const dm = buildBenchOfferDm({ firstName: "Ozgur", context: c.plain, lang: "tr" });
    expect(post.startsWith("🎟 Bir yer açıldı: 6 Ekim Salı günkü *Tuesday 7-a-side* için.")).toBe(true);
    for (const text of [post, dm]) {
      expect(text).not.toMatch(/akşam/i);
      expect(text).not.toMatch(DASHES);
    }
  });
});

describe("the bench DM's clarification and ack say the day too", () => {
  it("English: 'tonight' only on match day", () => {
    expect(buildBenchDmUnclear("en", MATCH, SATURDAY)).toBe(
      "Want the open slot for Tue 6 Oct? Reply *YES* to grab it. If not, no worries, you stay on the bench either way 🙏",
    );
    expect(buildBenchDmUnclear("en", MATCH, MATCH_DAY)).toBe(
      "Want the open slot for tonight? Reply *YES* to grab it. If not, no worries, you stay on the bench either way 🙏",
    );
    expect(buildBenchDmAck("confirmed", "en", MATCH, SATURDAY)).toBe("✅ You got it, you're in for Tue 6 Oct! ⚽");
    expect(buildBenchDmAck("confirmed", "en", MATCH, MATCH_DAY)).toBe("✅ You got it, you're in for tonight! ⚽");
  });

  it("Turkish: 'bu akşam' only on match day", () => {
    expect(buildBenchDmUnclear("tr", MATCH, SATURDAY)).toBe(
      "6 Ekim Salı günkü boş yeri ister misin? Almak için *EVET* yaz. İstemiyorsan sorun değil, her durumda yedekte kalırsın 🙏",
    );
    expect(buildBenchDmUnclear("tr", MATCH, MATCH_DAY)).toBe(
      "Bu akşamki boş yeri ister misin? Almak için *EVET* yaz. İstemiyorsan sorun değil, her durumda yedekte kalırsın 🙏",
    );
    expect(buildBenchDmAck("confirmed", "tr", MATCH, SATURDAY)).toBe("✅ Yer senin, 6 Ekim Salı günü oynuyorsun! ⚽");
    expect(buildBenchDmAck("confirmed", "tr", MATCH, MATCH_DAY)).toBe("✅ Yer senin, bu akşam oynuyorsun! ⚽");
  });

  it("no ack or clarification carries an em or en dash, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const now of [SATURDAY, MATCH_DAY]) {
        expect(buildBenchDmUnclear(lang, MATCH, now)).not.toMatch(DASHES);
        for (const kind of ["declined", "confirmed", "taken", "other"] as const) {
          expect(buildBenchDmAck(kind, lang, MATCH, now)).not.toMatch(DASHES);
        }
      }
    }
  });
});
