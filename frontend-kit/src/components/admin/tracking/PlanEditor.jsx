"use client";

import { useEffect, useState } from "react";

import { buttonStyles } from "@/components/cms/Drawer";
import { describeRule, describeTrigger, EVENT_LABELS } from "@/components/admin/tracking/describe";
import { Empty, input, Pill, Section } from "@/components/admin/tracking/ui";
import { blockOf } from "@/lib/trackCapture";

/* Edit every part of the tracking plan. Lists are keyed by index (R30). */

const META_EVENTS = ["Lead", "Schedule", "Contact", "SubmitApplication", "CompleteRegistration", "ViewContent", "Search", "Subscribe", "Donate", "custom"];
const PICK_KEY = "cms_tracking_pick";

const slug = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^\d+_?/, "").slice(0, 37) || "item";

function uniqueId(base, items) {
    let id = /^[a-z]/.test(base) ? base : `x_${base}`.slice(0, 37);
    let n = 2;
    while (items.some((x) => x.id === id)) id = `${base.slice(0, 34)}_${n++}`;
    return id;
}

/* ------------------------------------------------------------ pick on page */

export function startPick(onDone) {
    const banner = document.createElement("div");
    banner.className = "cms-ui";
    banner.setAttribute("data-cms-pick-banner", "");
    banner.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:3000;background:#0F172A;color:#fff;padding:10px 16px;border-radius:999px;font:600 13px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.3)";
    banner.textContent = "Click the button, link or section you want to track · Esc to cancel";
    document.body.appendChild(banner);
    const finish = (result) => {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        banner.remove();
        try {
            if (result) sessionStorage.setItem(PICK_KEY, JSON.stringify(result));
        } catch {
            /* storage blocked: the panel opens without the pick */
        }
        onDone(result);
    };
    const onClick = (e) => {
        if (e.target.closest(".cms-ui, [data-cms-layer]")) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.target;
        const link = el.closest("a[href]");
        const block = blockOf(el).name;
        let target = null;
        try {
            const u = link ? new URL(link.getAttribute("href"), location.href) : null;
            target = u && u.origin === location.origin ? u.pathname.replace(/\/+$/, "") || "/" : null;
        } catch {
            target = null;
        }
        const label = (link || el).textContent.replace(/\s+/g, " ").trim().slice(0, 60);
        finish(link && target
            ? { event: "cta_click", label: `Clicked “${label}”`, where: { ctaTargets: [target], ...(block ? { blocks: [block] } : {}) } }
            : block ? { event: "section_view", label: `Saw ${block}`, where: { blocks: [block] } } : null);
    };
    const onKey = (e) => e.key === "Escape" && finish(null);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
}

