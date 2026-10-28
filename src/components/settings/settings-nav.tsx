"use client";

/**
 * THE /admin/settings LAYOUT (2026-10-28): tabs across the top, cards that
 * collapse to their title and a one-line summary, a "Find a setting" box,
 * and deep links (`/admin/settings#<card id>`, ids in
 * `src/lib/settings-anchors.ts`).
 *
 *   <SettingsNavProvider lang>   the open tab and the open cards
 *     <FindSetting />            search the cards, open the one picked
 *     <SettingsTabs />           the tab row (scrolls sideways on a phone)
 *     <SettingsTabPanel tab>     one per tab; every panel stays mounted, so
 *                                each card loads once and keeps its state
 *       <SettingsCard id ...>    a card: header (title, summary, ⓘ) + body
 *
 * The open tab lives in the address (`?tab=`), so it survives a reload and
 * can be linked to. A `#<card id>` (on load, or a later in-page link)
 * opens that card's tab, expands it and scrolls to it, once it is drawn:
 * many cards load their own data first.
 *
 * Layout only: no card's behaviour or permissions change here. A card that
 * renders nothing for a club (its component returns null) is simply not on
 * the page, and the search leaves it out.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import {
  SETTINGS_TABS,
  initialSettingsTab,
  resolveSettingsHash,
  settingsTabHref,
  tabOfCard,
  type SettingsCardId,
  type SettingsTab,
} from "@/lib/settings-anchors";
import { searchSettings } from "@/lib/settings-search";
import { settingsNavCopy } from "@/lib/i18n/settings-nav";

interface NavState {
  lang: string | null | undefined;
  tab: SettingsTab;
  chooseTab: (tab: SettingsTab) => void;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Open `id`'s tab, expand it, scroll to `scrollTo` (default the card). */
  reveal: (id: SettingsCardId, scrollTo?: string) => void;
  present: ReadonlySet<string>;
  register: (id: string) => () => void;
}

const NavContext = createContext<NavState | null>(null);

function useNav(): NavState {
  const v = useContext(NavContext);
  if (!v) throw new Error("SettingsCard must sit inside SettingsNavProvider");
  return v;
}

/** How long a deep link waits for its card to be drawn (cards load their own data). */
const REVEAL_WAIT_MS = 15_000;

