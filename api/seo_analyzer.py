"""SEO audit engine.

`analyze_page(path, html=None, url=None)` reads the PageSEO row (and, for a
blog/<slug> path, the BlogPost) and produces:

    {
      overall, technical_score, content_score, metadata_score, schema_score,
      checks: [ {id, category, label, passed, weight, message, fix,
                 # UI-compat aliases:
                 name, pass, status, details} ],
      issues: [ ...failed checks... ],
    }

When `html` is supplied (POST body), live-DOM checks are added on top of the
stored-metadata checks. No external requests are made.
"""

import json
import re
from collections import Counter
from html.parser import HTMLParser

TECHNICAL, CONTENT, METADATA, SCHEMA = "technical", "content", "metadata", "schema"

DEFAULT_MIN_WORDS = 300
BLOG_MIN_WORDS = 600


def _check(id_, category, label, passed, message, fix="", weight=1):
    return {
        "id": id_,
        "category": category,
        "label": label,
        "passed": bool(passed),
        "weight": weight,
        "message": message,
        "fix": fix,
        # aliases so any existing UI renders it
        "name": label,
        "pass": bool(passed),
        "status": "pass" if passed else "fail",
        "details": message,
    }


# ----------------------------------------------------------------- DOM parsing

class _DOM(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self.h1s = []
        self.headings = []  # (level, text)
        self._cur = None
        self._buf = []
        self.metas = []  # dicts of attrs
        self.links = []  # (href, text, rel)
        self._a = None
        self.images = []  # dicts of attrs
        self.jsonld = []  # raw strings
        self._in_ld = False
        self.has_viewport = False
        self.has_favicon = False
        self.lang = ""
        self.text_words = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html" and a.get("lang"):
            self.lang = a["lang"]
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            self.metas.append(a)
            if a.get("name") == "viewport":
                self.has_viewport = True
        if tag == "link":
            rel = (a.get("rel") or "").lower()
            if "icon" in rel:
                self.has_favicon = True
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._cur = int(tag[1])
            self._buf = []
        if tag == "a":
            self._a = {"href": a.get("href", ""), "rel": (a.get("rel") or ""), "text": []}
        if tag == "img":
            self.images.append(a)
        if tag == "script" and (a.get("type") == "application/ld+json"):
            self._in_ld = True
            self._buf = []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") and self._cur:
            text = "".join(self._buf).strip()
            self.headings.append((self._cur, text))
            if self._cur == 1:
                self.h1s.append(text)
            self._cur = None
        if tag == "a" and self._a is not None:
            self._a["text"] = "".join(self._a["text"]).strip()
            self.links.append(self._a)
            self._a = None
        if tag == "script" and self._in_ld:
            self.jsonld.append("".join(self._buf))
            self._in_ld = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._cur:
            self._buf.append(data)
        if self._in_ld:
            self._buf.append(data)
        if self._a is not None:
            self._a["text"].append(data)
        stripped = data.strip()
        if stripped:
            self.text_words.extend(re.findall(r"[A-Za-z']+", stripped))


# ----------------------------------------------------------------- text helpers

def _words(text):
    return re.findall(r"[A-Za-z']+", text or "")


def _sentences(text):
    return [s for s in re.split(r"[.!?]+", text or "") if s.strip()]


def _syllables(word):
    word = word.lower()
    groups = re.findall(r"[aeiouy]+", word)
    count = len(groups)
    if word.endswith("e"):
        count -= 1
    return max(count, 1)


def flesch_reading_ease(text):
    words = _words(text)
    sentences = _sentences(text)
    if not words or not sentences:
        return None
    syl = sum(_syllables(w) for w in words)
    return round(206.835 - 1.015 * (len(words) / len(sentences)) - 84.6 * (syl / len(words)), 1)


# ----------------------------------------------------------------- checks

def _metadata_checks(d):
    out = []
    title = str(d.get("seoTitle") or "").strip()
    out.append(_check("title-present", TECHNICAL, "Title tag", bool(title),
                      "Title is set." if title else "No SEO title.",
                      "Set a 50–60 character title."))
    if title:
        n = len(title)
        out.append(_check("title-length", CONTENT, "Title length", 50 <= n <= 60,
                          f"Title is {n} chars (guideline 50–60).",
                          "Aim for 50–60 characters."))
    desc = str(d.get("metaDescription") or "").strip()
    out.append(_check("desc-present", TECHNICAL, "Meta description", bool(desc),
                      "Description is set." if desc else "No meta description.",
                      "Write a 120–160 character description."))
    if desc:
        n = len(desc)
        out.append(_check("desc-length", CONTENT, "Description length", 120 <= n <= 160,
                          f"Description is {n} chars (guideline 120–160).",
                          "Aim for 120–160 characters."))

    canonical = str(d.get("canonicalUrl") or "").strip()
    canonical_self = d.get("canonicalSelf", True)
    out.append(_check("canonical-present", TECHNICAL, "Canonical URL",
                      bool(canonical) or bool(canonical_self),
                      "Canonical is configured." if (canonical or canonical_self)
                      else "No canonical URL and canonicalSelf is off.",
                      "Set canonicalUrl or leave canonicalSelf true."))
    if canonical:
        ok = canonical.startswith("https://")
        out.append(_check("canonical-absolute", TECHNICAL, "Canonical is absolute https",
                          ok, "Canonical is an absolute https URL." if ok
                          else "Canonical should be an absolute https URL.",
                          "Use a full https:// URL."))

    robots = d.get("robots") or {}
    noindex = robots.get("index") is False
    out.append(_check("robots-indexable", TECHNICAL, "Page is indexable", not noindex,
                      "Page is not set to noindex." if not noindex
                      else "Page is set to noindex — it will be dropped from search.",
                      "Set robots.index true unless this page must be hidden."))

    sitemap = d.get("sitemap") or {}
    out.append(_check("sitemap-include", TECHNICAL, "Included in sitemap",
                      sitemap.get("include", True),
                      "Page is included in the sitemap." if sitemap.get("include", True)
                      else "Page is excluded from the sitemap.",
                      "Set sitemap.include true."))

    social = d.get("social") or {}
    for key, label in (("ogTitle", "OG title"), ("ogDescription", "OG description"),
                       ("ogImage", "OG image"), ("ogImageAlt", "OG image alt")):
        val = str(social.get(key) or "").strip()
        out.append(_check(f"og-{key.lower()}", METADATA, label, bool(val),
                          f"{label} is set." if val else f"{label} is missing.",
                          f"Set social.{key}."))
    tw = str(social.get("twitterCard") or "summary_large_image")
    out.append(_check("twitter-card", METADATA, "Twitter card type",
                      tw in ("summary", "summary_large_image", "app", "player"),
                      f"Twitter card is '{tw}'.", "Use summary_large_image."))

    hreflang = d.get("hreflang") or []
    if hreflang:
        ok = all(isinstance(h, dict) and h.get("lang") and h.get("href") for h in hreflang)
        out.append(_check("hreflang-wellformed", METADATA, "hreflang well-formed", ok,
                          "All hreflang entries have lang + href." if ok
                          else "Some hreflang entries are missing lang or href.",
                          "Each entry needs {lang, href}."))
    return out


def _schema_checks(d, dom=None):
    out = []
    schema = d.get("schema") or {}
    raw = schema.get("data")
    builders = schema.get("builders") or []
    ld_blocks = []
    if isinstance(raw, dict) and raw:
        ld_blocks.append(raw)
    if dom:
        for block in dom.jsonld:
            try:
                ld_blocks.append(json.loads(block))
            except (ValueError, TypeError):
                out.append(_check("schema-valid-json", SCHEMA, "JSON-LD parses", False,
                                  "A JSON-LD <script> block is not valid JSON.",
                                  "Fix the JSON syntax."))

    has_any = bool(ld_blocks) or bool(builders) or schema.get("enabled")
    out.append(_check("schema-present", SCHEMA, "Structured data present", has_any,
                      "Structured data is configured." if has_any
                      else "No JSON-LD / structured data for this page.",
                      "Enable a schema builder or paste JSON-LD."))

    for block in ld_blocks:
        nodes = block.get("@graph") if isinstance(block, dict) and "@graph" in block else [block]
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict):
                continue
            t = node.get("@type")
            req = {
                "Organization": ["name"], "LocalBusiness": ["name", "address"],
                "Article": ["headline", "datePublished"],
                "BlogPosting": ["headline", "datePublished"],
                "Product": ["name"], "FAQPage": ["mainEntity"],
                "BreadcrumbList": ["itemListElement"], "Person": ["name"],
            }.get(t)
            if req:
                missing = [k for k in req if not node.get(k)]
                out.append(_check(f"schema-req-{t}".lower(), SCHEMA,
                                  f"{t} required props", not missing,
                                  f"{t} has all required props." if not missing
                                  else f"{t} is missing: {', '.join(missing)}.",
                                  f"Add {', '.join(missing)} to the {t} node." if missing else ""))
    return out


