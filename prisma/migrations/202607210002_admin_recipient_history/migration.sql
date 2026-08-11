PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;

CREATE TABLE "new_SimulatedEmailLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT,
    "recipientSnapshot" JSONB NOT NULL,
    "actorId" TEXT,
    "actorSnapshot" JSONB,
    "templateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIMULATED_NO_SMTP',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SimulatedEmailLog_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SimulatedEmailLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_SimulatedEmailLog" (
    "id", "recipientId", "recipientSnapshot", "actorId", "actorSnapshot", "templateKey", "status", "createdAt"
)
SELECT
    "id", "recipientId", "recipientSnapshot", "actorId", "actorSnapshot", "templateKey", "status", "createdAt"
FROM "SimulatedEmailLog";

DROP TABLE "SimulatedEmailLog";
ALTER TABLE "new_SimulatedEmailLog" RENAME TO "SimulatedEmailLog";
CREATE INDEX "SimulatedEmailLog_createdAt_idx" ON "SimulatedEmailLog"("createdAt");

PRAGMA defer_foreign_keys=OFF;
PRAGMA foreign_keys=ON;
