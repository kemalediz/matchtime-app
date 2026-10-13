"use client";

/**
 * THE VENUE BOX WITH SUGGESTIONS (2026-10-13). A text input that, as the
 * organiser types, shows a short list of real places; tapping one puts
 * its name in the box and remembers which place it was. Used on
 * /create-org and, on /admin/activities, in the new game, edit game and
 * Change boxes.
 *
 * SUGGESTIONS ARE A HELPER, NEVER A GATE. This is an ordinary text input
 * first: whatever is typed is the value, the form submits it, and the
 * list can be ignored. Every failure (signed out, over the cap, Google
 * slow or down, a bad answer, no network) simply shows no list. Nothing
 * here can stop a form being submitted.
 *
 * A PICK LASTS ONLY WHILE THE TEXT IS UNTOUCHED. Picking calls
 * `onChange(name, pick)`; any keystroke afterwards calls
 * `onChange(text, null)`, so the pick is dropped and it is free text
 * again. The form sends the pick through `pickForSubmit`
 * (venue-suggest-rules.ts), which checks the same thing once more.
 *
 * NOTHING ABOUT THE PLACE IS TRUSTED FROM HERE. A pick is Google's place
 * id and the session token; the server asks Google where the place is.
 *
 * No Google script and no key in the browser: the list comes from
 * /api/venue/suggest. At least three characters, 300 ms after the last
 * keystroke, and a request that is no longer wanted is aborted.
 *
 * ACCESSIBLE COMBOBOX (WAI-ARIA 1.2, list autocomplete): the input is
 * `role="combobox"`, the list a `listbox` of `option`s, the highlighted
 * one is `aria-activedescendant`. Down and Up move, Enter picks the
 * highlighted one (and only then: Enter with nothing highlighted submits
 * the form as usual), Escape closes. The count is announced politely.
 *
 * NO PAGE SHIFT: the list is absolutely positioned over what is below
 * the box. Nothing is added to or removed from the layout when it opens.
 *
 * The foot of the list carries Google's attribution, which its terms
 * require wherever predictions are shown without a map.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { VenueSuggestLabels } from "@/lib/venue-suggest-labels";
import {
  VENUE_SUGGEST_DEBOUNCE_MS,
  VENUE_SUGGEST_MAX,
  shouldSuggest,
  type VenuePickState,
  type VenueSuggestion,
} from "@/lib/venue-suggest-rules";

/** A session token: Google wants at most 36 URL-safe characters. */
function newSessionToken(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }
}

/** Only well-formed suggestions are shown, whatever the route answered. */
function readSuggestions(body: unknown): VenueSuggestion[] {
  const list = (body as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) return [];
  const out: VenueSuggestion[] = [];
  for (const raw of list) {
    const s = raw as Partial<VenueSuggestion> | null;
    if (!s || typeof s.placeId !== "string" || typeof s.primary !== "string" || !s.primary) continue;
    out.push({ placeId: s.placeId, primary: s.primary, secondary: typeof s.secondary === "string" ? s.secondary : "" });
    if (out.length === VENUE_SUGGEST_MAX) break;
  }
  return out;
}

export function VenueSuggestInput(props: {
  id?: string;
  value: string;
  /** Typed text arrives with `null`; a picked suggestion with its pick. */
  onChange: (text: string, pick: VenuePickState | null) => void;
  /** The language suggestions are asked for in. */
  lang: string | null | undefined;
  labels: VenueSuggestLabels;
  /** Classes for the input itself (each form keeps its own look). */
  className?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
}) {
  const { onChange, lang, maxLength } = props;
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const [suggestions, setSuggestions] = useState<VenueSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const token = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  /** Counts requests, so only the newest answer is ever shown. */
  const seq = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    inFlight.current?.abort();
    inFlight.current = null;
    seq.current += 1;
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Leaving the page: nothing is left running.
  useEffect(() => cancel, [cancel]);

  const ask = useCallback(
    async (text: string, mine: number) => {
      const controller = new AbortController();
      inFlight.current = controller;
      token.current ??= newSessionToken();
      let found: VenueSuggestion[] = [];
      try {
        const qs = new URLSearchParams({ q: text, session: token.current, lang: lang ?? "en" });
        const res = await fetch(`/api/venue/suggest?${qs.toString()}`, { signal: controller.signal, cache: "no-store" });
        if (res.ok) found = readSuggestions(await res.json());
      } catch {
        // Aborted, offline or a bad answer: no list, and the box carries on.
      }
      if (seq.current !== mine) return;
      inFlight.current = null;
      setSuggestions(found);
      setActive(-1);
      setOpen(found.length > 0);
    },
    [lang],
  );

  function typed(text: string) {
    onChange(text, null);
    cancel();
    if (!shouldSuggest(text)) {
      setSuggestions([]);
      close();
      return;
    }
    const mine = seq.current;
    timer.current = setTimeout(() => void ask(text, mine), VENUE_SUGGEST_DEBOUNCE_MS);
  }

  function pick(s: VenueSuggestion) {
    cancel();
    const text = maxLength ? s.primary.slice(0, maxLength) : s.primary;
    onChange(text, { placeId: s.placeId, sessionToken: token.current ?? newSessionToken(), text });
    // The session ends with the pick: more typing starts a new one.
    token.current = null;
    setSuggestions([]);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : suggestions.length - 1);
        return;
      }
      const n = suggestions.length;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (e.key === "Enter") {
      // Only a highlighted suggestion is picked. Otherwise Enter is the
      // form's, as in any text box.
      if (open && active >= 0 && suggestions[active]) {
        e.preventDefault();
        pick(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
  }

  const showing = open && suggestions.length > 0;

  return (
    <div className="relative">
      <input
        id={props.id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing && active >= 0 ? optionId(active) : undefined}
        aria-describedby={props.describedBy}
        autoComplete="off"
        value={props.value}
        onChange={(e) => typed(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={close}
        placeholder={props.placeholder}
        required={props.required}
        minLength={props.minLength}
        maxLength={maxLength}
        disabled={props.disabled}
        data-testid={props.testId}
        className={props.className}
      />
      {showing && (
        <div
          data-testid="venue-suggest-popup"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-lg"
        >
          <ul id={listId} role="listbox" aria-label={props.labels.list} className="max-h-60 overflow-y-auto py-1">
            {suggestions.map((s, i) => (
              <li
                key={s.placeId}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // Keeps the focus in the box, so the tap is not lost to a blur.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseEnter={() => setActive(i)}
                className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1.5 ${i === active ? "bg-blue-50" : "bg-white"}`}
              >
                <span className="block break-words text-sm font-medium text-slate-800">{s.primary}</span>
                {s.secondary && <span className="block break-words text-xs text-slate-500">{s.secondary}</span>}
              </li>
            ))}
          </ul>
          <p data-testid="venue-suggest-attribution" className="border-t border-slate-100 px-3 py-1.5 text-right text-[11px] text-slate-500">
            {props.labels.powered}
          </p>
        </div>
      )}
      <span role="status" aria-live="polite" data-testid="venue-suggest-status" className="sr-only">
        {showing ? (props.labels.counts[suggestions.length - 1] ?? "") : ""}
      </span>
    </div>
  );
}
