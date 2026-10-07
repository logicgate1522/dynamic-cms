import { getImageProps } from "next/image";

import { mediaUrl } from "@/lib/api";

/* =========================================
   CSS background images, optimised.
   `url('/images/x.png')` in a style ships the raw
   file (often 1–3 MB) to every visitor. bgImage()
   routes it through the Next.js image optimiser
   instead (AVIF/WebP, resized, cached) — the
   official getImageProps() route.

     style={{ backgroundImage: bgImage(data.backgroundImage) }}

   Works for site images and CMS uploads (the API
   host is in next.config images.remotePatterns).
   SVGs and data: URLs are used as-is.
========================================= */

export function bgImage(src, { width = 1920, quality = 75 } = {}) {
    const url = mediaUrl(src);
    if (!url) return "none";
    if (url.startsWith("data:") || /\.svg($|\?)/i.test(url)) return `url("${url}")`;
    try {
        const { props } = getImageProps({ src: url, alt: "", width, height: Math.round(width * 0.5625), quality });
        return `url("${props.src}")`;
    } catch {
        return `url("${url}")`;
    }
}
