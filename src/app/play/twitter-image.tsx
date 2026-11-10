/** X's picture for a shared /play link: the Open Graph one (2026-11-03). */
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { SHARE_IMAGE } from "@/lib/pool/share-image-layout";
import OpenGraphImage from "./opengraph-image";

export const alt = poolLinkPreviewCopy("en").imageAlt;
export const size = { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height };
export const contentType = "image/png";

export default function Image() {
  return OpenGraphImage();
}
