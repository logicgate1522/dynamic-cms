"""The conversion library (R31): rules that turn site facts into a tracking
plan, so every site gets conversions that fit its business without anyone
writing them by hand.

    build_plan(facts) -> plan          deterministic; no AI needed
    classify_business(facts) -> pack   which business pack applies

Every rule checks it applies (no phone shown → no call conversion, no
articles → no read-depth conversion…) and carries a `rationale` the panel
shows as "why this is tracked". The AI prompt (prompts.tracking_plan_prompt)
starts from this output and refines it; tracking_plan.validate() holds both
to the same rules.
"""

import re

from .site_facts import norm_path

STOP = {"and", "the", "for", "our", "your", "with", "of", "to", "a", "an", "in", "on", "&", "tax", "return", "returns",
        "service", "services", "page", "uk", "online", "monthly", "quarterly", "annual", "yearly", "management"}

# Stage detectors: keyword sets matched against FAQ questions, CTA labels and
# block headings (lowercase, whole-word-ish). Each stage only enters the plan
# if the site has at least one signal for it.
STAGES = {
    "switching": {"label": "Switching provider", "strength": 3,
                  "keywords": ["switch", "move from", "moving from", "take over", "transfer", "change accountant", "change provider", "current provider", "leave my"],
                  "purpose": "People leaving another provider: show how easy the handover is"},
    "urgency": {"label": "Deadline or urgent need", "strength": 3,
                "keywords": ["deadline", "due", "late", "penalt", "urgent", "emergency", "same day", "today", "asap", "fine", "overdue"],
                "purpose": "People up against a deadline: lead with speed and reassurance"},
    "price": {"label": "Checking price", "strength": 2,
              "keywords": ["cost", "price", "pricing", "fee", "fees", "quote", "how much", "affordable", "budget"],
              "purpose": "Price checkers: explain how pricing works and offer a no-obligation quote"},
    "starting": {"label": "Just starting out", "strength": 1,
                 "keywords": ["do i need", "getting started", "get started", "new business", "first time", "starting a", "should i register", "register for"],
                 "purpose": "Early-stage visitors: nurture with guides before asking for a booking"},
    "hesitation": {"label": "Has concerns", "strength": 1,
                   "keywords": ["visit", "office", "secure", "security", "safe", "data", "privacy", "refund", "guarantee", "cancel", "contract", "in person", "remote"],
                   "purpose": "Visitors with doubts: answer them (security, remote working, commitment) in the ad itself"},
}

# Business packs, chosen from schema.org type + description words.
PACKS = {
    "professional_services": {"label": "Professional services", "types": {"AccountingService", "LegalService", "FinancialService", "ProfessionalService", "InsuranceAgency", "Attorney", "Notary", "RealEstateAgent", "EmploymentAgency"},
                              "words": ["accountant", "accounting", "solicitor", "lawyer", "legal", "consult", "advis", "tax", "bookkeep", "financial", "architect"]},
    "local_trades": {"label": "Local trades & home services", "types": {"HomeAndConstructionBusiness", "Plumber", "Electrician", "HVACBusiness", "Locksmith", "RoofingContractor", "GeneralContractor", "HousePainter", "MovingCompany", "AutoRepair", "CleaningService"},
                     "words": ["plumb", "electric", "builder", "roof", "clean", "repair", "install", "garage", "locksmith", "landscap", "removal"]},
    "clinic_health": {"label": "Clinic & health", "types": {"MedicalBusiness", "Dentist", "MedicalClinic", "Physician", "Optician", "Physiotherapy", "HealthAndBeautyBusiness", "VeterinaryCare"},
                      "words": ["clinic", "dental", "dentist", "therapy", "physio", "treatment", "patient", "health", "beauty", "aesthetic"]},
    "restaurant_venue": {"label": "Restaurant & venue", "types": {"Restaurant", "FoodEstablishment", "CafeOrCoffeeShop", "BarOrPub", "Bakery", "EventVenue", "LodgingBusiness", "Hotel"},
                         "words": ["restaurant", "menu", "dining", "cafe", "bar", "venue", "hotel", "table"]},
    "ecommerce": {"label": "Online shop", "types": {"Store", "OnlineStore", "ClothingStore", "ElectronicsStore"}, "words": ["shop", "store", "buy", "cart", "product"]},
    "saas": {"label": "Software product", "types": {"SoftwareApplication", "WebApplication"}, "words": ["saas", "platform", "app ", "software", "sign up", "free trial", "dashboard"]},
    "agency_portfolio": {"label": "Agency & studio", "types": set(), "words": ["agency", "studio", "development", "developer", "marketing", "design", "branding", "seo", "web design", "app development", "lead generation"]},
    "events": {"label": "Events", "types": {"Event", "EventVenue"}, "words": ["event", "ticket", "festival", "conference"]},
    "nonprofit": {"label": "Charity & non-profit", "types": {"NGO", "NonprofitOrganization"}, "words": ["charity", "donate", "volunteer", "non-profit", "nonprofit"]},
}

