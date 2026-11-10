/**
 * The /play funnel diagnostic (TEMPORARY, 2026-11-10): on Kemal's Android
 * phone inside the Facebook app a letter typed in "Your name" sent no
 * beacon at all. With `?mtdebug=1` on the link the page records what the
 * browser really did and posts it to /api/play/debug. Without the flag it
 * must do NOTHING: no listener, no timer, no request, no storage read.
 * It never sends what was typed: only lengths and whether it changed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FUNNEL_DEBUG_ENDPOINT,
  funnelDebugActive,
  funnelDebugInlineScript,
  funnelDebugNote,
  funnelDebugOnParams,
  funnelDebugOnSearch,
  installFunnelDebug,
  newFunnelDebugSid,
  resetFunnelDebugForTests,
  summariseFunnelEvent,
} from "../funnel-debug";

afterEach(() => resetFunnelDebugForTests());

function control(tagName: string, props: { type?: string; value?: string; checked?: boolean; name?: string; inForm?: boolean } = {}) {
  const { inForm = true, ...rest } = props;
  return { tagName, ...rest, closest: (sel: string) => (sel === "form" && inForm ? {} : null) };
}

function fakeWindow(search: string, stored: Record<string, string> = {}) {
  const docListeners: Array<{ type: string; fn: (e: unknown) => void; opts: unknown }> = [];
  const winListeners: Array<{ type: string; fn: (e: unknown) => void; opts: unknown }> = [];
  const ticks: Array<() => void> = [];
  const keys = Object.keys(stored);
  const w = {
    location: { search },
    document: {
      readyState: "interactive",
      visibilityState: "visible",
      addEventListener: vi.fn((type: string, fn: (e: unknown) => void, opts: unknown) => docListeners.push({ type, fn, opts })),
    },
    navigator: { sendBeacon: vi.fn<(url: string, data: unknown) => boolean>(() => true) },
    sessionStorage: {
      getItem: vi.fn((k: string) => stored[k] ?? null),
      key: vi.fn((i: number) => keys[i] ?? null),
      get length() {
        return keys.length;
      },
    },
    setInterval: vi.fn((fn: () => void) => {
      ticks.push(fn);
      return 1;
    }),
    clearInterval: vi.fn(),
    fetch: vi.fn<(url: string, init: { body: string }) => Promise<{ status: number }>>(async () => ({ status: 204 })),
    performance: { now: () => 1000, getEntriesByType: () => [{ type: "reload" }] },
    addEventListener: vi.fn((type: string, fn: (e: unknown) => void, opts: unknown) => winListeners.push({ type, fn, opts })),
  };
  const fire = (type: string, e: Record<string, unknown>) => {
    for (const l of docListeners) if (l.type === type) l.fn({ type, isTrusted: true, ...e });
  };
  const sentBodies = () => w.fetch.mock.calls.map((c) => JSON.parse(c[1].body));
  return { w, docListeners, winListeners, ticks, fire, sentBodies };
}

describe("the flag: on only with mtdebug=1", () => {
  it("off by default, on only for exactly mtdebug=1", () => {
    expect(funnelDebugOnSearch("")).toBe(false);
    expect(funnelDebugOnSearch("?src=fb")).toBe(false);
    expect(funnelDebugOnSearch("?mtdebug=0")).toBe(false);
    expect(funnelDebugOnSearch("?mtdebug=true")).toBe(false);
    expect(funnelDebugOnSearch("?mtdebug=1")).toBe(true);
    expect(funnelDebugOnSearch("?src=fb&mtdebug=1")).toBe(true);
  });

  it("the server reads the same from the page's search params", () => {
    expect(funnelDebugOnParams({})).toBe(false);
    expect(funnelDebugOnParams({ src: "fb" })).toBe(false);
    expect(funnelDebugOnParams({ mtdebug: ["1", "1"] })).toBe(false);
    expect(funnelDebugOnParams({ mtdebug: "1", src: "fb" })).toBe(true);
  });
});

describe("installFunnelDebug without the flag: changes nothing", () => {
  it("adds no listener, starts no timer, sends nothing and reads no storage", () => {
    const { w } = fakeWindow("?src=fb", { "mt-play-visit:fb:": "1" });
    expect(installFunnelDebug(w as never)).toBeNull();
    expect(w.document.addEventListener).not.toHaveBeenCalled();
    expect(w.addEventListener).not.toHaveBeenCalled();
    expect(w.setInterval).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.navigator.sendBeacon).not.toHaveBeenCalled();
    expect(w.sessionStorage.getItem).not.toHaveBeenCalled();
    expect(funnelDebugActive()).toBe(false);
  });

  it("the beacon's notes are a silent no-op", () => {
    expect(() => funnelDebugNote({ k: "b:send", step: "opened" })).not.toThrow();
    expect(funnelDebugActive()).toBe(false);
  });
});

describe("installFunnelDebug with mtdebug=1", () => {
  it("listens on document in the capture phase for every event the brief names", () => {
    const { w, docListeners } = fakeWindow("?src=fb&mtdebug=1");
    expect(installFunnelDebug(w as never)).not.toBeNull();
    for (const type of ["focusin", "keydown", "beforeinput", "compositionstart", "compositionupdate", "compositionend", "input", "change", "click"]) {
      const l = docListeners.find((x) => x.type === type);
      expect(l, type).toBeDefined();
      expect(l!.opts).toMatchObject({ capture: true });
    }
    expect(docListeners.find((x) => x.type === "visibilitychange")).toBeDefined();
    expect(w.setInterval).toHaveBeenCalledWith(expect.any(Function), 2000);
    expect(funnelDebugActive()).toBe(true);
  });

  it("records the boot: storage keys held, the draft (lengths only), navigation type; batched every 2 s by fetch keepalive", async () => {
    const draft = JSON.stringify({ v: 2, form: { name: "Kemal", district: "SM1", days: [1, 3] } });
    const { w, ticks, sentBodies } = fakeWindow("?src=fb&mtdebug=1", { "mt-play-visit:fb:": "1", "mt.pool.signupDraft.v2": draft });
    installFunnelDebug(w as never);
    expect(w.fetch).not.toHaveBeenCalled();
    ticks[0]();
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(w.fetch.mock.calls[0][0]).toBe(FUNNEL_DEBUG_ENDPOINT);
    expect(w.fetch.mock.calls[0][1]).toMatchObject({ method: "POST", keepalive: true });
    const [batch] = sentBodies();
    expect(batch).toMatchObject({ v: 1, seq: 1, why: "tick" });
    const boot = batch.ev[0];
    expect(boot).toMatchObject({ k: "boot", sv: true, ss: false, st: "ok", dr: true, dn: 5, dd: 2, nav: "reload", sbf: true, src: "fb" });
    expect(JSON.stringify(batch)).not.toContain("Kemal");
    expect(JSON.stringify(batch)).not.toContain("SM1");
    // Nothing new: the next tick sends nothing.
    ticks[0]();
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it("records typing as lengths and changes, never the text, and the beacon's own notes", () => {
    const { w, ticks, fire, sentBodies } = fakeWindow("?mtdebug=1");
    installFunnelDebug(w as never);
    const name = control("INPUT", { type: "text", name: "name", value: "" });
    fire("focusin", { target: name });
    fire("keydown", { target: name, key: "Unidentified", keyCode: 229 });
    name.value = "K";
    fire("input", { target: name, inputType: "insertCompositionText", isComposing: true, data: "K" });
    funnelDebugNote({ k: "b:entry", ev: "input", v: "counts", bl: 0, len: 1 });
    funnelDebugNote({ k: "b:beacon", step: "started", ok: true });
    ticks[0]();
    const ev = sentBodies()[0].ev;
    const typed = ev.find((e: { k: string }) => e.k === "input");
    expect(typed).toMatchObject({ tr: true, it: "insertCompositionText", comp: true, tag: "INPUT", ty: "text", nm: "name", len: 1, ch: true, dl: 1, f: true });
    expect(ev.find((e: { k: string }) => e.k === "keydown")).toMatchObject({ key: "Unidentified", kc: 229 });
    expect(ev.find((e: { k: string }) => e.k === "b:entry")).toMatchObject({ v: "counts" });
    expect(ev.find((e: { k: string }) => e.k === "b:beacon")).toMatchObject({ step: "started", ok: true });
    expect(JSON.stringify(ev)).not.toMatch(/"K"/);
  });

  it("on hidden, flushes at once by sendBeacon, and says how the last send went", async () => {
    const { w, fire, sentBodies } = fakeWindow("?mtdebug=1");
    installFunnelDebug(w as never);
    w.document.visibilityState = "hidden";
    fire("visibilitychange", { target: w.document });
    expect(w.navigator.sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = w.navigator.sendBeacon.mock.calls[0];
    expect(url).toBe(FUNNEL_DEBUG_ENDPOINT);
    const body = JSON.parse(await (blob as Blob).text());
    expect(body).toMatchObject({ v: 1, why: "hidden" });
    expect(sentBodies()).toHaveLength(0);
  });
});

describe("summariseFunnelEvent: what one event says, never the text", () => {
  it("a key press with a character is 'char'; a named key keeps its name", () => {
    const t = control("INPUT", { type: "text", value: "" });
    expect(summariseFunnelEvent({ type: "keydown", isTrusted: true, target: t, key: "a", keyCode: 65 }, 5, undefined).rec).toMatchObject({ key: "char", kc: 65 });
    expect(summariseFunnelEvent({ type: "keydown", isTrusted: true, target: t, key: "ş" }, 5, undefined).rec.key).toBe("char");
    expect(summariseFunnelEvent({ type: "keydown", isTrusted: true, target: t, key: "Backspace" }, 5, undefined).rec.key).toBe("Backspace");
    expect(summariseFunnelEvent({ type: "keydown", isTrusted: true, target: t, key: "😀" }, 5, undefined).rec.key).toBe("other");
  });

  it("value length before and after, and whether it changed since last seen", () => {
    const t = control("INPUT", { type: "text", value: "Sam" });
    const first = summariseFunnelEvent({ type: "focusin", isTrusted: true, target: t }, 1, undefined);
    expect(first.rec).toMatchObject({ len: 3 });
    expect(first.rec.ch).toBeUndefined();
    t.value = "Samy";
    const next = summariseFunnelEvent({ type: "input", isTrusted: false, target: t, inputType: "insertText", data: "y" }, 2, first.value);
    expect(next.rec).toMatchObject({ tr: false, len: 4, bl: 3, ch: true, it: "insertText", dl: 1 });
    expect(JSON.stringify(next.rec)).not.toContain("Sam");
  });

  it("a tick box: whether it is ticked; something that is not a control: just the type and trust", () => {
    const box = control("INPUT", { type: "checkbox", checked: true, name: "adult" });
    expect(summariseFunnelEvent({ type: "change", isTrusted: true, target: box }, 1, undefined).rec).toMatchObject({ ty: "checkbox", ck: true, nm: "adult" });
    expect(summariseFunnelEvent({ type: "click", isTrusted: true, target: { tagName: "DIV" } }, 1, undefined).rec).toEqual({ t: 1, k: "click", tr: true, tag: "DIV" });
  });

  it("a field outside the form says so", () => {
    expect(summariseFunnelEvent({ type: "input", isTrusted: true, target: control("INPUT", { type: "text", value: "", inForm: false }) }, 1, undefined).rec.f).toBe(false);
  });
});

describe("the inline script: proves the HTML ran script at all, before React", () => {
  it("sends one 'html' batch by sendBeacon with the server's session id and remembers it", async () => {
    const sid = newFunnelDebugSid();
    expect(sid).toMatch(/^[a-z0-9]{12}$/);
    const sendBeacon = vi.fn(() => true);
    const win: Record<string, unknown> = {};
    const run = new Function("window", "navigator", "document", "fetch", "Blob", funnelDebugInlineScript(sid));
    run(win, { sendBeacon }, { readyState: "loading" }, vi.fn(), Blob);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe(FUNNEL_DEBUG_ENDPOINT);
    const body = JSON.parse(await blob.text());
    expect(body).toMatchObject({ v: 1, sid, seq: 0, why: "html", ev: [{ k: "html", rs: "loading", sbf: true }] });
    expect(win.__mtFunnelDebugSid).toBe(sid);
    expect(win.__mtFunnelDebugHtml).toBe(true);
  });

  it("a session id that is not plain letters and digits is refused (it is written into the page)", () => {
    expect(() => funnelDebugInlineScript("</script><script>alert(1)")).toThrow();
  });
});
