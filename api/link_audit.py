"""Internal-link audit (R34): the site's link graph as visitors and search
engines see it, what's wrong with it, and which links to add.

Input is a rendered-site scan (lib/siteScan.js in the admin's browser, or
frontend-kit/acceptance/site-audit.mjs against the production build): for
every page, its internal links with the area they sit in (main content vs
header/footer/nav), their accessible text and rel, plus the page's H1 and main
text. One analyser, so the admin's "Internal links" report, the launch check
and the site-audit gate can never disagree.

    analyze(scan) -> {summary, pages, issues, suggestions}

It also checks primary keywords (kind "keywords"): every indexable page
except legal ones has its own, and no two pages share one.

issues: [{id, level: "fail"|"warn", path, text, fix}] — "fail" items fail
site-audit (R34). suggestions: [{from, to, anchor, reason}] — links worth
adding, used by the report and by the AI prompts (prompts.link_block).
"""

import re
from collections import deque

from .site_facts import db_facts, finalise, merge_scan, norm_path

MAX_DEPTH = 3                 # clicks from the home page
OFFERING_MIN_CONTEXT = 2      # distinct pages linking to an offering from their content
MAX_LINKS = 150               # internal links on one page before it dilutes them
PRIVATE = re.compile(r"^/(admin|api|_next)(/|$)")
GENERIC_ANCHORS = {
    "click here", "here", "read more", "learn more", "more", "find out more", "see more", "view more", "this",
    "link", "details", "continue", "continue reading", "go", "view", "see details", "more info",
    "more information", "this page", "this article", "read", "discover more", "explore",
}
EXEMPT_TYPES = {"home", "legal"}        # never need contextual links in
DEAD_END_OK = {"legal", "contact"}      # may have no contextual links out
STOP = {"the", "and", "for", "with", "your", "our", "you", "from", "that", "this", "what", "how", "why", "when",
        "are", "into", "about", "guide", "page", "services", "service", "home", "need", "know", "more", "best", "made",
        "simple", "complete", "important", "things", "everything", "tips", "ways"}


def _words(text):
    return [w for w in re.findall(r"[a-z0-9]+", str(text or "").lower()) if len(w) > 2 and w not in STOP]


def _brandless(title, brand):
    head = re.split(r"\s[|–—-]\s", str(title or ""))[0].strip()
    if brand and head.lower().endswith(brand.lower()):
        head = head[: -len(brand)].strip(" |–—-")
    return head


QUALIFIER = re.compile(r"\s+(?:for|in|near|with|across|from|to|and)\s+|\s*[–—:|,&]\s*", re.I)
LEAD_WORDS = {"monthly", "quarterly", "annual", "yearly", "weekly", "online", "professional", "expert", "complete",
              "simple", "easy", "affordable", "fast", "our", "your", "the", "a", "an"}


def _phrases(page, keyword, brand):
    """Anchor phrases another page's copy might already use for this page:
    its keyword, H1 and title, and their cores ("Weekly Garden Maintenance
    for Homeowners" → "Weekly Garden Maintenance" → "Garden Maintenance")."""
    out = []

    def add(candidate):
        candidate = re.sub(r"\s+", " ", str(candidate or "")).strip(" .:?!,")
        words = candidate.split()
        if (2 <= len(words) <= 7 and _words(candidate) and candidate.lower() not in [o.lower() for o in out]
                and candidate.lower() != (brand or "").lower()):  # the brand is mentioned everywhere: not an anchor
            out.append(candidate)

    for candidate in (keyword, page.get("h1"), _brandless(page.get("title"), brand)):
        candidate = str(candidate or "")
        add(candidate)
        for core in QUALIFIER.split(candidate)[:1] if candidate else []:  # the topic, not the subtitle
            add(core)
            words = core.split()
            while words and words[0].lower() in LEAD_WORDS:
                words = words[1:]
            add(" ".join(words))
    return out


def _site():
    from .models import PageSEO, Redirect, SiteSettings
    data = (SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}
    keywords = {}
    for row in PageSEO.objects.all():
        kw = str(((row.data or {}).get("keywords") or {}).get("primary") or "").strip()
        if kw:
            keywords[norm_path(row.path)] = kw
    redirects = {norm_path(r.source): norm_path(r.destination) for r in Redirect.objects.filter(is_active=True)
                 if r.destination.startswith("/")}
    return {"brand": str((data.get("organization") or {}).get("name") or "").strip(), "keywords": keywords, "redirects": redirects}


