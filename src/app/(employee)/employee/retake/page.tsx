import { RetakePanel } from "@/features/exams/components/retake-panel";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";
export default async function RetakePage() { await requireEmployeeModulePage(EmployeeModuleKey.RETAKE); return <main className="employee-content"><header className="employee-hero"><p className="eyebrow">RETAKE · 再充一次电</p><h1>补考申请</h1><p>第一次未通过会自动获得一次补考；第二次起需要提交申请。</p></header><RetakePanel /></main>; }
