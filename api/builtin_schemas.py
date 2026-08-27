"""Starting-point ComponentSchema definitions.

Seeded by migration 0003 via `sync_builtin_schemas`. They are ordinary rows
after that — a project may edit them, add fields, or add entirely new
schemas through the admin / API. Re-running the sync only touches rows still
marked ``builtin=True`` and never deletes project-authored schemas.

Descriptor shape (all keys optional except ``type`` on a field):

    {
      "label": "Hero",
      "fields": {
        "<field>": {
          "type": "string|text|number|boolean|url|image|list|object",
          "label": "...",
          "required": true,
          "default": <value>,
          "item": { ...field map... }   # when type == "list" of objects
          "fields": { ...field map... } # when type == "object"
        }
      }
    }
"""

S = "string"
T = "text"


def _f(type_, label, **extra):
    return {"type": type_, "label": label, **extra}


BUILTIN_SCHEMAS = {
    "hero": {
        "label": "Hero",
        "fields": {
            "heading": _f(S, "Heading", required=True),
            "subheading": _f(T, "Subheading"),
            "ctaText": _f(S, "Primary CTA text"),
            "ctaHref": _f("url", "Primary CTA link"),
            "secondaryCtaText": _f(S, "Secondary CTA text"),
            "secondaryCtaHref": _f("url", "Secondary CTA link"),
            "image": _f("image", "Background / hero image"),
            "imageAlt": _f(S, "Hero image alt text"),
        },
    },
    "rich_text": {
        "label": "Rich text",
        "fields": {
            "heading": _f(S, "Heading"),
            "content": _f(T, "Body (plain paragraphs, blank-line separated)", required=True),
        },
    },
    "image_text": {
        "label": "Image + text",
        "fields": {
            "heading": _f(S, "Heading", required=True),
            "content": _f(T, "Body", required=True),
            "image": _f("image", "Image"),
            "imageAlt": _f(S, "Image alt text"),
            "imagePosition": _f(S, "Image position", default="left"),
        },
    },
    "cards": {
        "label": "Cards",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Cards", required=True, item={
                "title": _f(S, "Title", required=True),
                "body": _f(T, "Body"),
                "icon": _f(S, "Icon name"),
                "image": _f("image", "Image"),
                "href": _f("url", "Link"),
            }),
        },
    },
    "features": {
        "label": "Features",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Features", required=True, item={
                "title": _f(S, "Title", required=True),
                "body": _f(T, "Body"),
                "icon": _f(S, "Icon name"),
            }),
        },
    },
    "statistics": {
        "label": "Statistics",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Stats", required=True, item={
                "value": _f(S, "Value", required=True),
                "label": _f(S, "Label", required=True),
            }),
        },
    },
    "testimonials": {
        "label": "Testimonials",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Testimonials", required=True, item={
                "quote": _f(T, "Quote", required=True),
                "name": _f(S, "Attribution name"),
                "role": _f(S, "Attribution role"),
                "avatar": _f("image", "Avatar"),
            }),
        },
    },
    "faq": {
        "label": "FAQ",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Questions", required=True, item={
                "question": _f(S, "Question", required=True),
                "answer": _f(T, "Answer", required=True),
            }),
        },
    },
    "gallery": {
        "label": "Gallery",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Images", required=True, item={
                "image": _f("image", "Image", required=True),
                "alt": _f(S, "Alt text"),
                "caption": _f(S, "Caption"),
            }),
        },
    },
    "team": {
        "label": "Team",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Members", required=True, item={
                "name": _f(S, "Name", required=True),
                "role": _f(S, "Role"),
                "bio": _f(T, "Bio"),
                "photo": _f("image", "Photo"),
            }),
        },
    },
    "timeline": {
        "label": "Timeline",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Events", required=True, item={
                "date": _f(S, "Date / label", required=True),
                "title": _f(S, "Title", required=True),
                "body": _f(T, "Body"),
            }),
        },
    },
    "pricing": {
        "label": "Pricing",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Plans", required=True, item={
                "name": _f(S, "Plan name", required=True),
                "price": _f(S, "Price", required=True),
                "period": _f(S, "Billing period"),
                "features": _f("list", "Features"),
                "ctaText": _f(S, "CTA text"),
                "ctaHref": _f("url", "CTA link"),
                "highlighted": _f("boolean", "Highlighted"),
            }),
        },
    },
    "logos": {
        "label": "Logo wall",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Logos", required=True, item={
                "image": _f("image", "Logo", required=True),
                "alt": _f(S, "Alt text", required=True),
                "href": _f("url", "Link"),
            }),
        },
    },
    "steps": {
        "label": "Steps / how-to",
        "fields": {
            "heading": _f(S, "Heading"),
            "items": _f("list", "Steps", required=True, item={
                "title": _f(S, "Title", required=True),
                "body": _f(T, "Body"),
                "image": _f("image", "Image"),
            }),
        },
    },
    "cta": {
        "label": "Call to action",
        "fields": {
            "heading": _f(S, "Heading", required=True),
            "body": _f(T, "Body"),
            "buttonText": _f(S, "Button text", required=True),
            "buttonHref": _f("url", "Button link"),
        },
    },
    "navbar": {
        "label": "Navbar",
        "fields": {
            "logo": _f("image", "Logo"),
            "logoAlt": _f(S, "Logo alt text"),
            "links": _f("list", "Links", item={
                "label": _f(S, "Label", required=True),
                "href": _f("url", "Link", required=True),
            }),
            "ctaText": _f(S, "CTA text"),
            "ctaHref": _f("url", "CTA link"),
        },
    },
    "footer": {
        "label": "Footer",
        "fields": {
            "tagline": _f(T, "Tagline"),
            "columns": _f("list", "Link columns", item={
                "title": _f(S, "Column title"),
                "links": _f("list", "Links"),
            }),
            "legal": _f(S, "Legal / copyright line"),
            "social": _f("list", "Social links"),
        },
    },
    "banner": {
        "label": "Banner",
        "fields": {
            "text": _f(S, "Text", required=True),
            "linkText": _f(S, "Link text"),
            "linkHref": _f("url", "Link"),
            "dismissible": _f("boolean", "Dismissible", default=True),
        },
    },
    "video": {
        "label": "Video",
        "fields": {
            "heading": _f(S, "Heading"),
            "videoUrl": _f("url", "YouTube / Vimeo embed URL", required=True),
            "caption": _f(S, "Caption"),
        },
    },
    "contact_block": {
        "label": "Contact block",
        "fields": {
            "heading": _f(S, "Heading"),
            "email": _f(S, "Email"),
            "phone": _f(S, "Phone"),
            "address": _f(T, "Address"),
            "hours": _f(T, "Hours"),
        },
    },
    "map_block": {
        "label": "Map",
        "fields": {
            "heading": _f(S, "Heading"),
            "embedUrl": _f("url", "Map embed URL", required=True),
            "latitude": _f("number", "Latitude"),
            "longitude": _f("number", "Longitude"),
        },
    },
    "newsletter": {
        "label": "Newsletter signup",
        "fields": {
            "heading": _f(S, "Heading", required=True),
            "body": _f(T, "Body"),
            "buttonText": _f(S, "Button text", default="Subscribe"),
            "formName": _f(S, "Form definition name", default="newsletter"),
        },
    },
}


def sync_builtin_schemas(ComponentSchema):
    """Idempotent upsert of the builtin catalogue. Safe to call from a data
    migration or a management command. Only rewrites rows with builtin=True."""
    for key, spec in BUILTIN_SCHEMAS.items():
        obj = ComponentSchema.objects.filter(key=key).first()
        if obj is None:
            ComponentSchema.objects.create(
                key=key, label=spec["label"], schema=spec, builtin=True
            )
        elif obj.builtin:
            obj.label = spec["label"]
            obj.schema = spec
            obj.save(update_fields=["label", "schema", "updated_at"])
