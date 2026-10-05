"use client";

/**
 * The club's language for the client pages under /admin (F1). The admin
 * layout already knows the signed-in admin's club, so it provides the
 * language once and a client page reads it with `useOrgLang()` instead
 * of fetching /api/org/settings just for the ⓘ copy.
 */
import { createContext, useContext } from "react";
import { DEFAULT_LANG, normaliseLang, type Lang } from "@/lib/i18n/lang";

const OrgLangContext = createContext<Lang>(DEFAULT_LANG);

export function OrgLangProvider({ lang, children }: { lang: string | null | undefined; children: React.ReactNode }) {
  return <OrgLangContext.Provider value={normaliseLang(lang)}>{children}</OrgLangContext.Provider>;
}

export function useOrgLang(): Lang {
  return useContext(OrgLangContext);
}
