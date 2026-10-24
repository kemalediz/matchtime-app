"use client";

/**
 * A pool tick box (slice L3): "I am 18 or over" and the consent, unticked
 * until he ticks them, with its error under it (aria-invalid,
 * aria-describedby). The same markup as the /play form's own ticks
 * (src/app/play/play-signup.tsx), which can switch to this one.
 */
import { useId } from "react";

export function PoolTick({ checked, onChange, label, error }: { checked: boolean; onChange: (v: boolean) => void; label: string; error?: string }) {
  const errId = useId();
  return (
    <div>
      <label className="flex items-start gap-3 text-sm text-slate-900">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          {...(error ? { "aria-invalid": true, "aria-describedby": errId } : {})}
        />
        <span>{label}</span>
      </label>
      {error && (
        <p id={errId} className="mt-1 pl-8 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
