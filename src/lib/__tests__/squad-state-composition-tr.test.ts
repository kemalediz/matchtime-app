/**
 * The composition guards, in Turkish: the twin of
 * `squad-state-composition.test.ts` (design section 4.5, point 5).
 *
 * Same incidents, same rule, second language: a Turkish reply that shows
 * squad state, or claims a move the database does not support, is not
 * patched but REPLACED by the post composed from the rows, in Turkish.
 * The English file is untouched; these cases are written beside it so
 * the English verdicts cannot drift while the Turkish ones are added.
 */
import { describe, it, expect } from "vitest";
import {
  SQUAD_POST_MARKER,
  composeSquadStatusPost,
  composeSquadStateReply,
  contradictsSquadState,
  displaysSquadState,
  type SquadTruth,
} from "@/lib/group-copy";
import { claimedMoves } from "../../../e2e/corpus/grade";

const truth: SquadTruth = {
  confirmed: ["Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Mustafa Kaya"],
  bench: ["Çağrı Yılmaz"],
  maxPlayers: 5,
  knownNames: [
    "Kemal Ediz",
    "Elvin Aliyev",
    "Sait Demir",
    "Mustafa Kaya",
    "Çağrı Yılmaz",
    "Erdal Özkan",
    "Zair Malik",
    "Wasim Akhtar",
  ],
};

const composed = composeSquadStatusPost({
  confirmed: truth.confirmed,
  bench: truth.bench,
  maxPlayers: truth.maxPlayers,
  lang: "tr",
});

const tr = (reply: string) => composeSquadStateReply(reply, truth, "tr");

describe("a Turkish reply that says nothing about squad state is left alone", () => {
  it("passes an ack through byte-for-byte", () => {
    expect(tr("Tamam Sait, not aldım 👍")).toEqual({ text: "Tamam Sait, not aldım 👍", composed: false });
  });

  it("passes a Turkish stats leaderboard through", () => {
    const leaderboard = "En istikrarlı:\n1. Kemal Ediz: 4 maç\n2. Elvin Aliyev: 3 maç";
    expect(tr(leaderboard).composed).toBe(false);
  });

  it("passes a move claim the database DOES support", () => {
    expect(tr("Çağrı Yılmaz yedekte, sıra onda.").composed).toBe(false);
    expect(tr("Sait Demir kadroda 👍").composed).toBe(false);
  });
});

describe("a model-authored Turkish roster is replaced, never patched", () => {
  it("drops the model's roster, count and ordering entirely", () => {
    const modelReply = [
      "Wasim çıktı, 3/5 kişiyiz, 2 kişi daha lazım 🙏",
      "",
      "*Bu akşam oynayanlar:*",
      "1. Mustafa Kaya",
      "2. Kemal Ediz",
      "3. 🥁",
    ].join("\n");
    const r = tr(modelReply);
    expect(r.composed).toBe(true);
    expect(r.text).toBe(composed);
    expect(r.text).toContain("*4/5*");
    expect(r.text).toContain("*Oynayanlar:*");
    expect(r.text).toContain("*Yedekler (1):*");
    expect(r.text).not.toContain("3/5");
    expect(r.text).not.toContain("Bu akşam oynayanlar");
  });

  it("a Turkish header alone is squad state", () => {
    for (const header of ["*Bu akşam oynayanlar:*", "*Yarın oynayanlar:*", "*8 Eylül Salı oynayanlar:*", "*Kadro:*", "*Onaylananlar (3/5):*", "*Yedekler (2):*"]) {
      expect(displaysSquadState(header, "tr"), header).toBe(true);
    }
  });
});

describe("stale Turkish counts and slot prose cannot survive", () => {
  it("replaces '2/5, 3 kişi daha lazım' with the truth", () => {
    const r = tr("2/5 kişiyiz, *3 kişi daha* lazım!");
    expect(r.composed).toBe(true);
    expect(r.text).toContain("*4/5*");
    expect(r.text).toContain("*1 kişi daha* lazım");
    expect(r.text).not.toContain("2/5");
  });

  it("catches a wrong shortfall written in words", () => {
    expect(contradictsSquadState("Üç kişi daha lazım", truth, "tr")).toBe(true);
    expect(contradictsSquadState("bir kişi daha lazım", truth, "tr")).toBe(false);
  });

  it("replaces a full-squad claim made while a slot is open", () => {
    for (const claim of ["Kadro tamam ✅", "Dolduk!", "Kadro doldu, yer yok."]) {
      expect(tr(claim).composed, claim).toBe(true);
    }
  });

  it("replaces a wrong open-slot count", () => {
    expect(tr("2 yer açıldı, almak için *VARIM* yazın.").composed).toBe(true);
    expect(contradictsSquadState("Bir yer açıldı, almak için *VARIM* yazın.", truth, "tr")).toBe(false);
  });

  it("replaces an impossible total", () => {
    expect(tr("Kadroda 9 kişi var, güçlü görünüyor.").composed).toBe(true);
  });

  it("replaces a wrong bench claim", () => {
    expect(tr("Yedek listesi boş, kimse beklemiyor.").composed).toBe(true);
    expect(tr("Yedekte kimse yok.").composed).toBe(true);
  });
});

