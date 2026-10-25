"use client";

/**
 * The pool profile's fields, for the /play sign-up and the manage page
 * alike (slice L2). Controlled: the parent holds the `PoolFormValue`
 * (src/lib/pool/form-state.ts, where every tap is defined) and the errors
 * the validator named. No wording here: `copy` is the page's, and the sport
 * names and levels are the catalogue's (src/lib/pool/sports.ts).
 *
 * Accessibility: each group is a fieldset with a legend; every input has a
 * label; an error sits under its field, is announced (role="alert" on the
 * summary, aria-describedby on the field) and the field is aria-invalid.
 */
import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import type { Lang } from "@/lib/i18n/lang";
import { LANGS, LANG_LABELS } from "@/lib/i18n/lang";
import { t } from "@/lib/i18n/t";
import type { PoolFieldsCopy } from "@/lib/i18n/pool-play";
import {
  TIME_OPTIONS,
  WEEK_ORDER,
  addRange,
  addVenue,
  removeRange,
  removeVenue,
  setRange,
  setSport,
  shownSports,
  toggleDay,
  toggleFormat,
  type LevelChoice,
  type PoolFormValue,
  type PoolVenueChoice,
  type SportState,
} from "@/lib/pool/form-state";
import { OTHER_SPORT, POOL_FREE_TEXT_MAX, SPORT_LEVELS, formatsOf, levelLabel, sportLabel } from "@/lib/pool/sports";
import { POOL_SIGNUP, POOL_TRAVEL_MILES } from "@/lib/pool/rules";

export type FieldErrorText = Partial<Record<"name" | "area" | "maxMiles" | "availability" | "sports", string>>;

const INPUT = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500";
const LEGEND = "text-base font-semibold text-slate-900";
const HINT = "mt-1 text-sm text-slate-600";
const CHIP = "inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50";

function ErrorLine({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="mt-2 text-sm font-medium text-red-700">
      {text}
    </p>
  );
}

