# Frontend Integration Prompt — Universal CMS + SEO Backend

**Purpose:** paste this whole file (or point an agent at it) along with ONE input —
a page, a section/component, a form, a list page, or a blog post page — and the
target will be rewritten to be fully dynamic, inline-editable by an admin, and
SEO-wired against this backend, with the existing design, layout, animation, and
content preserved exactly.

This document is written against the actual, current backend in `api/` — every
endpoint, field name, and header below is real, not aspirational. Do not invent
endpoints, headers, or field names that aren't in this document.

Two ways to use it:

- **Need one component, right now?** Copy the single self-contained block in
  **§A** below, fill in the two blanks, paste it as your entire prompt. It
  needs nothing else from this file.
- **Building a full page, form, list page, or blog post?** Those have more
  moving parts than one block can hold — use §1–§9 instead, which cover the
  backend contract once and then one worked pattern per target type.

### Build order — what to wire up first on a fresh project

Doing these out of order works, but doing them in order means nothing you
build early has to be revisited later. Each step only depends on the ones
before it:

1. **`app/layout.jsx`** — site-wide, once, first. Reads `settings/site/`
   (org name, default OG image, injected analytics/GTM scripts, default
   robots). Nothing else can meaningfully inherit sane defaults until this
   exists. See §5a for the metadata half of this; the `SiteSettings` fetch
   itself is the same server-side pattern, just pointed at
   `settings/site/` instead of `seo/<path>/`.
2. **`app/robots.js` and `app/sitemap.js`** — also site-wide, also early,
   also cheap: they only need `seo/` (list) and `blog/` to exist as
   endpoints, which they already do. Get these right once and never revisit.
3. **One `page.jsx` per route**, starting with the homepage. Each page needs
   §5a (`generateMetadata()`, server-side) before its sections are built —
   an SEO-blank page is a worse starting point than an unstyled one.
4. **Sections/components inside each page** — this is where §A (the
   copy-paste prompt) is used, once per section, repeatedly, for the bulk of
   the actual build. Do this after the page shell + metadata exist, not
   before — a section fetching from `home/hero/` is only useful once the
   page rendering it is real.
5. **Forms** (§6) — after the pages that host them exist, since a form is
   always embedded inside a page/section, never standalone.
6. **List pages + detail pages** (§7, §8) — blog index and blog post,
   product/service listings, etc. — after the simpler section-based pages
   are working, since these introduce real pagination and dynamic routing
   on top of everything above.
7. **Redirects** (`redirects/`) — last, and only reactively, once a URL
   actually needs to move. Nothing else depends on this existing.

If you're integrating one existing static component rather than building
from scratch, skip straight to §A — the build order above is for planning a
whole project, not a prerequisite for using §A on its own.

---

## A. The Universal Copy-Paste Prompt (self-contained — start here for any component)

Fill in the two blanks, paste everything in the box below as your entire
prompt, nothing else required.