def _content_checks(d, dom=None, min_words=DEFAULT_MIN_WORDS):
    out = []
    fk = str(d.get("focusKeyword") or "").strip().lower()
    title = str(d.get("seoTitle") or "").lower()
    desc = str(d.get("metaDescription") or "").lower()
    out.append(_check("focus-keyword", CONTENT, "Focus keyword set", bool(fk),
                      "A focus keyword is set." if fk else "No focus keyword.",
                      "Set focusKeyword."))
    if fk:
        out.append(_check("fk-in-title", CONTENT, "Keyword in title", fk in title,
                          "Focus keyword appears in the title." if fk in title
                          else "Focus keyword is not in the title.", "Include it in the title."))
        out.append(_check("fk-in-desc", CONTENT, "Keyword in description", fk in desc,
                          "Focus keyword appears in the description." if fk in desc
                          else "Focus keyword is not in the description.",
                          "Include it in the meta description."))

    if dom:
        body_text = " ".join(dom.text_words)
        wc = len(dom.text_words)
        out.append(_check("word-count", CONTENT, "Content length", wc >= min_words,
                          f"~{wc} words (threshold {min_words}).",
                          f"Add content — aim for {min_words}+ words."))
        out.append(_check("single-h1", TECHNICAL, "Exactly one H1", len(dom.h1s) == 1,
                          f"Found {len(dom.h1s)} H1 tags.", "Use exactly one H1."))
        out.append(_check("heading-order", TECHNICAL, "No heading-level gaps",
                          _no_heading_gaps(dom.headings),
                          "Heading levels increase without gaps." if _no_heading_gaps(dom.headings)
                          else "Heading levels skip (e.g. H2 -> H4).", "Don't skip heading levels."))
        internal = [l for l in dom.links if l["href"].startswith("/") or l["href"].startswith("#")]
        external = [l for l in dom.links if l["href"].startswith("http")]
        out.append(_check("internal-links", CONTENT, "Has internal links", len(internal) >= 1,
                          f"{len(internal)} internal link(s).", "Add links to related pages."))
        out.append(_check("link-text", CONTENT, "Links have anchor text",
                          all(l["text"] for l in dom.links) if dom.links else True,
                          "All links have descriptive text." if all(l["text"] for l in dom.links)
                          else "Some links have empty anchor text.", "Give every link text."))
        no_alt = [i for i in dom.images if not (i.get("alt") or "").strip()]
        out.append(_check("image-alt", TECHNICAL, "Image alt coverage",
                          len(no_alt) == 0,
                          "All images have alt text." if not no_alt
                          else f"{len(no_alt)} image(s) missing alt text.",
                          "Add alt text to every content image."))
        if fk and dom.h1s:
            out.append(_check("fk-in-h1", CONTENT, "Keyword in H1",
                              any(fk in h.lower() for h in dom.h1s),
                              "Focus keyword is in the H1." if any(fk in h.lower() for h in dom.h1s)
                              else "Focus keyword is not in the H1.", "Include it in the H1."))
        if fk and wc:
            density = 100 * body_text.lower().count(fk) / max(wc, 1)
            out.append(_check("kw-density", CONTENT, "Keyword density", 0.5 <= density <= 2.5,
                              f"Density ~{density:.1f}% (target 0.5–2.5%).",
                              "Adjust keyword usage."))
        ease = flesch_reading_ease(body_text)
        if ease is not None:
            out.append(_check("readability", CONTENT, "Reading ease", ease >= 50,
                              f"Flesch reading ease {ease} ({_flesch_bucket(ease)}).",
                              "Shorten sentences and words."))
        out.append(_check("viewport", TECHNICAL, "Viewport meta present", dom.has_viewport,
                          "Viewport meta tag present." if dom.has_viewport
                          else "No viewport meta tag.", "Add <meta name=viewport>."))
        out.append(_check("favicon", TECHNICAL, "Favicon present", dom.has_favicon,
                          "Favicon link present." if dom.has_favicon else "No favicon link.",
                          "Add a <link rel=icon>."))
        out.append(_check("lang-attr", TECHNICAL, "html lang set", bool(dom.lang),
                          f"lang='{dom.lang}'." if dom.lang else "No lang attribute on <html>.",
                          "Set <html lang>."))
        mixed = [i for i in dom.images if (i.get("src") or "").startswith("http://")]
        out.append(_check("mixed-content", TECHNICAL, "No mixed content", not mixed,
                          "No http:// resources." if not mixed else f"{len(mixed)} http:// image(s).",
                          "Serve all resources over https."))
    return out


