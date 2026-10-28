/**
 * MatchTime's one question when an organiser asks for players in HQ and
 * does not say from where (2026-10-28). EN and TR, naming only what the
 * club has.
 */
import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";

const q = (lang: string, options: Array<"club" | "partners" | "pool">) => t(lang).hq_ask_source({ options });

describe("hq_ask_source", () => {
  it("English, every shape", () => {
    expect(q("en", ["club", "partners", "pool"])).toBe("Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?");
    expect(q("en", ["club", "partners"])).toBe("Who shall I ask for players: your players' group, or your partner clubs?");
    expect(q("en", ["club", "pool"])).toBe("Who shall I ask for players: your players' group, or the MatchTime player pool?");
  });

  it("Turkish, every shape", () => {
    expect(q("tr", ["club", "partners", "pool"])).toBe("Oyuncu için kime sorayım: oyuncu grubunuza mı, partner kulüplerinize mi, yoksa MatchTime oyuncu havuzuna mı?");
    expect(q("tr", ["club", "partners"])).toBe("Oyuncu için kime sorayım: oyuncu grubunuza mı, yoksa partner kulüplerinize mi?");
    expect(q("tr", ["club", "pool"])).toBe("Oyuncu için kime sorayım: oyuncu grubunuza mı, yoksa MatchTime oyuncu havuzuna mı?");
  });

  it("names only the options it is given", () => {
    expect(q("en", ["club", "pool"])).not.toMatch(/partner/);
    expect(q("tr", ["club", "partners"])).not.toMatch(/havuz/);
  });

  it("the house rules: no dashes, no slashes, never free or waiting list", () => {
    for (const lang of ["en", "tr"]) {
      const s = q(lang, ["club", "partners", "pool"]);
      expect(s).not.toMatch(/[–—/]/);
      expect(s).not.toMatch(/\bfree\b|waiting list|ücretsiz|bekleme listesi/i);
    }
  });
});

describe("hq_ask_source in the players' group (2026-10-28)", () => {
  const g = (lang: string, options: Array<"club" | "partners" | "pool">) => t(lang).hq_ask_source({ options, inGroup: true });
  it("the club's own players are its recent players, EN and TR", () => {
    expect(g("en", ["club", "partners", "pool"])).toBe("Who shall I ask for players: your recent players, your partner clubs, or the MatchTime player pool?");
    expect(g("tr", ["club", "partners", "pool"])).toBe("Oyuncu için kime sorayım: son oyuncularınıza mı, partner kulüplerinize mi, yoksa MatchTime oyuncu havuzuna mı?");
  });
});

describe("recruit_nobody_left_ask and recruit_nobody_new", () => {
  const o = (lang: string, options: Array<"partners" | "pool">) => t(lang).recruit_nobody_left_ask({ matchName: "Football 9-a-side", options });
  it("English, every shape", () => {
    expect(o("en", ["partners", "pool"])).toBe("None of your recent players are left to ask for *Football 9-a-side*. Want me to ask your partner clubs or the MatchTime player pool?");
    expect(o("en", ["partners"])).toBe("None of your recent players are left to ask for *Football 9-a-side*. Want me to ask your partner clubs?");
    expect(t("en").recruit_nobody_new({ matchName: "Football 9-a-side" })).toBe("None of your recent players are left to ask for *Football 9-a-side* right now. 👍");
  });
  it("Turkish, every shape, each with its own question particle", () => {
    expect(o("tr", ["partners", "pool"])).toBe("*Football 9-a-side* için son oyuncularınızdan sorulacak kimse kalmadı. Partner kulüplerinize mi, MatchTime oyuncu havuzuna mı sorayım?");
    expect(o("tr", ["partners"])).toBe("*Football 9-a-side* için son oyuncularınızdan sorulacak kimse kalmadı. Partner kulüplerinize sorayım mı?");
    expect(o("tr", ["pool"])).toBe("*Football 9-a-side* için son oyuncularınızdan sorulacak kimse kalmadı. MatchTime oyuncu havuzuna sorayım mı?");
  });
  it("the house rules", () => {
    for (const lang of ["en", "tr"]) {
      const s = o(lang, ["partners", "pool"]);
      expect(s).not.toMatch(/[–—/]/);
      expect(s).not.toMatch(/\bfree\b|waiting list|ücretsiz|bekleme listesi/i);
    }
  });
});
