import { GuideViewer } from "@/features/guides/components/guide-viewer";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function GuidePage({ params }: { params: Promise<{ city: string }> }) {
  await requireEmployeeModulePage(EmployeeModuleKey.GUIDES);
  const { city } = await params;
  return <GuideViewer city={city} />;
}
