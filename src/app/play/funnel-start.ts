/**
 * When the /play funnel counts "started" (2026-11-06), the pure half of
 * `funnel-beacon.tsx`. No DOM of its own: it reads only what it is handed.
 *
 * WHY. Until 6 November 2026 the first focus, change or tap inside the form
 * counted. That morning the Facebook posts linking matchtime.ai/play?src=fb
 * went up and the counter read 17 opened and 17 started for "fb": all 34
 * beacons inside 34 seconds, in two bursts, none after. An automated scanner
 * that runs script and focuses or clicks the form, not 17 people.
 *
 * THE RULE. Started is the first INPUT or CHANGE event that
 *   - is trusted (`isTrusted`: the browser made it for a person's key, tap
 *     or pick; a script's `dispatchEvent` never is),
 *   - lands on a control a person fills in, inside the form (a text field,
 *     a select, a textarea, a tick box or radio; not a button, the submit or
 *     a hidden field),
 *   - for a tick box or radio, came from a trusted CLICK on that same box.
 *     Chromium marks the input and change after a script's `box.click()`
 *     trusted (checked 2026-11-06), but the click itself is not; a person's
 *     tap, a click on its label and the space bar all arrive as a trusted
 *     click on the box,
 *   - and left that control holding something other than what it held when
 *     the beacon first saw it (on its first focus). A control never focused
 *     has nothing to compare with, and a trusted input or change there is
 *     the browser saying its value changed (a tap on a tick box in Safari
 *     focuses nothing).
 * Focus alone and a bare click count nothing.
 */

/** What the rule reads of an event's target. */
interface ControlLike {
  tagName?: unknown;
  type?: unknown;
  value?: unknown;
  checked?: unknown;
  closest?: unknown;
}

const VALUE_CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
/** Inputs a person presses rather than fills in, or never sees. */
const NOT_FILLED_IN = new Set(["button", "submit", "reset", "image", "hidden"]);
const CHECKABLE = new Set(["checkbox", "radio"]);

/** A control a person fills in inside a form, read; null for anything else. */
function readControl(target: unknown): { value: string; checkable: boolean } | null {
  if (!target || typeof target !== "object") return null;
  const el = target as ControlLike;
  if (typeof el.tagName !== "string" || !VALUE_CONTROLS.has(el.tagName.toUpperCase())) return null;
  if (typeof el.closest !== "function" || !(el.closest as (s: string) => unknown).call(el, "form")) return null;
  const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
  if (NOT_FILLED_IN.has(type)) return null;
  if (CHECKABLE.has(type)) return { value: el.checked ? "ticked" : "unticked", checkable: true };
  return { value: typeof el.value === "string" ? el.value : "", checkable: false };
}

/**
 * What a control in the form holds now, as a string to compare: the value,
 * or for a tick box or radio whether it is ticked. Null for anything that
 * is not a control a person fills in inside a form.
 */
export function funnelControlValue(target: unknown): string | null {
  return readControl(target)?.value ?? null;
}

/** Why an event counts started or not; "counts" when it does. */
export type PersonEntryVerdict = "counts" | "not-input-or-change" | "untrusted" | "not-a-control" | "tick-without-trusted-click" | "value-unchanged";

/**
 * The rule below with its reason (2026-11-10, for the TEMPORARY /play debug
 * diagnostic in `funnel-debug.ts`): `isPersonEntry` is exactly `=== "counts"`.
 */
export function personEntryVerdict(
  e: { type: string; isTrusted: boolean; target: unknown },
  seen: { before?: string; clickTrusted?: boolean },
): PersonEntryVerdict {
  if (e.type !== "input" && e.type !== "change") return "not-input-or-change";
  if (!e.isTrusted) return "untrusted";
  const now = readControl(e.target);
  if (!now) return "not-a-control";
  if (now.checkable && seen.clickTrusted !== true) return "tick-without-trusted-click";
  return seen.before === undefined || now.value !== seen.before ? "counts" : "value-unchanged";
}

/**
 * Is this the event that counts started? What the beacon saw of the control
 * before it: `before`, what it held on its first focus (undefined if never
 * focused); `clickTrusted`, whether the latest click on THIS control was a
 * person's (undefined if there was none).
 */
export function isPersonEntry(
  e: { type: string; isTrusted: boolean; target: unknown },
  seen: { before?: string; clickTrusted?: boolean },
): boolean {
  return personEntryVerdict(e, seen) === "counts";
}