SERVICE_COLLECTION_RE = re.compile(r"service|product|solution|treatment|course|program|offer|package|practice", re.I)
WORK_COLLECTION_RE = re.compile(r"case|project|work|portfolio|stud(y|ies)|client", re.I)
SEGMENT_FIELD_RE = re.compile(r"type|industry|sector|role|size|who|business|company|customer|client", re.I)
INTENT_FIELD_RE = re.compile(r"service|interest|need|help|product|treatment|topic|enquiry|inquiry|project|looking", re.I)
BOOKING_RE = re.compile(r"book|appointment|consult|call|meeting|schedule|demo|date|time", re.I)


def slug_id(text, prefix=""):
    base = re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")
    base = re.sub(r"^\d+_?", "", base) or "item"
    out = f"{prefix}{base}"[:40].strip("_")
    return out if re.match(r"^[a-z]", out) else f"x_{out}"[:40]


def words(text):
    return [w for w in re.findall(r"[a-z0-9]+", str(text).lower()) if w not in STOP and len(w) > 2]


def keyword_hits(text, keywords):
    t = f" {str(text).lower()} "
    return [k for k in keywords if k in t]


def classify_business(facts):
    org = facts.get("org") or {}
    otype = org.get("type") or ""
    text = " ".join([org.get("name", ""), org.get("description", "")] + [p.get("title", "") for p in facts.get("pages", [])[:40]]).lower()
    scores = {}
    for key, pack in PACKS.items():
        score = 5 if otype in pack["types"] else 0
        score += sum(1 for w in pack["words"] if w in text)
        scores[key] = score
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else "generic"


def _match_option(options, title):
    """The form option that names this intent (token overlap), if any."""
    title_words = set(words(title))
    best, best_score = None, 0
    for opt in options:
        overlap = len(title_words & set(words(opt["label"]))) + len(title_words & set(words(opt["value"])))
        if overlap > best_score:
            best, best_score = opt, overlap
    return best if best_score else None


def _lead_forms(facts):
    return [f for f in facts["forms"] if any(x["type"] in ("email", "tel") or x["name"] in ("email", "phone") for x in f["fields"])]


def _intents(facts):
    """One intent per real offering: entries of a service-like collection,
    else the pages under a 'services' path, else none."""
    intents = []
    service_cols = [c for c in facts["collections"]
                    if c["hostKind"] != "blog" and (SERVICE_COLLECTION_RE.search(c["key"] + c["label"] + c.get("pageType", "")) or c.get("pageType") == "service")]
    entries = [(c, e) for c in service_cols for e in c["entries"]]
    if not entries:
        entries = [(None, {"path": p["path"], "title": p["title"]}) for p in facts["pages"]
                   if re.match(r"^/(services|products|solutions|treatments|what-we-do)/[^/]+$", p["path"])]
    lead_forms = _lead_forms(facts)
    used = set()
    for col, entry in entries:
        title = entry["title"].split("|")[0].strip() or entry["path"].rsplit("/", 1)[-1].replace("-", " ")
        iid = slug_id(entry["path"].rsplit("/", 1)[-1])
        while iid in used:
            iid = f"{iid}_2"[:40]
        used.add(iid)
        form_options = []
        for form in lead_forms:
            for field in form["fields"]:
                if field["options"] and (INTENT_FIELD_RE.search(field["name"]) or INTENT_FIELD_RE.search(field.get("label", ""))):
                    opt = _match_option(field["options"], title + " " + entry["path"])
                    if opt:
                        form_options.append({"form": form["name"], "field": field["name"], "option": opt["value"]})
        kw = sorted(set(words(title)) | set(words(entry["path"].rsplit("/", 1)[-1])))[:6]
        intents.append({
            "id": iid, "label": title[:60],
            "match": {"paths": [entry["path"]], "pathPrefixes": [], "blocks": [], "faqKeywords": kw, "formOptions": form_options},
            "value": 0, "rationale": f"“{title}” is one of the things you offer ({entry['path']}).", "createdBy": "library",
        })
    return intents


