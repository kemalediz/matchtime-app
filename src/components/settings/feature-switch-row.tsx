"use client";

/**
 * One feature switch on /admin/settings: a label with its ⓘ, a blurb, and
 * the switch. The rows of the old "Bot features" card, unchanged, now
 * placed in the card each belongs to (Attendance, Bench, Teams, Ratings
 * and stats, Man of the Match, Reminders, Payments) since 2026-10-28.
 */
import { SettingInfo } from "@/components/info/setting-info";
import type { SettingInfoKey } from "@/lib/settings-info";

export function FeatureSwitchRow(props: {
  settingKey: SettingInfoKey;
  label: React.ReactNode;
  blurb: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
  lang: string | null | undefined;
  /** The switch's hover text ("Enable" or "Disable"). */
  title: string;
  /** The switch's accessible name, where the row gives it one. */
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3" data-testid={props.testId} data-setting={props.settingKey}>
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
          <span>{props.label}</span>
          <SettingInfo k={props.settingKey} lang={props.lang} />
        </div>
        <p className="text-xs text-slate-500">{props.blurb}</p>
      </div>
      <button
        role="switch"
        aria-checked={props.on}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={props.onToggle}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
          props.on ? "bg-green-500" : "bg-slate-300"
        }`}
        title={props.title}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            props.on ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
