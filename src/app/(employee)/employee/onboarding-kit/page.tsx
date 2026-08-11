import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";
import { MaterialList } from "@/features/onboarding-kit/components/material-list";

export default async function OnboardingKitPage() {
  await requireEmployeeModulePage(EmployeeModuleKey.ONBOARDING_KIT);
  return (
    <main className="employee-content">
      <header className="employee-hero">
        <p className="eyebrow">ONBOARDING KIT · 入职资料</p>
        <h1>入职资料包</h1>
        <p>在这里查找并下载入职所需资料。</p>
      </header>
      <MaterialList />
    </main>
  );
}
