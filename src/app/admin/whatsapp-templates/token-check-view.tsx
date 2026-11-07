/**
 * The owner page's "Access token check", shown from a `TokenCheck`
 * (`src/lib/cloud-api/token-check.ts`), which never carries a secret: what
 * Meta's debug_token says about the access token, whether the token can see
 * the official number, the read-only probes (one row per probe and Graph
 * version, Meta's error fields or the answer), and which settings are
 * present (length only). No
 * hooks. English only, as the rest of the owner's pages.
 */
import type { Probe, ProbeError, TokenCheck } from "@/lib/cloud-api/token-check";

const TH = "px-3 py-2 text-left font-medium text-slate-600";
const TD = "px-3 py-2 align-top text-slate-800";
const yesNo = (b: boolean | null) => (b === null ? "unknown" : b ? "yes" : "no");
const dash = (v: string | number | null) => (v === null || v === "" ? "none" : String(v));

function unixTime(v: number | null): string {
  if (v === null) return "none";
  if (v === 0) return "never (0)";
  return `${v} (${new Date(v * 1000).toISOString()})`;
}

function Rows({ rows, testId }: { rows: [string, string][]; testId: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm" data-testid={testId}>
        <tbody className="divide-y divide-slate-100">
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className={`${TH} w-64 font-mono`}>
                {k}
              </th>
              <td className={`${TD} break-all font-mono`}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Meta's error fields on one line: status, code, subcode, type, fbtrace_id, then the message. */
function probeErrorText(e: ProbeError): string {
  const parts = [
    e.status !== null ? `HTTP ${e.status}` : "no HTTP answer",
    e.code !== null && `code ${e.code}`,
    e.subcode !== null && `subcode ${e.subcode}`,
    e.type && `type ${e.type}`,
    e.fbtraceId && `fbtrace_id ${e.fbtraceId}`,
  ].filter(Boolean);
  return `${parts.join(", ")}: ${e.message}`;
}

function Probes({ probes }: { probes: Probe[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm" data-testid="wt-token-probes">
        <thead className="bg-slate-50">
          <tr>
            <th className={TH}>Probe</th>
            <th className={TH}>Version</th>
            <th className={TH}>Outcome</th>
            <th className={TH}>Result or Meta&apos;s error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {probes.map((p) => {
            const o = p.outcome;
            return (
              <tr key={`${p.id}@${p.version}`} data-testid="wt-probe" data-probe={p.id} data-version={p.version}>
                <td className={TD}>
                  <div>{p.label}</div>
                  <div className="break-all font-mono text-xs text-slate-500">{p.path}</div>
                </td>
                <td className={`${TD} font-mono`}>{p.version}</td>
                <td className={`${TD} ${o.state === "error" ? "text-red-700" : o.state === "ok" ? "text-emerald-700" : ""}`}>{o.state}</td>
                <td className={`${TD} break-all font-mono text-xs`}>
                  {o.state === "skipped" && o.reason}
                  {o.state === "error" && <span className="text-red-700">{probeErrorText(o.error)}</span>}
                  {o.state === "ok" && (
                    <>
                      {o.note && <div className="font-sans text-sm font-medium">{o.note}</div>}
                      <div>{o.result}</div>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Problem({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="text-sm text-red-700" data-testid={testId}>
      {text}
    </p>
  );
}

export function TokenCheckView({ check }: { check: TokenCheck }) {
  const { debug, phone } = check;
  return (
    <div className="space-y-6" data-testid="wt-token-check">
      <p className="max-w-2xl text-sm text-slate-600">
        What Meta says about WA_CLOUD_ACCESS_TOKEN, read on the server on Graph {check.graphVersion}. Only facts that are not secret are shown: the
        token and the app secret never leave the server.
      </p>

      <div className="space-y-2">
        <h4 className="font-medium text-slate-900">debug_token</h4>
        {debug.state === "skipped" && <p className="text-sm text-slate-700">Not asked: {debug.reason}</p>}
        {debug.state === "error" && <Problem text={debug.message} testId="wt-token-debug-error" />}
        {debug.state === "ok" && (
          <Rows
            testId="wt-token-debug"
            rows={[
              ["is_valid", yesNo(debug.info.isValid)],
              ["app_id", dash(debug.info.appId)],
              ["type", dash(debug.info.type)],
              ["application", dash(debug.info.application)],
              ["expires_at", unixTime(debug.info.expiresAt)],
              ["data_access_expires_at", unixTime(debug.info.dataAccessExpiresAt)],
              ["issued_at", unixTime(debug.info.issuedAt)],
              ["scopes", debug.info.scopes.length ? debug.info.scopes.join(", ") : "none"],
              ...debug.info.granularScopes.map(
                (g): [string, string] => [`granular: ${g.scope}`, g.targetIds === null ? "all targets (Meta lists none)" : g.targetIds.join(", ") || "none"],
              ),
              ["WA_CLOUD_WABA_ID among the targets", yesNo(debug.info.wabaInTargets)],
              ["user_id", dash(debug.info.userId)],
              [
                "error",
                debug.info.error
                  ? `${debug.info.error.code ?? ""}${debug.info.error.subcode != null ? ` / ${debug.info.error.subcode}` : ""}: ${debug.info.error.message}`
                  : "none",
              ],
            ]}
          />
        )}
      </div>

      <div className="space-y-2">
        <h4 className="font-medium text-slate-900">The official number, read with the token</h4>
        {phone.state === "skipped" && <p className="text-sm text-slate-700">Not asked: {phone.reason}</p>}
        {phone.state === "error" && <Problem text={phone.message} testId="wt-token-phone-error" />}
        {phone.state === "ok" && (
          <Rows
            testId="wt-token-phone"
            rows={[
              ["id", dash(phone.id)],
              ["display_phone_number", dash(phone.displayPhoneNumber)],
              ["verified_name", dash(phone.verifiedName)],
            ]}
          />
        )}
      </div>

      <div className="space-y-2">
        <h4 className="font-medium text-slate-900">Probes, read with the token (GET only)</h4>
        <p className="max-w-2xl text-sm text-slate-600">
          Each asked on Graph {check.graphVersion} and, where it can differ, on v27.0. An error shows Meta&apos;s own fields as it gave them.
        </p>
        <Probes probes={check.probes ?? []} />
      </div>

      <div className="space-y-2">
        <h4 className="font-medium text-slate-900">Settings (values never shown)</h4>
        <Rows
          testId="wt-token-whitespace"
          rows={[
            ["WA_CLOUD_ACCESS_TOKEN: leading or trailing whitespace", yesNo(check.token.outerWhitespace)],
            ["WA_CLOUD_ACCESS_TOKEN: newline", yesNo(check.token.newline)],
          ]}
        />
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm" data-testid="wt-token-env">
            <thead className="bg-slate-50">
              <tr>
                <th className={TH}>Setting</th>
                <th className={TH}>Present</th>
                <th className={TH}>Length</th>
                <th className={TH}>Whitespace around</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {check.env.map((e) => (
                <tr key={e.name}>
                  <td className={`${TD} font-mono`}>{e.name}</td>
                  <td className={TD}>{yesNo(e.present)}</td>
                  <td className={TD}>{e.length}</td>
                  <td className={TD}>{yesNo(e.outerWhitespace)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
