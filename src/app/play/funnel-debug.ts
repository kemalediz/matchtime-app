/**
 * TEMPORARY (2026-11-10): the /play funnel diagnostic. Remove it, with
 * `funnel-debug-batch.ts`, `funnel-debug-recorder.tsx` and POST
 * /api/play/debug, once the cause below is known.
 *
 * WHY. On Kemal's Android phone inside the Facebook app, /play loaded twice
 * at 12:08 on 10 November 2026, he typed a letter in "Your name", and no
 * beacon of any kind arrived (`funnel-beacon.tsx`). Desktop Chrome sends
 * both. This records what that browser really did, so the cause is a fact.
 *
 * ONLY WITH `?mtdebug=1` on the link. Without it `installFunnelDebug` returns
 * at once: no listener, no timer, no request, no storage read, and the
 * beacon's `funnelDebugNote` calls do nothing. The page renders the recorder
 * and the inline script only with the flag too (page.tsx). Nothing shows on
 * screen either way.
 *
 * WHAT IT RECORDS, each with `t` (ms since the page's navigation began):
 *   html     the inline script ran (the HTML ran script at all, before React);
 *   boot     this module ran (the page's JS loaded): the beacon's two
 *            sessionStorage keys for this link held or not, how many
 *            `mt-play-` keys, the draft (`mt.pool.signupDraft.v2`) present
 *            and its name length and days count, navigation type, ready
 *            and visibility state, prerendering, sendBeacon available;
 *   r:effect / b:effect  React committed (hydrated) the recorder / the beacon;
 *   focusin keydown beforeinput composition* input change click  in the
 *            CAPTURE phase on document, so they show even if React's own
 *            handlers never run: trusted or not, inputType, isComposing,
 *            the key's NAME ("char" for any character), the control's tag,
 *            type and name attribute, the value's LENGTH and whether it
 *            changed, never the value;
 *   b:*      the beacon's own steps: each focus it saw, each isPersonEntry
 *            verdict and why, each send() (key already held or not) and
 *            whether sendBeacon returned true;
 *   vis pagehide pageshow error  the page's life and any script error.
 * Batched to POST /api/play/debug every 2 s by fetch (keepalive), and at
 * once by sendBeacon when the page is hidden; each batch says how the last
 * send went (`prev`).
 */
import { SIGNUP_DRAFT_KEY } from "@/lib/pool/signup-draft";
import { readSignupSource } from "@/lib/pool/profile-fields";
import type { DebugRecord, DebugValue } from "./funnel-debug-batch";

export const FUNNEL_DEBUG_ENDPOINT = "/api/play/debug";
const PARAM = "mtdebug";
const EVENTS = ["focusin", "keydown", "beforeinput", "compositionstart", "compositionupdate", "compositionend", "input", "change", "click"];
const CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const CLICKED = new Set(["INPUT", "SELECT", "TEXTAREA", "LABEL", "BUTTON"]);
const CHECKABLE = new Set(["checkbox", "radio"]);
const PLAIN = /^[A-Za-z0-9_:.-]{1,40}$/;
const SID = /^[A-Za-z0-9]{6,32}$/;
const TICK_MS = 2000;
const PER_BATCH = 40;
/** Under the endpoint's 60 an hour, with the inline script's one. */
const MAX_BATCHES = 55;
const MAX_QUEUED = 600;

/** Is the diagnostic on for this page's query string (`location.search`)? Exactly `mtdebug=1`. */
export function funnelDebugOnSearch(search: string): boolean {
  try {
    const all = new URLSearchParams(search).getAll(PARAM);
    return all.length === 1 && all[0] === "1";
  } catch {
    return false;
  }
}

/** The same, read on the server from the page's search params. */
export function funnelDebugOnParams(params: Record<string, unknown>): boolean {
  return params[PARAM] === "1";
}

// ── The beacon's notes: a no-op until the recorder is installed ──────────

let sink: ((rec: DebugRecord) => void) | null = null;

/** A step the beacon took, for the diagnostic. Does nothing without `?mtdebug=1`. */
export function funnelDebugNote(rec: { k: string } & Record<string, DebugValue | undefined>): void {
  if (!sink) return;
  try {
    const clean: DebugRecord = { k: rec.k };
    for (const [name, value] of Object.entries(rec)) if (value !== undefined) clean[name] = value;
    sink(clean);
  } catch {
    // A diagnostic never breaks the page.
  }
}

export function funnelDebugActive(): boolean {
  return sink !== null;
}

export function resetFunnelDebugForTests(): void {
  sink = null;
}

// ── One event, summarised: never the text ───────────────────────────────

