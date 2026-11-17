/**
 * The guest card's pure rules (2026-11-17): who may add a guest, which
 * name he is listed under, whose number may be attached, and the one
 * welcome DM per guest per match.
 */
import { describe, expect, it } from "vitest";
import {
  chooseGuestName,
  cleanCardName,
  GUEST_CARD_WINDOW_MS,
  guestWelcomeKey,
  hasPhoneNumberShape,
  isOrganiserMembership,
  numberOwnerDecision,
  phoneWrittenIn,
  chooseGame,
  typedGuestPhone,
  shouldReadGuestAdd,
} from "../rules";

describe("isOrganiserMembership: an owner or admin, never a guest", () => {
  it("owner and admin of the club", () => {
    expect(isOrganiserMembership({ role: "OWNER", guestMatchId: null, leftAt: null })).toBe(true);
    expect(isOrganiserMembership({ role: "ADMIN", guestMatchId: null, leftAt: null })).toBe(true);
  });
  it("a player, a guest, someone who left", () => {
    expect(isOrganiserMembership({ role: "PLAYER", guestMatchId: null, leftAt: null })).toBe(false);
    expect(isOrganiserMembership({ role: "ADMIN", guestMatchId: "m1", leftAt: null })).toBe(false);
    expect(isOrganiserMembership({ role: "OWNER", guestMatchId: null, leftAt: new Date() })).toBe(false);
    expect(isOrganiserMembership(null)).toBe(false);
  });
});

describe("cleanCardName: the phone-book label, cleaned of obvious suffixes", () => {
  it("football labels at the end", () => {
    expect(cleanCardName("Salman Shelly Ftbl")).toBe("Salman Shelly");
    expect(cleanCardName("Abu Ayoub Football")).toBe("Abu Ayoub");
    expect(cleanCardName("Mo Footy")).toBe("Mo");
    expect(cleanCardName("Ali 5aside")).toBe("Ali");
    expect(cleanCardName("Ali 5-a-side")).toBe("Ali");
    expect(cleanCardName("Sami FC")).toBe("Sami");
    expect(cleanCardName("Sami halısaha")).toBe("Sami");
  });
  it("brackets, emoji and trailing numbers", () => {
    expect(cleanCardName("Abu Ayoub (Tuesday)")).toBe("Abu Ayoub");
    expect(cleanCardName("Abu Ayoub [work]")).toBe("Abu Ayoub");
    expect(cleanCardName("Abu Ayoub ⚽️")).toBe("Abu Ayoub");
    expect(cleanCardName("Abu 2")).toBe("Abu");
  });
  it("a real name is left alone", () => {
    expect(cleanCardName("Abu Ayoub")).toBe("Abu Ayoub");
    expect(cleanCardName("Fatih Terim")).toBe("Fatih Terim");
  });
  it("a label that is only a number, or nothing, is no name", () => {
    expect(cleanCardName("+44 7700 900123")).toBeNull();
    expect(cleanCardName("Football")).toBeNull();
    expect(cleanCardName("")).toBeNull();
    expect(cleanCardName(null)).toBeNull();
  });
});

describe("chooseGuestName", () => {
  it("his existing name on MatchTime wins: an account is never renamed", () => {
    expect(chooseGuestName({ written: "Abu", existing: "Abu Ayoub", card: "Abu Ftbl" })).toEqual({ name: "Abu Ayoub", source: "existing" });
  });
  it("then a name the organiser wrote, over the card", () => {
    expect(chooseGuestName({ written: "Abu A", existing: null, card: "Salman Shelly Ftbl" })).toEqual({ name: "Abu A", source: "written" });
  });
  it("then the card's display name, cleaned", () => {
    expect(chooseGuestName({ written: null, existing: null, card: "Salman Shelly Ftbl" })).toEqual({ name: "Salman Shelly", source: "card" });
  });
  it("no usable name anywhere: none", () => {
    expect(chooseGuestName({ written: "  ", existing: null, card: "07700 900123" })).toEqual({ name: null, source: null });
  });
});

describe("numberOwnerDecision: the add-player guard (ensureOrgPlayer)", () => {
  it("nobody has the number: a new person", () => {
    expect(numberOwnerDecision({ userExists: false, membership: null })).toBe("new");
  });
  it("this club's own member", () => {
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: null, leftAt: null } })).toBe("member");
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: null, leftAt: new Date() } })).toBe("member");
  });
  it("this club's guest before (now or in the past): a guest again", () => {
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: "m0", guestVia: "pool", leftAt: new Date() } })).toBe("guest");
  });
  it("someone else on MatchTime with no tie to this club: never attached", () => {
    expect(numberOwnerDecision({ userExists: true, membership: null })).toBe("not-ours");
  });
  it("another club's member, even one who was this club's guest: never made a guest here (review of #621)", () => {
    // A partner guest of this club has a home club: never converted.
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: "m0", guestFromOrgId: "home", guestVia: "partner", leftAt: new Date() } })).toBe("not-ours");
    // A past pool guest here who is now another club's member.
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: "m0", guestVia: "pool", leftAt: new Date() }, memberElsewhere: true })).toBe("not-ours");
    // This club's own member stays this club's member, whatever else he plays for.
    expect(numberOwnerDecision({ userExists: true, membership: { guestMatchId: null, leftAt: null }, memberElsewhere: true })).toBe("member");
  });
});

