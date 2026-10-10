"use client";

import { PageTitle } from "@/components/admin/AdminShell";
import ContactsPanel from "@/components/admin/contacts/ContactsPanel";

export default function ContactsPage() {
    return (
        <>
            <PageTitle title="Contacts" description="Everyone who got in touch: what they wanted, where they came from, and where they are in your pipeline." />
            <ContactsPanel />
        </>
    );
}