export interface DebugEventLike {
  type: string;
  isTrusted?: unknown;
  target?: unknown;
  inputType?: unknown;
  isComposing?: unknown;
  key?: unknown;
  keyCode?: unknown;
  data?: unknown;
  persisted?: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const plain = (x: unknown): string | undefined => (typeof x === "string" && PLAIN.test(x) ? x : undefined);

/**
 * What one event says, and what the control now holds (`value`, kept in
 * memory only to tell the next event whether it changed; never sent).
 * `last` is what the recorder saw this control hold the time before.
 */
export function summariseFunnelEvent(e: DebugEventLike, t: number, last: string | undefined): { rec: DebugRecord; value?: string } {
  const rec: DebugRecord = { t: Math.round(t), k: plain(e.type) ?? "other", tr: e.isTrusted === true };
  let value: string | undefined;
  const el = e.target;
  if (isObj(el) && typeof el.tagName === "string") {
    const tag = el.tagName.toUpperCase();
    if (plain(tag)) rec.tag = tag.slice(0, 10);
    if (CONTROLS.has(tag)) {
      const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
      if (plain(type)) rec.ty = type;
      const name = plain(el.name);
      if (name) rec.nm = name.slice(0, 24);
      rec.f = typeof el.closest === "function" ? !!(el.closest as (s: string) => unknown).call(el, "form") : false;
      if (CHECKABLE.has(type)) {
        rec.ck = el.checked === true;
        value = rec.ck ? "1" : "0";
      } else {
        value = typeof el.value === "string" ? el.value : "";
        rec.len = value.length;
        if (last !== undefined) rec.bl = last.length;
      }
      if (last !== undefined) rec.ch = value !== last;
    }
  }
  const inputType = plain(e.inputType);
  if (inputType) rec.it = inputType;
  if (typeof e.isComposing === "boolean") rec.comp = e.isComposing;
  if (typeof e.key === "string") rec.key = e.key.length === 1 ? "char" : /^[A-Za-z]{2,20}$/.test(e.key) ? e.key : "other";
  if (typeof e.keyCode === "number") rec.kc = e.keyCode;
  if (typeof e.data === "string") rec.dl = e.data.length;
  if (typeof e.persisted === "boolean") rec.per = e.persisted;
  return value === undefined ? { rec } : { rec, value };
}

// ── The recorder ─────────────────────────────────────────────────────────

type Listen = (type: string, fn: (e: never) => void, opts?: unknown) => void;
interface StorageLike {
  getItem(key: string): string | null;
  key(i: number): string | null;
  readonly length: number;
}
/** What the recorder uses of `window`: the real one in the browser, a fake in tests. */
export interface DebugWindow {
  location: { search: string };
  document: { addEventListener: Listen; readyState?: string; visibilityState?: string; prerendering?: unknown };
  navigator: { sendBeacon?: (url: string, data: Blob) => boolean };
  sessionStorage: StorageLike;
  setInterval: (fn: () => void, ms: number) => unknown;
  fetch: (url: string, init: { method: string; body: string; keepalive: boolean }) => Promise<{ status: number }>;
  performance: { now(): number; getEntriesByType?: (type: string) => Array<{ type?: unknown }> };
  addEventListener: Listen;
  __mtFunnelDebugSid?: unknown;
  __mtFunnelDebugHtml?: unknown;
}

function bootRecord(w: DebugWindow, t: number): DebugRecord {
  const rec: DebugRecord = { t: Math.round(t), k: "boot" };
  const source = readSignupSource(Object.fromEntries(new URLSearchParams(w.location.search)));
  if (source.campaignCode && plain(source.campaignCode)) rec.src = source.campaignCode;
  const suffix = `${source.campaignCode ?? ""}:${source.referralCode ?? ""}`;
  try {
    const store = w.sessionStorage;
    rec.sv = !!store.getItem(`mt-play-visit:${suffix}`);
    rec.ss = !!store.getItem(`mt-play-started:${suffix}`);
    let mine = 0;
    for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith("mt-play-")) mine++;
    rec.mk = mine;
    const draft = store.getItem(SIGNUP_DRAFT_KEY);
    rec.dr = !!draft;
    if (draft) {
      try {
        const form = (JSON.parse(draft) as { form?: { name?: unknown; days?: unknown } }).form;
        if (typeof form?.name === "string") rec.dn = form.name.length;
        if (Array.isArray(form?.days)) rec.dd = form.days.length;
      } catch {
        // An unreadable draft: present, nothing more.
      }
    }
    rec.st = "ok";
  } catch {
    rec.st = "blocked";
  }
  try {
    const nav = plain(w.performance.getEntriesByType?.("navigation")?.[0]?.type);
    if (nav) rec.nav = nav;
  } catch {
    // Not available.
  }
  const rs = plain(w.document.readyState);
  if (rs) rec.rs = rs;
  const vis = plain(w.document.visibilityState);
  if (vis) rec.vis = vis;
  if (typeof w.document.prerendering === "boolean") rec.pre = w.document.prerendering;
  rec.sbf = typeof w.navigator.sendBeacon === "function";
  if (typeof w.__mtFunnelDebugHtml === "boolean") rec.hb = w.__mtFunnelDebugHtml;
  return rec;
}

/**
 * Starts the recorder when the page's URL has `?mtdebug=1`; otherwise does
 * nothing at all and returns null. Once per page.
 */
