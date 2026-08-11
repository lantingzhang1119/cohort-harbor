import type { Metadata } from "next";

import { EmployeeAdmin } from "@/features/employees/components/employee-admin";

export const metadata: Metadata = { title: "员工管理" };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <EmployeeAdmin initialFilters={{
    query: first(params.query),
    location: first(params.location),
    enabled: first(params.enabled),
  }} />;
}
