import { PolicyList } from "@/features/policies/components/policy-list";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function PoliciesPage() {
  await requireEmployeeModulePage(EmployeeModuleKey.POLICIES);
  return <main className="employee-content"><header className="employee-hero"><p className="eyebrow">POLICIES · 制度学习</p><h1>公司制度</h1><p>这里展示面向全体在职员工发布的制度，阅读记录仅用于本地学习追踪。</p></header><PolicyList /></main>;
}
