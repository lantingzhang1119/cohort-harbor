import "dotenv/config";

import { ensureAdmin } from "./seed";
import { prisma } from "../src/lib/db/client";

async function main() {
  const admin = await ensureAdmin(prisma, {
    adminUsername: process.env.ADMIN_USERNAME ?? "admin",
    adminDisplayName: process.env.ADMIN_DISPLAY_NAME ?? "系统管理员",
    adminPassword: process.env.ADMIN_PASSWORD,
    resetAdminPassword: process.argv.includes("--reset-admin-password"),
  });
  console.log(`管理员账号已就绪：${admin.employeeNo}（未输出密码）`);
}

main()
  .catch((error: unknown) => { console.error(error instanceof Error ? error.message : "管理员初始化失败"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
