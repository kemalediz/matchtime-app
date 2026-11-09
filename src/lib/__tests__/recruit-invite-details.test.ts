/**
 * THE INVITE DM SAYS WHO IS ASKING, WHERE AND FOR HOW MUCH (Kemal, Vets
 * MNF, 2026-11-09).
 *
 * "@Match Time DM these people" DMs people who may never have heard from
 * MatchTime. The old invite ("👋 there, we're putting the squad together
 * for *Football 7-a-side* ...") did not say which club or group it came
 * from, where the game is or what it costs. Kemal's decisions:
 *
 *   1. name the players' WhatsApp group the game belongs to (its subject,
 *      "Vets MNF"), left out cleanly when unknown;
 *   2. the club's name, the venue and the fee (left out when there is none);
 *   3. greet by the player's own WhatsApp name (the tag's), first word,
 *      even when the club stored another name; else the club's stored
 *      name; else "👋 Hi," and never "👋 there";
 *   4. keep IN, OUT and the app link, and add a stop line that names a
 *      reply MatchTime really handles: "STOP" in a DM is read as
 *      `stop_messages` by the one DM reader (`dm-intent.ts`, it is one of
 *      its own examples) and turns off every DM but payments
 *      (`dm-subscriptions.ts`, `inbound-dm.ts`).
 *
 * The recruit blast uses the same builders, so it says the same.
 */
import { describe, it, expect } from "vitest";
import { buildRecruitGroupInviteDm, buildRecruitInviteDm, inviteGreetingName } from "@/lib/recruit";

const GAME = {
  matchName: "Football 7-a-side",
  matchWhen: "Mon 9 Nov, 20:30",
  spotsLeft: 3,
  link: "https://matchtime.ai/r/abc",
};
const DETAILS = {
  club: "Monday night vets",
  groupSubject: "Vets MNF",
  venue: "Oaks Park High School football field",
  fee: "£8",
};

