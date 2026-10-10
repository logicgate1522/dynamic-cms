"use client";

import { useContext, useId, useState } from "react";

import { AddItem, ItemTools, SectionEditContext, T } from "@/components/dynamic/edit-context";
import { keyOf, pick } from "@/components/dynamic/media";
import { submitForm } from "@/lib/forms";

/* ------------------------------------------------ faq */
export function Faq({ heading, eyebrow, items }) {
    const [open, setOpen] = useState(0);
    const baseId = useId();
    const list = Array.isArray(items) ? items : [];

    return (
        <section className="bg-[#F4F7F8] py-16 sm:py-20 lg:py-24">
            <div className="mx-auto w-full max-w-[920px] px-5 sm:px-6 lg:px-8">
                {eyebrow ? <p className="text-center text-[11px] font-semibold uppercase tracking-[0.32em] text-[#0F9E86] sm:text-xs"><T path="eyebrow" value={eyebrow} /></p> : null}
                {heading ? (
                    <h2 className="mb-10 mt-3 text-center font-serif text-[32px] font-bold leading-[1.1] text-[#123A5C] sm:text-[40px]"><T path="heading" value={heading} /></h2>
                ) : null}
                <div className="space-y-3">
                    {list.map((item, i) => {
                        const isOpen = open === i;
                        const panelId = `${baseId}-panel-${i}`;
                        return (
                            <div key={i} data-track-faq={i} className="relative overflow-hidden rounded-[18px] bg-white shadow-[0_8px_24px_rgba(18,58,92,0.06)]">
                                <ItemTools index={i}/>
                                <h3>
                                    <button
                                        type="button"
                                        aria-expanded={isOpen}
                                        aria-controls={panelId}
                                        onClick={() => setOpen(isOpen ? -1 : i)}
                                        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left text-[16px] font-semibold text-[#123A5C]"
                                    >
                                        <T path={`items.${i}.${keyOf(item, "question", "title", "q")}`} value={pick(item, "question", "title", "q")} />
                                        <span className={`text-[20px] text-[#0F9E86] transition ${isOpen ? "rotate-45" : ""}`} aria-hidden="true">+</span>
                                    </button>
                                </h3>
                                <div id={panelId} hidden={!isOpen} className="px-6 pb-6 text-[15px] leading-7 text-[#475569]">
                                    <AnswerText path={`items.${i}.${keyOf(item, "answer", "text", "a")}`} text={String(pick(item, "answer", "text", "a"))} />
                                </div>
                            </div>
                        );
                    })}
                    <AddItem label="Add question" />
                </div>
            </div>
        </section>
    );
}

function AnswerText({ path, text }) {
    const ctx = useContext(SectionEditContext);
    if (ctx?.editMode) return <p style={{ whiteSpace: "pre-line" }}><T path={path} value={text} multiline /></p>;
    return text.split(/\n\s*\n/).map((p, j) => <p key={j} className={j ? "mt-3" : ""}>{p}</p>);
}

/* ------------------------------------------------ newsletter */
export function Newsletter({ heading, description, form_name }) {
    const [email, setEmail] = useState("");
    const [state, setState] = useState({ status: "idle", message: "" });
    const formName = /^[\w-]+$/.test(form_name || "") ? form_name : "newsletter";

    async function onSubmit(event) {
        event.preventDefault();
        setState({ status: "sending", message: "" });
        const data = new FormData(event.currentTarget);
        // Stored in the CMS, emailed via FormSubmit, generate_lead fired — lib/forms.js.
        const result = await submitForm(formName, { email, website: data.get("website") || "" });
        if (!result.ok) {
            const err = result.errors.email || Object.values(result.errors)[0]
                || (result.status === 0 ? "Something went wrong. Please try again." : "Please check your email address.");
            setState({ status: "error", message: err });
            return;
        }
        setEmail("");
        setState({ status: "done", message: "Thanks — you're subscribed." });
    }

    return (
        <section className="bg-[#06182F] py-16 text-white sm:py-20">
            <div className="mx-auto w-full max-w-[760px] px-5 text-center sm:px-6">
                <h2 className="font-serif text-[30px] font-bold sm:text-[38px]"><T path="heading" value={heading} /></h2>
                {description ? <p className="mt-3 text-[15px] leading-7 text-[#D7E2EE]"><T path="description" value={description} /></p> : null}
                <form onSubmit={onSubmit} data-cms-form={formName} className="mx-auto mt-8 flex max-w-[520px] flex-col gap-3 sm:flex-row" noValidate>
                    <label className="sr-only" htmlFor="newsletter-email">Email address</label>
                    <input
                        id="newsletter-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email address"
                        className="h-12 flex-1 rounded-xl border border-white/20 bg-white px-4 text-[14px] text-[#123A5C] outline-none focus:border-[#0F9E86]"
                    />
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
                    <button type="submit" disabled={state.status === "sending"} className="h-12 rounded-xl bg-[#FF6B4A] px-6 text-[14px] font-semibold text-white hover:brightness-95 disabled:opacity-60">
                        {state.status === "sending" ? "Subscribing…" : "Subscribe"}
                    </button>
                </form>
                {state.message ? (
                    <p role="status" className={`mt-3 text-[13px] ${state.status === "error" ? "text-[#FCA5A5]" : "text-[#5EEAD4]"}`}>{state.message}</p>
                ) : null}
            </div>
        </section>
    );
}
