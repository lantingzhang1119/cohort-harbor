import {
  Bell,
  BookOpenText,
  ClipboardCheck,
  Compass,
  FileClock,
  House,
  PackageOpen,
  RotateCcw,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { EmployeeModuleKey, Role, SessionViewMode } from "@/generated/prisma/enums";
import { EmployeeModuleVisibilityProvider } from "@/features/employee-modules/components/module-visibility";
import { getEmployeeNavigationItems } from "@/features/employee-modules/module-definitions";
import { BRAND } from "@/lib/brand";
import { AdminSidebar } from "@/lib/ui/admin-sidebar";
import { LogoutButton } from "@/lib/ui/logout-button";
import { MobileNav } from "@/lib/ui/mobile-nav";
import { ViewModeSwitch } from "@/lib/ui/view-mode-switch";

type ShellUser = { name: string; employeeNo: string; role?: Role };

const employeeModuleIcons = {
  [EmployeeModuleKey.GUIDES]: Compass,
  [EmployeeModuleKey.ONBOARDING_KIT]: PackageOpen,
  [EmployeeModuleKey.POLICIES]: BookOpenText,
  [EmployeeModuleKey.EXAM]: ClipboardCheck,
  [EmployeeModuleKey.RESULTS]: FileClock,
  [EmployeeModuleKey.RETAKE]: RotateCcw,
  [EmployeeModuleKey.NOTIFICATIONS]: Bell,
} as const;

export function AppShell({
  variant,
  user,
  enabledEmployeeModules = Object.values(EmployeeModuleKey),
  children,
}: {
  variant: "employee" | "admin";
  user: ShellUser;
  enabledEmployeeModules?: readonly EmployeeModuleKey[];
  children: ReactNode;
}) {
  if (variant === "admin") {
    return (
      <div className="app-shell admin-app-shell">
        <AdminSidebar role={user.role} />
        <div className="app-shell-main">
          <header className="admin-topbar">
            <div><strong>{user.name}</strong><span>{user.employeeNo} · 管理员</span></div>
            <div className="shell-actions">
              {user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN ? (
                <ViewModeSwitch targetMode={SessionViewMode.EMPLOYEE} />
              ) : null}
              <LogoutButton />
            </div>
          </header>
          <div className="app-shell-content">{children}</div>
        </div>
        <MobileNav variant="admin" />
      </div>
    );
  }

  const enabledSet = new Set(enabledEmployeeModules);
  const employeeNav = getEmployeeNavigationItems(enabledSet);
  return (
    <EmployeeModuleVisibilityProvider enabledKeys={enabledEmployeeModules}>
    <div className="app-shell employee-app-shell">
      <header className="employee-top-nav">
        <Link className="employee-brand" href="/employee">
          <span className="brand-chip">H</span>
          <span><strong>{BRAND.name}</strong><small>入职学习中心</small></span>
        </Link>
        <nav aria-label="员工端主导航">
          <Link href="/employee"><House aria-hidden="true" size={17} />首页</Link>
          {employeeNav.map(({ key, href, label }) => {
            const Icon = employeeModuleIcons[key];
            return <Link key={href} href={href}><Icon aria-hidden="true" size={17} />{label}</Link>;
          })}
        </nav>
        <div className="shell-user">
          <Link href="/employee/profile"><UserRound aria-hidden="true" size={18} />{user.name}</Link>
          {user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN ? (
            <ViewModeSwitch targetMode={SessionViewMode.ADMIN} />
          ) : null}
          <LogoutButton />
        </div>
      </header>
      <div className="app-shell-content">{children}</div>
      <MobileNav variant="employee" enabledEmployeeModules={enabledEmployeeModules} userName={user.name} />
    </div>
    </EmployeeModuleVisibilityProvider>
  );
}
