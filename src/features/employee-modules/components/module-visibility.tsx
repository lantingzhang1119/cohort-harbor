"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { EMPLOYEE_MODULE_DEFINITIONS } from "@/features/employee-modules/module-definitions";

const EmployeeModuleContext = createContext<ReadonlySet<EmployeeModuleKey>>(
  new Set(Object.values(EmployeeModuleKey)),
);

export function EmployeeModuleVisibilityProvider({
  enabledKeys,
  children,
}: {
  enabledKeys: readonly EmployeeModuleKey[];
  children: ReactNode;
}) {
  const value = useMemo(() => new Set(enabledKeys), [enabledKeys]);
  return (
    <EmployeeModuleContext.Provider value={value}>
      {children}
    </EmployeeModuleContext.Provider>
  );
}

export function EmployeeModuleGate({
  moduleKey,
  children,
}: {
  moduleKey: EmployeeModuleKey;
  children: ReactNode;
}) {
  const enabled = useContext(EmployeeModuleContext);
  return enabled.has(moduleKey) ? children : null;
}

export function EmployeeModuleQuickLinks() {
  const enabled = useContext(EmployeeModuleContext);
  const items = EMPLOYEE_MODULE_DEFINITIONS.filter(({ key }) => enabled.has(key));
  if (items.length === 0) return null;
  return (
    <section className="employee-module-shortcuts" aria-label="已开放板块">
      {items.map((item) => (
        <Link key={item.key} href={item.href}>
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
          <ChevronRight aria-hidden="true" size={18} />
        </Link>
      ))}
    </section>
  );
}
