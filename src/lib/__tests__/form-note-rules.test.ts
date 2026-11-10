/**
 * A FORM NOTE SAYS ITS AMOUNT, AND CAN BE CHANGED (Kemal, 2026-11-10).
 *
 * "It would be nice if it tells explicitly how much rating adjustment it
 * made (not giving the final rating) so if I don't like it, I can get it
 * amended further."
 *
 * The pure rules: the clamp, who may set a note for whom (from the sender
 * and the roles, never from the words), what is stored, the line MatchTime
 * says, and that a stored note wins over the rating adjuster's delta.
 */
import { describe, it, expect } from "vitest";
import {
  clampFormDelta,
  formatFormDelta,
  formNoteReason,
  formNoteSavedReply,
  formNotesWin,
  mayStoreFormNote,
  planFormNotes,
} from "../form-note-rules";
import { MAX_DELTA } from "../form-scale";

const EM_DASH = String.fromCharCode(0x2014);

describe("clampFormDelta", () => {
  it("keeps an amount inside plus or minus 1, to two decimals", () => {
    expect(clampFormDelta(-0.5)).toEqual({ delta: -0.5, clamped: false });
    expect(clampFormDelta(-0.25)).toEqual({ delta: -0.25, clamped: false });
    expect(clampFormDelta(1)).toEqual({ delta: 1, clamped: false });
    expect(clampFormDelta(0.333)).toEqual({ delta: 0.33, clamped: false });
  });

  it("clamps an amount past the cap, and says it did", () => {
    expect(MAX_DELTA).toBe(1);
    expect(clampFormDelta(-3)).toEqual({ delta: -1, clamped: true });
    expect(clampFormDelta(2)).toEqual({ delta: 1, clamped: true });
  });

  it("reads anything that is not a finite number as no adjustment", () => {
    expect(clampFormDelta(Number.NaN)).toEqual({ delta: 0, clamped: false });
    expect(clampFormDelta("x" as unknown as number)).toEqual({ delta: 0, clamped: false });
    expect(clampFormDelta(-0)).toEqual({ delta: 0, clamped: false });
  });
});

describe("mayStoreFormNote: from who sent it and their role, never from the words", () => {
  it("a player, for themselves", () => {
    expect(mayStoreFormNote({ userId: "u-kemal", isOrganiser: false }, "u-kemal")).toBe(true);
  });
  it("a player, for somebody else: no", () => {
    expect(mayStoreFormNote({ userId: "u-kemal", isOrganiser: false }, "u-tom")).toBe(false);
  });
  it("an organiser, for anybody", () => {
    expect(mayStoreFormNote({ userId: "u-org", isOrganiser: true }, "u-tom")).toBe(true);
  });
  it("an unknown sender, for nobody", () => {
    expect(mayStoreFormNote({ userId: null, isOrganiser: false }, "u-tom")).toBe(false);
  });
});

