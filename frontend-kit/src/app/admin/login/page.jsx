"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { SITE_NAME } from "@/lib/brand";

function LoginForm() {
    const router = useRouter();
    const params = useSearchParams();
    const { signIn } = useAdmin();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    async function onSubmit(event) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await signIn(email.trim(), password);
            // Back to the page the admin came from: editing happens on the site.
            const next = params.get("next");
            router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
        } catch (err) {
            setError(err.status === 429 ? "Too many attempts. Please wait a minute." : err.message);
            setBusy(false);
        }
    }

    const input = "h-11 w-full rounded-xl border border-[#D6DEE8] px-4 text-[14px] outline-none focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20";

    return (
        <div className="flex min-h-screen items-center justify-center px-4">
            <form onSubmit={onSubmit} className="w-full max-w-[400px] rounded-3xl bg-white p-8 shadow-[0_30px_80px_rgba(15,23,42,0.12)]">
                <p className="text-[20px] font-bold text-[var(--cms-primary)]">{SITE_NAME}</p>
                <h1 className="mt-6 text-[22px] font-bold text-[#0F172A]">Sign in to the CMS</h1>
                <p className="mt-1 text-[13px] text-[#64748B]">Staff accounts only.</p>

                <label className="mt-6 block text-[12px] font-semibold text-[#475569]" htmlFor="email">Email or username</label>
                <input id="email" type="text" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${input}`} />

                <label className="mt-4 block text-[12px] font-semibold text-[#475569]" htmlFor="password">Password</label>
                <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={`mt-1 ${input}`} />

                {error ? <p role="alert" className="mt-4 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error}</p> : null}

                <button type="submit" disabled={busy} className="mt-6 h-11 w-full rounded-xl bg-[#FF6B4A] text-[14px] font-semibold text-white hover:brightness-95 disabled:opacity-60">
                    {busy ? "Signing in…" : "Sign in"}
                </button>
            </form>
        </div>
    );
}

export default function AdminLoginPage() {
    return (
        <Suspense>
            <LoginForm />
        </Suspense>
    );
}