def _no_heading_gaps(headings):
    levels = [lvl for lvl, _ in headings]
    for prev, cur in zip(levels, levels[1:]):
        if cur - prev > 1:
            return False
    return True


def _flesch_bucket(score):
    if score >= 90:
        return "very easy"
    if score >= 70:
        return "easy"
    if score >= 50:
        return "fairly hard"
    if score >= 30:
        return "difficult"
    return "very difficult"


def _duplicate_checks(d, path):
    from .models import PageSEO
    out = []
    title = str(d.get("seoTitle") or "").strip().lower()
    desc = str(d.get("metaDescription") or "").strip().lower()
    if title:
        dupes = [r.path for r in PageSEO.objects.exclude(path=path)
                 if str((r.data or {}).get("seoTitle") or "").strip().lower() == title]
        out.append(_check("dup-title", CONTENT, "Title is unique", not dupes,
                          "Title is unique across pages." if not dupes
                          else f"Title duplicated on: {', '.join(dupes[:5])}.",
                          "Make every page title unique."))
    if desc:
        dupes = [r.path for r in PageSEO.objects.exclude(path=path)
                 if str((r.data or {}).get("metaDescription") or "").strip().lower() == desc]
        out.append(_check("dup-desc", CONTENT, "Description is unique", not dupes,
                          "Description is unique." if not dupes
                          else f"Description duplicated on: {', '.join(dupes[:5])}.",
                          "Make every meta description unique."))
    return out


