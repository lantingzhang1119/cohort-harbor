import { ExamSettingsForm } from "@/features/exams/components/exam-settings-form";

export default function ExamSettingsPage() { return <main className="admin-content compact-content"><header className="page-title-row"><div><p className="eyebrow">EXAM · 发布规则</p><h1>考试设置</h1><p>保存前会再次检查启用题目总分必须为 100。</p></div></header><ExamSettingsForm /></main>; }