function takePick() {
    try {
        const raw = sessionStorage.getItem(PICK_KEY);
        sessionStorage.removeItem(PICK_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/* ---------------------------------------------------------------- editor */

export default function PlanEditor({ plan, facts, onChange, onPick }) {
    const [editing, setEditing] = useState(null); // {kind, index}
    const set = (kind, list) => onChange({ ...plan, [kind]: list });
    const update = (kind, index, patch) => set(kind, plan[kind].map((x, i) => (i === index ? { ...x, ...patch } : x)));
    const remove = (kind, index) => set(kind, plan[kind].filter((_, i) => i !== index));

    useEffect(() => {
        const pick = takePick();
        if (!pick) return;
        const id = uniqueId(slug(pick.label), plan.conversions || []);
        set("conversions", [...(plan.conversions || []), { id, label: pick.label.slice(0, 60), tier: "secondary", enabled: true, createdBy: "owner",
            trigger: { event: pick.event, where: pick.where }, value: { mode: "none" }, destinations: { ga4: "event", meta: "custom" } }]);
        setEditing({ kind: "conversions", index: (plan.conversions || []).length });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const addConversion = () => {
        const id = uniqueId("new_conversion", plan.conversions || []);
        set("conversions", [...(plan.conversions || []), { id, label: "New conversion", tier: "secondary", enabled: true, createdBy: "owner",
            trigger: { event: "cta_click", where: {} }, value: { mode: "none" }, destinations: { ga4: "event", meta: "custom" } }]);
        setEditing({ kind: "conversions", index: (plan.conversions || []).length });
    };
    const addSimple = (kind, label) => {
        const id = uniqueId(slug(label), plan[kind] || []);
        set(kind, [...(plan[kind] || []), kind === "audiences"
            ? { id, label, purpose: "", include: [], exclude: [], windowDays: 30, tools: ["ga4", "meta"], createdBy: "owner" }
            : { id, label, match: { paths: [], blocks: [], faqKeywords: [], formOptions: [] }, createdBy: "owner" }]);
        setEditing({ kind, index: (plan[kind] || []).length });
    };

    return (
        <div>
            <Section
                title="Conversions"
                description="What counts as a result. Primary = real leads (sent to ad tools for bidding). Secondary = intent signals (for insight and audiences)."
                actions={<>
                    <button type="button" className={buttonStyles.secondary} onClick={onPick} title="Close this panel and click the thing on the page">Pick on page</button>
                    <button type="button" className={buttonStyles.secondary} onClick={addConversion}>+ Add conversion</button>
                </>}
            >
                {(plan.conversions || []).length ? (
                    <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                        {plan.conversions.map((c, index) => (
                            <div key={index} className="p-3" data-cms-conversion={c.id}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Pill status={c.tier === "primary" ? "in_sync" : "skipped"}>{c.tier}</Pill>
                                    <strong className="text-[13px] text-[#0F172A]">{c.label}</strong>
                                    {c.enabled === false ? <Pill status="inactive">off</Pill> : null}
                                    {c.locked ? <Pill status="manual">locked</Pill> : null}
                                    <span className="text-[11px] text-[#94A3B8]">{c.createdBy}</span>
                                    <span className="ml-auto flex gap-1">
                                        <button type="button" className={buttonStyles.link} onClick={() => setEditing(editing?.kind === "conversions" && editing.index === index ? null : { kind: "conversions", index })}>
                                            {editing?.kind === "conversions" && editing.index === index ? "Close" : "Edit"}
                                        </button>
                                        <button type="button" className={buttonStyles.danger} onClick={() => remove("conversions", index)} aria-label={`Remove ${c.label}`}>✕</button>
                                    </span>
                                </div>
                                <p className="mt-1 text-[12px] text-[#475569]">{describeTrigger(c.trigger, plan)}</p>
                                {c.rationale ? <p className="mt-0.5 text-[11px] text-[#94A3B8]">Why: {c.rationale}</p> : null}
                                {editing?.kind === "conversions" && editing.index === index ? (
                                    <ConversionForm conversion={c} plan={plan} facts={facts} onChange={(patch) => update("conversions", index, patch)} />
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : <Empty>No conversions yet. Use “Build from library” or “Ask AI” above.</Empty>}
            </Section>

            {[["intents", "Intents", "The things people come for (one per offering)."],
              ["segments", "Customer types", "Who they are (from your form options and “who we help” content)."],
              ["stages", "Buying stages", "Where they are in the decision (switching, deadline, price-checking…)."]].map(([kind, title, description]) => (
                <Section key={kind} title={title} description={description}
                         actions={<button type="button" className={buttonStyles.secondary} onClick={() => addSimple(kind, `New ${title.toLowerCase().replace(/s$/, "")}`)}>+ Add</button>}>
                    {(plan[kind] || []).length ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                            {plan[kind].map((item, index) => (
                                <div key={index} className="rounded-xl border border-[#E2E8F0] p-3">
                                    <div className="flex items-center gap-2">
                                        <strong className="text-[13px]">{item.label}</strong>
                                        <code className="text-[11px] text-[#94A3B8]">{item.id}</code>
                                        {item.locked ? <Pill status="manual">locked</Pill> : null}
                                        <span className="ml-auto flex gap-1">
                                            <button type="button" className={buttonStyles.link} onClick={() => setEditing(editing?.kind === kind && editing.index === index ? null : { kind, index })}>Edit</button>
                                            <button type="button" className={buttonStyles.danger} onClick={() => remove(kind, index)} aria-label={`Remove ${item.label}`}>✕</button>
                                        </span>
                                    </div>
                                    <p className="mt-1 text-[11px] text-[#64748B]">
                                        {[...(item.match?.paths || []), ...(item.match?.blocks || [])].join(", ") || "—"}
                                        {item.match?.formOptions?.length ? ` · form: ${item.match.formOptions.map((f) => f.option).join(", ")}` : ""}
                                    </p>
                                    {editing?.kind === kind && editing.index === index ? (
                                        <MatchForm item={item} kind={kind} facts={facts} onChange={(patch) => update(kind, index, patch)} />
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : <Empty>None yet.</Empty>}
                </Section>
            ))}

            <Section title="Audiences" description="Groups of visitors to show ads to (or exclude), with what to tell them. Created in each connected ad tool for you."
                     actions={<button type="button" className={buttonStyles.secondary} onClick={() => addSimple("audiences", "New audience")}>+ Add audience</button>}>
                {(plan.audiences || []).length ? (
                    <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                        {plan.audiences.map((a, index) => (
                            <div key={index} className="p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <strong className="text-[13px]">{a.label}</strong>
                                    {a.role === "exclusion" ? <Pill status="skipped">exclude</Pill> : null}
                                    <span className="text-[11px] text-[#94A3B8]">{a.windowDays} days · {(a.tools || []).join(", ")}</span>
                                    <span className="ml-auto flex gap-1">
                                        <button type="button" className={buttonStyles.link} onClick={() => setEditing(editing?.kind === "audiences" && editing.index === index ? null : { kind: "audiences", index })}>Edit</button>
                                        <button type="button" className={buttonStyles.danger} onClick={() => remove("audiences", index)} aria-label={`Remove ${a.label}`}>✕</button>
                                    </span>
                                </div>
                                <p className="mt-1 text-[12px] text-[#475569]">
                                    People who {(a.include || []).map((r) => describeRule(r, plan)).join(" or ") || "…"}
                                    {(a.exclude || []).length ? `, except those who ${(a.exclude || []).map((r) => describeRule(r, plan)).join(" or ")}` : ""}.
                                </p>
                                {a.purpose ? <p className="mt-0.5 text-[12px] text-[#0F766E]">Use it to: {a.purpose}</p> : null}
                                {editing?.kind === "audiences" && editing.index === index ? (
                                    <AudienceForm audience={a} plan={plan} onChange={(patch) => update("audiences", index, patch)} />
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : <Empty>No audiences yet.</Empty>}
            </Section>
        </div>
    );
}

/* ------------------------------------------------------------- forms */

function Field({ label, children, help }) {
    return (
        <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-[#334155]">{label}</span>
            {children}
            {help ? <span className="mt-0.5 block text-[11px] text-[#94A3B8]">{help}</span> : null}
        </label>
    );
}

function ConversionForm({ conversion: c, plan, facts, onChange }) {
    const w = c.trigger?.where || {};
    const setWhere = (patch) => {
        const next = { ...w, ...patch };
        for (const k of Object.keys(next)) if (next[k] === "" || next[k] == null || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
        onChange({ trigger: { ...c.trigger, where: next } });
    };
    const forms = facts?.forms || [];
    const form = forms.find((f) => f.name === w.form);
    const field = form?.fields.find((f) => f.name === w.field);
    const pages = (facts?.pages || []).map((p) => p.path);
    const blocks = Object.keys(facts?.blocks || {});
    const ev = c.trigger?.event;
    return (
        <div className="mt-3 grid gap-3 rounded-lg bg-[#F8FAFC] p-3 sm:grid-cols-2">
            <Field label="Name"><input className={input} value={c.label} onChange={(e) => onChange({ label: e.target.value.slice(0, 60) })} /></Field>
            <Field label="Kind">
                <select className={input} value={c.tier} onChange={(e) => onChange({ tier: e.target.value, destinations: { ...c.destinations, ga4: e.target.value === "primary" ? "key_event" : "event", googleAds: e.target.value === "primary" ? "import_from_ga4" : null } })}>
                    <option value="primary">Primary (a real lead)</option>
                    <option value="secondary">Secondary (a signal)</option>
                </select>
            </Field>
            <Field label="Happens when">
                <select className={input} value={ev} onChange={(e) => onChange({ trigger: { event: e.target.value, where: {} } })}>
                    {Object.entries(EVENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
            </Field>
            {["generate_lead", "form_start", "form_abandon", "form_error"].includes(ev) ? (
                <>
                    <Field label="Form">
                        <select className={input} value={w.form || ""} onChange={(e) => setWhere({ form: e.target.value, field: "", option: "" })}>
                            <option value="">Any form</option>
                            {forms.map((f, i) => <option key={i} value={f.name}>{f.name}</option>)}
                        </select>
                    </Field>
                    {ev === "generate_lead" && form ? (
                        <Field label="Only when this answer is chosen" help="e.g. one conversion per service ticked">
                            <div className="flex gap-2">
                                <select className={input} value={w.field || ""} onChange={(e) => setWhere({ field: e.target.value, option: "" })}>
                                    <option value="">Any answers</option>
                                    {form.fields.filter((f) => (f.options || []).length).map((f, i) => <option key={i} value={f.name}>{f.label || f.name}</option>)}
                                </select>
                                {field ? (
                                    <select className={input} value={w.option || ""} onChange={(e) => setWhere({ option: e.target.value })}>
                                        <option value="">Pick…</option>
                                        {(field.options || []).map((o, i) => <option key={i} value={o.value}>{o.label}</option>)}
                                    </select>
                                ) : null}
                            </div>
                        </Field>
                    ) : null}
                </>
            ) : null}
            {ev === "cta_click" ? (
                <Field label="Going to page">
                    <select className={input} value={w.ctaTargets?.[0] || ""} onChange={(e) => setWhere({ ctaTargets: e.target.value ? [e.target.value] : [] })}>
                        <option value="">Any CTA</option>
                        {pages.map((p, i) => <option key={i} value={p}>{p}</option>)}
                    </select>
                </Field>
            ) : null}
            {["cta_click", "section_view"].includes(ev) ? (
                <Field label="In section" help={blocks.length ? "" : "Scan the site to list sections"}>
                    <select className={input} value={w.blocks?.[0] || ""} onChange={(e) => setWhere({ blocks: e.target.value ? [e.target.value] : [] })}>
                        <option value="">{ev === "section_view" ? "Pick a section…" : "Any section"}</option>
                        {blocks.map((b, i) => <option key={i} value={b}>{b}{facts.blocks[b].heading ? ` — ${facts.blocks[b].heading.slice(0, 40)}` : ""}</option>)}
                    </select>
                </Field>
            ) : null}
            {["service_engaged", "cta_click", "faq_open"].includes(ev) ? (
                <Field label="About">
                    <select className={input} value={w.intent || ""} onChange={(e) => setWhere({ intent: e.target.value })}>
                        <option value="">Any offering</option>
                        {(plan.intents || []).map((x, i) => <option key={i} value={x.id}>{x.label}</option>)}
                    </select>
                </Field>
            ) : null}
            {ev === "faq_open" ? (
                <Field label="Signalling stage">
                    <select className={input} value={w.stage || ""} onChange={(e) => setWhere({ stage: e.target.value })}>
                        <option value="">Any</option>
                        {(plan.stages || []).map((x, i) => <option key={i} value={x.id}>{x.label}</option>)}
                    </select>
                </Field>
            ) : null}
            {ev === "scroll_depth" ? (
                <Field label="Depth / pages">
                    <div className="flex gap-2">
                        <select className={input} value={w.percent || 75} onChange={(e) => setWhere({ percent: Number(e.target.value) })}>
                            {[25, 50, 75, 90].map((p) => <option key={p} value={p}>{p}%</option>)}
                        </select>
                        <select className={input} value={w.pageType || ""} onChange={(e) => setWhere({ pageType: e.target.value })}>
                            <option value="">Any page</option>
                            {["article", "entry", "service"].map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                </Field>
            ) : null}
            {ev === "contact_click" ? (
                <Field label="Channel">
                    <select className={input} value={w.method || ""} onChange={(e) => setWhere({ method: e.target.value })}>
                        <option value="">Any</option>
                        {["phone", "email", "whatsapp"].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                </Field>
            ) : null}
            {ev === "page_view" ? (
                <Field label="Page">
                    <select className={input} value={w.path || ""} onChange={(e) => setWhere({ path: e.target.value })}>
                        <option value="">Pick…</option>
                        {pages.map((p, i) => <option key={i} value={p}>{p}</option>)}
                    </select>
                </Field>
            ) : null}
            <Field label="Meta (Facebook) event">
                <select className={input} value={c.destinations?.meta || "custom"} onChange={(e) => onChange({ destinations: { ...c.destinations, meta: e.target.value } })}>
                    {META_EVENTS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
            </Field>
            <Field label="Value (optional)" help="A relative value so ad tools favour better leads. Never shown to visitors.">
                <div className="flex gap-2">
                    <select className={input} value={c.value?.mode || "none"} onChange={(e) => onChange({ value: { mode: e.target.value, amount: c.value?.amount || 0 } })}>
                        <option value="none">No value</option>
                        <option value="fixed">Fixed amount</option>
                        <option value="by_intent">Sum of offering values</option>
                    </select>
                    {c.value?.mode === "fixed" ? <input className={input} type="number" min="0" value={c.value.amount || 0} onChange={(e) => onChange({ value: { mode: "fixed", amount: Number(e.target.value) || 0 } })} /> : null}
                </div>
            </Field>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={c.enabled !== false} onChange={(e) => onChange({ enabled: e.target.checked })} /> On</label>
                <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={Boolean(c.locked)} onChange={(e) => onChange({ locked: e.target.checked })} /> Lock (AI and rebuilds never change it)</label>
            </div>
        </div>
    );
}

function MatchForm({ item, kind, facts, onChange }) {
    const m = item.match || {};
    const list = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
    return (
        <div className="mt-2 grid gap-2 rounded-lg bg-[#F8FAFC] p-2">
            <Field label="Name"><input className={input} value={item.label} onChange={(e) => onChange({ label: e.target.value.slice(0, 60) })} /></Field>
            {kind === "intents" ? (
                <Field label="Pages (comma-separated)">
                    <input className={input} value={(m.paths || []).join(", ")} list="cms-tracking-pages" onChange={(e) => onChange({ match: { ...m, paths: list(e.target.value) } })} />
                    <datalist id="cms-tracking-pages">{(facts?.pages || []).map((p, i) => <option key={i} value={p.path} />)}</datalist>
                </Field>
            ) : null}
            <Field label="Question words (comma-separated)" help="A FAQ containing one of these counts toward this.">
                <input className={input} value={(m.faqKeywords || []).join(", ")} onChange={(e) => onChange({ match: { ...m, faqKeywords: list(e.target.value) } })} />
            </Field>
            {kind !== "stages" && (m.formOptions || []).length ? (
                <p className="text-[11px] text-[#64748B]">Form answer: {m.formOptions.map((f) => `${f.field} = “${f.option}”`).join(", ")}</p>
            ) : null}
            {kind === "intents" ? (
                <Field label="Relative value (optional)" help="Used when a conversion's value is “sum of offering values”.">
                    <input className={input} type="number" min="0" value={item.value || 0} onChange={(e) => onChange({ value: Number(e.target.value) || 0 })} />
                </Field>
            ) : null}
            <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={Boolean(item.locked)} onChange={(e) => onChange({ locked: e.target.checked })} /> Lock</label>
        </div>
    );
}

function AudienceForm({ audience: a, plan, onChange }) {
    const options = [
        ...(plan.conversions || []).map((c) => ({ key: `conversion:${c.id}`, label: `did “${c.label}”`, rule: { conversion: c.id } })),
        ...(plan.intents || []).map((i) => ({ key: `intent:${i.id}`, label: `read about ${i.label}`, rule: { event: "service_engaged", intent: i.id } })),
        ...(plan.stages || []).map((s) => ({ key: `stage:${s.id}`, label: `signalled “${s.label}”`, rule: { event: "faq_open", stage: s.id } })),
    ];
    const keyOf = (r) => (r.conversion ? `conversion:${r.conversion}` : r.intent ? `intent:${r.intent}` : r.stage ? `stage:${r.stage}` : "");
    const pick = (side, key) => onChange({ [side]: key ? [options.find((o) => o.key === key).rule] : [] });
    return (
        <div className="mt-3 grid gap-3 rounded-lg bg-[#F8FAFC] p-3 sm:grid-cols-2">
            <Field label="Name"><input className={input} value={a.label} onChange={(e) => onChange({ label: e.target.value.slice(0, 60) })} /></Field>
            <Field label="Use it to"><input className={input} value={a.purpose || ""} onChange={(e) => onChange({ purpose: e.target.value.slice(0, 200) })} /></Field>
            <Field label="People who">
                <select className={input} value={keyOf(a.include?.[0] || {})} onChange={(e) => pick("include", e.target.value)}>
                    <option value="">Pick…</option>
                    {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
            </Field>
            <Field label="Except people who">
                <select className={input} value={keyOf(a.exclude?.[0] || {})} onChange={(e) => pick("exclude", e.target.value)}>
                    <option value="">Nobody</option>
                    {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
            </Field>
            <Field label="Days to remember them" help="Meta keeps website audiences for up to 180 days.">
                <input className={input} type="number" min="1" max="540" value={a.windowDays || 30} onChange={(e) => onChange({ windowDays: Math.min(540, Math.max(1, Number(e.target.value) || 30)) })} />
            </Field>
            <Field label="Create in">
                <div className="flex flex-wrap gap-3 pt-1">
                    {["ga4", "meta", "googleAds", "tiktok", "linkedin"].map((t) => (
                        <label key={t} className="flex items-center gap-1 text-[12px]">
                            <input type="checkbox" checked={(a.tools || []).includes(t)} onChange={(e) => onChange({ tools: e.target.checked ? [...(a.tools || []), t] : (a.tools || []).filter((x) => x !== t) })} />
                            {t}
                        </label>
                    ))}
                </div>
            </Field>
        </div>
    );
}
