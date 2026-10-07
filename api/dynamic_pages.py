"""Section schema, AI-prompt generator, and parser for the dynamic page system.

SECTION_SCHEMA is the SINGLE source of truth. Both `build_ai_prompt` and
`parse_and_validate` read from it — never duplicate this dict. The section
type list is derived from its keys (no frozen DB enum), so adding a type is
a one-line change here with no migration.
"""

import json
import re

# type -> {field: "required" | "optional" | "required_list"}
# list/dict fields are checked for presence + basic shape only.
SECTION_SCHEMA = {
    "hero": {"heading": "required", "description": "required",
             "button_text": "optional", "button_href": "optional"},
    "rich_text": {"heading": "optional", "content": "required"},
    "image_text": {"heading": "required", "content": "required",
                   "image_position": "optional"},
    "cards": {"heading": "optional", "items": "required_list"},
    "features": {"heading": "optional", "items": "required_list"},
    "statistics": {"heading": "optional", "items": "required_list"},
    "testimonials": {"heading": "optional", "items": "required_list"},
    "faq": {"heading": "optional", "items": "required_list"},
    "gallery": {"heading": "optional", "items": "required_list"},
    "team": {"heading": "optional", "items": "required_list"},
    "timeline": {"heading": "optional", "items": "required_list"},
    "pricing": {"heading": "optional", "items": "required_list"},
    "logos": {"heading": "optional", "items": "required_list"},
    "steps": {"heading": "optional", "items": "required_list"},
    "cta": {"heading": "required", "description": "optional",
            "button_text": "required", "button_href": "optional"},
    "banner": {"text": "required", "link_text": "optional", "link_href": "optional"},
    "video": {"heading": "optional", "video_url": "required"},
    "contact_block": {"heading": "optional", "email": "optional",
                      "phone": "optional", "address": "optional"},
    "map_block": {"heading": "optional", "embed_url": "required"},
    "newsletter": {"heading": "required", "description": "optional",
                   "form_name": "optional"},
}

SECTION_TYPES = tuple(SECTION_SCHEMA.keys())

# Sections with a single top-level image slot (SectionMedia.slot="image").
SINGLE_IMAGE_SECTION_TYPES = {"hero", "image_text"}
# Sections whose `items` array carries a per-item image (slot="items[i].image").
PER_ITEM_IMAGE_SECTION_TYPES = {"gallery", "cards", "team", "logos", "steps", "timeline"}

VIDEO_HOST_PATTERN = re.compile(
    r"^https://(www\.)?(youtube\.com/embed/|youtu\.be/|player\.vimeo\.com/video/)",
    re.IGNORECASE,
)

RECOMMENDED_SIZE = {
    "hero": "1920x1080", "image_text": "1200x900", "gallery": "1200x800",
    "cards": "800x600", "team": "600x600", "logos": "400x200",
    "steps": "800x600", "timeline": "800x600",
}


# Placeholder content for a section an admin adds by hand (or a template
# slot the AI left out). Single source — the frontend reads it from
# GET ai/section-schema/ ("starters").
STARTER_CONTENT = {
    "hero": {"heading": "New heading", "description": "Describe the offer in one or two sentences.",
             "button_text": "Get started", "button_href": "/contact"},
    "rich_text": {"heading": "New section", "content": "Write the first paragraph here."},
    "image_text": {"heading": "New section", "content": "Write the copy here.", "image_position": "right"},
    "cta": {"heading": "Ready to get started?", "description": "", "button_text": "Contact us",
            "button_href": "/contact"},
    "banner": {"text": "Announcement text", "link_text": "", "link_href": ""},
    "video": {"heading": "", "video_url": "https://www.youtube.com/embed/"},
    "contact_block": {"heading": "Get in touch", "email": "", "phone": "", "address": ""},
    "map_block": {"heading": "Find us", "embed_url": "https://www.google.com/maps/embed?pb="},
    "newsletter": {"heading": "Stay in the loop", "description": "", "form_name": "newsletter"},
}
STARTER_ITEM = {
    "cards": {"title": "Card title", "description": "Card text", "href": ""},
    "features": {"title": "Feature", "description": "What it does"},
    "statistics": {"value": "100+", "label": "Label"},
    "testimonials": {"quote": "Quote", "author": "Name", "role": "Role", "rating": 5},
    "faq": {"question": "Question?", "answer": "Answer."},
    "gallery": {"caption": ""},
    "team": {"name": "Name", "role": "Role", "bio": ""},
    "timeline": {"date": "2026", "title": "Milestone", "description": ""},
    "pricing": {"name": "Plan", "price": "0", "period": "month", "features": ["Feature"],
                "button_text": "Choose", "button_href": "/contact"},
    "logos": {"name": "Partner"},
    "steps": {"title": "Step", "description": "What happens"},
}


