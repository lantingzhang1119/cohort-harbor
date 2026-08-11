import type { Metadata } from "next";

import { prisma } from "@/lib/db/client";

export const metadata: Metadata = { title: "审计日志" };

export default async function AuditPage() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, action: true, result: true, targetType: true, targetId: true, createdAt: true, actor: { select: { name: true, employeeNo: true } } },
  });
  return <main className="admin-content"><header className="page-title-row"><div><p className="eyebrow">AUDIT · 最近 100 条</p><h1>审计日志</h1><p>记录登录、导入、内容维护与业务审批等关键操作。</p></div></header><section className="audit-list">{logs.length === 0 && <p className="empty-note">暂无审计记录。</p>}{logs.map((log) => <article key={log.id}><time>{log.createdAt.toLocaleString("zh-CN")}</time><div><strong>{log.action}</strong><span>{log.targetType ?? "SYSTEM"}{log.targetId ? ` · ${log.targetId}` : ""}</span></div><span className={`audit-result ${log.result.toLowerCase()}`}>{log.result}</span><small>{log.actor ? `${log.actor.name} · ${log.actor.employeeNo}` : "系统/匿名"}</small></article>)}</section></main>;
}
