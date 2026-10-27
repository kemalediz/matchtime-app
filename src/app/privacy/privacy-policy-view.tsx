"use client";

/**
 * Renders the privacy policy from its data (`privacyPolicy(lang)`); no
 * wording lives here. Opens in the visitor's browser language (English on
 * the first paint, as every signed-out page does) and the switch changes
 * it in place. Reading rhythm comes from the help guides' `help-article`
 * styles, so the two read alike.
 */
import { useState } from "react";
import { BackToSiteLink } from "@/components/back-to-site-link";
import { ShieldCheck } from "lucide-react";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import { LANGS, LANG_LABELS, type Lang } from "@/lib/i18n/lang";
import { privacyPolicy, type PolicyBlock, type Rich } from "@/lib/i18n/privacy-policy";

export function PrivacyPolicyView() {
  const browserLang = useBrowserLang();
  const [chosen, setChosen] = useState<Lang | null>(null);
  const lang = chosen ?? browserLang;
  const copy = privacyPolicy(lang);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <BackToSiteLink className="text-sm font-medium text-blue-700 hover:underline">{copy.backHome}</BackToSiteLink>
          <div role="group" aria-label={copy.languageLabel} className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {LANGS.map((l) => (
              <button
                key={l}
                type="button"
                lang={l}
                aria-pressed={l === lang}
                onClick={() => setChosen(l)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  l === lang ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </div>

        <article lang={lang} className="help-article rounded-2xl border border-slate-200 bg-white px-4 py-6 sm:px-8 sm:py-8 break-words">
          <header className="flex items-start gap-3 mb-6">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-blue-600 flex items-center justify-center" aria-hidden="true">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{copy.title}</h1>
              <p className="!mb-1 text-slate-700">{copy.lead}</p>
              <p className="!mb-0 !text-sm text-slate-600">{copy.versionLine}</p>
            </div>
          </header>

          <nav aria-label={copy.contentsLabel} className="mb-8 rounded-xl bg-slate-50 px-4 py-4">
            <p className="!mb-2 !text-sm font-semibold text-slate-900">{copy.contentsLabel}</p>
            <ol className="!mb-0 sm:columns-2 gap-x-8">
              {copy.sections.map((s) => (
                <li key={s.id} className="!text-sm !mb-1 break-inside-avoid">
                  <a href={`#${s.id}`} onClick={(e) => jumpTo(e, s.id)} className="text-blue-700 hover:underline">
                    {s.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {copy.sections.map((s) => (
            <section key={s.id}>
              <h2 id={s.id} className="scroll-mt-6">
                {s.heading}
              </h2>
              {s.blocks.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

/** A contents jump that replaces the address rather than adding a history
 *  entry, so "Back to MatchTime" (history back) still lands where he came from. */
function jumpTo(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  target.scrollIntoView();
  window.history.replaceState(window.history.state, "", `#${id}`);
}

function Block({ block }: { block: PolicyBlock }) {
  if (block.kind === "p") {
    return (
      <p className="text-slate-700">
        <RichText text={block.text} />
      </p>
    );
  }
  return (
    <ul>
      {block.items.map((item, i) => (
        <li key={i} className="text-slate-700">
          <RichText text={item} />
        </li>
      ))}
    </ul>
  );
}

function RichText({ text }: { text: Rich }) {
  if (typeof text === "string") return <>{text}</>;
  return (
    <>
      {text.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <a key={i} href={part.href} className="text-blue-700 underline" {...externalProps(part.href)}>
            {part.label}
          </a>
        ),
      )}
    </>
  );
}

function externalProps(href: string) {
  return href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
