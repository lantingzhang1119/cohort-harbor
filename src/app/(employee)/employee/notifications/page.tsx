import { NotificationList } from "@/features/reminders/components/notification-list";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";
export default async function NotificationsPage() { await requireEmployeeModulePage(EmployeeModuleKey.NOTIFICATIONS); return <main className="employee-content"><header className="employee-hero"><p className="eyebrow">NOTIFICATIONS · 消息</p><h1>站内通知</h1><p>查看学习催办、补考审批和系统消息。</p></header><NotificationList /></main>; }
