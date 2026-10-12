"use client";

/**
 * The visitor's own language, for the few pages shown to somebody who is
 * NOT signed in and whose club is therefore not known (/login's "that link
 * has expired" notice, the /r page's error card). From the browser, never
 * from a link: a link must not carry a club's language (security review of
 * PR #248, fix 4).
 *
 * English on the server and on the first paint, then the browser's
 * language once mounted, so the markup the server sends always matches.
 */
import { useEffect, useState } from "react";
import { normaliseLang, type Lang } from "./lang";

export function useBrowserLang(): Lang {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const first = (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase();
    setLang(normaliseLang(first.split("-")[0]));
  }, []);
  return lang;
}