```
COMPONENT TO IMPLEMENT = 
COMPONENT DATA NAME (used in the API URL) = 

Build this as a Next.js App Router client component ("use client"), no
TypeScript, inline Tailwind CSS classes only. Keep 100% of the existing
design, layout, spacing, animation, and copy from the reference/target —
only change how data is sourced, edited, and saved.

BACKEND CONTRACT (this is real — do not deviate from it)
- apiUrl = process.env.NEXT_PUBLIC_API_URL
- Fetch data with: GET `${apiUrl}/home/COMPONENT_DATA_NAME/`
  This endpoint never 404s — an unknown name returns `200 {}`. If the
  response is an empty object, render sensible built-in default content
  instead of blank/loading forever. Nothing needs to be pre-created in the
  database — the first save creates it.
- Save changes with: PATCH `${apiUrl}/home/COMPONENT_DATA_NAME/`
  Body = the full data object (partial nested updates are fine — the
  backend deep-merges objects; arrays you send fully replace the old array,
  so always send the complete array, not a diff).
- Never append an id, pk, or slug to this URL for GET/PATCH/PUT/DELETE —
  it is name-keyed, not id-keyed. Always the exact same base URL every time.
- Every write (PATCH) must include this header:
  `Authorization: Token ${localStorage.getItem("authToken")}`
  This is a DRF TokenAuthentication header — the literal word is "Token",
  NOT "Bearer". Getting this word wrong makes every save silently fail
  with a 401.
- Admin mode = `!!localStorage.getItem("authToken")`. That local variable,
  checked in a `useEffect` after mount (never read `localStorage` during
  render/SSR), is the ONLY gate for showing edit affordances. No role
  check, no separate admin API call.
- Images: never let the admin type a raw image URL. Upload first:
  ```js
  const formData = new FormData();
  formData.append("image", file);
  formData.append("category", "SOME-DESCRIPTIVE-CATEGORY"); // e.g. "hero-background"
  const res = await fetch(`${apiUrl}/images/`, {
    method: "POST",
    headers: { Authorization: `Token ${localStorage.getItem("authToken")}` },
    // no Content-Type header — let the browser set the multipart boundary
    body: formData,
  });
  const { image } = await res.json(); // absolute URL string
  ```
  Then set `image` as the value of whatever image field you just uploaded
  for. Show a spinner/disabled state on the specific image being replaced
  while `uploading` is true, not the whole component.

EDITING BEHAVIOR
- Two states: view mode (default) and edit mode (admin only, toggled by an
  Edit button that only renders when admin mode is true).
- In edit mode, every text field becomes a controlled `<input>` or
  `<textarea>` bound to a `tempData` copy of the fetched data — never
  mutate the live `data` state directly, and never use real
  `contentEditable`.
- A Save button PATCHes `tempData` to the backend, then sets `data` to the
  server's response (not just to `tempData` — always trust what the server
  actually persisted) and exits edit mode.
- A Cancel button resets `tempData = data` and exits edit mode without
  saving.
- Any repeating group in the data (cards, list items, buttons, testimonials,
  gallery images — anything that is an array) must be, in edit mode:
  individually editable, individually removable (a small delete control on
  each item), and have an "Add new" affordance at the end of the list that
  appends a sensible blank/placeholder item. Never make a repeating group
  editable-in-place only — always addable/removable too.
- Use `structuredClone(prev)` (or an equivalent deep copy) when updating
  nested fields in `tempData` — never mutate nested objects/arrays in
  place before calling `setTempData`, or React won't re-render correctly
  and the deep-merge-on-save can behave unexpectedly.

Now, using the component below as your structural and stylistic reference
(same edit-mode pattern, same button placement, same background-image
upload affordance if the target has a background image), implement
COMPONENT_TO_IMPLEMENT, fetching from COMPONENT_DATA_NAME, and give me:
1. The full component code.
2. A sample JSON response shape for `GET /home/COMPONENT_DATA_NAME/`.

REFERENCE COMPONENT (CallToActions — correct backend usage, copy this
pattern exactly, adapt the fields/JSX to the new component):

"use client";
import { ArrowRight, Briefcase, PlayCircle, Edit, Save, X, Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL;
const ENDPOINT = `${apiUrl}/home/cta/`; // <-- COMPONENT_DATA_NAME goes here

const defaultData = {
  badgeIcon: "Briefcase",
  badgeText: "Get Started",
  title: "Ready to get started?",
  description: "Join thousands of satisfied customers today.",
  buttons: [{ text: "Get Started", link: "#", variant: "primary", icon: "ArrowRight" }],
  backgroundPattern: "",
};

export default function CallToActions() {
  const [data, setData] = useState(null);
  const [tempData, setTempData] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setIsAdmin(!!localStorage.getItem("authToken"));
  }, []);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((r) => r.json())
      .then((json) => {
        const resolved = json && Object.keys(json).length ? json : defaultData;
        setData(resolved);
        setTempData(resolved);
      })
      .catch(() => {
        setData(defaultData);
        setTempData(defaultData);
      });
  }, []);

  const toggleEdit = () => {
    if (!localStorage.getItem("authToken")) return;
    if (editMode) setTempData(data);
    setEditMode(!editMode);
  };

  const setField = (key, value) =>
    setTempData((prev) => ({ ...structuredClone(prev), [key]: value }));

  const setButtonField = (index, field, value) =>
    setTempData((prev) => {
      const next = structuredClone(prev);
      next.buttons[index][field] = value;
      return next;
    });

  const addButton = () =>
    setTempData((prev) => ({
      ...prev,
      buttons: [...prev.buttons, { text: "New Button", link: "#", variant: "secondary", icon: "ArrowRight" }],
    }));

  const removeButton = (index) =>
    setTempData((prev) => ({ ...prev, buttons: prev.buttons.filter((_, i) => i !== index) }));

  const handleBackgroundUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("category", "cta-background");
      const res = await fetch(`${apiUrl}/images/`, {
        method: "POST",
        headers: { Authorization: `Token ${localStorage.getItem("authToken")}` },
        body: formData,
      });
      const result = await res.json();
      setField("backgroundPattern", result.image);
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${localStorage.getItem("authToken")}`,
        },
        body: JSON.stringify(tempData),
      });
      const updated = await res.json();
      setData(updated);
      setTempData(updated);
      setEditMode(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (!data) return null;

  return (
    <section className="bg-gradient-to-r from-red-700 to-red-900 text-white py-20 relative overflow-hidden">
      {isAdmin && (
        <div className="absolute top-4 right-4 z-20 flex gap-2">
          {editMode ? (
            <>
              <button onClick={save} disabled={isSaving} className="bg-green-600 text-white p-2 rounded-full shadow-lg hover:bg-green-700 disabled:opacity-50">
                <Save size={20} />
              </button>
              <button onClick={toggleEdit} className="bg-gray-600 text-white p-2 rounded-full shadow-lg hover:bg-gray-700">
                <X size={20} />
              </button>
            </>
          ) : (
            <button onClick={toggleEdit} className="bg-white text-red-700 p-2 rounded-full shadow-lg hover:bg-gray-100">
              <Edit size={20} />
            </button>
          )}
        </div>
      )}

      {editMode && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-10">
          <label className="bg-white p-4 rounded-lg shadow-lg cursor-pointer flex flex-col items-center">
            {uploading ? "Uploading..." : (
              <>
                <Upload size={24} className="text-red-700 mb-2" />
                <span className="text-red-700 font-medium">Change background</span>
                <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundUpload} />
              </>
            )}
          </label>
        </div>
      )}

      <div
        className="absolute inset-0 opacity-10"
        style={data.backgroundPattern ? { backgroundImage: `url(${data.backgroundPattern})`, backgroundSize: "cover" } : undefined}
      />

      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <div className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-sm rounded-full px-4 py-2 mb-6">
          {editMode ? (
            <input value={tempData.badgeText} onChange={(e) => setField("badgeText", e.target.value)} className="bg-white/30 text-white rounded px-2 py-1 text-sm" />
          ) : (
            <>
              <Briefcase className="w-5 h-5 text-red-300" />
              <span className="text-sm font-medium">{data.badgeText}</span>
            </>
          )}
        </div>

        {editMode ? (
          <input
            value={tempData.title}
            onChange={(e) => setField("title", e.target.value)}
            className="text-4xl md:text-5xl font-bold mb-6 w-full bg-transparent text-white border-b border-white/30 focus:outline-none text-center"
          />
        ) : (
          <h2 className="text-4xl md:text-5xl font-bold mb-6">{data.title}</h2>
        )}

        {editMode ? (
          <textarea
            value={tempData.description}
            onChange={(e) => setField("description", e.target.value)}
            rows={3}
            className="text-xl text-red-100 mb-12 leading-relaxed w-full bg-transparent border-b border-white/30 focus:outline-none text-center resize-none"
          />
        ) : (
          <p className="text-xl text-red-100 mb-12 leading-relaxed">{data.description}</p>
        )}

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          {(editMode ? tempData : data).buttons.map((button, index) => (
            <div key={index} className="relative">
              {editMode && (
                <button onClick={() => removeButton(index)} className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full z-10">
                  <X size={14} />
                </button>
              )}
              {editMode ? (
                <div className="bg-white/10 p-4 rounded-2xl space-y-2">
                  <input value={button.text} onChange={(e) => setButtonField(index, "text", e.target.value)} placeholder="Button text" className="w-full bg-white/20 text-white placeholder-white/70 rounded px-3 py-2" />
                  <input value={button.link} onChange={(e) => setButtonField(index, "link", e.target.value)} placeholder="Link" className="w-full bg-white/20 text-white placeholder-white/70 rounded px-3 py-2" />
                </div>
              ) : (
                <a
                  href={button.link}
                  className={`${button.variant === "primary" ? "bg-white hover:bg-gray-100 text-red-700" : "border-2 border-white/30 hover:border-white hover:bg-white/10 text-white"} px-8 py-4 rounded-full font-semibold text-lg flex items-center gap-2 justify-center transform hover:scale-105 transition-all duration-300 shadow-lg`}
                >
                  {button.icon === "PlayCircle" && <PlayCircle className="w-5 h-5" />}
                  {button.icon === "ArrowRight" && <ArrowRight className="w-5 h-5" />}
                  {button.text}
                </a>
              )}
            </div>
          ))}
          {editMode && (
            <button onClick={addButton} className="border-2 border-dashed border-white/50 hover:border-white text-white/70 hover:text-white px-8 py-4 rounded-full font-semibold text-lg flex items-center gap-2 justify-center">
              <Plus size={20} /> Add Button
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
```

**If the target has a repeating grid of items that each have their OWN
image** (team members, testimonial cards, a gallery, pricing tiers with
icons) — the single whole-section background-image pattern above isn't the
right shape. Use this second reference instead, which shows per-item image
upload (each card gets its own upload spinner and file input, tracked by
index):

```jsx
"use client";
import { UserCheck, ChevronRight, MapPin, Edit, Save, X, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL;
const ENDPOINT = `${apiUrl}/home/testimonials/`; // <-- COMPONENT_DATA_NAME goes here

const defaultData = {
  preTitle: "Success Stories",
  title: "Our Alumni Network",
  description: "Hear from people who worked with us.",
  stories: [
    { name: "Jane Doe", role: "Position", location: "City, Country", quote: "Great experience.", image: "", buttonText: "Read more" },
  ],
};

export default function SuccessStoriesSection() {
  const [data, setData] = useState(null);
  const [tempData, setTempData] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [uploadingIndex, setUploadingIndex] = useState(null); // which card is uploading, or null
  const fileInputRefs = useRef({});

  useEffect(() => {
    setIsAdmin(!!localStorage.getItem("authToken"));
  }, []);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((r) => r.json())
      .then((json) => {
        const resolved = json && Object.keys(json).length ? json : defaultData;
        setData(resolved);
        setTempData(resolved);
      })
      .catch(() => {
        setData(defaultData);
        setTempData(defaultData);
      });
  }, []);

  const toggleEdit = () => {
    if (!localStorage.getItem("authToken")) return;
    if (editMode) setTempData(data);
    setEditMode(!editMode);
  };

  const setField = (key, value) =>
    setTempData((prev) => ({ ...structuredClone(prev), [key]: value }));

  const setStoryField = (index, field, value) =>
    setTempData((prev) => {
      const next = structuredClone(prev);
      next.stories[index][field] = value;
      return next;
    });

  const addStory = () =>
    setTempData((prev) => ({
      ...prev,
      stories: [...prev.stories, { name: "New Person", role: "Role", location: "Location", quote: "Quote", image: "", buttonText: "Read more" }],
    }));

  const removeStory = (index) =>
    setTempData((prev) => ({ ...prev, stories: prev.stories.filter((_, i) => i !== index) }));

  // Per-item upload: `index` identifies which card's image field to fill in.
  const handleImageUpload = async (event, index) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploadingIndex(index);
    try {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("category", "testimonial-images");
      const res = await fetch(`${apiUrl}/images/`, {
        method: "POST",
        headers: { Authorization: `Token ${localStorage.getItem("authToken")}` },
        body: formData,
      });
      const result = await res.json();
      setStoryField(index, "image", result.image);
    } finally {
      setUploadingIndex(null);
    }
  };

  const save = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${localStorage.getItem("authToken")}`,
        },
        body: JSON.stringify(tempData),
      });
      const updated = await res.json();
      setData(updated);
      setTempData(updated);
      setEditMode(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (!data) return null;
  const stories = (editMode ? tempData : data).stories;

  return (
    <section className="py-20 bg-white relative">
      {isAdmin && (
        <div className="absolute top-4 right-4 z-20 flex gap-2">
          {editMode ? (
            <>
              <button onClick={save} disabled={isSaving} className="bg-green-600 hover:bg-green-700 text-white p-2 rounded-full shadow-lg disabled:opacity-50">
                <Save className="w-5 h-5" />
              </button>
              <button onClick={toggleEdit} className="bg-gray-600 hover:bg-gray-700 text-white p-2 rounded-full shadow-lg">
                <X className="w-5 h-5" />
              </button>
            </>
          ) : (
            <button onClick={toggleEdit} className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-full shadow-lg">
              <Edit className="w-5 h-5" />
            </button>
          )}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-red-100 text-red-800 rounded-full px-4 py-2 mb-4">
            <UserCheck className="w-5 h-5" />
            {editMode ? (
              <input value={tempData.preTitle} onChange={(e) => setField("preTitle", e.target.value)} className="bg-transparent text-sm font-medium" />
            ) : (
              <span className="text-sm font-medium">{data.preTitle}</span>
            )}
          </div>
          {editMode ? (
            <input value={tempData.title} onChange={(e) => setField("title", e.target.value)} className="text-3xl md:text-4xl font-bold text-gray-900 mb-4 w-full text-center bg-transparent" />
          ) : (
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">{data.title}</h2>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {stories.map((story, index) => (
            <div key={index} className="bg-white rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300 relative">
              {editMode && (
                <button onClick={() => removeStory(index)} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 z-10">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}

              <div className="relative h-64 bg-gray-100">
                {editMode ? (
                  uploadingIndex === index ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-red-600" />
                    </div>
                  ) : (
                    <>
                      {story.image && <img src={story.image} alt={story.name} className="object-cover w-full h-full" />}
                      <button
                        onClick={() => fileInputRefs.current[index]?.click()}
                        className="absolute bottom-2 right-2 bg-blue-500 text-white rounded-full p-2"
                      >
                        <Upload className="w-4 h-4" />
                      </button>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        ref={(el) => (fileInputRefs.current[index] = el)}
                        onChange={(e) => handleImageUpload(e, index)}
                      />
                    </>
                  )
                ) : (
                  story.image && <img src={story.image} alt={story.name} className="object-cover w-full h-full" />
                )}
              </div>

              <div className="p-6">
                {editMode ? (
                  <>
                    <input value={story.name} onChange={(e) => setStoryField(index, "name", e.target.value)} className="text-xl font-bold text-gray-900 w-full mb-1 bg-transparent" />
                    <input value={story.role} onChange={(e) => setStoryField(index, "role", e.target.value)} className="text-gray-600 w-full mb-3 bg-transparent" />
                  </>
                ) : (
                  <>
                    <h3 className="text-xl font-bold text-gray-900">{story.name}</h3>
                    <p className="text-gray-600 mb-3">{story.role}</p>
                  </>
                )}

                <div className="flex items-center gap-1 text-red-600 mb-3">
                  <MapPin className="w-4 h-4" />
                  {editMode ? (
                    <input value={story.location} onChange={(e) => setStoryField(index, "location", e.target.value)} className="text-sm bg-transparent" />
                  ) : (
                    <span className="text-sm">{story.location}</span>
                  )}
                </div>

                {editMode ? (
                  <textarea value={story.quote} onChange={(e) => setStoryField(index, "quote", e.target.value)} rows={3} className="text-gray-700 italic mb-6 w-full bg-transparent" />
                ) : (
                  <p className="text-gray-700 italic mb-6">"{story.quote}"</p>
                )}

                {editMode ? (
                  <input value={story.buttonText} onChange={(e) => setStoryField(index, "buttonText", e.target.value)} className="text-red-600 font-medium bg-transparent" />
                ) : (
                  <button className="text-red-600 font-medium flex items-center gap-2 hover:gap-3 transition-all group">
                    {story.buttonText}
                    <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {editMode && (
            <div
              onClick={addStory}
              className="bg-white rounded-2xl shadow-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center cursor-pointer min-h-[400px]"
            >
              <Plus className="w-12 h-12 text-gray-400 mb-4" />
              <span className="text-gray-600 font-medium">Add New</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
```

That block is complete on its own. Everything below (§1 onward) is the
deeper reference for full pages, forms, list pages, and blog posts, where
more than one endpoint and more than one file are involved.

---

## 0. How to use this file

At the bottom of this document is **§9 — The Prompt Template**. Fill in:

```
TARGET TYPE = component | page | form | list-page | blog-post
TARGET      = <file path or description>
NAME        = <the ComponentData / SEO path / form name to use>
```

Everything above §9 is reference material the agent executing the prompt should
already treat as ground truth: the backend contract (§1), the auth contract (§2),
the image upload contract (§3), and one worked pattern per target type (§4–§8).
The agent should read the section matching `TARGET TYPE` and follow it exactly.

---

## 1. Backend contract — the only endpoints that exist

Base URL: `process.env.NEXT_PUBLIC_API_URL` (e.g. `http://localhost:8000/api` in
dev). Every path below is relative to that base.

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Admin login | POST | `/auth/login/` | public |
| Get/set a named content block | GET | `/home/<name>/` | public |
| " | PATCH | `/home/<name>/` | admin |
| " | PUT | `/home/<name>/` | admin |
| " | DELETE | `/home/<name>/` | admin |
| Get/set site-wide settings (singleton) | GET / PATCH | `/settings/site/` | GET public, PATCH admin |
| List all page SEO rows | GET | `/seo/` | public (paginated) |
| Get/set one page's SEO fields | GET / PATCH | `/seo/<path>/` | GET public, PATCH admin |
| List/create blog posts | GET / POST | `/blog/` | GET public (published only), POST admin |
| Get/update/delete one blog post | GET / PATCH / DELETE | `/blog/<slug>/` | GET public if published, write admin |
| List/create redirects | GET / POST | `/redirects/` | GET public, POST admin |
| Update/delete one redirect | PATCH / DELETE | `/redirects/<id>/` | admin |
| Submit a form | POST | `/forms/<name>/submit/` | public, throttled |
| List a form's submissions | GET | `/forms/<name>/submissions/` | admin |
| Upload an image | POST | `/images/` | admin |
| List images | GET | `/images/` | public |
| Get/update/delete one image | GET / PATCH / DELETE | `/images/<id>/` | GET public, write admin |

**Rules that must never be broken:**

- `home/<name>/`, `settings/site/`, and `seo/<path>/` are **name/path-keyed, not
  id-keyed** — never append an id to these three. `GET` on an unknown name/path
  returns `200 {}`, not `404` — nothing needs to be pre-seeded in the database
  before the frontend can use it. `PATCH` **creates the row if it doesn't exist**
  (upsert) and **deep-merges** into what's already there (nested objects merge
  key-by-key; arrays are replaced wholesale, not merged item-by-item).
