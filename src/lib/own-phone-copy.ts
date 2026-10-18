/** The words for an own-number refusal (own-phone-rules.ts), in the page's language. */
import type { Strings } from "./i18n/t";
import type { OwnPhoneRefusal } from "./own-phone-rules";

export function ownPhoneError(s: Strings, reason: OwnPhoneRefusal): string {
  switch (reason) {
    case "invalid":
      return s.own_err_invalid;
    case "locked":
      return s.own_err_locked;
    case "taken":
      return s.own_err_taken;
  }
}
