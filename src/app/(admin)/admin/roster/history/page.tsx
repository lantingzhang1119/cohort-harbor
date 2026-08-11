import { RosterHistory } from "@/features/roster/components/roster-history";

export default async function RosterHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <RosterHistory initialStatus={Array.isArray(status) ? status[0] : status} />;
}
