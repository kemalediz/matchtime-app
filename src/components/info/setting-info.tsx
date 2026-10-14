"use client";

/**
 * The ⓘ beside every setting on /admin/settings (2026-10-15): the shared
 * InfoButton, filled from the one settings explanation module
 * (src/lib/settings-info.ts) in the club's language.
 *
 *   <SettingInfo k="rollingSquad" lang={lang} />
 *
 * The popup reads, in order: what the setting does, an example of the
 * WhatsApp message where one helps, what each choice does (On and Off for
 * a switch), the default for a new club, who it suits, and how it works
 * with other settings.
 *
 * The trigger's test id is `info-setting-<k>`, which the Playwright specs
 * use; its accessible name is "What is <title>?" in the club's language.
 */
import { InfoButton } from "@/components/stats/info-button";
import { WaText } from "@/components/billing/wa-text";
import { t } from "@/lib/i18n/t";
import { settingInfo, settingInfoLabels, type SettingInfoKey } from "@/lib/settings-info";

export function SettingInfo({ k, lang }: { k: SettingInfoKey; lang: string | null | undefined }) {
  const s = t(lang);
  const copy = settingInfo(lang, k);
  const l = settingInfoLabels(lang);
  const heading = "mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 info-dark:text-slate-400";
  return (
    <InfoButton title={copy.title} label={s.info_open({ title: copy.title })} closeLabel={s.info_close} testId={`setting-${k}`}>
      {copy.what.map((p, i) => (
        <p key={`w${i}`}>{p}</p>
      ))}
      {copy.example && (
        <figure className="!mt-3">
          <figcaption className={heading.replace("mt-3 ", "")}>{l.example}</figcaption>
          <blockquote
            data-testid="setting-info-example"
            className="mt-1 whitespace-pre-line rounded-lg rounded-tl-none bg-emerald-50 px-3 py-2 text-[13px] text-slate-800 shadow-sm info-dark:bg-emerald-950 info-dark:text-emerald-50"
          >
            <WaText text={copy.example} />
          </blockquote>
        </figure>
      )}
      {copy.choices && copy.choices.length > 0 && (
        <dl className="!mt-3 space-y-2">
          {copy.choices.map((c) => (
            <div key={c.name}>
              <dt className="font-semibold text-slate-800 info-dark:text-slate-100">{c.name}</dt>
              <dd>{c.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="!mt-3">
        <span className="font-semibold text-slate-800 info-dark:text-slate-100">{l.newClubs} </span>
        {copy.newClubs}
      </p>
      {copy.suits && (
        <p>
          <span className="font-semibold text-slate-800 info-dark:text-slate-100">{l.suits} </span>
          {copy.suits}
        </p>
      )}
      {copy.together && copy.together.length > 0 && (
        <>
          <p className={heading}>{l.together}</p>
          <ul className="list-disc space-y-1 pl-5">
            {copy.together.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}
    </InfoButton>
  );
}