export function SettingsNavProvider({ lang, children }: { lang: string | null | undefined; children: React.ReactNode }) {
  // The provider is drawn only in the browser, after the page's settings
  // have loaded, so the address is there to read.
  const [tab, setTab] = useState<SettingsTab>(() =>
    typeof window === "undefined" ? "club" : initialSettingsTab({ hash: window.location.hash, search: window.location.search }),
  );
  // A #card in the address as the page first shows: that card is open.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const target = typeof window === "undefined" ? null : resolveSettingsHash(window.location.hash);
    return new Set(target?.kind === "card" ? [target.card] : []);
  });
  const [present, setPresent] = useState<ReadonlySet<string>>(() => new Set());
  // The spot a deep link is waiting to scroll to, once it is drawn and shown.
  // Only a card's: what sits above the tabs (#go-live, #learned-setup)
  // scrolls itself there, as it always did.
  const [pendingScroll, setPendingScroll] = useState<{ target: string; until: number } | null>(() => {
    const target = typeof window === "undefined" ? null : resolveSettingsHash(window.location.hash);
    return target?.kind === "card" ? { target: target.scrollTo, until: Date.now() + REVEAL_WAIT_MS } : null;
  });

  const reveal = useCallback((id: SettingsCardId, scrollTo: string = id) => {
    const target = resolveSettingsHash(id);
    if (target?.kind === "card") setTab(target.tab);
    setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setPendingScroll({ target: scrollTo, until: Date.now() + REVEAL_WAIT_MS });
  }, []);

  const followHash = useCallback(
    (hash: string) => {
      const target = resolveSettingsHash(hash);
      // Above the tabs, the browser's own jump (or the panel's) is enough.
      if (target?.kind === "card") reveal(target.card, target.scrollTo);
    },
    [reveal],
  );

  // Every in-page #link after the first (the billing card's "Choose a
  // money collector", the WhatsApp card's "#go-live").
  useEffect(() => {
    const onHash = () => followHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [followHash]);

  // Scroll once the spot is in the page and visible (its card open, its
  // tab shown). Polled: the card may still be loading its data.
  useEffect(() => {
    if (!pendingScroll) return;
    let frame = 0;
    const tick = () => {
      const el = document.getElementById(pendingScroll.target);
      if (el && el.getClientRects().length > 0) {
        el.scrollIntoView({ block: "start", behavior: "instant" });
        setPendingScroll(null);
        return;
      }
      if (Date.now() > pendingScroll.until) {
        setPendingScroll(null);
        return;
      }
      frame = window.setTimeout(tick, 100);
    };
    tick();
    return () => window.clearTimeout(frame);
  }, [pendingScroll, tab, open]);

  const chooseTab = useCallback((next: SettingsTab) => {
    setTab(next);
    setPendingScroll(null);
    try {
      window.history.replaceState(window.history.state, "", settingsTabHref(next, window.location));
    } catch {
      /* the tab still changes; only the address does not */
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const register = useCallback((id: string) => {
    setPresent((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    return () =>
      setPresent((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
  }, []);

  const value = useMemo<NavState>(
    () => ({ lang, tab, chooseTab, isOpen: (id) => open.has(id), toggle, reveal, present, register }),
    [lang, tab, chooseTab, open, toggle, reveal, present, register],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/** The tab row, in the style of the admin tabs above it. */
export function SettingsTabs() {
  const { lang, tab, chooseTab } = useNav();
  const c = settingsNavCopy(lang);
  const rowRef = useRef<HTMLDivElement>(null);

  // Keep the chosen tab in view when the row scrolls sideways (phone).
  useEffect(() => {
    const el = rowRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [tab]);

  function onKeyDown(e: React.KeyboardEvent) {
    const i = SETTINGS_TABS.indexOf(tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % SETTINGS_TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SETTINGS_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    chooseTab(SETTINGS_TABS[next]);
    rowRef.current?.querySelector<HTMLElement>(`[data-tab="${SETTINGS_TABS[next]}"]`)?.focus();
  }

  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label={c.tabsLabel}
      data-testid="settings-tabs"
      onKeyDown={onKeyDown}
      className="flex gap-1 p-1 bg-slate-100 rounded-lg max-w-full overflow-x-auto"
    >
      {SETTINGS_TABS.map((t) => {
        const active = t === tab;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            id={`settings-tab-${t}`}
            data-tab={t}
            data-testid={`settings-tab-${t}`}
            aria-selected={active}
            aria-controls={`settings-panel-${t}`}
            tabIndex={active ? 0 : -1}
            onClick={() => chooseTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              active ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {c.tabs[t]}
          </button>
        );
      })}
    </div>
  );
}

/** One tab's cards. Hidden, never unmounted, while another tab is open. */
export function SettingsTabPanel({ tab, children }: { tab: SettingsTab; children: React.ReactNode }) {
  const nav = useNav();
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${tab}`}
      aria-labelledby={`settings-tab-${tab}`}
      data-testid={`settings-panel-${tab}`}
      hidden={nav.tab !== tab}
      className="space-y-4"
    >
      {children}
    </div>
  );
}

/**
 * One settings card. Collapsed: its title and a one-line summary of what
 * is set. Tapping anywhere on the header opens it; the ⓘ keeps its own
 * tap. `rootProps` carries the data attributes the card had before
 * (`data-setting`, `data-mode`, `lang`).
 */
export function SettingsCard(props: {
  id: SettingsCardId;
  title: React.ReactNode;
  summary?: string | null;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  info?: React.ReactNode;
  testId?: string;
  rootProps?: Record<string, string | undefined>;
  /** Opened as it first shows (the posters card above the tabs while a club sets up). */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const nav = useNav();
  const bodyId = `${useId()}-body`;
  const { id, defaultOpen } = props;
  const { register, isOpen, toggle } = nav;

  useEffect(() => register(id), [register, id]);
  const opened = useRef(false);
  useEffect(() => {
    if (defaultOpen && !opened.current) {
      opened.current = true;
      if (!isOpen(id)) toggle(id);
    }
  }, [defaultOpen, id, isOpen, toggle]);

  const open = isOpen(id);
  const Icon = props.icon;
  return (
    <section
      id={id}
      data-card={id}
      data-open={open ? "true" : "false"}
      data-testid={props.testId}
      className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6 min-w-0"
      {...props.rootProps}
    >
      <div className="relative flex items-start gap-2 px-4 sm:px-6 py-4">
        {Icon && <Icon className="mt-1 w-4 h-4 shrink-0 text-slate-500" aria-hidden />}
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-800 [overflow-wrap:anywhere]">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              data-testid={`settings-card-toggle-${id}`}
              onClick={() => toggle(id)}
              className="text-left after:absolute after:inset-0 after:rounded-t-xl after:content-[''] focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-blue-500"
            >
              {props.title}
            </button>
          </h2>
          {!open && props.summary ? (
            <p className="mt-0.5 text-sm text-slate-500 truncate" data-testid={`settings-card-summary-${id}`}>
              {props.summary}
            </p>
          ) : null}
        </div>
        {props.info && <span className="relative z-10 shrink-0 flex items-center">{props.info}</span>}
        <ChevronDown
          aria-hidden
          className={`mt-1 w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>
      <div id={bodyId} hidden={!open} className="border-t border-slate-100 min-w-0">
        {props.children}
      </div>
    </section>
  );
}

/** "Find a setting": filters the cards on the page, every tab at once. */
export function FindSetting() {
  const { lang, present, reveal } = useNav();
  const c = settingsNavCopy(lang);
  const [query, setQuery] = useState("");
  const inputId = useId();
  const listId = `${inputId}-results`;
  const results = useMemo(() => searchSettings(query, lang, present), [query, lang, present]);
  const searching = query.trim().length > 0;

  function pick(id: SettingsCardId) {
    setQuery("");
    reveal(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tabOfCard(id));
      url.hash = id;
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {
      /* the card still opens */
    }
  }

  return (
    <div className="relative" data-testid="find-setting">
      <label htmlFor={inputId} className="sr-only">
        {c.find.label}
      </label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          id={inputId}
          type="search"
          role="combobox"
          aria-expanded={searching}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          enterKeyHint="search"
          data-testid="find-setting-input"
          value={query}
          placeholder={c.find.label}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) {
              e.preventDefault();
              pick(results[0].id);
            } else if (e.key === "Escape") {
              setQuery("");
            }
          }}
          className="w-full h-11 pl-9 pr-10 rounded-lg border border-slate-200 bg-white text-base sm:text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 [&::-webkit-search-cancel-button]:hidden"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={c.find.clear}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-9 h-9 rounded-md text-slate-400 hover:text-slate-600"
          >
            <X aria-hidden className="w-4 h-4" />
          </button>
        )}
      </div>
      {searching && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white shadow-sm" data-testid="find-setting-results">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500" role="status">
              {c.find.none}
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label={c.find.results} className="divide-y divide-slate-100">
              {results.map((r) => (
                <li key={r.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    data-testid={`find-setting-result-${r.id}`}
                    onClick={() => pick(r.id)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                  >
                    <span className="block text-sm font-medium text-slate-800">{r.title}</span>
                    <span className="block text-xs text-slate-500">{c.tabs[r.tab]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