describe("planFormNotes", () => {
  const ids: Record<string, string> = { tom: "u-tom", kemal: "u-kemal", ali: "u-ali" };
  const userIdOf = (ref: string) => ids[ref.toLowerCase()] ?? null;

  it("'me' is the sender: stored, the amount clamped", () => {
    const p = planFormNotes({
      claims: [{ personRef: "me", delta: -2, reason: "tired" }],
      sender: { userId: "u-kemal", isOrganiser: false },
      userIdOf,
    });
    expect(p).toEqual({ store: [{ userId: "u-kemal", delta: -1, clamped: true, reason: "tired" }], others: 0 });
  });

  it("a player about another player: acknowledged, nothing stored", () => {
    const p = planFormNotes({
      claims: [{ personRef: "Tom", delta: -1, reason: "bad knee" }],
      sender: { userId: "u-kemal", isOrganiser: false },
      userIdOf,
    });
    expect(p).toEqual({ store: [], others: 1 });
  });

  it("an organiser about another player: stored", () => {
    const p = planFormNotes({
      claims: [{ personRef: "Tom", delta: -1, reason: "bad knee" }],
      sender: { userId: "u-org", isOrganiser: true },
      userIdOf,
    });
    expect(p.store).toEqual([{ userId: "u-tom", delta: -1, clamped: false, reason: "bad knee" }]);
  });

  it("a name nobody is sure of is never stored", () => {
    const p = planFormNotes({
      claims: [{ personRef: "Zed", delta: -1, reason: "ill" }],
      sender: { userId: "u-org", isOrganiser: true },
      userIdOf,
    });
    expect(p).toEqual({ store: [], others: 1 });
  });

  it("the same person twice: the last amount", () => {
    const p = planFormNotes({
      claims: [
        { personRef: "me", delta: -0.5, reason: "tired" },
        { personRef: "Kemal", delta: -1, reason: "" },
      ],
      sender: { userId: "u-kemal", isOrganiser: false },
      userIdOf,
    });
    expect(p.store).toEqual([{ userId: "u-kemal", delta: -1, clamped: false, reason: "" }]);
  });

  it("a reason is trimmed, short and free of long dashes", () => {
    const p = planFormNotes({
      claims: [{ personRef: "me", delta: -0.5, reason: `  tired ${EM_DASH} long shift ${"x".repeat(200)}` }],
      sender: { userId: "u-kemal", isOrganiser: false },
      userIdOf,
    });
    const reason = p.store[0]!.reason;
    expect(reason.length).toBeLessThanOrEqual(80);
    expect(reason).not.toMatch(/[–—]/);
    expect(reason.startsWith("tired")).toBe(true);
  });
});

describe("formatFormDelta", () => {
  it("signs every amount and drops trailing zeros", () => {
    expect(formatFormDelta(-0.5, "en")).toBe("-0.5");
    expect(formatFormDelta(0.5, "en")).toBe("+0.5");
    expect(formatFormDelta(-1, "en")).toBe("-1");
    expect(formatFormDelta(-0.25, "en")).toBe("-0.25");
  });
  it("Turkish writes a decimal comma", () => {
    expect(formatFormDelta(-0.5, "tr")).toBe("-0,5");
    expect(formatFormDelta(1, "tr")).toBe("+1");
  });
});

describe("formNoteSavedReply: the amount, never a rating", () => {
  const one = (o: Partial<{ name: string; delta: number; reason: string; changed: boolean; clamped: boolean }> = {}) => ({
    name: "Kemal",
    delta: -0.5,
    reason: "tired",
    changed: false,
    clamped: false,
    ...o,
  });

  it("a new note: the amount, the player, the game, and how to change it", () => {
    expect(formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: false, saved: [one()], othersToo: false })).toBe(
      "Noted: -0.5 for Kemal (tired) in Tuesday's game. Want a different amount? Tag me, e.g. make it -1.",
    );
  });

  it("a new note at -1 suggests a different amount", () => {
    expect(
      formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: false, saved: [one({ delta: -1, reason: "ill" })], othersToo: false }),
    ).toBe("Noted: -1 for Kemal (ill) in Tuesday's game. Want a different amount? Tag me, e.g. make it -0.5.");
  });

  it("a change says so, with no hint", () => {
    expect(
      formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: false, saved: [one({ delta: -1, changed: true })], othersToo: false }),
    ).toBe("Changed: -1 for Kemal (tired) in Tuesday's game.");
  });

  it("a cancel is no adjustment", () => {
    expect(
      formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: false, saved: [one({ delta: 0, reason: "", changed: true })], othersToo: false }),
    ).toBe("Changed: no adjustment for Kemal in Tuesday's game.");
  });

  it("an amount past the cap says 1 is the most", () => {
    expect(
      formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: false, saved: [one({ delta: -1, changed: true, clamped: true })], othersToo: false }),
    ).toBe("Changed: -1 for Kemal (tired) in Tuesday's game. 1 is the most either way.");
  });

  it("teams already made: it counts if they are made again", () => {
    expect(formNoteSavedReply({ lang: "en", dayName: "Tuesday", teamsMade: true, saved: [one()], othersToo: false })).toBe(
      "Noted: -0.5 for Kemal (tired) in Tuesday's game. The teams are already made, so it counts if they are made again. Want a different amount? Tag me, e.g. make it -1.",
    );
  });

  it("two players and talk about another", () => {
    expect(
      formNoteSavedReply({
        lang: "en",
        dayName: "Friday",
        teamsMade: false,
        saved: [one({ name: "Tom", delta: -1, reason: "bad knee" }), one({ name: "Ali", delta: 0.5, reason: "scored four" })],
        othersToo: true,
      }),
    ).toBe(
      "Noted: -1 for Tom (bad knee) and +0.5 for Ali (scored four) in Friday's game. What was said about anyone else I'll take into account when the teams are made. Want a different amount? Tag me, e.g. make it -0.5.",
    );
  });

  it("Turkish", () => {
    expect(formNoteSavedReply({ lang: "tr", dayName: "Salı", teamsMade: false, saved: [one({ reason: "yorgun" })], othersToo: false })).toBe(
      'Not aldım: Salı maçında Kemal için -0,5 (yorgun). Farklı bir miktar mı istersiniz? Beni etiketleyip yazın, örneğin "-1 yap".',
    );
    expect(
      formNoteSavedReply({ lang: "tr", dayName: "Salı", teamsMade: true, saved: [one({ delta: 0, reason: "", changed: true })], othersToo: false }),
    ).toBe("Değiştirdim: Salı maçında Kemal için puan ayarı yok. Takımlar zaten kuruldu; yeniden kurulursa geçerli olur.");
  });

  it("never a long dash or a slash as a separator, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const line = formNoteSavedReply({
        lang,
        dayName: "Tuesday",
        teamsMade: true,
        saved: [one({ clamped: true }), one({ name: "Tom", delta: 1 })],
        othersToo: true,
      });
      expect(line).not.toMatch(/[–—]/);
      expect(line).not.toMatch(/ \/ /);
    }
  });
});

