"use client";

/**
 * The club setup form (self-join slice 4). All copy arrives from the
 * server, already rendered in both languages, so the page follows the
 * language picker as the organiser changes it without shipping the
 * string tables to the browser.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSelfJoinClubAction } from "@/app/actions/org";

export interface SelfJoinFormCopy {
  title: string;
  lead: string;
  clubName: string;
  clubNamePlaceholder: string;
  language: string;
  gameHeading: string;
  day: string;
  time: string;
  venue: string;
  venuePlaceholder: string;
  perSide: string;
  submit: string;
  submitting: string;
  generic: string;
  verifyPhone: string;
  verifyPhoneLink: string;
  oneClub: string;
  openMyClub: string;
  siteCap: string;
  /** Index = day of week, 0 = Sunday. */
  days: string[];
  /** Same order as `perSideValues`. */
  perSideOptions: string[];
}

type Lang = "en" | "tr";
type Refusal = "verify-phone" | "one-club" | "site-cap" | null;

/** Monday first, the way a week reads on a fixture list. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const INPUT = "w-full h-11 px-3 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";

export function SelfJoinForm(props: {
  copy: Record<Lang, SelfJoinFormCopy>;
  defaultLang: Lang;
  langLabels: Record<Lang, string>;
  perSideValues: number[];
  refusal: Refusal;
}) {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>(props.defaultLang);
  const [name, setName] = useState("");
  const [day, setDay] = useState(2);
  const [time, setTime] = useState("");
  const [venue, setVenue] = useState("");
  const [perSide, setPerSide] = useState(7);
  const [refusal, setRefusal] = useState<Refusal>(props.refusal);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const c = props.copy[lang];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await createSelfJoinClubAction({
        name,
        language: lang,
        game: { dayOfWeek: day, time, venue, playersPerSide: perSide },
      });
      if (res.ok) {
        router.push("/admin");
        router.refresh();
        return;
      }
      if (res.reason === "verify-phone" || res.reason === "one-club" || res.reason === "site-cap") {
        setRefusal(res.reason);
      } else {
        setError(res.error);
      }
    } catch {
      setError(c.generic);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 max-w-md w-full" lang={lang}>
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">{c.title}</h1>
          <p className="text-sm text-slate-500 mt-1">{c.lead}</p>
        </div>

        <div className="mb-5">
          <label htmlFor="sj-language" className="block text-sm font-medium text-slate-700 mb-1.5">
            {c.language}
          </label>
          <select id="sj-language" value={lang} onChange={(e) => setLang(e.target.value as Lang)} className={INPUT}>
            {(Object.keys(props.langLabels) as Lang[]).map((l) => (
              <option key={l} value={l}>
                {props.langLabels[l]}
              </option>
            ))}
          </select>
        </div>

        {refusal ? (
          <div data-testid="sj-refusal" className="p-4 bg-amber-50 text-amber-900 rounded-lg text-sm space-y-3">
            <p>{refusal === "verify-phone" ? c.verifyPhone : refusal === "one-club" ? c.oneClub : c.siteCap}</p>
            {refusal === "verify-phone" && (
              <Link href="/signup" className="inline-block font-medium text-blue-700 hover:text-blue-800">
                {c.verifyPhoneLink}
              </Link>
            )}
            {refusal === "one-club" && (
              <Link href="/admin" className="inline-block font-medium text-blue-700 hover:text-blue-800">
                {c.openMyClub}
              </Link>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="sj-name" className="block text-sm font-medium text-slate-700 mb-1.5">
                {c.clubName}
              </label>
              <input
                id="sj-name"
                type="text"
                required
                minLength={2}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={c.clubNamePlaceholder}
                className={INPUT}
              />
            </div>

            <fieldset className="space-y-4 pt-2">
              <legend className="text-sm font-semibold text-slate-800">{c.gameHeading}</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sj-day" className="block text-sm font-medium text-slate-700 mb-1.5">
                    {c.day}
                  </label>
                  <select id="sj-day" value={day} onChange={(e) => setDay(Number(e.target.value))} className={INPUT}>
                    {DAY_ORDER.map((d) => (
                      <option key={d} value={d}>
                        {c.days[d]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="sj-time" className="block text-sm font-medium text-slate-700 mb-1.5">
                    {c.time}
                  </label>
                  <input
                    id="sj-time"
                    type="time"
                    required
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className={INPUT}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="sj-venue" className="block text-sm font-medium text-slate-700 mb-1.5">
                  {c.venue}
                </label>
                <input
                  id="sj-venue"
                  type="text"
                  required
                  maxLength={120}
                  value={venue}
                  onChange={(e) => setVenue(e.target.value)}
                  placeholder={c.venuePlaceholder}
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="sj-per-side" className="block text-sm font-medium text-slate-700 mb-1.5">
                  {c.perSide}
                </label>
                <select
                  id="sj-per-side"
                  value={perSide}
                  onChange={(e) => setPerSide(Number(e.target.value))}
                  className={INPUT}
                >
                  {props.perSideValues.map((n, i) => (
                    <option key={n} value={n}>
                      {c.perSideOptions[i]}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

            <button
              type="submit"
              disabled={loading || name.trim().length < 2}
              className="w-full h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? c.submitting : c.submit}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
