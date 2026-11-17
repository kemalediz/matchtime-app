/**
 * The guest card's whole messages (2026-11-17), exact, in both languages,
 * so a reviewer sees what the guest and the organiser read. Made-up club,
 * people and venue.
 */
import { describe, expect, it } from "vitest";
import { guestOutDm, guestOutNotice, guestRemovedDm, guestWelcomeDm, organiserReply } from "../copy";

const kickoff = new Date("2026-11-17T20:00:00Z"); // Tue 17 Nov, 20:00 London (GMT)
const sameDay = new Date("2026-11-17T14:05:00Z");
const dayBefore = new Date("2026-11-16T14:05:00Z");

const game = {
  club: "Riverside FC",
  kickoff,
  format: "Football 7-a-side",
  venue: "Powerleague Shoreditch",
  address: "12 Whiston Road, London E2 8BN",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=Powerleague&query_place_id=abc",
  fee: { kind: "amount" as const, amount: "£6" },
  monthly: false,
};

describe("guestWelcomeDm", () => {
  it("English, in the squad: everything in one message, no group link", () => {
    expect(guestWelcomeDm("en", { ...game, guestName: "Abu Ayoub", organiser: "Kemal Organiser", status: "in", organiserPicks: false })).toBe(
      "Hi Abu 👋 Kemal has added you to *Riverside FC*'s game.\n\n" +
        "📅 Tuesday 17 November at 20:00\n" +
        "⚽ Football 7-a-side\n" +
        "📍 Powerleague Shoreditch\n" +
        "12 Whiston Road, London E2 8BN\n" +
        "🗺️ https://www.google.com/maps/search/?api=1&query=Powerleague&query_place_id=abc\n" +
        "💷 £6 a player\n\n" +
        "You're in the squad.\n" +
        "Reply OUT if you can't make it.\n" +
        "Any question about the game? Just message me here.",
    );
  });
  it("Turkish, in the squad", () => {
    expect(guestWelcomeDm("tr", { ...game, guestName: "Abu Ayoub", organiser: "Kemal Organiser", status: "in", organiserPicks: false })).toBe(
      "Merhaba Abu 👋 Kemal seni *Riverside FC* maçına ekledi.\n\n" +
        "📅 17 Kasım Salı 20:00\n" +
        "⚽ Football 7-a-side\n" +
        "📍 Powerleague Shoreditch\n" +
        "12 Whiston Road, London E2 8BN\n" +
        "🗺️ https://www.google.com/maps/search/?api=1&query=Powerleague&query_place_id=abc\n" +
        "💷 Kişi başı £6\n\n" +
        "Kadrodasın.\n" +
        "Gelemeyeceksen OUT yaz.\n" +
        "Maçla ilgili sormak istediğin bir şey olursa bana buradan yazman yeterli.",
    );
  });
  it("on the bench: says so, first-come and organiser-pick", () => {
    const bench = guestWelcomeDm("en", { ...game, guestName: "Abu Ayoub", organiser: "Kemal", status: "bench", organiserPicks: false });
    expect(bench).toContain("The squad is full, so you're on the bench for now. If a place opens I'll tell you.");
    const pick = guestWelcomeDm("en", { ...game, guestName: "Abu Ayoub", organiser: "Kemal", status: "bench", organiserPicks: true });
    expect(pick).toContain("You're on the bench for now. The organisers pick who plays from the bench.");
    expect(guestWelcomeDm("tr", { ...game, guestName: null, organiser: null, status: "bench", organiserPicks: false })).toContain(
      "Kadro dolu, şimdilik yedektesin. Bir yer açılırsa sana haber veririm.",
    );
  });
  it("what the club has not set is left out, never guessed", () => {
    const text = guestWelcomeDm("en", { ...game, guestName: null, organiser: null, format: null, venue: null, address: null, mapUrl: null, fee: null, status: "in", organiserPicks: false });
    expect(text).toBe(
      "Hi 👋 You've been added to *Riverside FC*'s game.\n\n" +
        "📅 Tuesday 17 November at 20:00\n\n" +
        "You're in the squad.\n" +
        "Reply OUT if you can't make it.\n" +
        "Any question about the game? Just message me here.",
    );
  });
  it("a monthly club's guest pays as he goes; a free game says nothing about money", () => {
    expect(guestWelcomeDm("en", { ...game, monthly: true, guestName: "Abu", organiser: "Kemal", status: "in", organiserPicks: false })).toContain("💷 £6, pay as you go");
    expect(guestWelcomeDm("en", { ...game, fee: { kind: "free" }, guestName: "Abu", organiser: "Kemal", status: "in", organiserPicks: false })).not.toContain("💷");
  });
  it("never carries a phone number or an invite link", () => {
    const text = guestWelcomeDm("en", { ...game, guestName: "Abu Ayoub", organiser: "Kemal", status: "in", organiserPicks: false });
    expect(text).not.toMatch(/chat\.whatsapp\.com/);
    expect(text).not.toMatch(/07700|447700/);
  });
});