describe("formNotesWin: a stored note beats the adjuster for that player", () => {
  const adj = (playerId: string, delta: number, reason = "from the chat") => ({ playerId, delta, reason, confidence: 0.8 });

  it("the note's amount and reason replace the adjuster's; everyone else keeps theirs", () => {
    const out = formNotesWin(
      new Map([
        ["u-kemal", adj("u-kemal", -1)],
        ["u-tom", adj("u-tom", -0.5)],
      ]),
      [{ userId: "u-kemal", delta: -0.25, reason: "tired" }],
      ["u-kemal", "u-tom"],
    );
    expect(out.get("u-kemal")).toEqual({ playerId: "u-kemal", delta: -0.25, reason: formNoteReason({ delta: -0.25, reason: "tired" }), confidence: 1 });
    expect(out.get("u-tom")).toEqual(adj("u-tom", -0.5));
  });

  it("a cancelled note (0) keeps the adjuster off that player", () => {
    const out = formNotesWin(new Map([["u-kemal", adj("u-kemal", -0.5)]]), [{ userId: "u-kemal", delta: 0, reason: "" }], ["u-kemal"]);
    expect(out.get("u-kemal")!.delta).toBe(0);
  });

  it("applies when the adjuster gave nothing at all (failed, or the AI cap)", () => {
    const out = formNotesWin(new Map(), [{ userId: "u-kemal", delta: -1, reason: "ill" }], ["u-kemal", "u-tom"]);
    expect(out.get("u-kemal")!.delta).toBe(-1);
    expect(out.has("u-tom")).toBe(false);
  });

  it("a note for somebody not playing changes nothing", () => {
    const out = formNotesWin(new Map(), [{ userId: "u-away", delta: -1, reason: "ill" }], ["u-kemal"]);
    expect(out.size).toBe(0);
  });

  it("clamps a stored amount again, in case a row was written by hand", () => {
    const out = formNotesWin(new Map(), [{ userId: "u-kemal", delta: -4, reason: "ill" }], ["u-kemal"]);
    expect(out.get("u-kemal")!.delta).toBe(-1);
  });

  it("the audit reason says it came from the note", () => {
    expect(formNoteReason({ delta: -0.5, reason: "tired" })).toBe("Form note in the chat: tired");
    expect(formNoteReason({ delta: 0, reason: "" })).toBe("Form note in the chat: no adjustment");
    expect(formNoteReason({ delta: -1, reason: "" })).toBe("Form note in the chat");
  });
});
