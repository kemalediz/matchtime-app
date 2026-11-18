/**
 * MAN OF THE MATCH ON THE WEB (review of #608, round 2): the dashboard, the
 * matches list, the match page and the admin stats read the same decision
 * as the group (`decideMom`). A decided match shows its credited winner
 * (with the announced votes when the post's tally is stored); an open or
 * still-to-be-posted match shows no leader and no counts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { momWebLine, momWebView } from "../mom-web";
import type { MomMatchDecision } from "../mom-records";

const at = new Date("2026-11-03T20:00:00Z");
const pete = { userId: "u-p", name: "Pete" };
const dan = { userId: "u-d", name: "Dan" };
const told = (mom: Record<string, unknown>, credit = [pete]): MomMatchDecision => ({
  date: at,
  decision: { kind: "told", mom: { tally: [], votes: null, pickedByOrganisers: false, winners: credit, told: "winner-only", ...mom } as never, credit },
  credit,
});
const pending = (state: "voting" | "closed" | "undecided", toBePosted = true): MomMatchDecision => ({ date: at, decision: { kind: "pending", state, toBePosted }, credit: [] });

describe("momWebView", () => {
  it("an announced vote: the winner, the announced votes, and who else got votes as announced", () => {
    const v = momWebView(
      told({ told: "announced", votes: { top: 3, total: 5 }, tally: [{ userId: "u-p", name: "Pete", votes: 3 }, { userId: "u-d", name: "Dan", votes: 2 }] }),
    );
    expect(v).toEqual({ kind: "decided", winners: ["Pete"], picked: false, votes: { top: 3, total: 5 }, others: [{ name: "Dan", votes: 2 }] });
  });

  it("the winner only, with no counts", () => {
    expect(momWebView(told({}))).toEqual({ kind: "decided", winners: ["Pete"], picked: false, votes: null, others: [] });
  });

  it("open, undecided, closed or posted with no copy: no leader, no counts", () => {
    expect(momWebView(pending("voting"))).toEqual({ kind: "open" });
    expect(momWebView(pending("undecided", false))).toEqual({ kind: "open" });
    expect(momWebView(pending("closed", true))).toEqual({ kind: "closed", toBePosted: true });
    expect(momWebView(told({ told: "posted-unrecorded", winners: [] }, []))).toEqual({ kind: "posted" });
    // An organisers' pick still to be posted: never "Voting open" (there is no vote), never the name.
    expect(momWebView(pending("picked" as never, true))).toEqual({ kind: "picked" });
  });

  it("no votes: nothing", () => {
    expect(momWebView(undefined)).toBeNull();
    expect(momWebView({ date: at, decision: { kind: "none" }, credit: [] })).toBeNull();
  });
});

describe("momWebLine, English and Turkish", () => {
  it("decided", () => {
    expect(momWebLine(momWebView(told({ told: "announced", votes: { top: 3, total: 5 } })), "en")).toBe("Pete (3 of 5 votes)");
    expect(momWebLine(momWebView(told({ told: "announced", votes: { top: 3, total: 5 } })), "tr")).toBe("Pete (3/5 oy)");
    expect(momWebLine(momWebView(told({})), "en")).toBe("Pete");
    expect(momWebLine(momWebView(told({ pickedByOrganisers: true })), "en")).toBe("Pete (picked by the organisers)");
    expect(momWebLine(momWebView(told({ pickedByOrganisers: true })), "tr")).toBe("Pete (organizatörler seçti)");
    expect(momWebLine(momWebView(told({ told: "announced", votes: { top: 2, total: 4 } }, [dan, pete])), "en")).toBe("Shared between Dan and Pete (2 votes each)");
    expect(momWebLine(momWebView(told({}, [dan, pete])), "tr")).toBe("Dan ve Pete paylaştı");
  });

  it("not decided: a status, never a name or a count", () => {
    expect(momWebLine(momWebView(pending("voting")), "en")).toBe("Voting open");
    expect(momWebLine(momWebView(pending("voting")), "tr")).toBe("Oylama sürüyor");
    expect(momWebLine(momWebView(pending("closed", true)), "en")).toBe("Voting closed, the result will be posted in the group");
    expect(momWebLine(momWebView(pending("closed", false)), "en")).toBe("Voting closed");
    expect(momWebLine(momWebView(pending("closed", false)), "tr")).toBe("Oylama kapandı");
    expect(momWebLine(momWebView(told({ told: "posted-unrecorded", winners: [] }, [])), "en")).toBe("Result posted in the group");
    expect(momWebLine(momWebView(told({ told: "posted-unrecorded", winners: [] }, [])), "tr")).toBe("Sonuç grupta paylaşıldı");
    expect(momWebLine(momWebView(pending("picked" as never, true)), "en")).toBe("Picked by the organisers, to be posted in the group");
    expect(momWebLine(momWebView(pending("picked" as never, true)), "tr")).toBe("Organizatörler seçti, grupta paylaşılacak");
    expect(momWebLine(null, "en")).toBeNull();
  });

  it("the admin column is labelled as wins, with what it counts, in both languages", async () => {
    const { momWebCopy } = await import("../i18n/mom-web");
    expect(momWebCopy("en").wins(0)).toBe("0 MoM wins");
    expect(momWebCopy("en").wins(1)).toBe("1 MoM win");
    expect(momWebCopy("tr").wins(2)).toBe("2 kez maçın adamı");
    expect(momWebCopy("en").winsNote).toMatch(/decided results only/);
    expect(momWebCopy("tr").winsNote).toMatch(/kesinleşmiş sonuçları/);
    for (const l of ["en", "tr"]) expect(momWebCopy(l).winsNote).not.toMatch(/[—–]/);
  });

  it("no long dashes, no slashes as separators in English", () => {
    const lines = [momWebLine(momWebView(pending("closed", true)), "en"), momWebLine(momWebView(told({ told: "announced", votes: { top: 1, total: 1 } })), "en")];
    for (const l of lines) expect(l).not.toMatch(/[—–/]/);
    expect(momWebLine(momWebView(told({ told: "announced", votes: { top: 1, total: 1 } })), "en")).toBe("Pete (1 of 1 vote)");
  });
});
