/**
 * The key features row right after the dropout story (variant D round 2):
 * the core value in eight short cards, an icon, a title and one line each.
 * The words are `KEY_FEATURES` (landing-content.ts). Presentational only.
 */
import { KEY_FEATURES, type ColorKey } from "./landing-content";
import { Icon, Stopped } from "./landing-sections";
import { DISPLAY_FONT } from "./display-font";

const TINT: Record<ColorKey, string> = {
  blue: "bg-blue-50 text-blue-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  purple: "bg-purple-50 text-purple-600",
  teal: "bg-teal-50 text-teal-600",
  rose: "bg-rose-50 text-rose-600",
  violet: "bg-violet-50 text-violet-600",
};

export function KeyFeatures() {
  const k = KEY_FEATURES;
  const headingId = `${k.id}-heading`;
  return (
    <section id={k.id} aria-labelledby={headingId} className="relative py-16 sm:py-24 px-4 sm:px-8 bg-white text-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">{k.eyebrow}</span>
          <h2 id={headingId} className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900" style={DISPLAY_FONT}>
            <Stopped text={k.title} />
          </h2>
        </div>
        <ul aria-label="Key features" className="mt-10 sm:mt-12 grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {k.cards.map((c) => (
            <li key={c.key} className="p-4 sm:p-5 rounded-2xl border border-slate-200 bg-slate-50/60">
              <span className={`w-10 h-10 rounded-xl inline-flex items-center justify-center ${TINT[c.color]}`}>
                <Icon k={c.icon} className="w-5 h-5" />
              </span>
              <h3 className="mt-3 text-[15px] sm:text-base font-bold leading-snug text-slate-900" style={DISPLAY_FONT}>
                {c.title}
              </h3>
              <p className="mt-1 text-[13px] sm:text-sm leading-relaxed text-slate-600">{c.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