export function installFunnelDebug(w: DebugWindow): { flush(why: "tick" | "hidden"): void } | null {
  if (!funnelDebugOnSearch(w.location?.search ?? "")) return null;
  if (sink) return null;

  const now = () => w.performance.now();
  const queue: DebugRecord[] = [];
  let dropped = 0;
  let seq = 1;
  let prev: string | undefined;
  let sid: string | null = null;
  const sessionId = () => {
    if (sid) return sid;
    const given = w.__mtFunnelDebugSid;
    sid = typeof given === "string" && SID.test(given) ? given : Math.random().toString(36).slice(2, 14).padEnd(12, "0");
    return sid;
  };
  const push = (rec: DebugRecord) => {
    if (queue.length >= MAX_QUEUED) dropped++;
    else queue.push(rec);
  };
  const post = (body: string) => {
    try {
      void w.fetch(FUNNEL_DEBUG_ENDPOINT, { method: "POST", body, keepalive: true }).then(
        (r) => {
          prev = `fetch:${r.status}`;
        },
        () => {
          prev = "fetch:error";
        },
      );
    } catch {
      prev = "fetch:throw";
    }
  };
  const flush = (why: "tick" | "hidden") => {
    for (let i = 0; i < 3 && queue.length > 0; i++) {
      if (seq > MAX_BATCHES) {
        queue.length = 0;
        return;
      }
      const body = JSON.stringify({ v: 1, sid: sessionId(), seq: seq++, why, ...(prev ? { prev } : {}), ...(dropped ? { drop: dropped } : {}), ev: queue.splice(0, PER_BATCH) });
      if (why === "hidden") {
        let ok = false;
        try {
          ok = typeof w.navigator.sendBeacon === "function" && w.navigator.sendBeacon(FUNNEL_DEBUG_ENDPOINT, new Blob([body], { type: "text/plain" }));
        } catch {
          ok = false;
        }
        prev = `beacon:${ok}`;
        if (!ok) post(body);
      } else {
        post(body);
        if (i >= 1) break;
      }
    }
  };

  sink = (rec) => push({ t: Math.round(now()), ...rec });
  push(bootRecord(w, now()));

  const last = new WeakMap<object, string>();
  const onEvent = (e: DebugEventLike) => {
    try {
      const target = isObj(e.target) ? (e.target as object) : null;
      const { rec, value } = summariseFunnelEvent(e, now(), target ? last.get(target) : undefined);
      if (target && value !== undefined) last.set(target, value);
      if (e.type === "click" && !(typeof rec.tag === "string" && CLICKED.has(rec.tag))) return;
      push(rec);
    } catch {
      // A diagnostic never breaks the page.
    }
  };
  for (const type of EVENTS) w.document.addEventListener(type, onEvent, { capture: true, passive: true });
  w.document.addEventListener("visibilitychange", () => {
    push({ t: Math.round(now()), k: "vis", vis: plain(w.document.visibilityState) ?? "unknown" });
    if (w.document.visibilityState === "hidden") flush("hidden");
  });
  w.addEventListener("pagehide", (e: { persisted?: unknown }) => {
    push({ t: Math.round(now()), k: "pagehide", per: e?.persisted === true });
    flush("hidden");
  });
  w.addEventListener("pageshow", (e: { persisted?: unknown }) => push({ t: Math.round(now()), k: "pageshow", per: e?.persisted === true }));
  w.addEventListener("error", (e: { message?: unknown }) => push({ t: Math.round(now()), k: "error", msg: String(e?.message ?? "error").slice(0, 160) }));
  w.addEventListener("unhandledrejection", (e: { reason?: unknown }) => {
    const reason = e?.reason;
    push({ t: Math.round(now()), k: "error", msg: `rejection: ${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 160) });
  });
  w.setInterval(() => flush("tick"), TICK_MS);
  return { flush };
}

// ── The inline script (server-rendered, only with the flag) ──────────────

/** A fresh session id for one debug page view, written into the inline script. */
export function newFunnelDebugSid(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * The script the server writes into the page with the flag: it runs as the
 * HTML is parsed, before any of React's JS, and sends one "html" batch by
 * sendBeacon (fetch if that fails). If it arrives and "boot" does not, the
 * page's JS never ran.
 */
export function funnelDebugInlineScript(sid: string): string {
  if (!SID.test(sid)) throw new Error("funnel debug: bad session id");
  const url = JSON.stringify(FUNNEL_DEBUG_ENDPOINT);
  return (
    `(function(){try{var s=${JSON.stringify(sid)};window.__mtFunnelDebugSid=s;` +
    `var t=0;try{t=Math.round(performance.now())}catch(e){}` +
    `var b=JSON.stringify({v:1,sid:s,seq:0,why:"html",ev:[{t:t,k:"html",rs:String(document.readyState),sbf:typeof navigator.sendBeacon==="function"}]});` +
    `var ok=false;try{ok=navigator.sendBeacon(${url},new Blob([b],{type:"text/plain"}))}catch(e){}` +
    `window.__mtFunnelDebugHtml=!!ok;` +
    `if(!ok){try{fetch(${url},{method:"POST",body:b,keepalive:true}).catch(function(){})}catch(e){}}` +
    `}catch(e){}})();`
  );
}
