import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Role } from "@/generated/prisma/enums";
import { requireSessionForPasswordChange } from "@/features/auth/guards";
import { RealNameForm } from "@/features/auth/components/real-name-form";
import { requiresRealNameBeforeEmployeeView } from "@/features/auth/real-name";
import { SESSION_COOKIE_NAME } from "@/features/auth/session";
import { prisma } from "@/lib/db/client";

export default async function RealNamePage() {
  const cookieStore = await cookies();
  let session: Awaited<ReturnType<typeof requireSessionForPasswordChange>>;
  try {
    session = await requireSessionForPasswordChange(
      prisma,
      cookieStore.get(SESSION_COOKIE_NAME)?.value,
    );
  } catch {
    redirect("/login");
  }
  if (session.user.mustChangePassword) redirect("/change-password");
  if (session.user.role === Role.EMPLOYEE) redirect("/employee/profile");
  if (!requiresRealNameBeforeEmployeeView(session.user)) {
    redirect(session.viewMode === "ADMIN" ? "/admin/settings" : "/employee");
  }

  return (
    <main className="auth-shell single-auth-shell">
      <section className="auth-card real-name-card">
        <div className="auth-heading">
          <span className="auth-step">02</span>
          <div><p>账号资料</p><h1>设置真实姓名</h1></div>
        </div>
        <p>当管理员切换到员工端时，系统会以当前登录账号的真实姓名显示欢迎语。</p>
        <RealNameForm initialName={session.user.name} required />
      </section>
    </main>
  );
}
