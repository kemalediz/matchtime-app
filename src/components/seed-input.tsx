"use client";

import { useState, type InputHTMLAttributes } from "react";
import { seedBoxValue } from "@/lib/default-seed";

/**
 * A seed box for forms that hold the seed in state (onboarding, finish
 * setup). An unset seed SHOWS as the default, 6 (`default-seed.ts`), so
 * the admin starts from a medium player and moves up or down.
 *
 * While the box has focus it keeps whatever the admin types, empty
 * included, so clearing the 6 to type a 7 does not snap back to 6. On
 * blur it shows the parent's value again. `onSeedChange(null)` means the
 * box was emptied: the seed stays unset, and is shown as 6 again.
 */
export function SeedInput({
  seed,
  onSeedChange,
  ...rest
}: {
  seed: number | null | undefined;
  onSeedChange: (value: number | null) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type">) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="number"
      min={1}
      max={10}
      step={1}
      value={editing ?? seedBoxValue(seed)}
      onFocus={(e) => {
        setEditing(e.target.value);
        rest.onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setEditing(raw);
        const n = parseInt(raw, 10);
        onSeedChange(isNaN(n) ? null : Math.min(10, Math.max(1, n)));
      }}
      onBlur={(e) => {
        setEditing(null);
        rest.onBlur?.(e);
      }}
    />
  );
}