describe("typedGuestPhone: a typed number, in the club's country (review of #621)", () => {
  it("UK local and international forms", () => {
    expect(typedGuestPhone("07700 900123", "en")).toBe("+447700900123");
    expect(typedGuestPhone("+44 7700 900123", "en")).toBe("+447700900123");
    expect(typedGuestPhone("0044 7700 900123", "tr")).toBe("+447700900123");
    expect(typedGuestPhone("+90 532 123 45 67", "en")).toBe("+905321234567");
  });
  it("a Turkish club's local mobile is +90", () => {
    expect(typedGuestPhone("0532 123 45 67", "tr")).toBe("+905321234567");
    expect(typedGuestPhone("532 123 45 67", "tr")).toBe("+905321234567");
  });
  it("a number with no country to read is none (the organiser is asked for the code)", () => {
    expect(typedGuestPhone("0532 123 45 67", "en")).toBeNull();
    expect(typedGuestPhone("555 1234", "en")).toBeNull();
  });
});

describe("hasPhoneNumberShape: a number is present to be read (the container, not the words)", () => {
  it("UK and international numbers in any spacing", () => {
    expect(hasPhoneNumberShape("Abu Ayoub 07700 900123 is playing tonight")).toBe(true);
    expect(hasPhoneNumberShape("+44 7700 900123")).toBe(true);
    expect(hasPhoneNumberShape("(0)7700-900-123")).toBe(true);
  });
  it("scores, times, prices and dates are not numbers", () => {
    expect(hasPhoneNumberShape("we won 5-3 at 20:00, £6 each")).toBe(false);
    expect(hasPhoneNumberShape("Tue 17 Nov 2026")).toBe(false);
  });
});

describe("phoneWrittenIn: a verifier on the model's answer", () => {
  it("the digits the model gave are written in the message", () => {
    expect(phoneWrittenIn("07700 900123", "add Abu 07700900123 for tonight")).toBe(true);
    expect(phoneWrittenIn("+447700900123", "add Abu 07700 900123")).toBe(true);
  });
  it("a number the model made up is not", () => {
    expect(phoneWrittenIn("07700 900999", "add Abu 07700900123")).toBe(false);
    expect(phoneWrittenIn("", "add Abu")).toBe(false);
  });
});

describe("shouldReadGuestAdd: when the reader is asked at all (facts only)", () => {
  const base = { organiser: true, cardsHeld: 0, quotedCard: false, numberInText: false, tagged: false, door: "players" as const };
  it("an organiser with a card just shared", () => {
    expect(shouldReadGuestAdd({ ...base, cardsHeld: 1 })).toBe(true);
  });
  it("an organiser replying to a card", () => {
    expect(shouldReadGuestAdd({ ...base, quotedCard: true })).toBe(true);
  });
  it("an organiser's message with a phone number in it", () => {
    expect(shouldReadGuestAdd({ ...base, numberInText: true })).toBe(true);
  });
  it("in HQ only a tagged message is read", () => {
    expect(shouldReadGuestAdd({ ...base, door: "hq", cardsHeld: 1 })).toBe(false);
    expect(shouldReadGuestAdd({ ...base, door: "hq", cardsHeld: 1, tagged: true })).toBe(true);
  });
  it("never for anyone but an organiser, and never with nothing to add", () => {
    expect(shouldReadGuestAdd({ ...base, organiser: false, cardsHeld: 1 })).toBe(false);
    expect(shouldReadGuestAdd(base)).toBe(false);
  });
});

describe("chooseGame (review of #621: a game not on the list is asked, never guessed)", () => {
  const one = [
    { matchId: "a", orgId: "o1" },
    { matchId: "b", orgId: "o1" },
  ];
  it("the game the model named", () => expect(chooseGame(one, { n: 2, notListed: false })).toEqual({ kind: "game", game: one[1] }));
  it("none named, one club: the soonest", () => expect(chooseGame(one, { n: 0, notListed: false })).toEqual({ kind: "game", game: one[0] }));
  it("a day that is not on the list: ask which game", () => {
    expect(chooseGame(one, { n: 0, notListed: true })).toEqual({ kind: "ask-game" });
    expect(chooseGame(one, { n: 9, notListed: false })).toEqual({ kind: "ask-game" });
  });
  it("none named, several clubs (a DM): ask which club", () => {
    const two = [one[0], { matchId: "c", orgId: "o2" }];
    expect(chooseGame(two, { n: 0, notListed: false })).toEqual({ kind: "ask-club" });
    expect(chooseGame(two, { n: 2, notListed: false })).toEqual({ kind: "game", game: two[1] });
  });
  it("no games: none", () => expect(chooseGame([], { n: 1, notListed: false })).toEqual({ kind: "none" }));
});

describe("the one welcome DM per guest per match", () => {
  it("is keyed on the match and the person", () => {
    expect(guestWelcomeKey("m1", "u1")).toBe("guest-card-welcome:m1:u1");
    expect(guestWelcomeKey("m1", "u1")).not.toBe(guestWelcomeKey("m2", "u1"));
  });
  it("cards pair with a request for half an hour", () => {
    expect(GUEST_CARD_WINDOW_MS).toBe(30 * 60_000);
  });
});