def starter_content(section_type, items=1, heading=None):
    """Valid placeholder content for one section (list types get `items`
    placeholder entries, so a blank page keeps the layout of its siblings)."""
    import copy
    if section_type in STARTER_CONTENT:
        content = copy.deepcopy(STARTER_CONTENT[section_type])
    elif section_type in STARTER_ITEM:
        content = {"heading": "New section",
                   "items": [copy.deepcopy(STARTER_ITEM[section_type]) for _ in range(max(1, items))]}
    else:
        content = {}
    if heading and "heading" in SECTION_SCHEMA.get(section_type, {}):
        content["heading"] = heading
    return content


class DynamicPageParseError(Exception):
    def __init__(self, errors):
        self.errors = errors  # [{"section_index": int|None, "message": str}]
        super().__init__("Dynamic page validation failed")


def build_ai_prompt(section_types=None, context=None):
    """Page prompt — delegates to api/prompts.py (the single prompt source)."""
    from .prompts import page_prompt
    return page_prompt(section_types, context)


def build_copy_structure_prompt():
    """Copy-structure prompt — delegates to api/prompts.py."""
    from .prompts import copy_structure_prompt
    return copy_structure_prompt()


def _validate_section_fields(section, schema):
    errors = []
    for field, rule in schema.items():
        if rule == "required":
            v = section.get(field)
            if not isinstance(v, str) or not v.strip():
                errors.append(f'"{field}" is required and must be a non-empty string.')
        elif rule == "required_list":
            v = section.get(field)
            if not isinstance(v, list) or not v:
                errors.append(f'"{field}" is required and must be a non-empty array.')
    return errors


def _check_image(obj, label, errors):
    prompt = obj.get("image_prompt")
    required = obj.get("image_required", bool(prompt))
    if required and not (isinstance(prompt, str) and prompt.strip()):
        errors.append(f'{label}: "image_prompt" is required when image_required is true.')


def _validate_images(section, section_type):
    errors = []
    if section_type in SINGLE_IMAGE_SECTION_TYPES:
        _check_image(section, "image", errors)
    if section_type in PER_ITEM_IMAGE_SECTION_TYPES:
        for i, item in enumerate(section.get("items") or []):
            if isinstance(item, dict):
                _check_image(item, f"items[{i}]", errors)
    return errors


def parse_and_validate(raw_text):
    """raw_text -> {"title", "page_type", "seo", "sections": [ {section_type,
    order, content, media} ]} or raises DynamicPageParseError."""
    errors = []
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", (raw_text or "").strip())
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise DynamicPageParseError([{"section_index": None, "message": f"Invalid JSON: {e}"}])

    if not isinstance(data, dict):
        raise DynamicPageParseError([{"section_index": None, "message": "Root must be a JSON object."}])
    if not str(data.get("title", "")).strip():
        errors.append({"section_index": None, "message": 'Missing required "title".'})

    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        errors.append({"section_index": None, "message": '"sections" must be a non-empty array.'})
        raise DynamicPageParseError(errors)

    validated = []
    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            errors.append({"section_index": i, "message": "Section must be an object."})
            continue
        stype = section.get("type")
        if stype not in SECTION_SCHEMA:
            errors.append({"section_index": i,
                           "message": f'Unknown section type "{stype}". '
                                      f'Allowed: {", ".join(SECTION_TYPES)}'})
            continue

        field_errors = _validate_section_fields(section, SECTION_SCHEMA[stype])
        field_errors += _validate_images(section, stype)
        if stype == "video" and not VIDEO_HOST_PATTERN.match(section.get("video_url") or ""):
            field_errors.append('"video_url" must be a YouTube or Vimeo embed URL.')
        # reject raw HTML in text fields
        for tf in ("content", "text", "description"):
            v = section.get(tf)
            if isinstance(v, str) and re.search(r"<[a-zA-Z/][^>]*>", v):
                field_errors.append(f'"{tf}" must be plain text — raw HTML is not allowed.')
        if field_errors:
            errors.extend({"section_index": i, "message": m} for m in field_errors)
            continue

        content = {k: v for k, v in section.items()
                   if k not in ("type", "image_required", "image_prompt")}
        media = []
        if stype in SINGLE_IMAGE_SECTION_TYPES:
            prompt = section.get("image_prompt", "")
            if section.get("image_required", bool(prompt)):
                media.append({"slot": "image", "image_prompt": prompt, "required": True})
        if stype in PER_ITEM_IMAGE_SECTION_TYPES:
            for idx, item in enumerate(section.get("items") or []):
                if not isinstance(item, dict):
                    continue
                prompt = item.get("image_prompt", "")
                if item.get("image_required", bool(prompt)):
                    media.append({"slot": f"items[{idx}].image",
                                  "image_prompt": prompt, "required": True})

        validated.append({"section_type": stype, "order": i,
                          "content": content, "media": media})

    if errors:
        raise DynamicPageParseError(errors)

    return {
        "title": data["title"],
        "page_type": data.get("page_type") or "generic",
        "seo": data.get("seo") or {},
        "sections": validated,
    }
