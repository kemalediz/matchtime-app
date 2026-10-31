/**
 * The friend link's whole messages, assembled (copy.ts). Exact text, both
 * languages, so a reviewer sees what people will read.
 */
import { describe, expect, it } from "vitest";
import { friendBookedDm, friendGroupLine, friendGroupOutLine, friendNotBookedDm, friendOutDm, friendRemovedDm, memberLinkDm } from "../copy";

const kickoff = new Date("2026-11-02T20:00:00Z"); // 20:00 London (GMT)

describe("memberLinkDm", () => {
  it("one named friend, English", () => {
    expect(memberLinkDm("en", { club: "Sutton FC", kickoff, venue: "Goals Sutton", links: [{ friend: "Ali", url: "https://m.ai/play/f/a.b" }], capped: false })).toBe(
      "Here's the link for Ali to join *Sutton FC* on Mon 2 Nov, 20:00 at Goals Sutton. Please forward it to them.\n\n" +
        "https://m.ai/play/f/a.b\n\n" +
        "Your friend can only join this game by opening the link, filling in their details and sending the WhatsApp code it gives them. Each link works for one person, until kick-off.",
    );
  });
  it("one unnamed friend, Turkish", () => {
    expect(memberLinkDm("tr", { club: "Sutton FC", kickoff, venue: null, links: [{ friend: null, url: "https://m.ai/play/f/a.b" }], capped: false })).toBe(
      "Arkadaşın için *Sutton FC* ile 2 Kasım Pazartesi 20:00 maçının bağlantısı aşağıda. Lütfen arkadaşına ilet.\n\n" +
        "https://m.ai/play/f/a.b\n\n" +
        "Arkadaşın bu maça yalnızca bağlantıyı açıp bilgilerini doldurarak ve verdiği WhatsApp kodunu göndererek katılabilir. Her bağlantı tek kişilik ve maç başlayana kadar geçerli.",
    );
  });
  it("two friends: numbered lines", () => {
    const text = memberLinkDm("en", { club: "Sutton FC", kickoff, venue: null, links: [{ friend: "Ali", url: "u1" }, { friend: null, url: "u2" }], capped: false });
    expect(text).toContain("Each friend needs their own link.");
    expect(text).toContain("1. Ali: u1\n2. Friend: u2");
  });
  it("capped: the unused links again", () => {
    const text = memberLinkDm("en", { club: "Sutton FC", kickoff, venue: null, links: [{ friend: "Ali", url: "u1" }], capped: true });
    expect(text.startsWith("You already have links for *Sutton FC* on Mon 2 Nov, 20:00 that nobody has used yet, so here they are again:\n\n1. Ali: u1")).toBe(true);
  });
});

describe("friendBookedDm", () => {
  const base = { club: "Sutton FC", kickoff, venue: "Goals Sutton", member: "Shane", status: "in" as const, organiserPicks: false, fee: { kind: "amount", amount: "£6" } as const, monthly: false, newToPool: true, manageLink: "https://m.ai/s", pullOutLink: "https://m.ai/p" };
  it("in, weekly fee, new to the pool, the pull-out link", () => {
    expect(friendBookedDm("en", base)).toBe(
      "You're in for *Sutton FC* on Mon 2 Nov, 20:00 at Goals Sutton. Shane brought you in.\nFee: £6, asked of you after the game.\nCan't make it? Give your place back here: https://m.ai/p\n\n" +
        "You're now in the MatchTime player pool too, so you'll hear about other games near you.\n\nYour settings: https://m.ai/s",
    );
  });
  it("monthly club: pay as you go, Turkish", () => {
    expect(friendBookedDm("tr", { ...base, monthly: true, fee: { kind: "amount", amount: "£7" }, newToPool: false })).toBe(
      "*Sutton FC* ile 2 Kasım Pazartesi 20:00, Goals Sutton maçındasın. Seni Shane getirdi.\nÜcret: maç başı ödeyen oyuncu olarak £7, maçtan sonra senden istenecek.\nGelemiyor musun? Yerini buradan geri ver: https://m.ai/p\n\nAyarların: https://m.ai/s",
    );
  });
  it("bench, and bench in an organiser-pick club; no fee line when unknown or free", () => {
    expect(friendBookedDm("en", { ...base, status: "bench", fee: null })).toContain("You're on the bench for *Sutton FC*");
    expect(friendBookedDm("en", { ...base, status: "bench", fee: null })).not.toContain("Fee");
    expect(friendBookedDm("en", { ...base, status: "bench", organiserPicks: true, fee: { kind: "free" } })).toContain("The organisers pick who plays from the bench.");
  });
});

describe("friendNotBookedDm", () => {
  it("each reason, with the pool sentence for a newcomer", () => {
    expect(friendNotBookedDm("en", { reason: "used", newToPool: true, manageLink: "L" })).toBe(
      "You're in the MatchTime player pool now, so you'll hear about games near you.\nThe place on that link was already taken, so you're not booked into that game.\n\nYour settings: L",
    );
    expect(friendNotBookedDm("en", { reason: "issuer", newToPool: false, manageLink: "L" })).toBe(
      "That link is for a friend of yours. To play yourself, say IN in the club's group.\n\nYour settings: L",
    );
    expect(friendNotBookedDm("tr", { reason: "called-off", newToPool: false, manageLink: "L" })).toBe("O maç iptal edildi.\n\nAyarların: L");
  });
  it("blocked, elsewhere and failed never say why", () => {
    for (const reason of ["blocked", "elsewhere", "failed"] as const) {
      expect(friendNotBookedDm("en", { reason, newToPool: false, manageLink: "L" })).toBe("You're not booked into that game.\n\nYour settings: L");
    }
  });
});

describe("pulling out", () => {
  it("the group line and his DM", () => {
    expect(friendGroupOutLine("en", { displayName: "Ali Yilmaz", member: "Shane Smith", kickoff })).toBe("Ali Y. (Shane's friend) can no longer play on Mon 2 Nov, 20:00. The place is open again.");
    expect(friendGroupOutLine("tr", { displayName: "Ali Yilmaz", member: "Shane Smith", kickoff })).toBe("Ali Y. (Shane getirdi) artık 2 Kasım Pazartesi 20:00 maçına gelemiyor. Yer yeniden boş.");
    expect(friendOutDm("en", { club: "FNF", kickoff, manageLink: "L" })).toBe("You've given your place back for *FNF* on Mon 2 Nov, 20:00. You stay in the MatchTime player pool.\n\nYour settings: L");
  });
});

describe("friendGroupLine and friendRemovedDm", () => {
  it("in, bench, bench-pick", () => {
    expect(friendGroupLine("en", { displayName: "Ali Yilmaz", member: "Shane Smith", kickoff, status: "in", organiserPicks: false })).toBe("🙋 Ali Y. (Shane's friend) is in for Mon 2 Nov, 20:00.");
    expect(friendGroupLine("tr", { displayName: "Ali Yilmaz", member: "Shane Smith", kickoff, status: "bench", organiserPicks: false })).toBe("🙋 Ali Y. (Shane getirdi) 2 Kasım Pazartesi 20:00 maçı için yedekte.");
    expect(friendGroupLine("en", { displayName: "Ali Yilmaz", member: "Shane", kickoff, status: "bench", organiserPicks: true })).toContain("*@Match Time put Ali Y. in*");
  });
  it("removed", () => {
    expect(friendRemovedDm("en", { club: "Sutton FC", kickoff })).toBe(
      "The organisers of *Sutton FC* took you out of the game on Mon 2 Nov, 20:00. You stay in the MatchTime player pool and will keep hearing about new games near you.",
    );
  });
});
