/**
 * Share a server-rendered PNG (a badge card, the Wrapped card) as an
 * IMAGE (Kemal, 2026-10-01).
 *
 * On a phone, `navigator.share({ files })` opens the share sheet with
 * the PNG attached, so WhatsApp is one tap away. Anywhere that cannot
 * share files (desktop, older browsers, or a share the browser refuses,
 * e.g. Safari's NotAllowedError when the tap's activation has lapsed
 * during the fetch) the PNG is downloaded instead and the caller shows a
 * short hint. A player who closes the share sheet did nothing wrong, so
 * that outcome is silent.
 *
 * Pure apart from the injected `deps`, so it is unit tested in node.
 */
export type ShareOutcome = "shared" | "cancelled" | "downloaded" | "failed";

export interface ShareRequest {
  url: string;
  filename: string;
  text: string;
}

interface ShareNavigator {
  canShare?: (data: { files?: File[]; text?: string }) => boolean;
  share?: (data: { files?: File[]; text?: string }) => Promise<void>;
}

export interface ShareDeps {
  fetchImage: (url: string) => Promise<Blob>;
  download: (blob: Blob, filename: string) => void;
  nav?: ShareNavigator;
}

export async function shareImage(req: ShareRequest, deps: ShareDeps): Promise<ShareOutcome> {
  let blob: Blob;
  try {
    blob = await deps.fetchImage(req.url);
  } catch {
    return "failed";
  }

  const file = new File([blob], req.filename, { type: blob.type || "image/png" });
  const nav = deps.nav;
  let canShareFiles = false;
  try {
    canShareFiles = !!nav?.share && !!nav.canShare && nav.canShare({ files: [file] });
  } catch {
    canShareFiles = false;
  }

  if (canShareFiles) {
    try {
      await nav!.share!({ files: [file], text: req.text });
      return "shared";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return "cancelled";
      // Anything else: fall through to the download.
    }
  }

  deps.download(blob, req.filename);
  return "downloaded";
}

/** Browser defaults for `shareImage`. */
export function browserShareDeps(): ShareDeps {
  return {
    fetchImage: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`image ${res.status}`);
      return res.blob();
    },
    download: (blob, filename) => {
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    },
    nav: typeof navigator !== "undefined" ? (navigator as ShareNavigator) : undefined,
  };
}
