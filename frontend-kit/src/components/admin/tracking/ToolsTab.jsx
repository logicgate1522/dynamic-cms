"use client";

import { useState } from "react";

import { useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { TOOL_NAMES } from "@/components/admin/tracking/describe";
import { Empty, input, Pill, Section } from "@/components/admin/tracking/ui";
import { apiFetch, apiRequest } from "@/lib/api";

const BROWSER_TOOLS = [["gtm", "gtmId"], ["ga4", "ga4Id"], ["googleAds", "googleAdsId"], ["meta", "metaPixelId"], ["tiktok", "tiktokPixelId"],
    ["linkedin", "linkedinPartnerId"], ["clarity", "clarityId"], ["hotjar", "hotjarId"]];

const CONNECTIONS = {
    google: { name: "Google (GA4 + Tag Manager)", help: "Upload a service account key (Google Cloud → IAM → Service accounts → Keys → JSON) and add its email as Editor on your GA4 property (and GTM container). Creates GA4 dimensions, key events, audiences and the server-event secret for you.",
              labels: { propertyId: "GA4 property id (numbers)", measurementId: "Measurement id (G-…, optional)", streamName: "Data stream (optional)", gtmAccountId: "GTM account id (optional)", gtmContainerId: "GTM container id (optional)", serviceAccount: "Service account JSON key", mpSecret: "Measurement Protocol secret (optional — created by Sync)" } },
    meta: { name: "Meta (Facebook / Instagram)", help: "Business settings → Users → System users → Generate token (ads_management), assign your pixel (dataset) and ad account. Test event code: Events Manager → Test events.",
            labels: { pixelId: "Pixel / dataset id", adAccountId: "Ad account id", testEventCode: "Test event code (for checks)", token: "System user access token" } },
    tiktok: { name: "TikTok", help: "Events Manager → your pixel → Settings → Generate access token.", labels: { pixelCode: "Pixel code", advertiserId: "Advertiser id (optional)", testEventCode: "Test event code (for checks)", token: "Events API access token" } },
    linkedin: { name: "LinkedIn", help: "Needs a LinkedIn app with Marketing API (Conversions API) access.", labels: { adAccountId: "Ad account id", apiVersion: "API version (optional)", token: "Access token" } },
    google_ads: { name: "Google Ads (advanced)", help: "Optional. Without it, link GA4 to Google Ads and import the key events (one click in Google Ads). With a developer token, conversions upload directly with the click id.",
                  labels: { customerId: "Customer id", loginCustomerId: "Manager (MCC) id (optional)", developerToken: "Developer token", serviceAccount: "Service account JSON (with Ads access)" } },
};

export default function ToolsTab({ explain, settings, onChanged }) {
    const conns = useApi("tracking/connections/");
    const [open, setOpen] = useState(null);
    const [busy, setBusy] = useState("");
    const [message, setMessage] = useState({ error: "", success: "" });
    const [preview, setPreview] = useState(null);
    const analytics = settings?.analytics || {};
    const data = conns.data || {};
    const connections = data.connections || {};

    const act = async (label, fn) => {
        setBusy(label);
        setMessage({ error: "", success: "" });
        try {
            const res = await fn();
            setMessage({ error: "", success: res || "Done." });
            await conns.reload();
            onChanged?.();
        } catch (err) {
            setMessage({ error: err.message, success: "" });
        } finally {
            setBusy("");
        }
    };

    const downloadGtm = async () => {
        const res = await apiFetch("tracking/gtm/");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: "gtm-container-dynamic-cms.json" });
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div>
            {message.error ? <p className="mb-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{message.error}</p> : null}
            {message.success ? <p className="mb-3 rounded-lg bg-[#ECFDF3] px-3 py-2 text-[13px] text-[#067647]">{message.success}</p> : null}

            <Section title="Tools on the site" description="Paste IDs in Site tools → Settings → Tracking & analytics. Every event and conversion reaches each one automatically, in its own format.">
                <div className="grid gap-2 sm:grid-cols-2">
                    {BROWSER_TOOLS.map(([key, field]) => {
                        const on = Boolean(String(analytics[field] || "").trim());
                        return (
                            <div key={key} className="rounded-xl border border-[#E2E8F0] p-3" data-cms-tool={key}>
                                <div className="flex items-center gap-2">
                                    <strong className="text-[13px]">{TOOL_NAMES[key]}</strong>
                                    <span className="ml-auto"><Pill status={on ? "connected" : "skipped"}>{on ? analytics[field] : "not set"}</Pill></span>
                                </div>
                                <p className="mt-1 text-[11px] font-semibold text-[#334155]">{on ? "Use it to:" : "Add it to:"}</p>
                                <ul className="mt-0.5 list-disc pl-4 text-[12px] text-[#475569]">
                                    {(explain?.[key] || []).map((line, i) => <li key={i}>{line}</li>)}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            </Section>

            <Section
                title="Connections (once per tool)"
                description="So the CMS can create your conversions, audiences and dimensions inside each tool, and send server-side copies that ad blockers can't stop. Secrets are stored encrypted and never shown again."
                actions={<>
                    <button type="button" className={buttonStyles.secondary} disabled={Boolean(busy)} onClick={() => act("preview", async () => { setPreview(await apiRequest("tracking/sync/?preview=1", { method: "POST" })); return "Preview below."; })}>Preview sync</button>
                    <button type="button" className={buttonStyles.primary} disabled={Boolean(busy)} onClick={() => act("sync", async () => { await apiRequest("tracking/sync/", { method: "POST" }); return "Sync started — refresh in a minute to see each item's status."; })}>{busy === "sync" ? "Starting…" : "Sync now"}</button>
                </>}
            >
                {data.hasKey === false ? <p className="mb-2 rounded-lg bg-[#FFFAEB] px-3 py-2 text-[12px] text-[#B54708]">The backend has no TRACKING_SECRET_KEY, so connections can't be saved. Ask your developer to set it (see .env.example).</p> : null}
                <div className="space-y-2">
                    {Object.entries(CONNECTIONS).map(([tool, spec]) => {
                        const c = connections[tool];
                        return (
                            <div key={tool} className="rounded-xl border border-[#E2E8F0] p-3" data-cms-connection={tool}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <strong className="text-[13px]">{spec.name}</strong>
                                    <Pill status={c?.status || "skipped"}>{c?.status ? c.status.replace("_", " ") : "not connected"}</Pill>
                                    {c?.hint ? <code className="text-[11px] text-[#94A3B8]">{c.hint}</code> : null}
                                    <span className="ml-auto flex gap-2">
                                        <button type="button" className={buttonStyles.link} onClick={() => setOpen(open === tool ? null : tool)}>{c ? "Update" : "Connect"}</button>
                                        {c ? <button type="button" className={buttonStyles.danger} disabled={Boolean(busy)} onClick={() => {
                                            const remote = window.confirm(`Also remove what the CMS created in ${spec.name}? (OK = remove, Cancel = keep them)`);
                                            act("disconnect", async () => { await apiRequest(`tracking/connections/${tool}/${remote ? "?remote=1" : ""}`, { method: "DELETE" }); return "Disconnected."; });
                                        }}>Disconnect</button> : null}
                                    </span>
                                </div>
                                {c?.error ? <p className="mt-1 text-[12px] text-[#B42318]">{c.error}</p> : null}
                                {open === tool ? (
                                    <ConnectForm tool={tool} spec={spec} fields={data.fields?.[tool]} current={c?.account || {}} busy={busy === tool}
                                                 onSubmit={(body) => act(tool, async () => { const r = await apiRequest(`tracking/connections/${tool}/`, { method: "POST", body }); setOpen(null); return `Connected${r.info ? `: ${Object.values(r.info).filter((v) => typeof v === "string").join(", ")}` : ""}.`; })} />
                                ) : null}
                            </div>
                        );
                    })}
                </div>
                {preview ? (
                    <div className="mt-3 rounded-lg bg-[#F8FAFC] p-3 text-[12px]">
                        {Object.keys(preview).length ? Object.entries(preview).map(([tool, p]) => (
                            <p key={tool}><strong>{tool}</strong>: create {p.create.length}, update {p.update.length}, archive {p.archive.length}</p>
                        )) : "No tools connected."}
                    </div>
                ) : null}
            </Section>

            <Section title="What the CMS manages in your tools">
                {(data.items || []).length ? (
                    <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
                        <table className="w-full text-left text-[12px]">
                            <thead className="bg-[#F8FAFC] text-[#64748B]"><tr><th className="p-2">Tool</th><th className="p-2">Item</th><th className="p-2">Status</th><th className="p-2"></th></tr></thead>
                            <tbody>
                                {data.items.map((item, i) => (
                                    <tr key={i} className="border-t border-[#E2E8F0] align-top">
                                        <td className="p-2">{item.tool}</td>
                                        <td className="p-2">{item.kind.replace(/_/g, " ")} · <code>{item.plan_id}</code>
                                            {item.manual ? <pre className="mt-1 whitespace-pre-wrap text-[11px] text-[#475569]">Create manually: {JSON.stringify(item.manual, null, 1)}</pre> : null}
                                        </td>
                                        <td className="p-2"><Pill status={item.status} />{item.error ? <span className="mt-0.5 block text-[11px] text-[#B42318]">{item.error}</span> : null}</td>
                                        <td className="p-2 whitespace-nowrap">
                                            {item.status !== "unmanaged" ? <button type="button" className={buttonStyles.link} onClick={() => act("item", async () => { await apiRequest(`tracking/sync/items/${item.id}/`, { method: "POST", body: { action: "keep_theirs" } }); return "The CMS won't change that item again."; })}>Keep theirs</button>
                                                : <button type="button" className={buttonStyles.link} onClick={() => act("item", async () => { await apiRequest(`tracking/sync/items/${item.id}/`, { method: "POST", body: { action: "restore_ours" } }); return "Will be restored on the next sync."; })}>Restore ours</button>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : <Empty>Nothing yet. Connect a tool and approve the plan; items appear after the first sync.</Empty>}
            </Section>

            <Section title="Google Tag Manager" description="Every CMS event, parameter and conversion as GTM variables, triggers and GA4 tags.">
                <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonStyles.secondary} onClick={() => downloadGtm().catch((e) => setMessage({ error: e.message, success: "" }))}>Download container (import in GTM)</button>
                    <GtmPush disabled={connections.google?.status !== "connected"} act={act} />
                </div>
            </Section>
        </div>
    );
}

function GtmPush({ disabled, act }) {
    const [workspace, setWorkspace] = useState("");
    return (
        <>
            <button type="button" className={buttonStyles.secondary} disabled={disabled} title={disabled ? "Connect Google with the GTM ids first" : ""}
                    onClick={() => act("gtm", async () => { const r = await apiRequest("tracking/gtm/", { method: "POST" }); setWorkspace(r.workspace); return "Workspace created in GTM. Review it there, then publish."; })}>
                Push to GTM (new workspace)
            </button>
            {workspace ? (
                <button type="button" className={buttonStyles.primary}
                        onClick={() => window.confirm("Publish this workspace? Other tags in the container go live too.") && act("gtm-publish", async () => { await apiRequest(`tracking/gtm/?publish=${encodeURIComponent(workspace)}`, { method: "POST" }); setWorkspace(""); return "Published."; })}>
                    Publish workspace
                </button>
            ) : null}
        </>
    );
}

function ConnectForm({ tool, spec, fields, current, busy, onSubmit }) {
    const [account, setAccount] = useState(() => ({ ...current }));
    const [secret, setSecret] = useState({});
    if (!fields) return <p className="mt-2 text-[12px] text-[#64748B]">Loading…</p>;
    return (
        <form className="mt-3 grid gap-2 rounded-lg bg-[#F8FAFC] p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ account, secret }); }}>
            <p className="text-[12px] text-[#475569] sm:col-span-2">{spec.help}</p>
            {fields.account.map((k) => (
                <label key={k} className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-[#334155]">{spec.labels[k] || k}</span>
                    <input className={input} value={account[k] || ""} onChange={(e) => setAccount({ ...account, [k]: e.target.value })} />
                </label>
            ))}
            {fields.secret.map((k) => (
                <label key={k} className={`block ${k === "serviceAccount" ? "sm:col-span-2" : ""}`}>
                    <span className="mb-1 block text-[11px] font-semibold text-[#334155]">{spec.labels[k] || k} <span className="font-normal text-[#94A3B8]">(leave empty to keep the saved one)</span></span>
                    {k === "serviceAccount" ? (
                        <>
                            <input type="file" accept="application/json,.json" className="text-[12px]" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setSecret({ ...secret, [k]: await f.text() }); }} />
                            {secret[k] ? <span className="ml-2 text-[11px] text-[#067647]">key loaded</span> : null}
                        </>
                    ) : (
                        <input className={input} type="password" autoComplete="off" value={secret[k] || ""} onChange={(e) => setSecret({ ...secret, [k]: e.target.value })} />
                    )}
                </label>
            ))}
            <div className="sm:col-span-2">
                <button type="submit" className={buttonStyles.primary} disabled={busy}>{busy ? "Checking with the tool…" : "Check & save"}</button>
            </div>
        </form>
    );
}
