#!/usr/bin/env python3
"""Refresh frontend-kit/src from a reference Next.js frontend that already runs the kit.

    python frontend-kit/sync_kit.py /path/to/frontend        # copies into frontend-kit/src

The manifest below is the single list of kit files. CORE files are copied
verbatim and must stay site-agnostic (the script fails if a brand string leaks
in). ADAPT files carry one site-specific hook each; MANIFEST.md says what to
change. lib/brand.js is never copied — the kit ships a placeholder.
"""
import re
import shutil
import sys
from pathlib import Path

CORE = [
    "app/cms.css",
    "app/api/revalidate/route.js",
    "app/admin/layout.jsx",
    "app/admin/page.jsx",
    "app/admin/login/page.jsx",
    "app/admin/blog/page.jsx",
    "app/admin/images/page.jsx",
    "app/admin/pages/page.jsx",
    "app/admin/redirects/page.jsx",
    "app/admin/seo/page.jsx",
    "app/admin/settings/page.jsx",
    "app/admin/sitemap/page.jsx",
    "app/admin/submissions/page.jsx",
    "app/admin/tracking/page.jsx",
    "app/admin/contacts/page.jsx",
    "components/admin/AdminShell.jsx",
    "components/admin/contacts/ContactsPanel.jsx",
    "components/admin/tracking/ChecksTab.jsx",
    "components/admin/tracking/describe.js",
    "components/admin/tracking/PlanEditor.jsx",
    "components/admin/tracking/ToolsTab.jsx",
    "components/admin/tracking/TrackingPanel.jsx",
    "components/admin/tracking/ui.jsx",
    "components/admin/useApi.js",
    "components/cms/AdminBar.jsx",
    "components/cms/AdminProvider.jsx",
    "components/cms/ai.jsx",
    "components/cms/CmsDataProvider.jsx",
    "components/cms/CmsSection.jsx",
    "components/cms/CollectionPanel.jsx",
    "components/cms/CreatePage.jsx",
    "components/cms/Drawer.jsx",
    "components/cms/FieldEditor.jsx",
    "components/cms/floating.jsx",
    "components/cms/inline.jsx",
    "components/cms/PageAssist.jsx",
    "components/cms/SectionEditor.jsx",
    "components/cms/SeoEditPanel.jsx",
    "components/cms/SiteTools.jsx",
    "components/cms/useCms.jsx",
    "components/dynamic/DynamicPageAdmin.jsx",
    "components/dynamic/DynamicPageRenderer.jsx",
    "components/dynamic/edit-context.jsx",
    "components/dynamic/EditableParagraphs.jsx",
    "components/dynamic/HeaderSpacer.jsx",
    "components/dynamic/interactive.jsx",
    "components/dynamic/media.js",
    "components/dynamic/registry.js",
    "components/dynamic/sections.jsx",
    "components/dynamic/SectionSlot.jsx",
    "components/seo/Analytics.jsx",
    "components/seo/AnalyticsEvents.jsx",
    "components/seo/ConsentBanner.jsx",
    "components/seo/ConsentedTags.jsx",
    "components/seo/VerifyHarness.jsx",
    "components/seo/JsonLd.jsx",
    "components/seo/PageSeo.jsx",
    "components/seo/RawHtmlInjector.jsx",
    "lib/api.js",
    "lib/bgImage.js",
    "lib/cms.js",
    "lib/consent.js",
    "lib/forms.js",
    "lib/intentProfile.js",
    "lib/keywords.js",
    "lib/seoChecks.js",
    "middleware.js",
    "lib/seo.js",
    "lib/siteScan.js",
    "lib/track.js",
    "lib/trackCapture.js",
    "lib/visibility.js",
]
# Gate scripts live in <frontend>/scripts and frontend-kit/scripts; they are
# copied too, so the kit's gates never drift from the reference site's.
SCRIPTS = ["check-inline.mjs", "check-sections.mjs"]
ADAPT = [
    "components/cms/BlogPostEditor.jsx",
    "components/cms/DraftPreview.jsx",
    "components/dynamic/DynamicContentPage.jsx",
    "lib/blog.js",
]
BRAND = '''// The site's display name — used in titles, the admin UI and defaults.
// Set NEXT_PUBLIC_SITE_NAME, or replace the fallback below.
export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || "My Site";
'''


def main(frontend):
    src_root = Path(frontend).resolve() / "src"
    out_root = Path(__file__).resolve().parent / "src"
    if not src_root.is_dir():
        sys.exit(f"{src_root} not found")
    brand = None
    brand_file = src_root / "lib/brand.js"
    if brand_file.exists():
        m = re.search(r'\|\|\s*"([^"]+)"', brand_file.read_text())
        brand = m.group(1) if m else None
    if out_root.exists():
        shutil.rmtree(out_root)
    leaks = []
    for rel in CORE + ADAPT:
        src = src_root / rel
        if not src.exists():
            sys.exit(f"missing kit file in reference frontend: {rel}")
        text = src.read_text()
        if rel in CORE and brand and brand.split()[0] in text:
            leaks.append(rel)
        dest = out_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text)
    (out_root / "lib/brand.js").write_text(BRAND)
    scripts_out = out_root.parent / "scripts"
    for name in SCRIPTS:
        src = Path(frontend).resolve() / "scripts" / name
        if not src.exists():
            sys.exit(f"missing gate script in reference frontend: scripts/{name}")
        (scripts_out / name).write_text(src.read_text())
    if leaks:
        sys.exit("brand string leaked into CORE files (use SITE_NAME from lib/brand):\n  " + "\n  ".join(leaks))
    print(f"kit refreshed: {len(CORE)} core + {len(ADAPT)} adapt files + {len(SCRIPTS)} gate scripts -> {out_root.parent}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
