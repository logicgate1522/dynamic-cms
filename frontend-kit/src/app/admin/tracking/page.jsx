"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { PageTitle } from "@/components/admin/AdminShell";
import TrackingPanel from "@/components/admin/tracking/TrackingPanel";

function Panel() {
    const params = useSearchParams();
    const runAll = params.get("run") === "all";
    return <TrackingPanel initialTab={runAll ? "checks" : params.get("tab") || "overview"} autoRun={runAll} />;
}

export default function TrackingPage() {
    return (
        <>
            <PageTitle title="Tracking" description="Which actions count as results, which offerings and customer types they come from, which tools receive them — and proof that every conversion works." />
            <Suspense fallback={null}>
                <Panel />
            </Suspense>
        </>
    );
}
