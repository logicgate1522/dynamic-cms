"use client";

import { PageTitle } from "@/components/admin/AdminShell";
import TrackingPanel from "@/components/admin/tracking/TrackingPanel";

export default function TrackingPage() {
    return (
        <>
            <PageTitle title="Tracking" description="Which actions count as results, which offerings and customer types they come from, which tools receive them — and proof that every conversion works." />
            <TrackingPanel />
        </>
    );
}