def analyze(scan, site=None):
    site = site or _site()
    raw_pages = [p for p in (scan or {}).get("pages") or [] if isinstance(p, dict) and p.get("path")]
    facts = finalise(merge_scan(db_facts(), {"pages": raw_pages}))
    from .tracking_library import offering_pages
    offerings = {norm_path(e["path"]) for _, e in offering_pages(facts)}
    types = {p["path"]: p["type"] for p in facts["pages"]}
    pages = {norm_path(p["path"]): p for p in raw_pages}
    articles = {path for path in pages if types.get(path) == "article"}
    redirects = site["redirects"]

    issues = []

    def issue(id_, level, path, text, fix, kind="links"):
        if (id_, path, text) not in seen_issues:  # repeated markup (mobile + desktop) reports once
            seen_issues.add((id_, path, text))
            issues.append({"id": id_, "level": level, "path": path, "text": text, "fix": fix, "kind": kind})

    inbound = {path: set() for path in pages}
    seen_issues = set()
    context_in = {path: set() for path in pages}
    context_out = {path: set() for path in pages}
    edges = {path: set() for path in pages}
    anchors = {}
    for path, page in pages.items():
        links = [l for l in page.get("links") or [] if isinstance(l, dict)]
        if len(links) > MAX_LINKS:
            issue("too-many-links", "warn", path, f"{len(links)} internal links on one page",
                  f"Keep it under {MAX_LINKS}: trim repeated menus and link lists.")
        for link in links:
            to = norm_path(link.get("to"))
            text = re.sub(r"\s+", " ", str(link.get("text") or "")).strip()
            area = link.get("area") or "main"
            if to == path or PRIVATE.match(to):
                continue  # the staff login and API aren't part of the public site
            if to in redirects:
                issue("redirected-link", "fail", path, f"links to {to}, which redirects to {redirects[to]}",
                      f"Point the link straight at {redirects[to]}.")
                to = redirects[to]
            if "nofollow" in str(link.get("rel") or "").lower() and to in pages:
                issue("nofollow-internal", "fail", path, f"internal link to {to} is rel=nofollow",
                      "Remove rel=nofollow from internal links; it throws the link away.")
            if to not in pages:
                issue("unlisted-target", "warn", path, f"links to {to}, which isn't in the sitemap",
                      "Add the page to the sitemap, or link to a page that is.")
                continue
            edges[path].add(to)
            inbound[to].add(path)
            if area == "main":
                context_in[to].add(path)
                context_out[path].add(to)
                if not text:
                    issue("empty-anchor", "fail", path, f"a link to {to} has no text",
                          "Give the link visible text or an aria-label that names the page.")
                elif text.lower().strip(" .…→›»") in GENERIC_ANCHORS:
                    issue("generic-anchor", "fail", path, f"“{text}” → {to} says nothing about the page",
                          "Use words that name the target (its topic or keyword), or add an aria-label that does.")
                else:
                    anchors.setdefault(text.lower(), set()).add(to)

    # Depth: breadth-first from the home page over every link.
    depth = {}
    if "/" in pages:
        depth["/"] = 0
        queue = deque(["/"])
        while queue:
            here = queue.popleft()
            for to in edges[here]:
                if to not in depth:
                    depth[to] = depth[here] + 1
                    queue.append(to)

    for path in pages:
        kind = types.get(path, "other")
        if path != "/" and not inbound[path]:
            issue("orphan", "fail", path, "no page links here", "Link it from its index page and from related pages.")
        elif path != "/" and path not in depth:
            issue("unreachable", "fail", path, "can't be reached by following links from the home page",
                  "Link it from a page that is reachable (its index, the home page or the footer).")
        elif depth.get(path, 0) > MAX_DEPTH:
            issue("too-deep", "fail", path, f"{depth[path]} clicks from the home page (max {MAX_DEPTH})",
                  "Link it from the home page, its index or a page closer to home.")
        if path in offerings and len(context_in[path]) < OFFERING_MIN_CONTEXT:
            issue("offering-few-links", "fail", path,
                  f"only {len(context_in[path])} page(s) link here from their content (need {OFFERING_MIN_CONTEXT})",
                  "Link it from its index cards and from the home page or a related guide, in the copy.")
        elif kind == "article" and not context_in[path]:
            issue("article-no-links", "fail", path, "no page links here from its content (menus don't count)",
                  "List it on the blog index and link it from related articles or the offering it supports.")
        elif kind not in EXEMPT_TYPES and path not in offerings and kind != "article" and not context_in[path]:
            issue("no-contextual-links", "warn", path, "only menus link here",
                  "Link it from the content of a related page.")
        if path in articles and offerings and not (context_out[path] & offerings):
            issue("article-to-offering", "fail", path, "doesn't link to any offering page from its content",
                  "Link the offering this article supports, with the offering's name as the anchor.")
        if path in offerings and articles and not (context_out[path] & articles):
            issue("offering-to-article", "fail", path, "doesn't link to any article from its content",
                  "Link its related guide (hero secondary button or a sentence in the copy).")
        if kind not in DEAD_END_OK and not context_out[path] and path != "/":
            issue("dead-end", "warn", path, "no links out from its content", "Link the next step: a related page or the contact page.")
    # Keywords: every page that should rank has its own primary keyword
    # (SEO → Essentials); two pages chasing one keyword compete (cannibalise).
    by_keyword = {}
    for path in pages:
        if types.get(path) == "legal":
            continue
        kw = str(site["keywords"].get(path) or "").strip()
        if not kw:
            issue("no-keyword", "fail", path, "no primary keyword",
                  "Set one in SEO → Essentials (Ask AI proposes one from the page): the words people search for this page's topic.", "keywords")
        else:
            by_keyword.setdefault(re.sub(r"\s+", " ", kw.lower()), []).append(path)
    for kw, paths in by_keyword.items():
        if len(paths) > 1:
            issue("shared-keyword", "fail", ", ".join(sorted(paths)), f"{len(paths)} pages share the primary keyword “{kw}”",
                  "Give each page its own keyword (its specific topic); keep the broad one on the page that should rank for it.", "keywords")
    for text, targets in anchors.items():
        if len(targets) > 1:
            issue("mixed-anchor", "warn", ", ".join(sorted(targets)[:3]), f"the anchor “{text}” points to {len(targets)} different pages",
                  "Use one anchor text per target page so search engines know which page is about what.")

    # Suggestions: pages whose content already mentions another page's
    # keyword, H1 or title without linking to it.
    suggestions = []
    need = {p for p in pages if (p in offerings and len(context_in[p]) < OFFERING_MIN_CONTEXT + 1) or len(context_in[p]) < 2}
    targets = sorted(pages, key=lambda p: (p not in need, p not in offerings, len(context_in[p])))
    phrases = {to: _phrases(pages[to], site["keywords"].get(to), site["brand"]) for to in pages}
    owners = {}
    for to, items in phrases.items():
        for phrase in items:
            owners.setdefault(phrase.lower(), set()).add(to)
    for to in targets:
        if types.get(to) in EXEMPT_TYPES:
            continue
        made = 0
        for phrase in phrases[to]:
            if len(owners[phrase.lower()]) > 1:
                continue  # names more than one page: not a safe anchor
            pattern = re.compile(rf"(?<![\w-]){re.escape(phrase)}(?![\w-])", re.I)
            for frm, page in pages.items():
                if frm == to or to in context_out[frm] or types.get(frm) == "legal" or made >= 5:
                    continue
                if any(s["from"] == frm and s["to"] == to for s in suggestions):
                    continue
                m = pattern.search(str(page.get("text") or ""))
                if m:
                    suggestions.append({"from": frm, "to": to, "anchor": m.group(0),
                                        "reason": "it mentions this page's topic" + (" (an offering with few links)" if to in offerings and to in need else "")})
                    made += 1
        if len(suggestions) >= 150:
            break

    page_rows = [{"path": p, "type": types.get(p, "other"), "title": pages[p].get("title") or "", "offering": p in offerings,
                  "inbound": len(inbound[p]), "contextualInbound": len(context_in[p]), "contextualOutbound": len(context_out[p]),
                  "depth": depth.get(p)} for p in sorted(pages)]
    fails = [i for i in issues if i["level"] == "fail"]
    return {
        "summary": {"pages": len(pages), "links": sum(len(e) for e in edges.values()), "fail": len(fails),
                    "warn": len(issues) - len(fails), "orphans": sum(1 for i in issues if i["id"] == "orphan"),
                    "suggestions": len(suggestions),
                    "avgContextualInbound": round(sum(len(v) for v in context_in.values()) / len(pages), 1) if pages else 0},
        "pages": page_rows, "issues": issues, "suggestions": suggestions,
    }


def latest():
    """The analysis of the last stored site scan (Site tools → SEO → Internal links)."""
    from .models import TrackingScan
    scan = TrackingScan.objects.filter(pk=1).first()
    if not scan or not any((p or {}).get("links") is not None for p in (scan.data or {}).get("pages") or []):
        return None
    out = analyze(scan.data)
    out["scannedAt"] = scan.scanned_at.isoformat() if scan.scanned_at else None
    return out


def suggestions_for(path, limit=8):
    """Links worth adding FROM this page (for the AI prompts)."""
    result = latest()
    if not result:
        return [], []
    p = norm_path(path)
    picks = [s for s in result["suggestions"] if s["from"] == p][:limit]
    titles = {row["path"]: row["title"] for row in result["pages"]}
    return picks, [(row["path"], titles[row["path"]]) for row in result["pages"]
                   if row["offering"] or row["type"] in ("article", "index", "contact")]
