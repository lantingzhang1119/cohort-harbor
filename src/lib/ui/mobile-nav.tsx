import { Bell, BookOpenText, ClipboardCheck, Compass, FileClock, House, PackageOpen, RotateCcw, UserRound, Users } from "lucide-react";
import Link from "next/link";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { getEmployeeNavigationItems } from "@/features/employee-modules/module-definitions";

const employeeModuleIcons = {
  [EmployeeModuleKey.GUIDES]: Compass,
  [EmployeeModuleKey.ONBOARDING_KIT]: PackageOpen,
  [EmployeeModuleKey.POLICIES]: BookOpenText,
  [EmployeeModuleKey.EXAM]: ClipboardCheck,
  [EmployeeModuleKey.RESULTS]: FileClock,
  [EmployeeModuleKey.RETAKE]: RotateCcw,
  [EmployeeModuleKey.NOTIFICATIONS]: Bell,
} as const;

const adminItems = [
  { href: "/admin", label: "看板", icon: House },
  { href: "/admin/employees", label: "员工", icon: Users },
  { href: "/admin/reminders", label: "催办", icon: Bell },
  { href: "/admin/results", label: "结果", icon: ClipboardCheck },
];

export function MobileNav({
  variant,
  enabledEmployeeModules = Object.values(EmployeeModuleKey),
  userName,
}: {
  variant: "employee" | "admin";
  enabledEmployeeModules?: readonly EmployeeModuleKey[];
  userName?: string;
}) {
  const profileName = userName?.trim() || "我的";
  const items: Array<{ href: string; label: string; icon: typeof House; ariaLabel?: string }> = variant === "employee"
    ? [
        { href: "/employee", label: "首页", icon: House },
        { href: "/employee/profile", label: profileName, ariaLabel: `个人资料：${profileName}`, icon: UserRound },
        ...getEmployeeNavigationItems(new Set(enabledEmployeeModules)).map(({ key, href, shortLabel }) => ({
          href,
          label: shortLabel,
          icon: employeeModuleIcons[key],
        })),
      ]
    : adminItems;
  return (
    <nav className={`mobile-bottom-nav ${variant}`} aria-label="移动端主导航">
      {items.map(({ href, label, icon: Icon, ariaLabel }) => (
        <Link key={href} href={href} aria-label={ariaLabel}>
          <Icon aria-hidden="true" size={20} />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
