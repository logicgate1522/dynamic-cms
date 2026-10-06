import AdminShell from "@/components/admin/AdminShell";
import { SITE_NAME } from "@/lib/brand";

export const metadata = {
    title: { absolute: `CMS Dashboard | ${SITE_NAME}` },
    robots: { index: false, follow: false },
};

export default function AdminLayout({ children }) {
    return <AdminShell>{children}</AdminShell>;
}
