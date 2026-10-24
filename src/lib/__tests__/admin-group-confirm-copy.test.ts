/**
 * THE SAFE-YES RULE'S QUESTIONS, IN THE CLUB'S LANGUAGE (one home, L10).
 * "Is that YES to ...?" about one item, and "Which one is that YES for?"
 * naming every item waiting, whatever their kinds.
 */
import { describe, expect, it } from "vitest";
import { confirmQuestion } from "../admin-group-confirm-copy";
import type { PendingWithLabel } from "../admin-group-context";

const ASKED = new Date("2026-10-27T10:00:00Z");
const TEAMS: PendingWithLabel = { ref: "teams:m1", kind: "teams", day: "Tue 27 Oct", askedAt: ASKED };
const LIST: PendingWithLabel = { ref: "list:w1", kind: "list", day: null, askedAt: ASKED };
const POOL: PendingWithLabel = { ref: "pool-ask:m1", kind: "pool-ask", day: "Tue 27 Oct", askedAt: ASKED };
const POOL2: PendingWithLabel = { ref: "pool-ask:m2", kind: "pool-ask", day: "Thu 29 Oct", askedAt: ASKED };
const FEE: PendingWithLabel = { ref: "fee:f1", kind: "fee", day: "Tue 27 Oct", names: "Bilal", askedAt: ASKED };

describe("one item", () => {
  it("each kind keeps its own question (unchanged), and the pool notice has one", () => {
    expect(confirmQuestion("en", [TEAMS])).toBe("Is that YES to the proposed teams for Tue 27 Oct?");
    expect(confirmQuestion("en", [LIST])).toBe("Is that YES to the squad list pasted here?");
    expect(confirmQuestion("en", [FEE])).toBe("Is that YES to the free place for Bilal on Tue 27 Oct?");
    expect(confirmQuestion("en", [POOL])).toBe("Is that YES to asking nearby players from the MatchTime player pool for Tue 27 Oct?");
    expect(confirmQuestion("tr", [POOL])).toBe("Bu EVET, Tue 27 Oct maçı için MatchTime oyuncu havuzundaki yakın oyunculara sormak için mi?");
  });
});

describe("several items: which one", () => {
  it("the teams and the list: exactly today's words, EN and TR", () => {
    expect(confirmQuestion("en", [TEAMS, LIST])).toBe(
      "Which one is that YES for: the proposed teams for Tue 27 Oct, or the pasted squad list? Reply YES to that message.",
    );
    expect(confirmQuestion("tr", [TEAMS, LIST])).toBe(
      "Bu EVET hangisi için: Tue 27 Oct için önerilen takımlar mı, yapıştırılan kadro listesi mi? O mesaja EVET diye cevap verin.",
    );
  });

  it("names whatever is waiting: the pool notice beside the teams, two pool notices, three items", () => {
    expect(confirmQuestion("en", [TEAMS, POOL])).toBe(
      "Which one is that YES for: the proposed teams for Tue 27 Oct, or asking nearby players from the MatchTime player pool for Tue 27 Oct? Reply YES to that message.",
    );
    expect(confirmQuestion("en", [POOL, POOL2])).toMatch(/pool for Tue 27 Oct, or asking nearby players from the MatchTime player pool for Thu 29 Oct\?/);
    expect(confirmQuestion("en", [TEAMS, FEE, POOL])).toBe(
      "Which one is that YES for: the proposed teams for Tue 27 Oct, the free place for Bilal on Tue 27 Oct, or asking nearby players from the MatchTime player pool for Tue 27 Oct? Reply YES to that message.",
    );
    expect(confirmQuestion("tr", [TEAMS, POOL])).toBe(
      "Bu EVET hangisi için: Tue 27 Oct için önerilen takımlar mı, Tue 27 Oct maçı için MatchTime oyuncu havuzundaki yakın oyunculara sormak mı? O mesaja EVET diye cevap verin.",
    );
  });
});
