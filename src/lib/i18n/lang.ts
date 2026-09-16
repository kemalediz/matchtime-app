/**
 * The language a group is spoken to in. CLIENT-SAFE: no Prisma, no DB,
 * nothing but a type and two tiny functions, for the same reason
 * `org-features-meta.ts` is split from `org-features.ts` (the admin
 * settings page is a client component and imports the picker list).
 *
 * `Organisation.language` holds a lowercase ISO 639-1 code. The set of
 * languages the product ships is exactly `LANGS`: a language is only
 * added here once `src/lib/i18n/strings.<code>.ts` exists, because
 * `t()` resolves a code to that table and the type system proves the
 * table is complete (`Strings = typeof en`, every other table is
 * declared `: Strings`).
 *
 * Anything unknown normalises to `"en"`. A bad value in the column can
 * therefore never produce a blank message; the worst case is English,
 * which is what every group got before this existed.
 *
 * See MDs/multi-language-design-2026-09-16.md section 4.1.
 */

export const LANGS = ["en", "tr"] as const;

export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = "en";

/** Human labels for the admin settings picker. Each language is named
 *  in itself, which is how every language picker on earth reads. */
export const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  tr: "Türkçe",
};

export function isLang(raw: unknown): raw is Lang {
  return typeof raw === "string" && (LANGS as readonly string[]).includes(raw);
}

/**
 * Resolve whatever the database, a form or a script handed us to a
 * language the product ships. Case and surrounding whitespace are
 * forgiven ("TR", " en ") because a value typed by a human should not
 * silently become English; a region suffix is forgiven for the same
 * reason ("en-GB", "tr_TR"). Everything else is `"en"`.
 */
export function normaliseLang(raw: string | null | undefined): Lang {
  if (typeof raw !== "string") return DEFAULT_LANG;
  const code = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isLang(code) ? code : DEFAULT_LANG;
}
