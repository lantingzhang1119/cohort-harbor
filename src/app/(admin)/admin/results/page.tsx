import { AdminResults } from "@/features/exams/components/admin-results";

export default async function AdminResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <AdminResults initialStatus={Array.isArray(status) ? status[0] : status} />;
}