def _segments(facts):
    segments, used = [], set()
    for form in _lead_forms(facts):
        for field in form["fields"]:
            if field["type"] in ("select", "radio") and field["options"] and SEGMENT_FIELD_RE.search(field["name"] + " " + field.get("label", "")) \
                    and not INTENT_FIELD_RE.search(field["name"]):
                for opt in field["options"]:
                    if opt["value"].strip().lower() in ("other", "none", "prefer not to say", ""):
                        continue
                    sid = slug_id(opt["value"])
                    if sid in used:
                        continue
                    used.add(sid)
                    segments.append({"id": sid, "label": opt["label"][:60],
                                     "match": {"formOptions": [{"form": form["name"], "field": field["name"], "option": opt["value"]}],
                                               "blocks": [], "faqKeywords": words(opt["label"])[:4]},
                                     "rationale": f"Your form asks “{field.get('label') or field['name']}”, so leads can be grouped by it.",
                                     "createdBy": "library"})
    for sb in facts.get("segmentBlocks") or []:
        for label in sb.get("items") or []:
            sid = slug_id(label)
            match = next((s for s in segments if s["id"] == sid or set(words(s["label"])) & set(words(label))), None)
            if match:
                if sb["block"] not in match["match"]["blocks"]:
                    match["match"]["blocks"].append(sb["block"])
            elif sid not in used and len(segments) < 12:
                used.add(sid)
                segments.append({"id": sid, "label": label[:60], "match": {"formOptions": [], "blocks": [sb["block"]], "faqKeywords": words(label)[:4]},
                                 "rationale": f"“{label}” is a customer type named on {sb['path']}.", "createdBy": "library"})
    return segments


def _stages(facts):
    texts = [q["question"] for q in facts["faqs"]] + [c["label"] for c in facts.get("ctas") or []] + \
            [b.get("heading", "") for b in (facts.get("blocks") or {}).values()]
    stages = []
    for sid, spec in STAGES.items():
        hits = [t for t in texts if keyword_hits(t, spec["keywords"])]
        if sid == "price" and facts.get("pricing"):
            hits.append("pricing block")
        if not hits:
            continue
        stages.append({"id": sid, "label": spec["label"], "strength": spec["strength"],
                       "match": {"faqKeywords": spec["keywords"], "blocks": [p["block"] for p in facts.get("pricing") or []] if sid == "price" else []},
                       "rationale": f"{len(hits)} question(s)/section(s) on the site signal this, e.g. “{hits[0][:70]}”.",
                       "createdBy": "library"})
    return stages


def _conversion(cid, label, tier, event, where=None, meta=None, rationale="", tiktok=None):
    cid = cid[:37].rstrip("_")
    return {"id": cid, "label": label[:60], "tier": tier, "trigger": {"event": event, "where": where or {}},
            "value": {"mode": "none"}, "destinations": {"ga4": "key_event" if tier == "primary" else "event",
                                                       "meta": meta or ("Lead" if tier == "primary" else "custom"),
                                                       "tiktok": tiktok or ("SubmitForm" if tier == "primary" else None),
                                                       "googleAds": "import_from_ga4" if tier == "primary" else None,
                                                       "linkedin": "auto" if tier == "primary" else None},
            "enabled": True, "locked": False, "createdBy": "library", "rationale": rationale}


