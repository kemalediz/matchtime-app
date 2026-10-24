"use client";

/**
 * "Group invite link" (pool L8), its own card on /admin/settings: how
 * MatchTime gets the WhatsApp group's invite link it sends to a guest the
 * club and he both said yes to. Option A, MatchTime as a group admin, makes
 * it itself; option B is a link pasted here once. Renders nothing for a
 * club that cannot invite guests (`loadInviteLinkSettings`). Loads and
 * saves through its own server actions (`app/actions/club-invite.ts`).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { inviteCopy } from "@/lib/i18n/pool-invite";
import { getInviteLinkSettings, setInviteLink } from "@/app/actions/club-invite";
import type { InviteLinkSettings } from "@/lib/pool/invite-link-settings";

export function GroupInviteLinkSection(props: { orgId: string; language: string | null | undefined }) {
  const c = inviteCopy(props.language);
  const [data, setData] = useState<InviteLinkSettings | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // A late answer from an earlier run of this effect must never overwrite
    // what the organiser has typed since.
    let live = true;
    getInviteLinkSettings(props.orgId)
      .then((r) => {
        if (!live) return;
        setData(r);
        setDraft(r?.link ?? "");
      })
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [props.orgId]);

  if (!data) return null;

  async function save(value: string) {
    setSaving(true);
    setError(null);
    try {
      const r = await setInviteLink(props.orgId, value);
      if (!r.ok) {
        setError(c.set_invalid);
        return;
      }
      setDraft(r.link ?? "");
      setData((d) => (d ? { ...d, link: r.link, mode: d.mode === "bot" ? "bot" : r.link ? "pasted" : "none" } : d));
      toast.success(r.link ? (r.sent > 0 ? `${c.set_saved} ${c.set_sent_waiting({ n: r.sent })}` : c.set_saved) : c.set_removed);
    } catch {
      setError(c.set_invalid);
    } finally {
      setSaving(false);
    }
  }

  const status = data.mode === "bot" ? c.set_status_bot : data.mode === "pasted" ? c.set_status_pasted : c.set_status_none;
  return (
    <section id="group-invite-link" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-20" data-testid="group-invite-link" data-setting="groupInviteLink" data-mode={data.mode}>
      <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-slate-500" aria-hidden />
        <h2 className="font-semibold text-slate-800">{c.set_title}</h2>
        <SettingInfo k="groupInviteLink" lang={props.language} />
      </div>
      <div className="p-4 sm:p-6 space-y-4">
        <p className="text-sm text-slate-600">{c.set_blurb}</p>
        <p data-testid="group-invite-link-status" className={`text-sm font-medium ${data.mode === "none" ? "text-amber-800" : "text-green-800"}`}>
          {status}
        </p>
        <ul className="space-y-2 text-sm text-slate-600 list-none">
          <li data-testid="group-invite-link-option-a" className="rounded-lg bg-slate-50 px-3 py-2">
            {c.set_option_bot}
          </li>
          <li data-testid="group-invite-link-option-b" className="rounded-lg bg-slate-50 px-3 py-2">
            {c.set_option_paste}
          </li>
        </ul>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft);
          }}
        >
          <label htmlFor="group-invite-link-input" className="block text-sm font-medium text-slate-700">
            {c.set_label}
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="group-invite-link-input"
              data-testid="group-invite-link-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://chat.whatsapp.com/..."
              value={draft}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "group-invite-link-error" : undefined}
              onChange={(e) => setDraft(e.target.value)}
              className="h-10 min-w-0 flex-1 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="group-invite-link-save"
                disabled={saving}
                className="h-10 px-4 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {c.set_save}
              </button>
              {data.link && (
                <button
                  type="button"
                  data-testid="group-invite-link-remove"
                  disabled={saving}
                  onClick={() => void save("")}
                  className="h-10 px-4 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {c.set_remove}
                </button>
              )}
            </div>
          </div>
          <p data-testid="group-invite-link-not-hq" className="text-xs text-slate-500">
            {c.set_not_hq}
          </p>
          {error && (
            <p id="group-invite-link-error" role="alert" data-testid="group-invite-link-error" className="text-sm text-red-700">
              {error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