describe("the app invite: club, group, venue, fee and a stop line", () => {
  it("English, everything known", () => {
    expect(buildRecruitInviteDm({ ...GAME, ...DETAILS, firstName: "Matt" })).toBe(
      [
        "👋 Matt, it's *Monday night vets* here, from the Vets MNF group.",
        "",
        "We're putting the squad together for *Football 7-a-side* on Mon 9 Nov, 20:30. 3 spots left.",
        "📍 Oaks Park High School football field",
        "💷 £8 a game",
        "",
        "Playing? Just reply *IN*.",
        "Can't make it? Reply *OUT* and I'll stop asking 🙌",
        "",
        "Prefer the app? https://matchtime.ai/r/abc",
        "",
        "Don't want messages like this? Reply *STOP*.",
      ].join("\n"),
    );
  });

  it("Turkish, everything known", () => {
    expect(buildRecruitInviteDm({ ...GAME, ...DETAILS, firstName: "Matt", lang: "tr" })).toBe(
      [
        "👋 Matt, *Monday night vets* adına yazıyorum (WhatsApp grubu: Vets MNF).",
        "",
        "*Football 7-a-side* (Mon 9 Nov, 20:30) için kadroyu kuruyoruz. 3 yer kaldı.",
        "📍 Oaks Park High School football field",
        "💷 Maç başı £8",
        "",
        "Oynuyor musun? *VARIM* yazman yeterli.",
        "Gelemiyor musun? *YOKUM* yaz, bir daha sormam 🙌",
        "",
        "Uygulamadan yapmak istersen: https://matchtime.ai/r/abc",
        "",
        "Bu tür mesajlar istemiyorsan *STOP* yaz.",
      ].join("\n"),
    );
  });

  it("English, nothing known: no name, no group, no club, no venue, no fee", () => {
    expect(buildRecruitInviteDm({ ...GAME, firstName: null })).toBe(
      [
        "👋 Hi, we're putting the squad together for *Football 7-a-side* on Mon 9 Nov, 20:30. 3 spots left.",
        "",
        "Playing? Just reply *IN*.",
        "Can't make it? Reply *OUT* and I'll stop asking 🙌",
        "",
        "Prefer the app? https://matchtime.ai/r/abc",
        "",
        "Don't want messages like this? Reply *STOP*.",
      ].join("\n"),
    );
  });

  it("Turkish, nothing known", () => {
    expect(buildRecruitInviteDm({ ...GAME, firstName: null, lang: "tr" })).toBe(
      [
        "👋 Merhaba, *Football 7-a-side* (Mon 9 Nov, 20:30) için kadroyu kuruyoruz. 3 yer kaldı.",
        "",
        "Oynuyor musun? *VARIM* yazman yeterli.",
        "Gelemiyor musun? *YOKUM* yaz, bir daha sormam 🙌",
        "",
        "Uygulamadan yapmak istersen: https://matchtime.ai/r/abc",
        "",
        "Bu tür mesajlar istemiyorsan *STOP* yaz.",
      ].join("\n"),
    );
  });

  it("no group subject: the club alone, and no empty phrase", () => {
    const en = buildRecruitInviteDm({ ...GAME, ...DETAILS, groupSubject: null, firstName: "BH" });
    expect(en.split("\n")[0]).toBe("👋 BH, it's *Monday night vets* here.");
    expect(en).not.toMatch(/group/);
    const tr = buildRecruitInviteDm({ ...GAME, ...DETAILS, groupSubject: "  ", firstName: "BH", lang: "tr" });
    expect(tr.split("\n")[0]).toBe("👋 BH, *Monday night vets* adına yazıyorum.");
  });

  it("a group subject but no club name", () => {
    expect(buildRecruitInviteDm({ ...GAME, ...DETAILS, club: null, firstName: "BH" }).split("\n")[0]).toBe(
      "👋 BH, it's MatchTime here, from the Vets MNF group.",
    );
    expect(buildRecruitInviteDm({ ...GAME, ...DETAILS, club: null, firstName: "BH", lang: "tr" }).split("\n")[0]).toBe(
      "👋 BH, MatchTime'dan yazıyorum (WhatsApp grubu: Vets MNF).",
    );
  });

  it("a subject that already ends in 'group' is not doubled", () => {
    const text = buildRecruitInviteDm({ ...GAME, ...DETAILS, groupSubject: "Sunday Football Group", firstName: "BH" });
    expect(text.split("\n")[0]).toBe("👋 BH, it's *Monday night vets* here, from the Sunday Football Group.");
  });

  it("no name but details: 'Hi', never 'there'", () => {
    const text = buildRecruitInviteDm({ ...GAME, ...DETAILS, firstName: null });
    expect(text.split("\n")[0]).toBe("👋 Hi, it's *Monday night vets* here, from the Vets MNF group.");
    expect(text).not.toMatch(/\bthere\b/);
  });

  it("venue without a fee, and a fee without a venue", () => {
    const noFee = buildRecruitInviteDm({ ...GAME, ...DETAILS, fee: null, firstName: "BH" });
    expect(noFee).toContain("📍 Oaks Park High School football field\n\nPlaying?");
    expect(noFee).not.toContain("💷");
    const noVenue = buildRecruitInviteDm({ ...GAME, ...DETAILS, venue: "", firstName: "BH" });
    expect(noVenue).toContain("3 spots left.\n💷 £8 a game\n\nPlaying?");
    expect(noVenue).not.toContain("📍");
  });

  it("an organiser-pick club: the bench line replaces the playing line, the rest stays", () => {
    const text = buildRecruitInviteDm({ ...GAME, ...DETAILS, firstName: "Ali", organiser: true });
    expect(text).toContain("💷 £8 a game\n\nWant to play? Reply *IN* to go on the bench, and the organisers will pick who plays.\nCan't make it?");
    expect(text).not.toContain("Playing? Just reply *IN*.");
    expect(text.endsWith("Don't want messages like this? Reply *STOP*.")).toBe(true);
  });

  it("no em or en dashes, in either language", () => {
    for (const lang of ["en", "tr"]) {
      const text = buildRecruitInviteDm({ ...GAME, ...DETAILS, firstName: "Matt", lang });
      expect(text).not.toMatch(/[—–]/);
    }
  });
});

