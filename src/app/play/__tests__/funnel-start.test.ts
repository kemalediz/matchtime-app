/**
 * When the /play funnel counts "started" (2026-11-06). On 6 November 2026
 * a scanner opened matchtime.ai/play?src=fb 17 times in 34 seconds and
 * focused or clicked the form each time, so "started" read 17 out of 17.
 * Now only a person entering something counts: the first TRUSTED input or
 * change on a form control whose value really changed. Focus alone, a bare
 * click and a script's synthetic event count nothing.
 */
import { describe, expect, it } from "vitest";
import { funnelControlValue, isPersonEntry, personEntryVerdict } from "../funnel-start";

/** A stand-in for a DOM control: only what the rule reads. */
function control(tagName: string, props: { type?: string; value?: string; checked?: boolean; inForm?: boolean } = {}) {
  const { inForm = true, ...rest } = props;
  return { tagName, ...rest, closest: (sel: string) => (sel === "form" && inForm ? {} : null) };
}
const NAME = () => control("INPUT", { type: "text", value: "" });

describe("funnelControlValue: what a control holds, or null when it is not one a person fills in", () => {
  it("a text field, a select and a textarea: their value", () => {
    expect(funnelControlValue(control("INPUT", { type: "text", value: "Sam" }))).toBe("Sam");
    expect(funnelControlValue(control("INPUT", { value: "SM1" }))).toBe("SM1");
    expect(funnelControlValue(control("SELECT", { value: "mon" }))).toBe("mon");
    expect(funnelControlValue(control("TEXTAREA", { value: "" }))).toBe("");
  });

  it("a tick box or a radio: whether it is ticked, so a toggle is a change", () => {
    const off = funnelControlValue(control("INPUT", { type: "checkbox", value: "on", checked: false }));
    const on = funnelControlValue(control("INPUT", { type: "checkbox", value: "on", checked: true }));
    expect(off).not.toBeNull();
    expect(on).not.toBe(off);
    expect(funnelControlValue(control("INPUT", { type: "radio", value: "a", checked: true }))).not.toBe(
      funnelControlValue(control("INPUT", { type: "radio", value: "a", checked: false })),
    );
  });

  it("a button, the submit, a hidden field, a heading, or a field outside the form: null", () => {
    expect(funnelControlValue(control("BUTTON"))).toBeNull();
    for (const type of ["submit", "button", "reset", "image", "hidden"]) expect(funnelControlValue(control("INPUT", { type }))).toBeNull();
    expect(funnelControlValue(control("H1"))).toBeNull();
    expect(funnelControlValue(control("INPUT", { type: "text", value: "x", inForm: false }))).toBeNull();
    expect(funnelControlValue(null)).toBeNull();
    expect(funnelControlValue({})).toBeNull();
  });
});

describe("isPersonEntry: the event that counts started", () => {
  const TICKED = control("INPUT", { type: "checkbox", checked: true });
  const UNTICKED = funnelControlValue(control("INPUT", { type: "checkbox", checked: false }))!;

  it("focus alone, and a bare click, never count, trusted or not", () => {
    for (const type of ["focus", "focusin", "click", "pointerdown", "keydown"]) {
      expect(isPersonEntry({ type, isTrusted: true, target: NAME() }, {})).toBe(false);
      expect(isPersonEntry({ type, isTrusted: true, target: NAME() }, { before: "", clickTrusted: true })).toBe(false);
    }
  });

  it("a trusted input or change whose value changed counts: typing a character, choosing an option", () => {
    expect(isPersonEntry({ type: "input", isTrusted: true, target: control("INPUT", { type: "text", value: "S" }) }, { before: "" })).toBe(true);
    expect(isPersonEntry({ type: "change", isTrusted: true, target: control("SELECT", { value: "tue" }) }, { before: "mon" })).toBe(true);
  });

  it("a trusted change on a text field never focused counts (nothing to compare with)", () => {
    expect(isPersonEntry({ type: "input", isTrusted: true, target: control("INPUT", { type: "text", value: "S" }) }, {})).toBe(true);
  });

  it("ticking a box counts when the click that ticked it was a person's, focused or not (a tap in Safari focuses nothing)", () => {
    expect(isPersonEntry({ type: "change", isTrusted: true, target: TICKED }, { before: UNTICKED, clickTrusted: true })).toBe(true);
    expect(isPersonEntry({ type: "input", isTrusted: true, target: TICKED }, { clickTrusted: true })).toBe(true);
  });

  it("a box ticked by a script's click() never counts, though the browser marks its input and change trusted", () => {
    expect(isPersonEntry({ type: "input", isTrusted: true, target: TICKED }, { before: UNTICKED, clickTrusted: false })).toBe(false);
    expect(isPersonEntry({ type: "change", isTrusted: true, target: TICKED }, { clickTrusted: false })).toBe(false);
  });

  it("a box whose ticking click was never seen counts nothing (every real tick comes through a click)", () => {
    expect(isPersonEntry({ type: "change", isTrusted: true, target: TICKED }, { before: UNTICKED })).toBe(false);
  });

  it("a script's synthetic event never counts, even when it changed the value", () => {
    expect(isPersonEntry({ type: "input", isTrusted: false, target: control("INPUT", { type: "text", value: "bot" }) }, { before: "" })).toBe(false);
    expect(isPersonEntry({ type: "change", isTrusted: false, target: TICKED }, { clickTrusted: true })).toBe(false);
  });

  it("a trusted event that left the value as it was counts nothing", () => {
    expect(isPersonEntry({ type: "change", isTrusted: true, target: control("INPUT", { type: "text", value: "Sam" }) }, { before: "Sam" })).toBe(false);
    expect(isPersonEntry({ type: "change", isTrusted: true, target: control("INPUT", { type: "checkbox", checked: false }) }, { before: UNTICKED, clickTrusted: true })).toBe(
      false,
    );
  });

  it("an input or change on something that is not a form control a person fills in counts nothing", () => {
    expect(isPersonEntry({ type: "change", isTrusted: true, target: control("INPUT", { type: "text", value: "x", inForm: false }) }, { before: "" })).toBe(false);
    expect(isPersonEntry({ type: "input", isTrusted: true, target: control("BUTTON") }, { clickTrusted: true })).toBe(false);
  });
});

describe("personEntryVerdict: why an event counts or not (the /play debug diagnostic, 2026-11-10)", () => {
  it("names each reason, and counts exactly when isPersonEntry does", () => {
    const TEXT = (value: string) => control("INPUT", { type: "text", value });
    const cases: Array<[Parameters<typeof personEntryVerdict>[0], Parameters<typeof personEntryVerdict>[1], string]> = [
      [{ type: "input", isTrusted: true, target: TEXT("S") }, { before: "" }, "counts"],
      [{ type: "focusin", isTrusted: true, target: TEXT("S") }, {}, "not-input-or-change"],
      [{ type: "input", isTrusted: false, target: TEXT("S") }, { before: "" }, "untrusted"],
      [{ type: "input", isTrusted: true, target: control("BUTTON") }, {}, "not-a-control"],
      [{ type: "change", isTrusted: true, target: control("INPUT", { type: "checkbox", checked: true }) }, {}, "tick-without-trusted-click"],
      [{ type: "change", isTrusted: true, target: TEXT("Sam") }, { before: "Sam" }, "value-unchanged"],
    ];
    for (const [e, seen, why] of cases) {
      expect(personEntryVerdict(e, seen)).toBe(why);
      expect(isPersonEntry(e, seen)).toBe(why === "counts");
    }
  });
});
