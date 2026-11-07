"use client";

/**
 * One line under "we sent you a code" on /login, /signup and /claim
 * (WhatsApp Cloud API plan, PR C7a, section 3.1): the number the code
 * comes from, when the code action named one. It names one only when the
 * code went from MatchTime's official number, which is new to the person;
 * otherwise (the flags off, the club number) nothing is rendered and the
 * page reads exactly as before. The browser's own language, as the
 * template the code went in.
 */
import { t } from "@/lib/i18n/t";
import { useBrowserLang } from "@/lib/i18n/browser-lang";

export function CodeSentFrom({ number, className }: { number: string | null | undefined; className?: string }) {
  const lang = useBrowserLang();
  if (!number) return null;
  return (
    <p data-testid="code-sent-from" className={className}>
      {t(lang).code_sent_from({ number })}
    </p>
  );
}