- `blog/`, `redirects/`, and `images/` ARE real resource collections — they use
  their own id/slug in the URL for anything but list/create, exactly like any
  normal REST API. Do not apply the "no id" rule to these three.
- `seo/<path>/` accepts slashes in `<path>` (e.g. `seo/services/web-development/`)
  — it is not a single URL segment.

---

## 2. Auth contract

```js
const isAdmin = typeof window !== "undefined" && !!localStorage.getItem("authToken");
```

That single check is the **entire** admin-gate on the frontend. If `isAdmin` is
true, render edit affordances; if false, render the plain public view.

**Login** (already implemented in `app/login/page.js` — do not rebuild this
unless explicitly asked to):

```js
const response = await fetch(`${apiUrl}/auth/login/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const data = await response.json();
const token = data.key; // backend returns { "key": "<token>" }
localStorage.setItem("authToken", token);
```

**Every authenticated write** (PATCH/PUT/DELETE/POST to admin-gated endpoints)
must send:

```js
headers: {
  "Content-Type": "application/json",
  Authorization: `Token ${localStorage.getItem("authToken")}`,
}
```

> ⚠️ The header scheme is **`Token <key>`**, not `Bearer <key>`. This backend
> uses DRF's `TokenAuthentication`, which requires the literal word `Token`.
> Older prompts/components in this codebase used `Bearer` — that is wrong
> against this backend and must be corrected wherever it appears.

For `multipart/form-data` requests (image upload), do **not** set
`Content-Type` manually — let the browser set the multipart boundary. Still
send the `Authorization` header.

---

## 3. Image upload contract (used everywhere an image field exists)

```js
async function uploadImage(file, category) {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("category", category); // e.g. "hero-background", "blog-cover"

  const response = await fetch(`${apiUrl}/images/`, {
    method: "POST",
    headers: { Authorization: `Token ${localStorage.getItem("authToken")}` },
    body: formData,
  });
  if (!response.ok) throw new Error("Image upload failed");
  const result = await response.json();
  return result.image; // absolute URL string — set this directly as the image src
}
```

Every editable image field in every pattern below (§4–§8) uses this exact
function. Never let an admin type a raw image URL by hand when an upload
control is available.

---

## 4. TARGET TYPE = `component` (a section, e.g. Navbar, CTA, Testimonials, Hero)

**When to use:** the target is one self-contained section rendered inside a
page, following the same shape as the existing `CallToActions` /
`SuccessStoriesSection` components in this codebase.

**Backend:** `home/<NAME>/` where `NAME` is a short kebab-case identifier for
this section (e.g. `cta`, `hero`, `testimonials`, `navbar`).

**Pattern (full worked example):**

```jsx
"use client";
import { useEffect, useState, useRef } from "react";
import { Edit, Save, X, Plus, Trash2, Upload } from "lucide-react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL;
const ENDPOINT = `${apiUrl}/home/cta/`; // <-- NAME goes here