describe("the group invite (no app squad, or not a member): the same details", () => {
  it("English, everything known", () => {
    expect(buildRecruitGroupInviteDm({ ...GAME, ...DETAILS, firstName: "Matt" })).toBe(
      [
        "👋 Matt, it's *Monday night vets* here, from the Vets MNF group.",
        "",
        "We're putting the squad together for *Football 7-a-side* on Mon 9 Nov, 20:30.",
        "📍 Oaks Park High School football field",
        "💷 £8 a game",
        "",
        "Fancy it? Just reply *IN* in the group and you're sorted 🙌",
        "",
        "Don't want messages like this? Reply *STOP*.",
      ].join("\n"),
    );
  });

  it("Turkish, everything known", () => {
    expect(buildRecruitGroupInviteDm({ ...GAME, ...DETAILS, firstName: "Matt", lang: "tr" })).toBe(
      [
        "👋 Matt, *Monday night vets* adına yazıyorum (WhatsApp grubu: Vets MNF).",
        "",
        "*Football 7-a-side* (Mon 9 Nov, 20:30) için kadroyu kuruyoruz.",
        "📍 Oaks Park High School football field",
        "💷 Maç başı £8",
        "",
        "Var mısın? Grupta *VARIM* yazman yeterli 🙌",
        "",
        "Bu tür mesajlar istemiyorsan *STOP* yaz.",
      ].join("\n"),
    );
  });

  it("English and Turkish, nothing known", () => {
    expect(buildRecruitGroupInviteDm({ ...GAME, firstName: null })).toBe(
      [
        "👋 Hi, we're putting the squad together for *Football 7-a-side* on Mon 9 Nov, 20:30.",
        "",
        "Fancy it? Just reply *IN* in the group and you're sorted 🙌",
        "",
        "Don't want messages like this? Reply *STOP*.",
      ].join("\n"),
    );
    expect(buildRecruitGroupInviteDm({ ...GAME, firstName: null, lang: "tr" })).toBe(
      [
        "👋 Merhaba, *Football 7-a-side* (Mon 9 Nov, 20:30) için kadroyu kuruyoruz.",
        "",
        "Var mısın? Grupta *VARIM* yazman yeterli 🙌",
        "",
        "Bu tür mesajlar istemiyorsan *STOP* yaz.",
      ].join("\n"),
    );
  });
});

describe("inviteGreetingName: the WhatsApp name first, then the club's", () => {
  it("the first word of the WhatsApp name, even when the club stored another name", () => {
    expect(inviteGreetingName("Matt Afc Walcountians Vets", "UTV")).toBe("Matt");
  });
  it("a one-word WhatsApp name", () => {
    expect(inviteGreetingName("BH", null)).toBe("BH");
  });
  it("the club's stored name when the tag carried no name", () => {
    expect(inviteGreetingName(null, "Shane Smith")).toBe("Shane");
    expect(inviteGreetingName("   ", "UTV")).toBe("UTV");
  });
  it("a WhatsApp name with no letters (a phone, emoji) falls back", () => {
    expect(inviteGreetingName("+44 7747 410069", "Dave Jones")).toBe("Dave");
    expect(inviteGreetingName("🔥🔥", null)).toBeNull();
  });
  it("WhatsApp's '~' marker is not part of the name", () => {
    expect(inviteGreetingName("~BH", null)).toBe("BH");
  });
  it("nothing at all", () => {
    expect(inviteGreetingName(undefined, null)).toBeNull();
    expect(inviteGreetingName(null, "")).toBeNull();
  });
});
