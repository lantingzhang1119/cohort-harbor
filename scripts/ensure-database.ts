import "dotenv/config";

import { ensureDatabaseFile } from "../src/lib/db/ensure-database";

const databaseUrl = process.env.DATABASE_URL ?? "file:./storage/private/demo.db";
const path = await ensureDatabaseFile(databaseUrl);
console.log(`SQLite 数据库已就绪：${path}`);