def _conversions(facts, intents, stages, pack):
    convs = []
    lead_forms = _lead_forms(facts)
    for form in lead_forms:
        is_booking = bool(BOOKING_RE.search(form["name"]) or any(x["type"] in ("date", "time", "datetime") for x in form["fields"])
                          or any(BOOKING_RE.search(p) for p in form["pages"]))
        cid = "lead" if len(lead_forms) == 1 else slug_id(form["name"], "lead_")
        label = ("Booking request" if is_booking else "Enquiry") + ("" if len(lead_forms) == 1 else f" ({form['name']})")
        convs.append(_conversion(cid, label, "primary", "generate_lead", {"form": form["name"]}, "Schedule" if is_booking else "Lead",
                                 f"The {form['name']} form is how visitors {'book' if is_booking else 'enquire'}."))
    for intent in intents:
        for fo in intent["match"]["formOptions"]:
            convs.append(_conversion(slug_id(intent["id"], "lead_"), f"Lead: {intent['label']}", "primary", "generate_lead",
                                     {"form": fo["form"], "field": fo["field"], "option": fo["option"]},
                                     "Lead", f"Leads who ticked “{fo['option']}”: see which service brings enquiries and run ads per service."))
            break
    if facts.get("ctaPages"):
        convs.append(_conversion("booking_intent", "Clicked to book / enquire", "secondary", "cta_click", {"ctaTargets": facts["ctaPages"]},
                                 rationale="A click towards the form shows intent even when they don't finish."))
    for form in lead_forms:
        convs.append(_conversion(slug_id(form["name"], "abandon_"), f"Started but didn't send ({form['name']})", "secondary", "form_abandon",
                                 {"form": form["name"]}, rationale="Shows where the form loses people (the last field reached is recorded)."))
    if intents:
        if len(intents) <= 6:
            for intent in intents:
                convs.append(_conversion(slug_id(intent["id"], "engaged_"), f"Engaged with {intent['label']}", "secondary", "service_engaged",
                                         {"intent": intent["id"]}, rationale="Read the page properly (30s or half-way): demand per offering before anyone books."))
        else:
            convs.append(_conversion("engaged_offering", "Engaged with an offering", "secondary", "service_engaged", {},
                                     rationale="Read an offering's page properly; the intent is in the event."))
    if facts.get("pricing"):
        convs.append(_conversion("pricing_seen", "Viewed pricing", "secondary", "section_view",
                                 {"blocks": sorted({p["block"] for p in facts["pricing"]})}, rationale="How many people need price reassurance."))
    for stage in stages:
        if stage["id"] in ("switching", "urgency", "price"):
            convs.append(_conversion(slug_id(stage["id"], "signal_"), f"Signal: {stage['label']}", "secondary", "faq_open",
                                     {"stage": stage["id"]}, rationale=STAGES[stage["id"]]["purpose"]))
    if facts["has"].get("articles"):
        convs.append(_conversion("guide_read", "Read a guide (75%)", "secondary", "scroll_depth", {"percent": 75, "pageType": "article"},
                                 rationale="Which content earns attention, and which guides lead to bookings."))
    channels = facts["channels"]
    if channels.get("phone"):
        convs.append(_conversion("call_click", "Tapped to call", "primary" if pack == "local_trades" else "secondary", "contact_click",
                                 {"method": "phone"}, "Contact", "Phone calls are leads too."))
    if channels.get("email"):
        convs.append(_conversion("email_click", "Clicked to email", "secondary", "contact_click", {"method": "email"}, "Contact"))
    if channels.get("whatsapp"):
        convs.append(_conversion("whatsapp_click", "Opened WhatsApp", "secondary", "contact_click", {"method": "whatsapp"}, "Contact"))
    if facts["has"].get("downloads"):
        convs.append(_conversion("download", "Downloaded a file", "secondary", "file_download", {}, rationale="Downloads show deeper interest."))
    for col in facts["collections"]:
        if WORK_COLLECTION_RE.search(col["key"] + col["label"]) and col["entries"]:
            convs.append(_conversion(slug_id(col["key"], "viewed_"), f"Viewed {col['plural'].lower()}", "secondary", "page_view",
                                     {"pathPrefix": col["pathPrefix"]}, rationale=f"Interest in your {col['plural'].lower()}."))
    seen, unique = set(), []
    for c in convs:
        if c["id"] not in seen:
            seen.add(c["id"])
            unique.append(c)
    return unique