const defaultData = {
  title: "Ready to get started?",
  description: "Join thousands of satisfied customers today.",
  buttons: [{ text: "Get Started", link: "#", variant: "primary" }],
  backgroundImage: "",
};

export default function CallToActionSection() {
  const [data, setData] = useState(null);
  const [tempData, setTempData] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    setIsAdmin(!!localStorage.getItem("authToken"));
  }, []);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((r) => r.json())
      .then((json) => {
        // GET never 404s — an empty {} means nothing has been saved yet,
        // so fall back to defaultData rather than rendering blank.
        const resolved = json && Object.keys(json).length ? json : defaultData;
        setData(resolved);
        setTempData(resolved);
      })
      .catch(() => {
        setData(defaultData);
        setTempData(defaultData);
      });
  }, []);

  const toggleEdit = () => {
    if (!localStorage.getItem("authToken")) return;
    if (editMode) setTempData(data); // cancel resets
    setEditMode(!editMode);
  };

  const setField = (path, value) => {
    setTempData((prev) => {
      const next = structuredClone(prev);
      const keys = path.split(".");
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const setButtonField = (index, field, value) => {
    setTempData((prev) => {
      const next = structuredClone(prev);
      next.buttons[index][field] = value;
      return next;
    });
  };

  const addButton = () =>
    setTempData((prev) => ({
      ...prev,
      buttons: [...(prev.buttons || []), { text: "New Button", link: "#", variant: "secondary" }],
    }));

  const removeButton = (index) =>
    setTempData((prev) => ({ ...prev, buttons: prev.buttons.filter((_, i) => i !== index) }));

  const handleBackgroundUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("category", "cta-background");
      const response = await fetch(`${apiUrl}/images/`, {
        method: "POST",
        headers: { Authorization: `Token ${localStorage.getItem("authToken")}` },
        body: formData,
      });
      const result = await response.json();
      setField("backgroundImage", result.image);
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${localStorage.getItem("authToken")}`,
        },
        body: JSON.stringify(tempData),
      });
      const updated = await response.json();
      setData(updated);
      setTempData(updated);
      setEditMode(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (!data) return null;

  return (
    <section className="relative py-20 bg-gradient-to-r from-red-700 to-red-900 text-white overflow-hidden">
      {isAdmin && (
        <div className="absolute top-4 right-4 z-20 flex gap-2">
          {editMode ? (
            <>
              <button onClick={save} disabled={isSaving} className="bg-green-600 hover:bg-green-700 text-white p-2 rounded-full shadow-lg">
                <Save className="w-5 h-5" />
              </button>
              <button onClick={toggleEdit} className="bg-gray-600 hover:bg-gray-700 text-white p-2 rounded-full shadow-lg">
                <X className="w-5 h-5" />
              </button>
            </>
          ) : (
            <button onClick={toggleEdit} className="bg-white text-red-700 p-2 rounded-full shadow-lg">
              <Edit className="w-5 h-5" />
            </button>
          )}
        </div>
      )}

      {editMode && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-10">
          <label className="bg-white p-4 rounded-lg shadow-lg cursor-pointer flex flex-col items-center">
            {uploading ? "Uploading..." : (
              <>
                <Upload className="w-6 h-6 text-red-700 mb-2" />
                <span className="text-red-700 font-medium">Change background</span>
                <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundUpload} />
              </>
            )}
          </label>
        </div>
      )}

      {data.backgroundImage && (
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: `url(${data.backgroundImage})`, backgroundSize: "cover" }} />
      )}

      <div className="relative max-w-4xl mx-auto px-4 text-center">
        {editMode ? (
          <input
            value={tempData.title}
            onChange={(e) => setField("title", e.target.value)}
            className="text-4xl md:text-5xl font-bold mb-6 w-full bg-transparent border-b border-white/30 text-center focus:outline-none"
          />
        ) : (
          <h2 className="text-4xl md:text-5xl font-bold mb-6">{data.title}</h2>
        )}

        {editMode ? (
          <textarea
            value={tempData.description}
            onChange={(e) => setField("description", e.target.value)}
            className="text-xl mb-12 w-full bg-transparent border-b border-white/30 text-center resize-none"
            rows={3}
          />
        ) : (
          <p className="text-xl mb-12">{data.description}</p>
        )}

        <div className="flex flex-wrap gap-4 justify-center">
          {(editMode ? tempData : data).buttons.map((button, index) => (
            <div key={index} className="relative">
              {editMode && (
                <button onClick={() => removeButton(index)} className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full z-10">
                  <X className="w-3 h-3" />
                </button>
              )}
              {editMode ? (
                <div className="bg-white/10 p-3 rounded-xl space-y-2">
                  <input value={button.text} onChange={(e) => setButtonField(index, "text", e.target.value)} className="w-full bg-white/20 rounded px-3 py-2" placeholder="Button text" />
                  <input value={button.link} onChange={(e) => setButtonField(index, "link", e.target.value)} className="w-full bg-white/20 rounded px-3 py-2" placeholder="Link" />
                </div>
              ) : (
                <a href={button.link} className="bg-white text-red-700 px-8 py-4 rounded-full font-semibold shadow-lg hover:scale-105 transition-transform">
                  {button.text}
                </a>
              )}
            </div>
          ))}
          {editMode && (
            <button onClick={addButton} className="border-2 border-dashed border-white/50 text-white/70 px-8 py-4 rounded-full flex items-center gap-2">
              <Plus className="w-5 h-5" /> Add button
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
```

**What to preserve from the original component when applying this pattern:**
every visual class name, animation, and layout structure — only the data
source, edit affordances, and save/upload wiring change.

---

## 5. TARGET TYPE = `page` (a full route, e.g. `app/about/page.jsx`)

**When to use:** the target is an entire Next.js route, made of multiple
sections plus page-level SEO.

**Backend:** each section on the page uses its own `home/<name>/` (§4). The
**page itself** additionally uses `seo/<path>/`, where `<path>` is the route's
identifier (e.g. `home`, `about`, `services/web-development` — matches the
route, not the URL slug of any single section).

**Two things must exist for a page**, in two different files:

### 5a. `generateMetadata()` — server-side, in `page.jsx` itself

This is what actually puts `<title>`/`<meta>` tags in the HTML crawlers see.
It must run server-side — never rely on the client-side SEO panel below for
this.

```jsx
// app/about/page.jsx
async function getPageSEO(path) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/seo/${path}/`, {
    cache: "no-store", // or { next: { revalidate: 60 } } if you want ISR
  });
  return res.ok ? res.json() : {};
}

export async function generateMetadata() {
  const seo = await getPageSEO("about");
  return {
    title: seo.seoTitle || "About Us",
    description: seo.metaDescription || "Default fallback description.",
    alternates: { canonical: seo.canonicalUrl || "/about" },
    robots: {
      index: seo.robotsIndex !== false,
      follow: seo.robotsFollow !== false,
    },
    openGraph: {
      title: seo.ogTitle || seo.seoTitle || "About Us",
      description: seo.ogDescription || seo.metaDescription,
      images: seo.ogImage ? [{ url: seo.ogImage, width: 1200, height: 630 }] : undefined,
    },
  };
}

export default function AboutPage() {
  return (
    <main>
      {/* section components, each self-contained per §4 */}
    </main>
  );
}
```

### 5b. `SeoEditPanel` — client-side, admin-only, rendered inside the page body

A floating, collapsed-by-default panel that lets an admin edit the same
`seo/<path>/` row. This is a UI convenience for editing; it is **not** what
puts tags in the HTML — that's §5a.

```jsx
"use client";
import { useEffect, useState } from "react";
import { Search, Save, X, ChevronDown } from "lucide-react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL;

export default function SeoEditPanel({ path }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({});
  const [saving, setSaving] = useState(false);
  const ENDPOINT = `${apiUrl}/seo/${path}/`;

  useEffect(() => {
    setIsAdmin(!!localStorage.getItem("authToken"));
    fetch(ENDPOINT).then((r) => r.json()).then(setData);
  }, [path]);

  if (!isAdmin) return null;

  const setField = (key, value) => setData((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${localStorage.getItem("authToken")}`,
        },
        body: JSON.stringify(data),
      });
      setData(await response.json());
    } finally {
      setSaving(false);
    }
  };

  // Pure client-side audit checklist — no external calls, runs against
  // the data already fetched above.
  const checks = [
    { label: "Title 50–60 chars", pass: (data.seoTitle || "").length >= 50 && (data.seoTitle || "").length <= 60 },
    { label: "Description 120–160 chars", pass: (data.metaDescription || "").length >= 120 && (data.metaDescription || "").length <= 160 },
    { label: "Canonical set", pass: !!data.canonicalUrl },
    { label: "OG image set", pass: !!data.ogImage },
    { label: "Focus keyword set", pass: !!data.focusKeyword },
  ];
  const passCount = checks.filter((c) => c.pass).length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 bg-white rounded-xl shadow-2xl border border-gray-200">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-4">
        <span className="flex items-center gap-2 font-semibold text-gray-800">
          <Search className="w-4 h-4" /> SEO — {passCount}/{checks.length}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="p-4 border-t border-gray-100 space-y-3">
          <input value={data.seoTitle || ""} onChange={(e) => setField("seoTitle", e.target.value)} placeholder="SEO title" className="w-full border rounded px-3 py-2 text-sm" />
          <textarea value={data.metaDescription || ""} onChange={(e) => setField("metaDescription", e.target.value)} placeholder="Meta description" rows={3} className="w-full border rounded px-3 py-2 text-sm" />
          <input value={data.canonicalUrl || ""} onChange={(e) => setField("canonicalUrl", e.target.value)} placeholder="Canonical URL" className="w-full border rounded px-3 py-2 text-sm" />
          <input value={data.focusKeyword || ""} onChange={(e) => setField("focusKeyword", e.target.value)} placeholder="Focus keyword" className="w-full border rounded px-3 py-2 text-sm" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={data.robotsIndex !== false} onChange={(e) => setField("robotsIndex", e.target.checked)} />
            Indexable
          </label>
          <ul className="text-xs space-y-1">
            {checks.map((c) => (
              <li key={c.label} className={c.pass ? "text-green-600" : "text-amber-600"}>
                {c.pass ? "✓" : "○"} {c.label}
              </li>
            ))}
          </ul>
          <button onClick={save} disabled={saving} className="w-full bg-blue-600 text-white rounded py-2 text-sm font-medium flex items-center justify-center gap-2">
            <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save SEO"}
          </button>
        </div>
      )}
    </div>
  );
}
```

Render `<SeoEditPanel path="about" />` once, near the bottom of the page's
JSX — it's fixed-positioned and only renders anything for an admin.

---

## 6. TARGET TYPE = `form` (booking, contact, quote request, newsletter, etc.)

**When to use:** the target collects user input and needs to notify an admin
— it is fundamentally different from a `component`: its state lives in
`FormSubmission` rows (write side), not in the `ComponentData` row that
defines its fields (definition side).

**Backend:**
- Field definition lives in `home/form-<NAME>/` (a `ComponentData` row, edited
  like any section — admin can add/remove/relabel fields with zero code
  changes).
- Submissions go to `forms/<NAME>/submit/` (public, POST, throttled).
- Admin views submissions via `forms/<NAME>/submissions/` (admin GET, not
  built into the public form component — that's a separate admin-only view if
  needed).

**Field definition shape** (what a `home/form-booking/` `PATCH` looks like):

```json
{
  "title": "Book a Consultation",
  "fields": [
    { "name": "fullName", "label": "Full Name", "type": "text", "required": true },
    { "name": "email", "label": "Email", "type": "email", "required": true },
    { "name": "date", "label": "Preferred Date", "type": "date", "required": true },
    { "name": "notes", "label": "Notes", "type": "textarea", "required": false }
  ],
  "submitLabel": "Request Booking",
  "successMessage": "Thanks — we'll confirm by email."
}
```

**Component:**

```jsx
"use client";
import { useEffect, useState } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL;

export default function DynamicForm({ name }) {
  const [definition, setDefinition] = useState(null);
  const [values, setValues] = useState({});
  const [status, setStatus] = useState("idle"); // idle | submitting | success | error

  useEffect(() => {
    fetch(`${apiUrl}/home/form-${name}/`).then((r) => r.json()).then((json) => {
      setDefinition(Object.keys(json).length ? json : null);
    });
  }, [name]);

  if (!definition) return null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus("submitting");
    try {
      const response = await fetch(`${apiUrl}/forms/${name}/submit/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "website" is a honeypot field the backend silently discards —
        // include it hidden so bots that auto-fill every field get dropped.
        body: JSON.stringify({ ...values, website: "" }),
      });
      setStatus(response.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  };

  if (status === "success") {
    return <p className="text-green-700 font-medium">{definition.successMessage || "Thank you!"}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      <h3 className="text-2xl font-bold text-gray-900">{definition.title}</h3>

      {/* Honeypot — real users never see or fill this in. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        className="absolute -left-[9999px]"
        aria-hidden="true"
      />

      {definition.fields.map((field) => (
        <div key={field.name}>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {field.label}{field.required && " *"}
          </label>
          {field.type === "textarea" ? (
            <textarea
              required={field.required}
              rows={4}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            />
          ) : (
            <input
              type={field.type}
              required={field.required}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            />
          )}
        </div>
      ))}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-3 rounded-lg disabled:opacity-50"
      >
        {status === "submitting" ? "Sending..." : definition.submitLabel || "Submit"}
      </button>
      {status === "error" && <p className="text-red-600 text-sm">Something went wrong — please try again.</p>}
    </form>
  );
}
```

The **field definition itself** (title, field list, labels) is admin-editable
using the exact same edit-mode pattern from §4, pointed at
`home/form-<name>/` instead of a content section — add a thin
`FormFieldEditor` wrapper only if the admin needs to edit field structure
in-place; otherwise editing that JSON via the general CMS admin surface is
sufficient.

---

## 7. TARGET TYPE = `list-page` (blog index, services list, etc.)

**When to use:** the target lists many items of one kind with a link into
each detail page.

**Backend:** `blog/` (or any future list-backed resource) — a real paginated
DRF list, not a `ComponentData` row.

```jsx
// app/blog/page.jsx
async function getPosts() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/blog/`, {
    next: { revalidate: 60 },
  });
  const json = await res.json();
  return json.results || []; // paginated: { count, next, previous, results }
}

export async function generateMetadata() {
  return { title: "Blog", description: "Latest articles and updates." };
}

export default async function BlogIndexPage() {
  const posts = await getPosts();
  return (
    <main className="max-w-5xl mx-auto px-4 py-16">
      <h1 className="text-4xl font-bold mb-10">Blog</h1>
      <div className="grid md:grid-cols-2 gap-8">
        {posts.map((post) => (
          <a key={post.slug} href={`/blog/${post.slug}`} className="block rounded-xl overflow-hidden shadow hover:shadow-lg transition-shadow">
            {post.content?.coverImage && (
              <img src={post.content.coverImage} alt={post.content.coverImageAlt || post.title} className="w-full h-48 object-cover" />
            )}
            <div className="p-5">
              <h2 className="text-xl font-bold text-gray-900">{post.title}</h2>
              <p className="text-gray-600 mt-2">{post.excerpt}</p>
            </div>
          </a>
        ))}
      </div>
    </main>
  );
}
```

Admin create/delete controls for a list page (new post button, delete-in-place)
follow the same `isAdmin` gate as §4, but call `POST /blog/` and
`DELETE /blog/<slug>/` — real REST semantics, not the upsert pattern.

---

## 8. TARGET TYPE = `blog-post` (a single detailed post, `blog/[slug]/page.jsx`)

**Backend:** `blog/<slug>/` — `GET` for content, `PATCH` for admin edits.
Content is **block-structured JSON**, not a single HTML/markdown string:

```json
{
  "coverImage": "https://.../cover.jpg",
  "coverImageAlt": "Team meeting in the new office",
  "sections": [
    { "type": "text", "heading": "Why this matters", "body": "..." },
    { "type": "image", "image": "https://...", "alt": "...", "caption": "..." },
    { "type": "text", "heading": "The approach", "body": "..." }
  ]
}
```

```jsx
// app/blog/[slug]/page.jsx
import { notFound } from "next/navigation";

async function getPost(slug) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/blog/${slug}/`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: "Post not found", robots: { index: false } };
  return {
    title: post.seo_title || post.title,
    description: post.meta_description || post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      title: post.seo_title || post.title,
      images: post.og_image ? [{ url: post.og_image, width: 1200, height: 630 }] : undefined,
    },
  };
}

export default async function BlogPostPage({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  return (
    <article className="max-w-3xl mx-auto px-4 py-16">
      {post.content.coverImage && (
        <img src={post.content.coverImage} alt={post.content.coverImageAlt || post.title} className="w-full rounded-xl mb-8" />
      )}
      <h1 className="text-4xl font-bold text-gray-900 mb-6">{post.title}</h1>
      {post.content.sections.map((section, i) =>
        section.type === "image" ? (
          <figure key={i} className="my-8">
            <img src={section.image} alt={section.alt || ""} className="w-full rounded-lg" />
            {section.caption && <figcaption className="text-sm text-gray-500 mt-2">{section.caption}</figcaption>}
          </figure>
        ) : (
          <section key={i} className="mb-8">
            {section.heading && <h2 className="text-2xl font-bold mb-3">{section.heading}</h2>}
            <p className="text-gray-700 leading-relaxed whitespace-pre-line">{section.body}</p>
          </section>
        )
      )}
    </article>
  );
}
```

The **admin edit surface** for a blog post's sections (add/remove/reorder
text and image blocks) follows the exact repeating-group pattern from §4's
`buttons` array — a `BlogPostEditor` client component fetching
`blog/<slug>/`, PATCHing back the whole `content` object, with per-section
add/remove/image-upload controls. Build it as a variant of §4 with
`sections` in place of `buttons`, not as a new pattern.

---

## 9. The Prompt Template

Copy everything below the line into a fresh request, fill in the blanks, and
attach the target file (if editing an existing component) or a description
of the new page/section/form.

```
TARGET TYPE = component | page | form | list-page | blog-post
TARGET = <file path, or "new component for X">
NAME = <ComponentData name, SEO path, or form name to use — kebab-case>

Follow FRONTEND_INTEGRATION_PROMPT.md in the backend/ root exactly:
- Use the backend contract in §1 — no invented endpoints or field names.
- Use the auth contract in §2 — Authorization: Token <key>, gate on
  localStorage.authToken, never Bearer.
- Use the image upload contract in §3 for every image field.
- Follow the pattern matching TARGET TYPE from §4 (component), §5 (page),
  §6 (form), §7 (list-page), or §8 (blog-post) as the structural template —
  adapt field names and visual design to the target, but keep the data flow,
  auth gating, save/cancel behavior, and upsert/REST semantics identical to
  the worked example.
- If TARGET TYPE = component or page-section: repeating groups (cards,
  buttons, list items) must be individually addable/removable/reorderable
  in edit mode, never just editable in place.
- If TARGET TYPE = page: implement BOTH generateMetadata() (§5a, server-side,
  required) AND the SeoEditPanel (§5b, client-side, admin UI) — do not skip
  generateMetadata() even if it feels redundant with the panel; the panel
  edits data, generateMetadata() is what actually emits the tags.
- If TARGET TYPE = blog-post: content is block-structured JSON (§8), never a
  single HTML or markdown string field.
- Keep 100% of the existing design, animation, spacing, and copy from TARGET
  as-is — only change how data is sourced, edited, and saved.
- Next.js App Router, no TypeScript, inline Tailwind classes, no new
  component libraries beyond what TARGET already imports (e.g. lucide-react
  icons if already in use).

Now implement TARGET per the above, and give me:
1. The full component/page code.
2. Sample JSON for every backend endpoint it reads from or writes to.
3. A one-line note on what NAME to use if a ComponentData/SEO/form row needs
   to be created for this to work (remember: nothing needs to be pre-seeded —
   the first PATCH creates it).
```
