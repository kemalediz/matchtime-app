/**
 * Squad changes typed in a club's ADMIN group (2026-10-14): the pure half.
 * Name matching for a pasted list, the diff of a pasted list against the
 * current squad, and every sentence MatchTime says back, in English and
 * Turkish. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_GROUP_SQUAD_ROUTES,
  PASTE_PROPOSAL_TTL_MS,
  hqChangeFacts,
  buildAdminSquadReply,
  vetAdminGroupFacts,
  type AdminClaimRef,
  type VettedClaim,
  buildPasteExpiredReply,
  buildPasteProposalReply,
  buildSquadChangeReply,
  diffPastedSquad,
  matchPastedName,
  type PasteMember,
} from "../admin-group-squad-rules";
import type { AttendanceFacts, Claim } from "../pipeline/types";

const members: PasteMember[] = [
  { userId: "u-shehryar", name: "Shehryar Khan", aliases: [] },
  { userId: "u-bilal", name: "Bilal Ahmed", aliases: [] },
  { userId: "u-ali1", name: "Ali Raza", aliases: [] },
  { userId: "u-ali2", name: "Ali Hassan", aliases: ["ali h"] },
  { userId: "u-clarence", name: "Clarence Obi", aliases: [] },
  { userId: "u-abdul", name: "Abdul-Hafeez Malik", aliases: ["hafeez"] },
  { userId: "u-ilker", name: "İlker Yılmaz", aliases: [] },
];

describe("matchPastedName", () => {
  it("matches a full name exactly, case and accents folded", () => {
    expect(matchPastedName("shehryar khan", members)).toEqual({ kind: "member", userId: "u-shehryar" });
    expect(matchPastedName("ILKER YILMAZ", members)).toEqual({ kind: "member", userId: "u-ilker" });
  });
  it("matches a unique first name, the way lists are usually written", () => {
    expect(matchPastedName("Bilal", members)).toEqual({ kind: "member", userId: "u-bilal" });
    expect(matchPastedName("Clarence", members)).toEqual({ kind: "member", userId: "u-clarence" });
  });
  it("an alias settles it", () => {
    expect(matchPastedName("Hafeez", members)).toEqual({ kind: "member", userId: "u-abdul" });
    expect(matchPastedName("Ali H", members)).toEqual({ kind: "member", userId: "u-ali2" });
  });
  it("two players with the same first name: ambiguous, unless only one is on this match", () => {
    expect(matchPastedName("Ali", members)).toEqual({ kind: "ambiguous" });
    expect(matchPastedName("Ali", members, new Set(["u-ali1"]))).toEqual({ kind: "member", userId: "u-ali1" });
  });
  it("nobody by that name: new", () => {
    expect(matchPastedName("Naim", members)).toEqual({ kind: "new" });
  });
});

// readSquadPaste is gone (2026-10-29): a pasted HQ list is read by the HQ
// squad reader, a model (hq-squad-reader.test.ts); its fact gates are in
// hq-squad-paste-gates.test.ts.

describe("diffPastedSquad", () => {
  const current = [
    { userId: "u-shehryar", status: "CONFIRMED" as const },
    { userId: "u-clarence", status: "CONFIRMED" as const },
    { userId: "u-ali1", status: "CONFIRMED" as const },
    { userId: "u-abdul", status: "BENCH" as const },
    { userId: "u-ilker", status: "DROPPED" as const },
  ];
  it("adds, removes and benches against the current squad", () => {
    const d = diffPastedSquad({
      playing: [{ userId: "u-ali1" }, { userId: "u-bilal" }, { userId: "u-ilker" }, { newName: "Naim" }],
      reserves: [{ userId: "u-clarence" }],
      current,
    });
    expect(d.add).toEqual([{ userId: "u-bilal" }, { userId: "u-ilker" }, { newName: "Naim" }]);
    expect(d.remove).toEqual([{ userId: "u-shehryar" }]);
    expect(d.toBench).toEqual([{ userId: "u-clarence" }]);
    expect(d.same).toBe(false);
  });
  it("someone on the waiting list but not in the paste is left alone", () => {
    const d = diffPastedSquad({
      playing: [{ userId: "u-shehryar" }, { userId: "u-clarence" }, { userId: "u-ali1" }],
      reserves: [],
      current,
    });
    expect(d).toEqual({ add: [], remove: [], toBench: [], same: true });
  });
  it("a reserve already on the waiting list is no change", () => {
    const d = diffPastedSquad({
      playing: [{ userId: "u-shehryar" }, { userId: "u-clarence" }, { userId: "u-ali1" }],
      reserves: [{ userId: "u-abdul" }],
      current,
    });
    expect(d.same).toBe(true);
  });
  it("a name written twice is counted once", () => {
    const d = diffPastedSquad({ playing: [{ userId: "u-bilal" }, { userId: "u-bilal" }, { newName: "Naim" }, { newName: "naim" }], reserves: [], current: [] });
    expect(d.add).toEqual([{ userId: "u-bilal" }, { newName: "Naim" }]);
  });
});


describe("the routes the admin group acts on", () => {
  it("attendance about players, and unsure (handed over only when addressed to MatchTime)", () => {
    expect([...ADMIN_GROUP_SQUAD_ROUTES].sort()).toEqual(["other_att", "self_att", "unsure"]);
  });
  it("a pasted list waits 30 minutes for YES, like the pick question", () => {
    expect(PASTE_PROPOSAL_TTL_MS).toBe(30 * 60 * 1000);
  });
});

describe("copy, English and Turkish", () => {
  it("a single change", () => {
    const changes = [
      { kind: "out" as const, name: "Shehryar" },
      { kind: "in" as const, name: "Bilal" },
    ];
    expect(buildSquadChangeReply({ lang: "en", changes, failed: [], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Done: Shehryar out, Bilal in. 18 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes, failed: [], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Tamam: Shehryar çıktı, Bilal kadroya girdi. 18/18.",
    );
  });
  it("the waiting list and a maybe", () => {
    const changes = [
      { kind: "bench" as const, name: "Tom" },
      { kind: "maybe" as const, name: "Sait" },
    ];
    expect(buildSquadChangeReply({ lang: "en", changes, failed: [], confirmed: 17, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Done: Tom on the bench, Sait a maybe. 17 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes, failed: [], confirmed: 17, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Tamam: Tom yedek listesinde, Sait belki. 17/18.",
    );
  });
  it("a change that did not land is said plainly", () => {
    expect(
      buildSquadChangeReply({ lang: "en", changes: [], failed: ["Shehryar"], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null }),
    ).toBe("I couldn't change Shehryar. Please check the match page. 18 of 18.");
    expect(
      buildSquadChangeReply({ lang: "tr", changes: [], failed: ["Shehryar"], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null }),
    ).toBe("Shehryar için değişiklik yapamadım. Lütfen maç sayfasını kontrol edin. 18/18.");
  });
  it("nothing to change", () => {
    expect(buildSquadChangeReply({ lang: "en", changes: [], failed: [], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Nothing to change: the squad already says that. 18 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes: [], failed: [], confirmed: 18, maxPlayers: 18, bench: [], benchPickMode: null })).toBe(
      "Değişecek bir şey yok: kadro zaten öyle. 18/18.",
    );
  });
  it("a pasted list: the exact changes, then YES", () => {
    const p = {
      add: ["Bilal"],
      remove: ["Shehryar", "Clarence"],
      toBench: [] as string[],
      newNames: ["Naim"],
      unclear: [] as string[],
      listed: 18,
      maxPlayers: 18,
    };
    expect(buildPasteProposalReply({ lang: "en", ...p })).toBe(
      "Adding: Bilal. Removing: Shehryar, Clarence. Unknown names: Naim (not a member yet, I'll add them as a new player). Say *@Match Time YES* to apply.",
    );
    expect(buildPasteProposalReply({ lang: "tr", ...p })).toBe(
      "Eklenecek: Bilal. Çıkarılacak: Shehryar, Clarence. Tanımadığım isimler: Naim (henüz üye değil, yeni oyuncu olarak ekleyeceğim). Uygulamak için *@Match Time EVET* yazın.",
    );
  });
  it("several unknown names, a reserve, an unclear name and too many names", () => {
    const p = {
      add: [] as string[],
      remove: [] as string[],
      toBench: ["Clarence"],
      newNames: ["Naim", "Tariq"],
      unclear: ["Ali"],
      listed: 19,
      maxPlayers: 18,
    };
    expect(buildPasteProposalReply({ lang: "en", ...p })).toBe(
      "To the bench: Clarence. Unknown names: Naim, Tariq (not members yet, I'll add them as new players). " +
        "Not sure who Ali is, so I'll leave them out; use the full name. " +
        "The list has 19 names for 18 places, so the last ones go on the bench. Say *@Match Time YES* to apply.",
    );
    expect(buildPasteProposalReply({ lang: "tr", ...p })).toBe(
      "Yedek listesine alınacak: Clarence. Tanımadığım isimler: Naim, Tariq (henüz üye değiller, yeni oyuncu olarak ekleyeceğim). " +
        "Ali kim, emin değilim; dışarıda bırakıyorum, tam adını yazın. " +
        "Listede 18 yer için 19 isim var, sondakiler yedek listesine gider. Uygulamak için *@Match Time EVET* yazın.",
    );
  });
  it("a list identical to the squad", () => {
    const p = { add: [], remove: [], toBench: [], newNames: [], unclear: [], listed: 18, maxPlayers: 18 };
    expect(buildPasteProposalReply({ lang: "en", ...p })).toBe("That matches the squad, nothing to change.");
    expect(buildPasteProposalReply({ lang: "tr", ...p })).toBe("Bu liste kadroyla aynı, değişecek bir şey yok.");
  });
  it("identical apart from a name it could not place: says so, asks nothing", () => {
    const p = { add: [], remove: [], toBench: [], newNames: [], unclear: ["Ali"], listed: 18, maxPlayers: 18 };
    expect(buildPasteProposalReply({ lang: "en", ...p })).toBe(
      "That matches the squad, nothing to change. Not sure who Ali is, so I'll leave them out; use the full name.",
    );
  });
  it("YES too late", () => {
    expect(buildPasteExpiredReply("en")).toBe(
      "That list is more than 30 minutes old, so I haven't applied it. Paste it again if it still stands.",
    );
    expect(buildPasteExpiredReply("tr")).toBe(
      "O liste 30 dakikadan eski, bu yüzden uygulamadım. Hâlâ geçerliyse yeniden yapıştırın.",
    );
  });
  it("no dashes in any of it", () => {
    const all = [
      buildPasteExpiredReply("en"),
      buildPasteExpiredReply("tr"),
      buildSquadChangeReply({ lang: "en", changes: [{ kind: "in", name: "A" }], failed: ["B"], confirmed: 1, maxPlayers: 2, bench: ["C"], benchPickMode: "organiser" }),
      buildSquadChangeReply({ lang: "tr", changes: [{ kind: "in", name: "A" }], failed: ["B"], confirmed: 1, maxPlayers: 2, bench: ["C"], benchPickMode: "organiser" }),
    ].join(" ");
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});

// A change read in HQ (2026-10-30).
//
// Which sentence in HQ is an instruction is the HQ squad reader's to say
// (a model, `hq-squad-reader-prompt.ts`); the word lists that decided it
// here are gone. What is pinned: the reader's change as the engine's facts,
// the one fact hold (the list not set yet), and what MatchTime says back.
// Paraphrased, fictional names.

function claim(over: Partial<Claim> = {}): Claim {
  return {
    subject: "other",
    personRef: "Kai",
    personNamed: true,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    reported: false,
    confidence: 0.95,
    replaces: "",
    ...over,
  };
}
const self = (over: Partial<Claim> = {}) => claim({ subject: "sender", personRef: "", personNamed: false, ...over });

describe("hqChangeFacts: the reader's change, as the engine's facts", () => {
  it("each person named, definite, present; a member by roster name; the sender's own place is theirs", () => {
    const f = hqChangeFacts(
      [
        { name: "Kai Patel", userId: "u-kai", to: "out", replaces: "" },
        { name: "Omar Shah", userId: "u-omar", to: "in", replaces: "" },
        { name: "Zayn", userId: null, to: "bench", replaces: "" },
        { name: "Mo Ali", userId: "u-mo", to: "in", replaces: "Kai Patel" },
      ],
      "u-omar",
    );
    expect(f).toEqual({
      kind: "attendance",
      affirmation: null,
      sideRequests: [],
      claims: [
        claim({ personRef: "Kai Patel", polarity: "out", confidence: 1 }),
        claim({ subject: "sender", personRef: "Omar Shah", polarity: "in", confidence: 1 }),
        claim({ personRef: "Zayn", polarity: "bench", confidence: 1 }),
        claim({ personRef: "Mo Ali", polarity: "in", confidence: 1, replaces: "Kai Patel" }),
      ],
    });
  });
});

describe("vetAdminGroupFacts: who each claim is about, and the one fact hold", () => {
  const roster: Record<string, AdminClaimRef> = {
    kai: { kind: "member", userId: "u-kai", name: "Kai Patel" },
    ravi: { kind: "member", userId: "u-ravi", name: "Ravi Singh" },
  };
  const resolve = (ref: string): AdminClaimRef =>
    roster[ref.toLowerCase().split(" ")[0]] ?? (ref ? { kind: "unknown", name: ref } : { kind: "none" });
  const facts = (claims: Claim[], affirmation: AttendanceFacts["affirmation"] = null): AttendanceFacts => ({
    kind: "attendance",
    claims,
    affirmation,
    sideRequests: [],
  });
  const vet = (f: AttendanceFacts, status: Record<string, "CONFIRMED" | "BENCH" | "DROPPED"> = {}, listNotSet = false) =>
    vetAdminGroupFacts({ facts: f, senderUserId: "u-omar", senderName: "Omar Shah", listNotSet, resolve, statusOf: (id) => status[id] ?? null });

  it("every claim applies, with who it is about and where they stand", () => {
    const out = vet(facts([claim({ polarity: "out" }), claim({ personRef: "Ravi" })]), { "u-kai": "CONFIRMED" });
    expect(out.facts.claims.map((c) => c.personRef)).toEqual(["Kai", "Ravi"]);
    expect(out.vetted.map((v) => [v.claim.personRef, v.hold, v.ref.kind, v.before])).toEqual([
      ["Kai", null, "member", "CONFIRMED"],
      ["Ravi", null, "member", null],
    ]);
  });

  it("the sender's own claim is about the sender", () => {
    const out = vet(facts([self({ polarity: "out" })]), { "u-omar": "CONFIRMED" });
    expect(out.vetted[0]).toMatchObject({ self: true, hold: null, before: "CONFIRMED", ref: { kind: "member", userId: "u-omar" } });
  });

  it("the list is not set yet (the rolling squad still to carry over): nothing reaches the engine, every claim is marked not-set", () => {
    const out = vet(facts([claim({ polarity: "out" }), claim({ personRef: "Ravi" })]), {}, true);
    expect(out.facts.claims).toEqual([]);
    expect(out.vetted.map((v) => v.hold)).toEqual(["not-set", "not-set"]);
  });

  it('a bare "yes" pointing at something else is never read in HQ', () => {
    expect(vet(facts([], "yes")).facts.affirmation).toBeNull();
  });
});

describe("buildAdminSquadReply: what MatchTime says back, and when it says nothing", () => {
  const v = (over: Partial<VettedClaim> & { claim: Claim }): VettedClaim => ({
    self: over.claim.subject === "sender",
    hold: null,
    ref: { kind: "member", userId: "u-kai", name: "Kai Patel" },
    before: null,
    ...over,
  });
  const me: AdminClaimRef = { kind: "member", userId: "u-omar", name: "Omar Shah" };
  const reply = (p: Parameters<typeof buildAdminSquadReply>[0]) => buildAdminSquadReply(p)?.text ?? null;
  const base = { lang: "en", changes: [], failed: [], confirmed: 17, maxPlayers: 18, kickoffLabel: "Fri 20:30", bench: [] as string[], benchPickMode: null };

  it("a change is reported as before", () => {
    expect(
      reply({ ...base, changes: [{ kind: "out", name: "Kai Patel" }], vetted: [v({ claim: claim({ polarity: "out" }), before: "CONFIRMED" })] }),
    ).toBe("Done: Kai Patel out. 17 of 18.");
  });

  // FNF HQ 2026-10-18 18:16: "Akram out" answered "17 of 18." with Uncle
  // Najib on the bench, in a club whose organisers pick from the bench.
  describe("the bench in the count (FNF HQ 2026-10-18)", () => {
    const out = {
      changes: [{ kind: "out" as const, name: "Akram" }],
      movedUserIds: ["u-akram"],
      vetted: [v({ claim: claim({ polarity: "out" }), before: "CONFIRMED", ref: { kind: "member", userId: "u-akram", name: "Akram" } })],
    };
    it("organiser pick, a place free: the bench and how to bring someone in", () => {
      expect(reply({ ...base, ...out, bench: ["Uncle Najib"], benchPickMode: "organiser" })).toBe(
        'Done: Akram out. 17 of 18, 1 on the bench (Uncle Najib). A place is free. Just tell me who should come in from the bench, in your own words (for example Uncle Najib).',
      );
      expect(reply({ ...base, ...out, lang: "tr", bench: ["Uncle Najib"], benchPickMode: "organiser" })).toBe(
        'Tamam: Akram çıktı. 17/18, yedekte 1 kişi (Uncle Najib). Bir yer boş. Yedekten kimin gireceğini kendi cümlelerinizle yazmanız yeterli (örneğin Uncle Najib).',
      );
    });
    it("automatic bench (first come): the count is accurate, no instruction", () => {
      expect(reply({ ...base, ...out, bench: ["Uncle Najib"], benchPickMode: "first-come" })).toBe(
        "Done: Akram out. 17 of 18, 1 on the bench (Uncle Najib).",
      );
    });
    it("a full squad with five waiting: the count alone, no instruction", () => {
      expect(
        reply({ ...base, ...out, confirmed: 18, bench: ["A", "B", "C", "D", "E"], benchPickMode: "organiser" }),
      ).toBe("Done: Akram out. 18 of 18, 5 on the bench.");
    });
    it("nobody on the bench: as before", () => {
      expect(reply({ ...base, ...out, bench: [], benchPickMode: "organiser" })).toBe("Done: Akram out. 17 of 18.");
    });
  });

  // FNF HQ 2026-10-24 13:47: "Glazers is out now. @Match Time what is the
  // list?" Glazers had been removed from the club and dropped from the match
  // minutes before, so he was on no roster: the claim resolved to a name
  // nobody in the club has, nothing moved, and MatchTime said nothing.
  describe("an OUT for someone not on the list (FNF HQ 2026-10-24)", () => {
    const glazers = v({ claim: claim({ personRef: "Glazers", polarity: "out" }), ref: { kind: "unknown", name: "Glazers" } });
    it("asked of MatchTime: one line saying they are not on the list and nothing changed, EN and TR", () => {
      expect(buildAdminSquadReply({ ...base, vetted: [glazers], addressed: true })).toEqual({
        text: "I can't find Glazers on the list for Fri 20:30, so nothing changed.",
        outcome: "squad-not-on-list",
      });
      expect(reply({ ...base, lang: "tr", kickoffLabel: "Cum 20:30", vetted: [glazers], addressed: true })).toBe(
        "Cum 20:30 listesinde Glazers adında birini bulamadım, bu yüzden hiçbir şey değişmedi.",
      );
    });
    it("an organiser's instruction, untagged: the same line", () => {
      expect(reply({ ...base, vetted: [glazers], organiser: true })).toBe("I can't find Glazers on the list for Fri 20:30, so nothing changed.");
    });
    it("a member who is not an organiser, untagged: silence, as for chatter", () => {
      expect(reply({ ...base, vetted: [glazers] })).toBeNull();
    });
    it("two names: one line naming both", () => {
      const zed = v({ claim: claim({ personRef: "Zed", polarity: "out" }), ref: { kind: "unknown", name: "Zed" } });
      expect(reply({ ...base, vetted: [glazers, zed], addressed: true })).toBe("I can't find Glazers, Zed on the list for Fri 20:30, so nothing changed.");
    });
  });

  it('"Nothing to change" only when it is literally true', () => {
    expect(buildAdminSquadReply({ ...base, vetted: [v({ claim: claim({ polarity: "out" }), before: "DROPPED" })] })).toEqual({
      text: "Nothing to change: the squad already says that. 17 of 18.",
      outcome: "squad-unchanged",
    });
    expect(reply({ ...base, vetted: [v({ claim: claim({ polarity: "out" }), before: null })] })).toBe(
      "Nothing to change: the squad already says that. 17 of 18.",
    );
    expect(reply({ ...base, vetted: [v({ claim: claim(), before: "CONFIRMED" })] })).toBe(
      "Nothing to change: the squad already says that. 17 of 18.",
    );
    // an explicit command the engine did not carry out is not "already so"
    expect(reply({ ...base, vetted: [v({ claim: claim(), before: "BENCH" })] })).toBe(
      "I couldn't change Kai Patel. Please check the match page. 17 of 18.",
    );
  });







  it("an instruction is answered whether or not it was addressed", () => {
    expect(
      reply({ ...base, changes: [{ kind: "out", name: "Kai Patel" }], vetted: [v({ claim: claim({ polarity: "out" }), before: "CONFIRMED" })] }),
    ).toBe("Done: Kai Patel out. 17 of 18.");
    expect(reply({ ...base, vetted: [v({ claim: claim({ personRef: "Ali" }), ref: { kind: "ambiguous", name: "Ali" } })] })).toBe(
      "Not sure who Ali is, so I'll leave them out; use the full name.",
    );
  });

  // Owner rule 4 (2026-10-17): the rolling squad of the next game is carried
  // over at 08:00 the morning after the last one. Until then that list is not
  // set: an instruction for it is not applied and gets one line saying so;
  // chatter about it stays silent.
  it("the list is not set yet: an instruction gets one line", () => {
    const notSet = { day: "Saturday", time: "08:00" };
    const instruction = [v({ claim: claim({ polarity: "out" }), hold: "not-set", before: null })];
    expect(buildAdminSquadReply({ ...base, notSet, vetted: instruction })).toEqual({
      text: "The list for Fri 20:30 isn't set yet: last week's squad carries over at 08:00 on Saturday. Send it again after that.",
      outcome: "squad-not-set",
    });
    expect(reply({ ...base, lang: "tr", kickoffLabel: "Cuma 20:30", notSet: { day: "Cumartesi", time: "08:00" }, vetted: instruction })).toBe(
      "Cuma 20:30 listesi henüz belli değil: geçen haftanın kadrosu Cumartesi saat 08:00 itibarıyla aktarılacak. Ondan sonra tekrar yazın.",
    );
    // nothing read, not addressed: silence; addressed: the same one line
    expect(buildAdminSquadReply({ ...base, notSet, vetted: [] })).toBeNull();
    expect(buildAdminSquadReply({ ...base, notSet, addressed: true, vetted: [] })?.outcome).toBe("squad-not-set");
  });

  it("an explicit command naming two possible players asks for the full name", () => {
    expect(reply({ ...base, vetted: [v({ claim: claim({ personRef: "Ali" }), ref: { kind: "ambiguous", name: "Ali" } })] })).toBe(
      "Not sure who Ali is, so I'll leave them out; use the full name.",
    );
  });


  it("the sender's own explicit line that changes nothing: silence, not a false or pointless line", () => {
    expect(reply({ ...base, vetted: [v({ claim: self({ polarity: "out" }), before: null, ref: me })] })).toBeNull();
  });

});