describe("an announced Turkish move that the database does not back is replaced (S7, Erdal)", () => {
  it("cannot announce a bench move that never happened", () => {
    const r = tr("Erdal Özkan yedeğe geçti 👍");
    expect(r.composed).toBe(true);
    expect(r.text).not.toMatch(/Erdal/);
    expect(claimedMoves(r.text)).toEqual([]);
  });

  it("cannot announce a promotion while the player is still benched", () => {
    const r = tr("Çağrı Yılmaz kadroya geçti, hallettik.");
    expect(r.composed).toBe(true);
    expect(r.text).toContain("*Yedekler (1):*");
    expect(r.text).toContain("Çağrı Yılmaz");
  });

  it("catches every Turkish move shape the corpus grader can detect", () => {
    const claims = [
      "Erdal Özkan yedeğe geçti",
      "Erdal Özkan artık yedekte",
      "Zair Malik artık kadroda",
      "Zair Malik kadroya eklendi",
      "Kemal Ediz çıktı",
      "Kemal Ediz kadrodan çıkarıldı",
      "Wasim Akhtar onaylandı",
    ];
    for (const claim of claims) {
      expect(claimedMoves(claim).length, `grader sees a claim in: ${claim}`).toBeGreaterThan(0);
      expect(contradictsSquadState(claim, truth, "tr"), `composer sees it too: ${claim}`).toBe(true);
      expect(claimedMoves(tr(claim).text)).toEqual([]);
    }
  });

  it("a Turkish capital starts a name (Çağrı, Özkan)", () => {
    // The grader captures the one token adjacent to the verb, as its
    // English patterns do; what matters is that a Turkish capital is one.
    expect(claimedMoves("Çağrı kadroya eklendi").map((c) => c.name)).toEqual(["Çağrı"]);
    expect(claimedMoves("Erdal Özkan kadroya eklendi").map((c) => c.name)).toEqual(["Özkan"]);
    expect(contradictsSquadState("Özkan yedeğe geçti", truth, "tr")).toBe(true);
  });

  it("ignores claims about people the group has never heard of", () => {
    expect(contradictsSquadState("Salı kadroya eklendi", truth, "tr")).toBe(false);
  });
});

describe("the model keeps the Turkish human half, and only that", () => {
  it("keeps a claim-free lead above the composed Turkish post", () => {
    const r = tr(`Geçmiş olsun İbrahim, biri girebilir mi? 🙏\n\n${SQUAD_POST_MARKER}`);
    expect(r.composed).toBe(true);
    expect(r.text).toContain("Geçmiş olsun İbrahim");
    expect(r.text.endsWith(composed)).toBe(true);
  });

  it("drops a lead that makes its own count claim", () => {
    const r = tr(`2/5 kişiyiz, 3 kişi daha lazım.\n${SQUAD_POST_MARKER}`);
    expect(r.text).toBe(composed);
  });

  it("drops a lead that announces an unbacked move", () => {
    const r = tr(`Erdal Özkan yedeğe geçti.\n${SQUAD_POST_MARKER}`);
    expect(r.text).toBe(composed);
  });
});

describe("English verdicts are unchanged by the language argument", () => {
  it("an English reply judged with 'en' or with nothing gets the same verdict", () => {
    for (const text of [
      "Erdal goes on the bench. 👍",
      "We're 2/5 — three slots open, need *3 more* lads!",
      "nice one 👍",
      "1. Kemal — 4/4 (100%)\n2. Elvin — 3/4 (75%)",
    ]) {
      expect(displaysSquadState(text, "en")).toBe(displaysSquadState(text));
      expect(contradictsSquadState(text, truth, "en")).toBe(contradictsSquadState(text, truth));
    }
  });

  it("Turkish vocabulary is not applied to an English group", () => {
    // "Kadro tamam" in an English group is not a squad claim the English
    // guard knows; the English guard's verdict on it is the same as before.
    expect(contradictsSquadState("Kadro tamam", truth, "en")).toBe(false);
  });
});
