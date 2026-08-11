import { PolicyViewer } from "@/features/policies/components/policy-viewer";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  await requireEmployeeModulePage(EmployeeModuleKey.POLICIES);
  const { id } = await params;
  return <PolicyViewer policyId={id} />;
}
