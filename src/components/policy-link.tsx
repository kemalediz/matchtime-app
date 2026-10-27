/**
 * A link to the privacy policy from inside a form: opens in a new tab, so
 * reading the policy never leaves the form (Kemal, 2026-10-27). `noopener`
 * but not `noreferrer`: the policy's back control reads the referrer to
 * close that tab and put him back on the form.
 */
import type { ReactNode } from "react";
import { PRIVACY_PATH } from "@/lib/privacy-policy";

export function PolicyLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a href={PRIVACY_PATH} target="_blank" rel="noopener" className={className}>
      {children}
    </a>
  );
}
