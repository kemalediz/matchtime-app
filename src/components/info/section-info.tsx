"use client";

/**
 * One organiser ⓘ (F1, 2026-10-05): the shared InfoButton, filled from
 * the string table in the club's language. Usable from server and client
 * components alike (its props are two strings).
 *
 *   <SectionInfo k="pl_seed" lang={lang} />
 *
 * The trigger's test id is `info-<k>`, which the Playwright specs use.
 */
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import { infoCopy, type InfoKey } from "@/lib/info-copy";

export function SectionInfo({ k, lang }: { k: InfoKey; lang: string | null | undefined }) {
  const s = t(lang);
  const { title, paragraphs } = infoCopy(lang, k);
  return (
    <InfoButton title={title} label={s.info_open({ title })} closeLabel={s.info_close} testId={k}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </InfoButton>
  );
}
