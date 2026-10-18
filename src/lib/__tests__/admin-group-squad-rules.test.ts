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
  adminClaimHold,
  buildAdminSquadReply,
  vetAdminGroupFacts,
  type AdminClaimRef,
  type VettedClaim,
  buildPasteExpiredReply,
  buildPasteProposalReply,
  buildSquadChangeReply,
  diffPastedSquad,
  matchPastedName,
  readSquadPaste,
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

describe("readSquadPaste", () => {
  const list18 = Array.from({ length: 18 }, (_, i) => `${i + 1}. Player ${String.fromCharCode(65 + i)}`).join("\n");
  it("a numbered list of the whole squad is a paste", () => {
    const r = readSquadPaste(`Friday 8pm\n${list18}`, 18);
    expect(r?.playing).toHaveLength(18);
    expect(r?.reserves).toEqual([]);
  });
  it("one name per line counts too", () => {
    const body = ["Shehryar", "Bilal", "Clarence", "Ali Raza", "Hafeez", "Ilker", "Naim", "Tom", "Sam"].join("\n");
    expect(readSquadPaste(body, 18)?.playing).toHaveLength(9);
  });
  it("reserves are read separately", () => {
    const r = readSquadPaste(`${list18}\nReserves:\n1. Naim\n2. Tariq`, 18);
    expect(r?.reserves).toEqual(["Naim", "Tariq"]);
  });
  it("a short list is not the squad (fewer than half the places)", () => {
    expect(readSquadPaste("1. Ali\n2. Bilal\n3. Clarence\n4. Shehryar", 18)).toBeNull();
  });
  it("chat is not a paste", () => {
    expect(readSquadPaste("Shehryar out", 18)).toBeNull();
    expect(readSquadPaste("Wasim played well last week", 18)).toBeNull();
  });
});

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
      "Adding: Bilal. Removing: Shehryar, Clarence. Unknown names: Naim (not a member yet, I'll add them as a new player). Reply YES to apply.",
    );
    expect(buildPasteProposalReply({ lang: "tr", ...p })).toBe(
      "Eklenecek: Bilal. Çıkarılacak: Shehryar, Clarence. Tanımadığım isimler: Naim (henüz üye değil, yeni oyuncu olarak ekleyeceğim). Uygulamak için EVET yazın.",
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
        "The list has 19 names for 18 places, so the last ones go on the bench. Reply YES to apply.",
    );
    expect(buildPasteProposalReply({ lang: "tr", ...p })).toBe(
      "Yedek listesine alınacak: Clarence. Tanımadığım isimler: Naim, Tariq (henüz üye değiller, yeni oyuncu olarak ekleyeceğim). " +
        "Ali kim, emin değilim; dışarıda bırakıyorum, tam adını yazın. " +
        "Listede 18 yer için 19 isim var, sondakiler yedek listesine gider. Uygulamak için EVET yazın.",
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

// \u2500\u2500 What an organiser's sentence in HQ is allowed to do (2026-10-15) \u2500\u2500
//
// The live club rehearsal replayed a real HQ fortnight and found ordinary
// conversation among organisers turned into squad writes and false
// "Nothing to change" lines. The extractor's facts are unchanged; what is
// under test is OUR reading of them in the admin group. Paraphrased,
// fictional names.

function claim(over: Partial<Claim> = {}): Claim {
  return {
    subject: "other",
    personRef: "Kai",
    personNamed: true,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    replaces: "",
    ...over,
  };
}
const self = (over: Partial<Claim> = {}) => claim({ subject: "sender", personRef: "", personNamed: false, ...over });
const hold = (body: string, c: Claim, extra: { claims?: Claim[]; bare?: boolean; sender?: string } = {}) =>
  adminClaimHold({ body, claim: c, claims: extra.claims ?? [c], senderName: extra.sender ?? "Omar Shah", bareDeclaration: extra.bare ?? false });

describe("adminClaimHold: an explicit instruction applies, conversation does not", () => {
  it.each<[string, Claim]>([
    ["put Kai in", claim()],
    ["Kai out", claim({ polarity: "out" })],
    ["Kai in", claim()],
    ["Kai out, Ravi in?", claim({ polarity: "out" })],
    ["Kai out, Ravi in?", claim({ personRef: "Ravi" })],
    ["pls put Kai in for friday", claim()],
    ["Kai to the bench", claim({ polarity: "bench" })],
    ["Abdul-Rahim dropping out", claim({ personRef: "Abdul-Rahim", polarity: "out" })],
    ["Kai can't make it", claim({ polarity: "out" })],
    ["Kai and Ravi in", claim()],
    ["swap Kai for Ravi", claim({ personRef: "Ravi", replaces: "Kai" })],
    ["Kai Patel out", claim({ personRef: "Kai Patel", polarity: "out" })],
    ["Kai is out", claim({ polarity: "out" })],
    ["Kai yok", claim({ polarity: "out" })],
    ["Kai var", claim()],
    ["Kai'yi yede\u011fe al", claim({ polarity: "bench" })],
  ])("%s: applies", (body, c) => {
    expect(hold(body, c, { claims: [c, claim({ personRef: "Ravi" }), claim({ personRef: "Kai" })] })).toBeNull();
  });

  // Review of #269: future and negative auxiliaries. Every one an
  // organiser's plain instruction about somebody else.
  it.each<[string, string, Partial<Claim>]>([
    ["Mo will play", "Mo", {}],
    ["Ravi won't be playing", "Ravi", { polarity: "out" }],
    ["Kofi is joining us", "Kofi", {}],
    ["Yusuf's gonna play", "Yusuf", {}],
    ["Ali is going to play", "Ali", {}],
    ["Sam will be in", "Sam", {}],
    ["Dev wont make it", "Dev", { polarity: "out" }],
    ["Hari not playing", "Hari", { polarity: "out" }],
    ["Kofi in for Dev", "Kofi", { replaces: "Dev" }],
    ["Kofi in for Dev", "Dev", { polarity: "out" }],
    ["Sam replaces Dev", "Sam", { replaces: "Dev" }],
    ["Add Kofi to the list", "Kofi", {}],
    ["Ali gelecek", "Ali", {}],
    ["Ali bu hafta oynamayacak", "Ali", { polarity: "out" }],
  ])("%s (%s): applies", (body, ref, over) => {
    const c = claim({ personRef: ref, ...over });
    const others = [claim({ personRef: "Kofi", replaces: "Dev" }), claim({ personRef: "Dev", polarity: "out" })];
    expect(hold(body, c, { claims: [c, ...others] })).toBeNull();
  });

  it.each<[string, Claim]>([
    ["Dev is back too", claim({ personRef: "Dev" })],
    ["Kai is in the hospital", claim()],
    ["will be good to see Mo", claim({ personRef: "Mo" })],
    ["I might have to pull out", self({ polarity: "out" })],
    ["my foot is wrecked", self({ polarity: "out" })],
  ])("%s: held, even if the extractor calls it a definite decision", (body, c) => {
    expect(hold(body, c)).toBe("not-a-command");
  });

  it("a third party mentioned in passing is not an instruction", () => {
    expect(hold("Kai is back as well", claim())).toBe("not-a-command");
    expect(hold("Kai is in the hospital", claim())).toBe("not-a-command");
    expect(hold("put Ravi in", claim())).toBe("not-a-command"); // Kai is not in the sentence at all
  });

  it("tentative, contingent, past, availability, relayed and unsure claims are held, whoever they are about", () => {
    expect(hold("Kai out", claim({ polarity: "out", contingent: true, conditionOn: "self" }))).toBe("contingent");
    expect(hold("Kai out", claim({ polarity: "out", tense: "hypothetical" }))).toBe("not-now");
    expect(hold("Kai out", claim({ polarity: "out", tense: "past" }))).toBe("not-now");
    expect(hold("Kai out", claim({ polarity: "out", basis: "availability" }))).toBe("availability");
    expect(hold("Kai out", claim({ polarity: "out", reported: true }))).toBe("reported");
    expect(hold("Kai out", claim({ polarity: "out", confidence: 0.4 }))).toBe("unsure");
  });

  it("the sender: a bare IN/OUT or a command applies; a sentence about themselves does not", () => {
    expect(hold("out", self({ polarity: "out" }), { bare: true })).toBeNull();
    expect(hold("put me in", self())).toBeNull();
    expect(hold("I'm out this week", self({ polarity: "out" }))).toBeNull();
    expect(hold("Omar out", self({ polarity: "out", personRef: "Omar" }))).toBeNull();
    expect(hold("Omar Shah in", self({ personRef: "Omar Shah" }))).toBeNull();
    // since the review of #269 the auxiliaries are command words, so the
    // sender's own plain "won't be playing" is an instruction too
    expect(hold("I won't be playing on friday", self({ polarity: "out" }))).toBeNull();
    // the rehearsal's shapes, paraphrased
    expect(hold("won't be around on friday", self({ polarity: "out" }))).toBe("not-a-command");
    expect(hold("might have to pull out lads", self({ polarity: "out", contingent: true, conditionOn: "self" }))).toBe("contingent");
    expect(hold("my ankle is wrecked", self({ polarity: "out", basis: "availability" }))).toBe("availability");
    expect(hold("my ankle is wrecked", self({ polarity: "out" }))).toBe("not-a-command");
    expect(hold("happy to go in goal but I'll stay in all session", self())).toBe("not-a-command");
  });

  it("the sender asking for the bench is a stated preference and applies", () => {
    expect(hold("I'd rather just be a reserve", self({ polarity: "bench" }))).toBeNull();
  });
});

describe("vetAdminGroupFacts: only explicit claims reach the engine", () => {
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
  const vet = (body: string, f: AttendanceFacts, status: Record<string, "CONFIRMED" | "BENCH" | "DROPPED"> = {}) =>
    vetAdminGroupFacts({
      body,
      facts: f,
      senderUserId: "u-omar",
      senderName: "Omar Shah",
      bareDeclaration: false,
      resolve,
      statusOf: (id) => status[id] ?? null,
    });

  it("keeps the command, drops the chatter, and records who each claim is about and where they stand", () => {
    const out = vet("Kai out, Ravi is back as well", facts([claim({ polarity: "out" }), claim({ personRef: "Ravi" })]), { "u-kai": "CONFIRMED" });
    expect(out.facts.claims.map((c) => c.personRef)).toEqual(["Kai"]);
    expect(out.vetted.map((v) => [v.claim.personRef, v.hold, v.ref.kind, v.before])).toEqual([
      ["Kai", null, "member", "CONFIRMED"],
      ["Ravi", "not-a-command", "member", null],
    ]);
  });

  it("the sender's own claim is about the sender", () => {
    const out = vet("won't be around on friday", facts([self({ polarity: "out" })]), { "u-omar": "CONFIRMED" });
    expect(out.facts.claims).toEqual([]);
    expect(out.vetted[0]).toMatchObject({ self: true, hold: "not-a-command", before: "CONFIRMED", ref: { kind: "member", userId: "u-omar" } });
  });

  it("the list is not set yet (the rolling squad still to carry over): nothing reaches the engine, the instruction is marked not-set", () => {
    const out = vetAdminGroupFacts({
      body: "Kai out, Ravi is back as well",
      facts: facts([claim({ polarity: "out" }), claim({ personRef: "Ravi" })]),
      senderUserId: "u-omar",
      senderName: "Omar Shah",
      bareDeclaration: false,
      listNotSet: true,
      resolve,
      statusOf: () => null,
    });
    expect(out.facts.claims).toEqual([]);
    expect(out.vetted.map((v) => [v.claim.personRef, v.hold])).toEqual([
      ["Kai", "not-set"],
      ["Ravi", "not-a-command"],
    ]);
  });

  it('a bare "yes" pointing at something else is never read in HQ', () => {
    expect(vet("yeah", facts([], "yes")).facts.affirmation).toBeNull();
  });

  // FNF HQ 2026-10-17 09:01: "Imti\nRafi\nAH\n\nIn". A name alone on its
  // line is not a command clause, so every claim was held, and silence.
  // The router's floor reads the shape as a list (`floorAttendanceFacts`),
  // and its names are the instruction.
  describe("a list of names with a bare IN or OUT (the floor's list)", () => {
    const listVet = (body: string, names: string[], polarity: "in" | "out", listedNames?: string[]) =>
      vetAdminGroupFacts({
        body,
        facts: facts(names.map((n) => claim({ personRef: n, polarity, confidence: 1 }))),
        senderUserId: "u-omar",
        senderName: "Omar Shah",
        bareDeclaration: false,
        ...(listedNames ? { listedNames } : {}),
        resolve,
        statusOf: () => null,
      });

    it("without the floor's names, every claim is held: the incident", () => {
      expect(listVet("Imti \nRafi \nAH\n\nIn", ["Imti", "Rafi", "AH"], "in").vetted.map((v) => v.hold)).toEqual([
        "not-a-command",
        "not-a-command",
        "not-a-command",
      ]);
    });

    it.each<[string, string[], "in" | "out"]>([
      ["Imti \nRafi \nAH\n\nIn", ["Imti", "Rafi", "AH"], "in"],
      ["Yaseen \nMo\nFeroz\nAli\n\nOut", ["Yaseen", "Mo", "Feroz", "Ali"], "out"],
      ["Imti, Rafi and AH in", ["Imti", "Rafi", "AH"], "in"],
    ])("%j with the floor's names: every claim applies", (body, names, polarity) => {
      const out = listVet(body, names, polarity, names);
      expect(out.vetted.map((v) => v.hold)).toEqual(names.map(() => null));
      expect(out.facts.claims.map((c) => c.personRef)).toEqual(names);
    });

    it("a name the floor did not list is still vetted as before", () => {
      const out = listVet("Imti \nRafi\n\nIn", ["Imti", "Kai"], "in", ["Imti", "Rafi"]);
      expect(out.vetted.map((v) => [v.claim.personRef, v.hold])).toEqual([
        ["Imti", null],
        ["Kai", "not-a-command"],
      ]);
    });

    it("a listed name is still held when the claim is not definite", () => {
      const out = vetAdminGroupFacts({
        body: "Imti\nRafi\n\nIn",
        facts: facts([claim({ personRef: "Imti", contingent: true, conditionOn: "self" })]),
        senderUserId: "u-omar",
        senderName: "Omar Shah",
        bareDeclaration: false,
        listedNames: ["Imti", "Rafi"],
        resolve,
        statusOf: () => null,
      });
      expect(out.vetted[0].hold).toBe("contingent");
    });
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
  const base = { lang: "en", changes: [], failed: [], confirmed: 17, maxPlayers: 18, kickoffLabel: "Fri 20:30", senderName: "Omar Shah", bench: [] as string[], benchPickMode: null };

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

  it("held chatter, a tentative or a contingent line: silence", () => {
    expect(reply({ ...base, vetted: [v({ claim: claim({ contingent: true }), hold: "contingent" })] })).toBeNull();
    expect(
      reply({
        ...base,
        vetted: [v({ claim: self({ polarity: "out", contingent: true }), hold: "contingent", before: "CONFIRMED", ref: me })],
      }),
    ).toBeNull();
    expect(reply({ ...base, vetted: [v({ claim: claim(), hold: "not-a-command" })] })).toBeNull();
    expect(reply({ ...base, vetted: [] })).toBeNull();
  });

  it("a name nobody in the club has, mentioned in passing to MatchTime (a tag or a reply to it): says so and how to add them", () => {
    const vetted = [v({ claim: claim({ personRef: "Zayn" }), hold: "not-a-command", ref: { kind: "unknown", name: "Zayn" } })];
    expect(reply({ ...base, addressed: true, vetted })).toBe('I don\'t know Zayn yet. To add them, just ask me in your own words (for example put Zayn in).');
    expect(reply({ ...base, addressed: true, lang: "tr", vetted })).toBe('Zayn adında birini henüz tanımıyorum. Eklemek için kendi cümlelerinizle yazmanız yeterli (örneğin Zayn var).');
    // but not for a past or contingent mention, nor a drop of a stranger
    expect(
      reply({
        ...base,
        addressed: true,
        vetted: [v({ claim: claim({ personRef: "Zayn", tense: "past" }), hold: "not-now", ref: { kind: "unknown", name: "Zayn" } })],
      }),
    ).toBeNull();
    expect(
      reply({
        ...base,
        addressed: true,
        vetted: [v({ claim: claim({ personRef: "Zayn", contingent: true }), hold: "contingent", ref: { kind: "unknown", name: "Zayn" } })],
      }),
    ).toBeNull();
    expect(
      reply({
        ...base,
        addressed: true,
        vetted: [v({ claim: claim({ personRef: "Zayn", polarity: "out" }), hold: "not-a-command", ref: { kind: "unknown", name: "Zayn" } })],
      }),
    ).toBeNull();
  });

  // FNF HQ, 2026-10-16 23:49 London: "Imti Rafi AH back", a WhatsApp reply
  // to ANOTHER organiser about next week, got a tick and "I don't know AH
  // yet...". Nothing was written. A hint for a held claim is said only when
  // the message was addressed to MatchTime; otherwise it is their chat.
  it("the incident: held chatter about a stranger and members, not addressed: silence", () => {
    const vetted = [
      v({ claim: claim({ personRef: "Imti" }), hold: "not-a-command", ref: { kind: "member", userId: "u-imti", name: "Imti" } }),
      v({ claim: claim({ personRef: "Rafi" }), hold: "not-a-command", ref: { kind: "member", userId: "u-rafi", name: "Rafi" } }),
      v({ claim: claim({ personRef: "AH" }), hold: "unsure", ref: { kind: "unknown", name: "AH" } }),
    ];
    expect(buildAdminSquadReply({ ...base, vetted })).toBeNull();
    expect(buildAdminSquadReply({ ...base, addressed: false, vetted })).toBeNull();
    expect(reply({ ...base, addressed: true, vetted })).toBe('I don\'t know AH yet. To add them, just ask me in your own words (for example put AH in).');
  });

  it("the sender's own plain line in conversation, not addressed: silence", () => {
    expect(
      buildAdminSquadReply({ ...base, vetted: [v({ claim: self({ polarity: "out" }), hold: "not-a-command", before: "CONFIRMED", ref: me })] }),
    ).toBeNull();
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
  it("the list is not set yet: an instruction gets one line, chatter nothing", () => {
    const notSet = { day: "Saturday", time: "08:00" };
    const instruction = [v({ claim: claim({ polarity: "out" }), hold: "not-set", before: null })];
    expect(buildAdminSquadReply({ ...base, notSet, vetted: instruction })).toEqual({
      text: "The list for Fri 20:30 isn't set yet: last week's squad carries over at 08:00 on Saturday. Send it again after that.",
      outcome: "squad-not-set",
    });
    expect(reply({ ...base, lang: "tr", kickoffLabel: "Cuma 20:30", notSet: { day: "Cumartesi", time: "08:00" }, vetted: instruction })).toBe(
      "Cuma 20:30 listesi henüz belli değil: geçen haftanın kadrosu Cumartesi saat 08:00 itibarıyla aktarılacak. Ondan sonra tekrar yazın.",
    );
    const chatter = [v({ claim: claim({ personRef: "AH" }), hold: "not-a-command", ref: { kind: "unknown", name: "AH" } })];
    expect(buildAdminSquadReply({ ...base, notSet, vetted: chatter })).toBeNull();
    // addressed to MatchTime: the same one line, never silence
    expect(buildAdminSquadReply({ ...base, notSet, addressed: true, vetted: chatter })?.outcome).toBe("squad-not-set");
  });

  it("an explicit command naming two possible players asks for the full name", () => {
    expect(reply({ ...base, vetted: [v({ claim: claim({ personRef: "Ali" }), ref: { kind: "ambiguous", name: "Ali" } })] })).toBe(
      "Not sure who Ali is, so I'll leave them out; use the full name.",
    );
  });

  it("the sender says plainly they are out (or in) to MatchTime: no write, one line saying how", () => {
    const outLine = buildAdminSquadReply({ ...base, addressed: true, vetted: [v({ claim: self({ polarity: "out" }), hold: "not-a-command", before: "CONFIRMED", ref: me })] });
    expect(outLine).toEqual({ text: 'If you want me to take you out of Fri 20:30, just ask me in your own words (for example Omar Shah out).', outcome: "squad-question" });
    const inLine = reply({ ...base, addressed: true, vetted: [v({ claim: self(), hold: "not-a-command", before: null, ref: me })] });
    expect(inLine).toBe('If you want me to put you in for Fri 20:30, just ask me in your own words (for example Omar Shah in).');
    expect(
      reply({
        ...base,
        addressed: true,
        lang: "tr",
        kickoffLabel: "Cum 20:30",
        vetted: [v({ claim: self({ polarity: "out" }), hold: "not-a-command", before: "CONFIRMED", ref: me })],
      }),
    ).toBe('Sizi Cum 20:30 kadrosundan çıkarmamı isterseniz kendi cümlelerinizle yazmanız yeterli (örneğin Omar Shah yok).');
    expect(
      reply({ ...base, addressed: true, lang: "tr", kickoffLabel: "Cum 20:30", vetted: [v({ claim: self(), hold: "not-a-command", before: null, ref: me })] }),
    ).toBe('Sizi Cum 20:30 kadrosuna yazmamı isterseniz kendi cümlelerinizle yazmanız yeterli (örneğin Omar Shah var).');
    // already where they say: silence, not "Nothing to change"
    expect(
      reply({ ...base, addressed: true, vetted: [v({ claim: self({ polarity: "out" }), hold: "not-a-command", before: null, ref: me })] }),
    ).toBeNull();
    // an injury report (availability) is never turned into a question
    expect(
      reply({
        ...base,
        addressed: true,
        vetted: [v({ claim: self({ polarity: "out", basis: "availability" }), hold: "availability", before: "CONFIRMED", ref: me })],
      }),
    ).toBeNull();
  });

  it("the sender's own explicit line that changes nothing: silence, not a false or pointless line", () => {
    expect(reply({ ...base, vetted: [v({ claim: self({ polarity: "out" }), before: null, ref: me })] })).toBeNull();
  });

  it("no dashes in the new lines", () => {
    const all = ["en", "tr"].flatMap((lang) => [
      reply({ ...base, addressed: true, lang, vetted: [v({ claim: claim({ personRef: "Zayn" }), hold: "not-a-command", ref: { kind: "unknown", name: "Zayn" } })] }),
      reply({ ...base, addressed: true, lang, vetted: [v({ claim: self({ polarity: "out" }), hold: "not-a-command", before: "CONFIRMED", ref: me })] }),
      reply({ ...base, addressed: true, lang, vetted: [v({ claim: self(), hold: "not-a-command", before: null, ref: me })] }),
    ]);
    expect(all.join(" ")).not.toMatch(/[\u2013\u2014]/);
  });
});
