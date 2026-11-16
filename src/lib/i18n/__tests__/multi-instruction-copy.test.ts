/**
 * The line naming a part of a several-instruction message that was not
 * done (2026-11-16): house rules, and one part read apart from several.
 */
import { describe, expect, it } from "vitest";
import { multiInstructionCopy } from "../multi-instruction";

describe("multi-instruction copy", () => {
  const en = multiInstructionCopy("en");
  const tr = multiInstructionCopy("tr");

  it("no em or en dash, no slash, in either language", () => {
    const all = [
      ...Object.values(en.part),
      ...Object.values(tr.part),
      en.notDone({ parts: "x", count: 1 }),
      en.notDone({ parts: "x", count: 2 }),
      tr.notDone({ parts: "x", count: 1 }),
      tr.notDone({ parts: "x", count: 2 }),
    ];
    for (const s of all) expect(s).not.toMatch(/[–—/]/);
  });

  it("Turkish is never the English", () => {
    for (const k of Object.keys(en.part) as Array<keyof typeof en.part>) expect(tr.part[k]).not.toBe(en.part[k]);
    for (const count of [1, 2]) expect(tr.notDone({ parts: "x", count })).not.toBe(en.notDone({ parts: "x", count }));
  });

  it("one part reads apart from several, in both languages", () => {
    expect(en.notDone({ parts: "x", count: 1 })).toContain("this part");
    expect(en.notDone({ parts: "x", count: 2 })).toContain("these parts");
    expect(tr.notDone({ parts: "x", count: 1 })).toContain("şu kısmı");
    expect(tr.notDone({ parts: "x", count: 2 })).toContain("şu kısımları");
  });

  it("joins the parts naturally", () => {
    expect(en.join(["a"])).toBe("a");
    expect(en.join(["a", "b", "c"])).toBe("a, b and c");
    expect(tr.join(["a", "b"])).toBe("a ve b");
  });
});