def analyze_page(path, html=None, url=None):
    from .models import BlogPost, PageSEO

    path = (path or "").strip("/")
    row = PageSEO.objects.filter(path=path).first()
    d = (row.data if row else {}) or {}

    min_words = DEFAULT_MIN_WORDS
    if path.startswith("blog/"):
        min_words = BLOG_MIN_WORDS

    dom = None
    if html:
        dom = _DOM()
        try:
            dom.feed(html)
        except Exception:
            dom = None

    checks = []
    checks += _metadata_checks(d)
    checks += _schema_checks(d, dom)
    checks += _content_checks(d, dom, min_words)
    checks += _duplicate_checks(d, path)

    scores = {}
    for cat in (TECHNICAL, CONTENT, METADATA, SCHEMA):
        cat_checks = [c for c in checks if c["category"] == cat]
        if not cat_checks:
            scores[cat] = 100
            continue
        got = sum(c["weight"] for c in cat_checks if c["passed"])
        total = sum(c["weight"] for c in cat_checks)
        scores[cat] = round(100 * got / total) if total else 100

    overall = round(sum(scores.values()) / 4)
    return {
        "path": path,
        "overall": overall,
        "score": overall,
        "technical_score": scores[TECHNICAL],
        "content_score": scores[CONTENT],
        "metadata_score": scores[METADATA],
        "schema_score": scores[SCHEMA],
        "checks": checks,
        "issues": [c for c in checks if not c["passed"]],
    }