describe("organiserReply", () => {
  it("English: in for tonight, details sent", () => {
    expect(organiserReply("en", { kind: "in", name: "Abu Ayoub", kickoff, now: sameDay, dm: "sent" })).toBe("✅ Abu Ayoub is in for tonight, I've sent him the details.");
  });
  it("English: another day, on the bench", () => {
    expect(organiserReply("en", { kind: "bench", name: "Abu Ayoub", kickoff, now: dayBefore, dm: "sent" })).toBe(
      "✅ Abu Ayoub is on the bench for Tue 17 Nov, the squad is full. I've sent him the details.",
    );
  });
  it("Turkish: in, and on the bench", () => {
    expect(organiserReply("tr", { kind: "in", name: "Abu Ayoub", kickoff, now: sameDay, dm: "sent" })).toBe("✅ Abu Ayoub bu akşamki maça eklendi, detayları ona gönderdim.");
    expect(organiserReply("tr", { kind: "bench", name: "Abu Ayoub", kickoff, now: dayBefore, dm: "sent" })).toBe(
      "✅ Abu Ayoub 17 Kasım Salı maçı için yedekte, kadro dolu. Detayları ona gönderdim.",
    );
  });
  it("already on the list: said, and the details only once", () => {
    expect(organiserReply("en", { kind: "already-in", name: "Abu Ayoub", kickoff, now: sameDay, dm: "had" })).toBe("Abu Ayoub is already in for tonight. He already has the details.");
    expect(organiserReply("en", { kind: "already-bench", name: "Abu Ayoub", kickoff, now: sameDay, dm: "sent" })).toBe(
      "Abu Ayoub is already on the bench for tonight. I've sent him the details.",
    );
  });
  it("refusals, each one plain line and no number", () => {
    expect(organiserReply("en", { kind: "not-ours" })).toBe("That number is already on MatchTime, so it can't be added here.");
    expect(organiserReply("en", { kind: "no-number" })).toBe("I couldn't find a phone number on that contact, so I haven't added anyone.");
    expect(organiserReply("en", { kind: "no-name" })).toBe("What's his name? Tell me and I'll add him, for example *add Sam Jones for tonight*.");
    expect(organiserReply("en", { kind: "no-game" })).toBe("There's no game coming up to add him to.");
    expect(organiserReply("en", { kind: "elsewhere", name: "Abu Ayoub" })).toBe("Abu Ayoub is already down as a guest for another game, so I haven't added him to this one.");
    expect(organiserReply("en", { kind: "failed", name: "Abu Ayoub" })).toBe("I couldn't add Abu Ayoub just now. Please add him on the match page.");
    expect(organiserReply("tr", { kind: "not-ours" })).toBe("Bu numara zaten MatchTime'da kayıtlı, bu yüzden buraya eklenemez.");
    expect(organiserReply("tr", { kind: "no-number" })).toBe("Bu kişide bir telefon numarası bulamadım, bu yüzden kimseyi eklemedim.");
    expect(organiserReply("tr", { kind: "no-name" })).toBe("Adı ne? Yazarsan eklerim, örneğin *Sam Jones'u bu akşama ekle*.");
    expect(organiserReply("tr", { kind: "no-game" })).toBe("Ekleyebileceğim yaklaşan bir maç yok.");
    expect(organiserReply("tr", { kind: "elsewhere", name: "Abu Ayoub" })).toBe("Abu Ayoub zaten başka bir maça misafir olarak yazılı, bu yüzden bu maça eklemedim.");
    expect(organiserReply("tr", { kind: "failed", name: "Abu Ayoub" })).toBe("Abu Ayoub şu an eklenemedi. Lütfen maç sayfasından ekle.");
  });
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: no dashes as punctuation, "bench" words only`, () => {
      const all = [
        organiserReply(lang, { kind: "in", name: "A", kickoff, now: sameDay, dm: "sent" }),
        organiserReply(lang, { kind: "bench", name: "A", kickoff, now: sameDay, dm: "none" }),
        guestWelcomeDm(lang, { ...game, guestName: "A", organiser: "K", status: "bench", organiserPicks: false }),
        guestOutDm(lang, { club: "Riverside FC", kickoff }),
      ].join("\n");
      expect(all).not.toMatch(/[—–]/);
      expect(all.toLowerCase()).not.toContain("waiting list");
    });
  }
});

describe("his OUT by DM", () => {
  it("his DM, both languages", () => {
    expect(guestOutDm("en", { club: "Riverside FC", kickoff })).toBe("No problem, I've taken you off *Riverside FC*'s game on Tue 17 Nov, 20:00.");
    expect(guestOutDm("tr", { club: "Riverside FC", kickoff })).toBe("Tamam, seni *Riverside FC* ile 17 Kasım Salı 20:00 maçından çıkardım.");
  });
  it("the club is told, by name and never by number", () => {
    expect(guestOutNotice("en", { name: "Abu Ayoub", organiser: "Kemal Organiser", kickoff })).toBe("Abu Ayoub (Kemal's guest) can't make it on Tue 17 Nov, 20:00 any more. The place is free again.");
    expect(guestOutNotice("tr", { name: "Abu Ayoub", organiser: "Kemal Organiser", kickoff })).toBe("Abu Ayoub (Kemal getirdi) artık 17 Kasım Salı 20:00 maçına gelemiyor. Yer yeniden boş.");
  });
});

describe("asked, never guessed (review of #621)", () => {
  const games = [
    { club: "Riverside FC", kickoff },
    { club: "Riverside FC", kickoff: new Date("2026-11-20T20:00:00Z") },
  ];
  it("a day that is not on the list: which game, the games listed", () => {
    expect(organiserReply("en", { kind: "ask-game", games })).toBe("Which game is he for? The coming games are Tue 17 Nov, 20:00 and Fri 20 Nov, 20:00. Tell me the day, for example *add him for Fri 20 Nov*.");
    expect(organiserReply("tr", { kind: "ask-game", games })).toBe("Hangi maça ekleyeyim? Sıradaki maçlar: 17 Kasım Salı 20:00 ve 20 Kasım Cuma 20:00. Günü yazman yeterli, örneğin *20 Kasım Cuma maçına ekle*.");
  });
  it("several clubs by DM: which club", () => {
    expect(organiserReply("en", { kind: "ask-club", clubs: ["Riverside FC", "Hillside FC"] })).toBe("Which club is he playing for, Riverside FC or Hillside FC? Tell me with the club's name, for example *add him for Riverside FC*.");
    expect(organiserReply("tr", { kind: "ask-club", clubs: ["Riverside FC", "Hillside FC"] })).toBe("Hangi kulüpte oynayacak: Riverside FC mi, Hillside FC mi? Kulübün adını yazman yeterli.");
  });
  it("a number with no country to read: send it with the code", () => {
    expect(organiserReply("en", { kind: "no-country-code" })).toBe("I couldn't read that number. Please send it with the country code, starting with +.");
    expect(organiserReply("tr", { kind: "no-country-code" })).toBe("O numarayı okuyamadım. Lütfen ülke koduyla, + ile başlayarak gönder.");
  });
});

describe("an organiser takes his guest off the game (review of #621: the organisers' words, not the pool's)", () => {
  it("both languages, and no pool", () => {
    expect(guestRemovedDm("en", { club: "Riverside FC", kickoff })).toBe("The organisers of *Riverside FC* took you out of the game on Tue 17 Nov, 20:00.");
    expect(guestRemovedDm("tr", { club: "Riverside FC", kickoff })).toBe("*Riverside FC* organizatörleri seni 17 Kasım Salı 20:00 maçından çıkardı.");
  });
});