export function PoolProfileFields({
  value,
  onChange,
  copy,
  lang,
  errors,
}: {
  value: PoolFormValue;
  onChange: (next: PoolFormValue) => void;
  copy: PoolFieldsCopy;
  lang: Lang;
  errors: FieldErrorText;
}) {
  const id = useId();
  const err = (k: keyof FieldErrorText) => `${id}-${k}-error`;
  const invalid = (k: keyof FieldErrorText) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": err(k) } : {});
  const shown = shownSports(value);

  return (
    <div className="space-y-8">
      {/* Name */}
      <div>
        <label htmlFor={`${id}-name`} className={LEGEND}>
          {copy.nameLabel}
        </label>
        <p id={`${id}-name-hint`} className={HINT}>
          {copy.nameHint}
        </p>
        <input
          id={`${id}-name`}
          name="name"
          autoComplete="name"
          maxLength={POOL_SIGNUP.nameMax}
          className={`${INPUT} mt-2`}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          {...invalid("name")}
        />
        <ErrorLine id={err("name")} text={errors.name} />
      </div>

      {/* Area */}
      <fieldset {...invalid("area")}>
        <legend className={LEGEND}>{copy.areaLegend}</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["district", "venues"] as const).map((kind) => (
            <label key={kind} className={CHIP}>
              <input type="radio" name={`${id}-area`} checked={value.areaKind === kind} onChange={() => onChange({ ...value, areaKind: kind })} />
              {kind === "district" ? copy.areaDistrictOption : copy.areaVenuesOption}
            </label>
          ))}
        </div>
        {value.areaKind === "district" ? (
          <div className="mt-4">
            <label htmlFor={`${id}-district`} className="text-sm font-medium text-slate-800">
              {copy.districtLabel}
            </label>
            <p className={HINT}>{copy.districtHint}</p>
            <input
              id={`${id}-district`}
              name="district"
              autoComplete="off"
              inputMode="text"
              maxLength={4}
              className={`${INPUT} mt-2 max-w-[10rem] uppercase`}
              value={value.district}
              onChange={(e) => onChange({ ...value, district: e.target.value.toUpperCase() })}
            />
          </div>
        ) : (
          <VenuePicker value={value} onChange={onChange} copy={copy} />
        )}
        <ErrorLine id={err("area")} text={errors.area} />
      </fieldset>

      {/* Travel */}
      <fieldset {...invalid("maxMiles")}>
        <legend className={LEGEND}>{copy.travelLegend}</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {POOL_TRAVEL_MILES.map((m) => (
            <label key={m} className={CHIP}>
              <input type="radio" name={`${id}-miles`} checked={value.maxMiles === m} onChange={() => onChange({ ...value, maxMiles: m })} />
              {copy.miles(m)}
            </label>
          ))}
        </div>
        <ErrorLine id={err("maxMiles")} text={errors.maxMiles} />
      </fieldset>

      {/* Days and hours */}
      <fieldset {...invalid("availability")}>
        <legend className={LEGEND}>{copy.daysLegend}</legend>
        <p className={HINT}>{copy.daysHint}</p>
        <ul className="mt-3 space-y-3">
          {WEEK_ORDER.map((day) => {
            const dayName = copy.dayNames[day];
            const ranges = value.days[day] ?? [];
            return (
              <li key={day} className="rounded-lg border border-slate-200 bg-white p-3">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-900">
                  <input type="checkbox" checked={ranges.length > 0} onChange={() => onChange(toggleDay(value, day))} />
                  {dayName}
                </label>
                {ranges.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {ranges.map((r, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <TimeSelect label={copy.fromLabel(dayName)} value={r.from} onChange={(from) => onChange(setRange(value, day, i, { from }))} />
                        <span aria-hidden="true" className="text-slate-500">
                          →
                        </span>
                        <TimeSelect label={copy.toLabel(dayName)} value={r.to} onChange={(to) => onChange(setRange(value, day, i, { to }))} />
                        <button
                          type="button"
                          aria-label={copy.removeRange(dayName)}
                          className="rounded-md p-2 text-slate-500 hover:bg-slate-100"
                          onClick={() => onChange(removeRange(value, day, i))}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="text-sm font-medium text-blue-700 underline" onClick={() => onChange(addRange(value, day))}>
                      {copy.addRange(dayName)}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <ErrorLine id={err("availability")} text={errors.availability} />
      </fieldset>

      {/* Sports */}
      <fieldset {...invalid("sports")}>
        <legend className={LEGEND}>{copy.sportsLegend}</legend>
        <p className={HINT}>{shown.single ? copy.sportsHintOne : copy.sportsHint}</p>
        {/* Only the live sports (LIVE_SPORTS, pool/sports.ts), plus one he already has. */}
        <ul className="mt-3 space-y-3" data-testid="pool-sports">
          {shown.sports.map((key) => (
            <SportRow
              key={key}
              name={sportLabel(key, lang)}
              formats={formatsOf(key)}
              state={shown.single ? { ...value.sports[key], on: true } : value.sports[key]}
              fixed={shown.single}
              onChange={(patch) => onChange(setSport(value, key, patch))}
              copy={copy}
              lang={lang}
            />
          ))}
          {shown.other && (
            <SportRow
              name={sportLabel(OTHER_SPORT, lang)}
              formats={[]}
              state={value.other}
              onChange={(patch) => onChange({ ...value, other: { ...value.other, ...patch } })}
              copy={copy}
              lang={lang}
              otherName={{ value: value.other.name, onChange: (name) => onChange({ ...value, other: { ...value.other, name } }) }}
            />
          )}
        </ul>
        <ErrorLine id={err("sports")} text={errors.sports} />
      </fieldset>

      {/* Language */}
      <div>
        <label htmlFor={`${id}-lang`} className={LEGEND}>
          {copy.languageLabel}
        </label>
        <select
          id={`${id}-lang`}
          className={`${INPUT} mt-2 max-w-xs`}
          value={value.language}
          onChange={(e) => onChange({ ...value, language: e.target.value as Lang })}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABELS[l]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function TimeSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label={label} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-base" value={value} onChange={(e) => onChange(e.target.value)}>
      {TIME_OPTIONS.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function SportRow({
  name,
  formats,
  state,
  onChange,
  copy,
  lang,
  otherName,
  fixed = false,
}: {
  name: string;
  formats: readonly number[];
  state: SportState;
  onChange: (patch: Partial<SportState>) => void;
  copy: PoolFieldsCopy;
  lang: Lang;
  otherName?: { value: string; onChange: (v: string) => void };
  /** The only sport offered: no tick box, always on. */
  fixed?: boolean;
}) {
  const id = useId();
  const shown = otherName && otherName.value.trim() ? otherName.value.trim() : name;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      {fixed ? (
        <p className="text-sm font-medium text-slate-900">{name}</p>
      ) : (
        <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-900">
          <input type="checkbox" checked={state.on} onChange={(e) => onChange({ on: e.target.checked })} />
          {name}
        </label>
      )}
      {state.on && (
        <div className={`mt-3 space-y-3 ${fixed ? "" : "pl-6"}`}>
          {otherName && (
            <div>
              <label htmlFor={`${id}-other`} className="text-sm text-slate-800">
                {copy.otherNameLabel}
              </label>
              <input
                id={`${id}-other`}
                maxLength={POOL_FREE_TEXT_MAX}
                className={`${INPUT} mt-1`}
                value={otherName.value}
                onChange={(e) => otherName.onChange(e.target.value)}
              />
            </div>
          )}
          {formats.length > 0 && (
            <fieldset>
              <legend className="text-sm text-slate-800">{copy.formatsLegend(shown)}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {formats.map((n) => (
                  <label key={n} className={CHIP}>
                    <input type="checkbox" checked={state.formats.includes(n)} onChange={() => onChange({ formats: toggleFormat(state.formats, n) })} />
                    {t(lang).sj_per_side_option({ perSide: n })}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${id}-level`} className="block text-sm text-slate-800">
                {copy.levelLabel(shown)}
              </label>
              <select
                id={`${id}-level`}
                className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base"
                value={state.level}
                onChange={(e) => onChange({ level: e.target.value as LevelChoice })}
              >
                <option value="">{copy.levelNone}</option>
                {SPORT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {levelLabel(l, lang)}
                  </option>
                ))}
                <option value="own">{copy.levelOwnWords}</option>
              </select>
            </div>
            {state.level === "own" && (
              <div className="min-w-[12rem] flex-1">
                <label htmlFor={`${id}-level-text`} className="block text-sm text-slate-800">
                  {copy.levelOwnWordsLabel(shown)}
                </label>
                <input
                  id={`${id}-level-text`}
                  maxLength={POOL_FREE_TEXT_MAX}
                  className={`${INPUT} mt-1`}
                  value={state.levelText}
                  onChange={(e) => onChange({ levelText: e.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function VenuePicker({ value, onChange, copy }: { value: PoolFormValue; onChange: (v: PoolFormValue) => void; copy: PoolFieldsCopy }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PoolVenueChoice[] | null>(null);

  useEffect(() => {
    if (q.trim().length < 3) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/play/venues?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((d: { venues: PoolVenueChoice[] }) => setResults(d.venues))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q]);

  return (
    <div className="mt-4 space-y-3">
      {value.venues.length > 0 && (
        <div>
          <p className="text-sm font-medium text-slate-800">{copy.venuesChosen}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {value.venues.map((v) => (
              <li key={v.id} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-900">
                {v.name}
                <button type="button" aria-label={copy.venueRemove(v.name)} className="p-1" onClick={() => onChange(removeVenue(value, v.id))}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <label htmlFor={`${id}-q`} className="text-sm font-medium text-slate-800">
          {copy.venueSearchLabel}
        </label>
        <p className={HINT}>{copy.venueSearchHint}</p>
        <input
          id={`${id}-q`}
          type="search"
          className={`${INPUT} mt-2`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value.trim().length < 3) setResults(null);
          }}
        />
      </div>
      {results && results.length === 0 && <p className="text-sm text-slate-600">{copy.venueNoResults}</p>}
      {results && results.length > 0 && (
        <ul className="space-y-1">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-label={copy.venueAdd(r.name)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => onChange(addVenue(value, r))}
              >
                <span className="font-medium text-slate-900">{r.name}</span>
                {r.address && <span className="block text-slate-600">{r.address}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
