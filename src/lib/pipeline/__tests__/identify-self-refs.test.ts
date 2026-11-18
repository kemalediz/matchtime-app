/**
 * WHO IS LOOKED UP (`identify-batch.ts` `factRefs`, `identifyRefs`), review
 * of #628 (2026-11-18). The lookup skipped every word on the self list,
 * "bana" included, so in a club with a member called Bana she was never
 * looked up and could never be the subject. A self word that is also a
 * member's name or alias is looked up now (`isSelfRefAmong`). Pure, plus a
 * recording picker. Made-up people.
 */
import { describe, expect, it } from "vitest";
import { factRefs, identifyRefs } from "../identify-batch";
import type { Facts } from "../types";

const question = (personRef: string) => ({ kind: "question", topic: "other", personRef }) as unknown as Facts;
const WITH_BANA = [{ userId: "u-bana", name: "Bana Kaya" }, { userId: "u-bruno", name: "Bruno Carr" }];
const NO_BANA = [{ userId: "u-bruno", name: "Bruno Carr" }];

describe("factRefs", () => {
  it("'bana' beside a member called Bana is looked up", () => {
    expect(factRefs(question("bana"), null, null, WITH_BANA)).toEqual(["bana"]);
  });
  it("'bana' with no Bana is the sender, not looked up", () => {
    expect(factRefs(question("bana"), null, null, NO_BANA)).toEqual([]);
  });
  it("UNCHANGED: no roster given, the plain self list", () => {
    expect(factRefs(question("bana"))).toEqual([]);
    expect(factRefs(question("Bruno"))).toEqual(["Bruno"]);
  });
});

describe("identifyRefs", () => {
  const recording = () => {
    const asked: string[][] = [];
    const picker = async (req: { messages: Array<{ refs: string[] }> }) => {
      asked.push(req.messages[0].refs);
      return { picks: new Map(), degradations: [] };
    };
    return { asked, picker: picker as never };
  };
  it("'Bana' beside a member called Bana is asked about", async () => {
    const { asked, picker } = recording();
    await identifyRefs({ picker, refs: ["Bana"], body: "Bana?", author: "Bruno Carr", senderUserId: "u-bruno", roster: WITH_BANA });
    expect(asked).toEqual([["Bana"]]);
  });
  it("'bana' with no Bana: nobody is asked about", async () => {
    const { asked, picker } = recording();
    await identifyRefs({ picker, refs: ["bana"], body: "bana?", author: "Bruno Carr", senderUserId: "u-bruno", roster: NO_BANA });
    expect(asked).toEqual([]);
  });
});
