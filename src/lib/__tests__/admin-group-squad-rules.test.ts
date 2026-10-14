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
  buildPasteExpiredReply,
  buildPasteProposalReply,
  buildSquadChangeReply,
  diffPastedSquad,
  isAdminGroupYes,
  matchPastedName,
  readSquadPaste,
  type PasteMember,
} from "../admin-group-squad-rules";

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

describe("isAdminGroupYes", () => {
  it.each(["YES", "yes", " Yes ", "yes.", "EVET", "evet!"])("%s is a yes", (t) => expect(isAdminGroupYes(t)).toBe(true));
  it.each(["yes please add him too", "no", "y", "yep"])("%s is not", (t) => expect(isAdminGroupYes(t)).toBe(false));
});

describe("the routes the admin group acts on", () => {
  it("only attendance about players: self_att and other_att", () => {
    expect([...ADMIN_GROUP_SQUAD_ROUTES].sort()).toEqual(["other_att", "self_att"]);
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
    expect(buildSquadChangeReply({ lang: "en", changes, failed: [], confirmed: 18, maxPlayers: 18 })).toBe(
      "Done: Shehryar out, Bilal in. 18 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes, failed: [], confirmed: 18, maxPlayers: 18 })).toBe(
      "Tamam: Shehryar çıktı, Bilal kadroya girdi. 18/18.",
    );
  });
  it("the waiting list and a maybe", () => {
    const changes = [
      { kind: "bench" as const, name: "Tom" },
      { kind: "maybe" as const, name: "Sait" },
    ];
    expect(buildSquadChangeReply({ lang: "en", changes, failed: [], confirmed: 17, maxPlayers: 18 })).toBe(
      "Done: Tom on the bench, Sait a maybe. 17 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes, failed: [], confirmed: 17, maxPlayers: 18 })).toBe(
      "Tamam: Tom yedek listesinde, Sait belki. 17/18.",
    );
  });
  it("a change that did not land is said plainly", () => {
    expect(
      buildSquadChangeReply({ lang: "en", changes: [], failed: ["Shehryar"], confirmed: 18, maxPlayers: 18 }),
    ).toBe("I couldn't change Shehryar. Please check the match page. 18 of 18.");
    expect(
      buildSquadChangeReply({ lang: "tr", changes: [], failed: ["Shehryar"], confirmed: 18, maxPlayers: 18 }),
    ).toBe("Shehryar için değişiklik yapamadım. Lütfen maç sayfasını kontrol edin. 18/18.");
  });
  it("nothing to change", () => {
    expect(buildSquadChangeReply({ lang: "en", changes: [], failed: [], confirmed: 18, maxPlayers: 18 })).toBe(
      "Nothing to change: the squad already says that. 18 of 18.",
    );
    expect(buildSquadChangeReply({ lang: "tr", changes: [], failed: [], confirmed: 18, maxPlayers: 18 })).toBe(
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
      buildSquadChangeReply({ lang: "en", changes: [{ kind: "in", name: "A" }], failed: ["B"], confirmed: 1, maxPlayers: 2 }),
      buildSquadChangeReply({ lang: "tr", changes: [{ kind: "in", name: "A" }], failed: ["B"], confirmed: 1, maxPlayers: 2 }),
    ].join(" ");
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});
