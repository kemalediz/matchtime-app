"use client";

/**
 * "Player pool" on /admin/settings (2026-10-28, decision log P.2): the
 * club's own switch for the MatchTime player pool (`featurePlayerPool`).
 * Owners and admins; shown only while the platform switch is on (the
 * action returns null otherwise). Switching off asks first: any pool ask
 * still open for the club's matches is closed. Style of play, "Ask the
 * player pool automatically" and "Tell your players about the player pool"
 * appear under it once it is on (`onChange` makes the page reload them).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { poolClubSwitchCopy } from "@/lib/i18n/pool-club-switch";
import { getClubPlayerPool, setClubPlayerPoolAction } from "@/app/actions/pool-club-switch";
import { playerPoolSummary } from "@/lib/settings-summaries";
import { SettingsCard } from "./settings-nav";

export function PlayerPoolSection(props: {
  orgId: string;
  language: string | null | undefined;
  onChange?: (on: boolean) => void;
  /** "Ask the player pool automatically", for the summary; null until known. */
  autoAsk?: boolean | null;
}) {
  const s = t(props.language);
  const c = poolClubSwitchCopy(props.language);
  const [on, setOn] = useState<boolean | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getClubPlayerPool(props.orgId)
      .then((r) => setOn(r ? r.on : undefined))
      .catch(() => setOn(undefined));
  }, [props.orgId]);

  if (on === undefined) return null;

  async function save(next: boolean) {
    if (!next && !window.confirm(c.confirmOff)) return;
    setSaving(true);
    try {
      const res = await setClubPlayerPoolAction(props.orgId, next);
      if (!res.ok) {
        toast.error(s.wr_save_failed);
        if (res.reason === "hidden") setOn(undefined);
        return;
      }
      setOn(res.on);
      toast.success(res.on ? c.savedOn : c.savedOff(res.closedAsks));
      props.onChange?.(res.on);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      id="player-pool"
      title={c.title}
      icon={Users}
      info={<SettingInfo k="playerPool" lang={props.language} />}
      summary={playerPoolSummary(props.language, { on, autoAsk: props.autoAsk ?? null })}
      testId="player-pool"
      rootProps={{ "data-setting": "playerPool" }}
    >
      <div className="p-4 sm:p-6 flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500" id="player-pool-blurb">
          {c.lead}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={c.title}
          aria-describedby="player-pool-blurb"
          data-testid="player-pool-switch"
          disabled={saving}
          onClick={() => void save(!on)}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-green-500" : "bg-slate-300"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>
    </SettingsCard>
  );
}
