import { GuideList } from "@/features/guides/components/guide-list";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function GuidesPage() {
  await requireEmployeeModulePage(EmployeeModuleKey.GUIDES);
  return <main className="employee-content"><header className="employee-hero"><p className="eyebrow">YOUR CITY · 入职第一站</p><h1>四地入职指南</h1><p>优先查看你的工作地点，也可以随时浏览其他城市。</p></header><GuideList /></main>;
}