def _audiences(facts, intents, stages, conversions):
    primary = [c["id"] for c in conversions if c["tier"] == "primary"]
    exclude = [{"conversion": cid} for cid in primary[:1]]
    auds = []
    for intent in intents:
        auds.append({"id": slug_id(intent["id"], "aud_"), "label": f"{intent['label']}: interested, not converted",
                     "purpose": f"Remind them about {intent['label'].lower()} and how to get started.",
                     "include": [{"event": "service_engaged", "intent": intent["id"]}], "exclude": exclude,
                     "windowDays": 30, "tools": ["ga4", "meta", "googleAds"], "createdBy": "library"})
    for stage in stages:
        auds.append({"id": slug_id(stage["id"], "aud_"), "label": f"{stage['label']}, not converted",
                     "purpose": STAGES[stage["id"]]["purpose"], "include": [{"event": "faq_open", "stage": stage["id"]}],
                     "exclude": exclude, "windowDays": 60 if stage["id"] == "switching" else 30,
                     "tools": ["ga4", "meta", "googleAds"], "createdBy": "library"})
    if facts["has"].get("articles"):
        auds.append({"id": "aud_readers", "label": "Guide readers", "purpose": "Nurture with more useful content before asking for a booking.",
                     "include": [{"event": "scroll_depth", "percent": 75}], "exclude": exclude, "windowDays": 90,
                     "tools": ["ga4", "meta"], "createdBy": "library"})
    if primary:
        auds.append({"id": "aud_converted", "label": "Already enquired (exclude)", "purpose": "Exclude from acquisition ads so you don't pay to reach people who already contacted you.",
                     "include": [{"conversion": primary[0]}], "exclude": [], "windowDays": 180,
                     "tools": ["ga4", "meta", "googleAds"], "createdBy": "library", "role": "exclusion"})
    return auds


def build_plan(facts, region=None):
    pack = classify_business(facts)
    intents = _intents(facts)
    segments = _segments(facts)
    stages = _stages(facts)
    conversions = _conversions(facts, intents, stages, pack)
    audiences = _audiences(facts, intents, stages, conversions)
    country = (facts.get("org") or {}).get("country") or ""
    return {
        "version": 0, "status": "draft", "pack": pack,
        "region": region or ("us" if country == "US" else "uk_eu" if country in EU_UK else "other"),
        "currency": (facts.get("org") or {}).get("currency") or "USD",
        "intents": intents, "segments": segments, "stages": stages,
        "conversions": conversions, "audiences": audiences, "valueRules": [],
        "facts": {"hash": facts.get("hash"), "at": None},
    }


EU_UK = {"GB", "IE", "DE", "FR", "ES", "IT", "NL", "BE", "AT", "PT", "FI", "SE", "DK", "PL", "CZ", "GR", "HU", "RO",
         "BG", "HR", "SK", "SI", "LT", "LV", "EE", "LU", "MT", "CY", "IS", "NO", "LI", "CH"}


def explain_tool(tool, plan):
    """'What it's for on this site' text for the Tracking panel's tool cards,
    built from the plan (so it names this business's own audiences)."""
    auds = [a for a in plan.get("audiences") or [] if a.get("role") != "exclusion"]
    prim = [c for c in plan.get("conversions") or [] if c.get("tier") == "primary" and c.get("enabled", True)]
    top = prim[0]["label"] if prim else "your main conversion"
    lines = {
        "ga4": [f"See which offerings, customer types and stages lead to “{top}”",
                "Reports by intent, segment and stage (custom dimensions are created for you)",
                "Audiences you can share with Google Ads"],
        "gtm": ["Manage any extra tags yourself; every CMS event and parameter is already in the data layer",
                "Download a ready-made container from this panel"],
        "meta": [f"Optimise Facebook/Instagram ads for “{top}”"] +
                [f"Retarget “{a['label']}”: {a['purpose']}" for a in auds[:3]] +
                ["Find lookalikes of people who converted"],
        "googleAds": [f"Count “{top}” from your search ads (imported from GA4)",
                      "Bid more for higher-value enquiries when you set values"] +
                     [f"Remarket to “{a['label']}”" for a in auds[:2]],
        "tiktok": [f"Optimise TikTok ads for “{top}”", "Retarget engaged visitors"],
        "linkedin": [f"Count “{top}” from LinkedIn ads", "Reach decision makers who visited (company-level reporting)"],
        "clarity": ["Watch recordings of where people stop on your forms", "Heatmaps of what gets clicked"],
        "hotjar": ["Heatmaps and recordings", "On-page surveys"],
    }
    return lines.get(tool, [])
