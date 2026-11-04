"use client";

/**
 * The SHORT /play form's fields (Kemal, 2026-11-04): his name, his postcode
 * area and the days he can play. Nothing else: the hours, formats and
 * level are asked later on WhatsApp (`src/lib/pool/details-rules.ts`), and
 * the manage page keeps the full form (`pool-profile-fields.tsx`).
 * Controlled: the parent holds the `ShortFormValue` (src/lib/pool/
 * short-form.ts, where each tap is defined) and the errors the validator
 * named. No wording here: `copy` is the page's.
 *
 * Built for a phone first: three answers, big tap targets, the days as one
 * row of chips that wraps.
 *
 * Accessibility: the days are a fieldset with a legend; every input has a
 * label; an error sits under its field, the field is aria-invalid and
 * names it with aria-describedby.
 */
import { useId } from "react";
import type { PoolPlayCopy } from "@/lib/i18n/pool-play";
import { WEEK_ORDER } from "@/lib/pool/form-state";
import { POOL_SIGNUP } from "@/lib/pool/rules";
import { toggleShortDay, type ShortFormValue } from "@/lib/pool/short-form";

export type ShortFieldErrorText = Partial<Record<"name" | "area" | "days", string>>;

const INPUT = "w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500";
const LABEL = "block text-base font-semibold text-slate-900";
const HINT = "mt-1 text-sm text-slate-600";
const CHIP =
  "inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:checked]:text-blue-900";

function ErrorLine({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="mt-2 text-sm font-medium text-red-700">
      {text}
    </p>
  );
}

export function PoolShortFields({
  value,
  onChange,
  copy,
  errors,
}: {
  value: ShortFormValue;
  onChange: (next: ShortFormValue) => void;
  copy: PoolPlayCopy;
  errors: ShortFieldErrorText;
}) {
  const id = useId();
  const err = (k: keyof ShortFieldErrorText) => `${id}-${k}-error`;
  const invalid = (k: keyof ShortFieldErrorText) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": err(k) } : {});
  const f = copy.fields;

  return (
    <div className="space-y-6" data-testid="pool-short-fields">
      <div>
        <label htmlFor={`${id}-name`} className={LABEL}>
          {f.nameLabel}
        </label>
        <p className={HINT}>{f.nameHint}</p>
        <input
          id={`${id}-name`}
          name="name"
          autoComplete="given-name"
          maxLength={POOL_SIGNUP.nameMax}
          className={`${INPUT} mt-2`}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          {...invalid("name")}
        />
        <ErrorLine id={err("name")} text={errors.name} />
      </div>

      <div>
        <label htmlFor={`${id}-district`} className={LABEL}>
          {f.districtLabel}
        </label>
        <p className={HINT}>{f.districtHint}</p>
        <input
          id={`${id}-district`}
          name="district"
          autoComplete="off"
          autoCapitalize="characters"
          inputMode="text"
          maxLength={4}
          className={`${INPUT} mt-2 max-w-[10rem] uppercase`}
          value={value.district}
          onChange={(e) => onChange({ ...value, district: e.target.value.toUpperCase() })}
          {...invalid("area")}
        />
        <ErrorLine id={err("area")} text={errors.area} />
      </div>

      <fieldset {...invalid("days")}>
        <legend className={LABEL}>{copy.signup.daysLegend}</legend>
        <p className={HINT}>{copy.signup.daysHint}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {WEEK_ORDER.map((day) => (
            <label key={day} className={CHIP}>
              <input type="checkbox" className="h-5 w-5" checked={value.days.includes(day)} onChange={() => onChange(toggleShortDay(value, day))} />
              {f.dayNames[day]}
            </label>
          ))}
        </div>
        <ErrorLine id={err("days")} text={errors.days} />
      </fieldset>
    </div>
  );
}
