"use client";

/**
 * "Admin messages go to" (slice 2a, 2026-09-30), a block inside the
 * "Weekly routine" section of /admin/settings.
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 5.
 *
 * Three choices: one person by DM (a picker of the owner and admins with a
 * phone, default the owner), the admins' WhatsApp group, or each admin by
 * DM. Choosing the group shows "Link admin group"; pressing it shows a
 * code and the three steps, and the section polls until the group is
 * linked, then shows "Linked: <group>" with Unlink. Until then the saved
 * choice stays what it was. Copy in the club's language (src/lib/i18n).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import type { Lang } from "@/lib/i18n/lang";
import type { AdminChannelStatus } from "@/lib/admin-channel";
import {
  createAdminGroupLinkCodeAction,
  getAdminChannelStatusAction,
  unlinkAdminGroupAction,
} from "@/app/actions/admin-channel";
import { setWeeklyRoutine } from "@/app/actions/org";

type Mode = AdminChannelStatus["mode"];
const POLL_MS = 4000;

export function AdminChannelSettings({ orgId, lang }: { orgId: string; lang: Lang }) {
  const s = t(lang);
  const [status, setStatus] = useState<AdminChannelStatus | null>(null);
  // What the organiser has picked on screen. "admin-group" can be picked
  // before a group is linked; it is only saved once one is.
  const [picked, setPicked] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getAdminChannelStatusAction(orgId);
    setStatus(next);
    return next;
  }, [orgId]);

  useEffect(() => {
    refresh().then((st) => st && setPicked(st.mode));
  }, [refresh]);

  // Poll while a code is on screen and no group is linked yet.
  const waiting = !!status?.code && !status.adminGroup;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const next = await refresh();
      if (next?.adminGroup) {
        setPicked(next.mode);
        toast.success(s.settings_admin_channel_linked({ group: next.adminGroup.subject ?? "WhatsApp" }));
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, refresh, s]);

  if (!status) return null;
  const mode = picked ?? status.mode;
  const owner = status.people.find((p) => p.role === "OWNER");

  async function choose(next: Mode, userId: string | null = status!.channelUserId) {
    setPicked(next);
    if (next === "admin-group" && !status!.adminGroup) return; // takes effect once linked
    setBusy(true);
    try {
      const res = await setWeeklyRoutine(orgId, {
        adminChannel: { mode: next, userId: next === "one-person" ? userId : null },
      });
      if (!res.ok) throw new Error(res.error);
      if (!res.adminChannel?.ok) throw new Error(res.adminChannel?.reason ?? "Failed");
      await refresh();
      toast.success(s.settings_admin_channel_saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
      setPicked(status!.mode);
    } finally {
      setBusy(false);
    }
  }

  async function linkGroup() {
    setBusy(true);
    try {
      await createAdminGroupLinkCodeAction(orgId);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await unlinkAdminGroupAction(orgId);
      const next = await refresh();
      if (next) setPicked(next.mode);
      toast.success(s.settings_admin_channel_unlinked);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const option = (value: Mode, label: string) => (
    <label key={value} className="flex items-center gap-3 py-1.5 cursor-pointer">
      <input
        type="radio"
        name="admin-channel"
        value={value}
        checked={mode === value}
        disabled={busy}
        onChange={() => choose(value)}
        className="h-4 w-4 text-blue-600"
      />
      <span className="text-sm text-slate-700">{label}</span>
    </label>
  );

  return (
    <div className="py-3 space-y-3" data-testid="admin-channel-section">
      <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
        {s.settings_admin_channel_heading}
        <InfoButton title={s.settings_admin_channel_heading}>
          <p>{s.settings_admin_channel_info}</p>
        </InfoButton>
      </div>
      <div className="space-y-4">
        <div role="radiogroup" aria-label={s.settings_admin_channel_heading}>
          {option("one-person", s.settings_admin_channel_mode_one_person)}
          {option("admin-group", s.settings_admin_channel_mode_admin_group)}
          {option("each-admin", s.settings_admin_channel_mode_each_admin)}
        </div>

        {mode === "one-person" && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="admin-channel-person">
              {s.settings_admin_channel_person_label}
            </label>
            <select
              id="admin-channel-person"
              value={status.channelUserId ?? ""}
              disabled={busy}
              onChange={(e) => choose("one-person", e.target.value || null)}
              className="h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">
                {s.settings_admin_channel_person_owner({ name: owner?.name ?? "" }).trim()}
              </option>
              {status.people
                .filter((p) => p.role !== "OWNER")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}
                  </option>
                ))}
            </select>
          </div>
        )}

        {mode === "admin-group" && status.adminGroup && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-slate-800" data-testid="admin-group-linked">
              {s.settings_admin_channel_linked({ group: status.adminGroup.subject ?? "WhatsApp" })}
            </span>
            <button
              type="button"
              onClick={unlink}
              disabled={busy}
              className="px-3 h-9 rounded-lg border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {s.settings_admin_channel_unlink}
            </button>
          </div>
        )}

        {mode === "admin-group" && !status.adminGroup && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={linkGroup}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
              >
                {status.code ? s.settings_admin_channel_link_again : s.settings_admin_channel_link_button}
              </button>
              <InfoButton title={s.settings_admin_channel_link_info_title}>
                <p>{s.settings_admin_channel_link_info}</p>
              </InfoButton>
            </div>
            {status.code && (
              <ol className="list-decimal pl-5 space-y-1.5 text-sm text-slate-700" data-testid="admin-group-steps">
                <li>{s.settings_admin_channel_step_code({ code: status.code.code })}</li>
                <li>{s.settings_admin_channel_step_add}</li>
                <li>
                  {s.settings_admin_channel_step_send}{" "}
                  <code className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 break-all">
                    {s.settings_admin_channel_command({ code: status.code.code })}
                  </code>
                </li>
              </ol>
            )}
            <p className="text-xs text-slate-500">
              {status.code ? `${s.settings_admin_channel_validity} ` : ""}
              {s.settings_admin_channel_pending_note}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
