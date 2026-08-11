import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  extractSceneAssetReferences,
  type SceneAssetReference,
} from "../src/features/portal/portal-asset-references";
import {
  inspectPortalImage,
  MAX_PORTAL_IMAGE_BYTES,
} from "../src/features/portal/portal-file-validation";
import {
  parseStoredPortalScene,
} from "../src/features/portal/portal-scene-adapter";
import type {
  PortalSceneV1,
  PortalViewportInput,
} from "../src/features/portal/portal-scene";
import {
  resolvePrivateAssetPath,
  resolvePrivateAssetPathSecure,
} from "../src/lib/storage/private-storage";

const PORTAL_DDL_MIGRATIONS = [
  "202607250001_visual_portal_scene",
  "202607250002_visual_portal_publication_scene",
] as const;
const CITIES = ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"] as const;
const VIEWPORTS = ["DESKTOP", "MOBILE"] as const;
const migrationsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);

type CityInput = (typeof CITIES)[number];
type MigrationFindingCode =
  | "ASSET_FILE_MISSING"
  | "ASSET_PATH_UNSAFE"
  | "ASSET_NOT_REGULAR"
  | "ASSET_FILE_TOO_LARGE"
  | "ASSET_SIZE_MISMATCH"
  | "ASSET_SHA256_MISMATCH"
  | "ASSET_INVALID"
  | "ASSET_RECORD_MISSING"
  | "ASSET_KIND_INVALID"
  | "INCOMPLETE_LEGACY_PAIR"
  | "LEGACY_ROW_EMPTY"
  | "LEGACY_ROW_INVALID";

export type PortalSceneMigrationFinding = {
  code: MigrationFindingCode;
  city?: string;
  viewport?: string;
  version?: number;
  assetRef?: string;
};

export type PortalSceneMigrationReport = {
  status:
    | "DRY_RUN"
    | "NOOP"
    | "MIGRATED"
    | "COMPLETED_WITH_FALLBACK"
    | "COMMITTED_WITH_AUDIT_WARNING";
  convertedDrafts: number;
  convertedPublications: number;
  fallbackPublicationPairs: number;
  metadataChanges: number;
  referenceChanges: number;
  latestMatrix: Array<{
    city: CityInput;
    viewport: PortalViewportInput;
    status: "NO_PUBLICATION" | "V0_FALLBACK" | "V1";
  }>;
  findings: PortalSceneMigrationFinding[];
  backupFile: string | null;
  backupSha256: string | null;
  auditFile: string | null;
  auditState: "NONE" | "PENDING" | "COMMITTED";
  auditWarning: "AUDIT_FINALIZE_FAILED" | null;
};

export type PortalSceneMigrationHooks = {
  afterSnapshotFingerprint?: () => void | Promise<void>;
  beforeWriteTransaction?: () => void | Promise<void>;
  afterFirstMutation?: () => void;
  beforeCommit?: () => void | Promise<void>;
  beforeAuditFinalize?: () => void | Promise<void>;
  beforeBackupReservation?: (backupPath: string) => void | Promise<void>;
  backupTargetReserved?: (backupPath: string) => void | Promise<void>;
  backupProgress?: (
    backupPath: string,
    progress: Database.BackupMetadata,
  ) => void;
  afterBackupCopy?: (backupPath: string) => void | Promise<void>;
};

type RawSceneRow = {
  id: string;
  city: string;
  viewport: string;
  version?: number;
  elements: string;
  sceneVersion: number;
  scene: string | null;
  legacyElements: string | null;
  draftRevision?: number;
};

type ParsedSceneRow = {
  row: RawSceneRow;
  scene: PortalSceneV1 | null;
  references: SceneAssetReference[] | null;
};

type RawAsset = {
  id: string;
  kind: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

type RawMetadata = {
  assetId: string;
  category: string;
  width: number | null;
  height: number | null;
  frameCount: number | null;
  decodedCostBytes: number | null;
  inspectionStatus: string;
  incompatibilityReason: string | null;
  inspectedAt: string | null;
};

type AssetInspectionPlan = {
  assetId: string;
  asset: RawAsset | null;
  valid: boolean;
  findingCode?: MigrationFindingCode;
  category: string;
  width: number | null;
  height: number | null;
  frameCount: number | null;
  decodedCostBytes: number | null;
  inspectionStatus: "VALID" | "LEGACY_UNINSPECTED";
  incompatibilityReason: string | null;
  inspectedAt: string | null;
  verificationFingerprint: string;
  fileIdentity: AssetFileIdentity | null;
};

type AssetFileIdentity = {
  device: string;
  inode: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
  actualSha256: string;
};

type BackupIdentity = {
  device: bigint;
  inode: bigint;
};

type ReferenceReplacement = {
  draftId?: string;
  publicationId?: string;
  references: SceneAssetReference[];
};

type MigrationPlan = {
  fingerprint: string;
  assetInspections: AssetInspectionPlan[];
  parsedDrafts: ParsedSceneRow[];
  parsedPublications: ParsedSceneRow[];
  draftConversions: ParsedSceneRow[];
  publicationConversions: ParsedSceneRow[];
  metadataChanges: AssetInspectionPlan[];
  referenceReplacements: ReferenceReplacement[];
  fallbackPublicationPairs: number;
  findings: PortalSceneMigrationFinding[];
  latestMatrix: PortalSceneMigrationReport["latestMatrix"];
};

type PendingAudit = {
  protocolVersion: 1;
  state: "PENDING";
  sourceFingerprint: string;
  targetFingerprint: string | null;
  report: PortalSceneMigrationReport;
};

export async function runPortalSceneMigration(
  options: {
    databasePath: string;
    privateRoot: string;
    dryRun: boolean;
  },
  hooks: PortalSceneMigrationHooks = {},
): Promise<PortalSceneMigrationReport> {
  const databasePath = validateFilePath(options.databasePath, "Database path");
  const privateRoot = validateDirectoryPath(options.privateRoot, "Private storage root");
  const connection = new Database(databasePath, {
    readonly: options.dryRun,
    fileMustExist: true,
  });
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");
  try {
    assertPortalSchemaReady(connection);
    assertDatabaseIntegrity(connection);
    if (options.dryRun) {
      const plan = await buildMigrationPlanInReadSnapshot(connection, privateRoot, hooks);
      return reportForPlan(plan, "DRY_RUN", null, null, null, "NONE", null);
    }

    const databaseDirectory = path.dirname(databasePath);
    const lockPath = `${databasePath}.portal-scene-v1.lock`;
    const lock = await acquireLock(lockPath);
    try {
      const plan = await buildMigrationPlanInReadSnapshot(connection, privateRoot, hooks);
      await recoverPendingAudits(databaseDirectory, plan.fingerprint);
      const hasMutations = (
        plan.draftConversions.length
        + plan.publicationConversions.length
        + plan.metadataChanges.length
        + plan.referenceReplacements.length
      ) > 0;
      if (!hasMutations) {
        return reportForPlan(
          plan,
          plan.findings.length > 0 ? "COMPLETED_WITH_FALLBACK" : "NOOP",
          null,
          null,
          null,
          "NONE",
          null,
        );
      }

      const artifactId = `${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
      const backupFile = `portal-scene-v1-${artifactId}.backup.sqlite`;
      const backupPath = path.join(databaseDirectory, backupFile);
      const auditFile = `portal-scene-v1-${artifactId}.json`;
      const auditPath = path.join(databaseDirectory, auditFile);
      if (existsSync(backupPath)) throw new Error("Refusing to overwrite an existing portal migration backup");
      await hooks.beforeWriteTransaction?.();
      connection.exec("BEGIN IMMEDIATE");
      let committed = false;
      let backupSha256: string;
      let backupIdentity: BackupIdentity | null = null;
      const status = plan.findings.length > 0 ? "COMPLETED_WITH_FALLBACK" : "MIGRATED";
      let pending: PendingAudit;
      try {
        if (databaseFingerprint(connection) !== plan.fingerprint) {
          throw new Error("Portal migration source data changed concurrently after inspection");
        }
        await verifyPlannedAssetFiles(plan, privateRoot);

        backupIdentity = await backupLockedDatabase(
          databasePath,
          backupPath,
          hooks,
        );
        try {
          await hooks.afterBackupCopy?.(backupPath);
          assertSecureBackupTarget(backupPath, backupIdentity);
          backupSha256 = hashFile(backupPath);
          validateBackup(backupPath);
        } catch (error) {
          await removeOwnedBackup(backupPath, backupIdentity);
          throw error;
        }

        const pendingReport = reportForPlan(
          plan,
          status,
          backupFile,
          backupSha256,
          auditFile,
          "PENDING",
          null,
        );
        pending = {
          protocolVersion: 1,
          state: "PENDING",
          sourceFingerprint: plan.fingerprint,
          targetFingerprint: null,
          report: pendingReport,
        };
        await createPendingAudit(auditPath, pending);

        applyMigrationPlan(connection, plan, hooks);
        await verifyPlannedAssetFiles(plan, privateRoot);
        assertDatabaseIntegrity(connection);
        assertV1PublicationPairs(connection);

        pending.targetFingerprint = databaseFingerprint(connection);
        await replacePendingAudit(auditPath, pending);
        await hooks.beforeCommit?.();
        await verifyPlannedAssetFiles(plan, privateRoot);
        assertSecureBackupTarget(backupPath, backupIdentity);
        connection.exec("COMMIT");
        committed = true;
      } catch (error) {
        if (!committed) {
          try {
            connection.exec("ROLLBACK");
          } catch {
            // Preserve the original failure; SQLite may already have ended the transaction.
          }
          if (backupIdentity) {
            await removeBackupIfInsecure(backupPath, backupIdentity);
          }
        }
        throw error;
      }

      assertDatabaseIntegrity(connection);
      const committedReport = reportForPlan(
        plan,
        status,
        backupFile,
        backupSha256!,
        auditFile,
        "COMMITTED",
        null,
      );
      try {
        await hooks.beforeAuditFinalize?.();
        await finalizeAudit(auditPath, committedReport);
        return committedReport;
      } catch {
        return reportForPlan(
          plan,
          "COMMITTED_WITH_AUDIT_WARNING",
          backupFile,
          backupSha256!,
          auditFile,
          "PENDING",
          "AUDIT_FINALIZE_FAILED",
        );
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  } finally {
    connection.close();
  }
}

async function buildMigrationPlanInReadSnapshot(
  connection: Database.Database,
  privateRoot: string,
  hooks: PortalSceneMigrationHooks,
) {
  connection.exec("BEGIN");
  try {
    const plan = await buildMigrationPlan(connection, privateRoot, hooks);
    connection.exec("COMMIT");
    return plan;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Preserve the plan failure if SQLite already closed the read transaction.
    }
    throw error;
  }
}

async function buildMigrationPlan(
  connection: Database.Database,
  privateRoot: string,
  hooks: PortalSceneMigrationHooks,
): Promise<MigrationPlan> {
  const fingerprint = databaseFingerprint(connection);
  await hooks.afterSnapshotFingerprint?.();
  const drafts = readDrafts(connection).map(parseSceneRow);
  const publications = readPublications(connection).map(parseSceneRow);
  assertSupportedCities([...drafts, ...publications]);
  const findings: PortalSceneMigrationFinding[] = [];
  for (const parsed of [...drafts, ...publications]) {
    if (parsed.row.sceneVersion !== 0 && parsed.row.sceneVersion !== 1) {
      throw new Error("Unsupported portal scene version");
    }
    if (parsed.row.sceneVersion === 0 && parsed.scene === null) {
      findings.push(rowFinding("LEGACY_ROW_INVALID", parsed.row));
    }
    if (parsed.row.sceneVersion === 1 && parsed.scene === null) {
      throw new Error("Invalid V1 portal scene");
    }
  }

  const assets = readAssets(connection);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const existingMetadata = readMetadata(connection);
  const categories = deriveAssetCategories([...drafts, ...publications]);
  const referencedIds = [...new Set(
    [...drafts, ...publications].flatMap((parsed) =>
      parsed.references?.map(({ assetId }) => assetId) ?? []
    ),
  )].sort();
  const inspections = new Map<string, AssetInspectionPlan>();
  for (const assetId of referencedIds) {
    const asset = assetById.get(assetId);
    const category = existingMetadata.get(assetId)?.category
      ?? categories.get(assetId)
      ?? "IMAGE";
    const inspection = await inspectStoredAsset(assetId, asset, privateRoot, category);
    inspections.set(assetId, inspection);
    if (!inspection.valid && inspection.findingCode) {
      findings.push({
        code: inspection.findingCode,
        assetRef: anonymizeAssetId(assetId),
      });
    }
  }

  for (const parsed of [...drafts, ...publications]) {
    if (parsed.row.sceneVersion !== 1 || parsed.references === null) continue;
    if (parsed.references.some(({ assetId }) => !inspections.get(assetId)?.valid)) {
      throw new Error("A V1 portal scene references an unsafe or missing asset");
    }
  }

  const draftConversions = drafts.filter((parsed) =>
    parsed.row.sceneVersion === 0
    && parsed.scene !== null
    && rowAssetsAreSafe(parsed, inspections)
  );
  const publicationConversions: ParsedSceneRow[] = [];
  let fallbackPublicationPairs = 0;
  const publicationGroups = groupPublications(publications);
  for (const group of publicationGroups) {
    const desktop = group.rows.find(({ row }) => row.viewport === "DESKTOP");
    const mobile = group.rows.find(({ row }) => row.viewport === "MOBILE");
    const versions = new Set(group.rows.map(({ row }) => row.sceneVersion));
    if (versions.has(1) && (versions.size !== 1 || !desktop || !mobile || group.rows.length !== 2)) {
      throw new Error("V1 and v0 portal publications must remain a complete paired version");
    }
    if (versions.has(1)) continue;
    if (!desktop || !mobile || group.rows.length !== 2) {
      fallbackPublicationPairs += 1;
      findings.push({
        code: "INCOMPLETE_LEGACY_PAIR",
        city: group.city,
        version: group.version,
      });
      continue;
    }
    for (const parsed of [desktop, mobile]) {
      if (parsed.scene && sceneIsEmpty(parsed.scene)) {
        findings.push(rowFinding("LEGACY_ROW_EMPTY", parsed.row));
      }
    }
    if (
      desktop.scene !== null
      && mobile.scene !== null
      && !sceneIsEmpty(desktop.scene)
      && !sceneIsEmpty(mobile.scene)
      && rowAssetsAreSafe(desktop, inspections)
      && rowAssetsAreSafe(mobile, inspections)
    ) {
      publicationConversions.push(desktop, mobile);
    } else {
      fallbackPublicationPairs += 1;
    }
  }

  const metadataChanges = [...inspections.values()].filter((inspection) =>
    assetById.get(inspection.assetId)?.kind === "PORTAL_IMAGE"
    && metadataDiffers(existingMetadata.get(inspection.assetId), inspection)
  );
  const referenceReplacements = buildReferenceReplacements(
    connection,
    [...drafts, ...publications],
    assetById,
  );
  const convertingPublicationIds = new Set(publicationConversions.map(({ row }) => row.id));
  const latestMatrix = latestPublicationMatrix(publications, convertingPublicationIds);
  return {
    fingerprint,
    assetInspections: [...inspections.values()],
    parsedDrafts: drafts,
    parsedPublications: publications,
    draftConversions,
    publicationConversions,
    metadataChanges,
    referenceReplacements,
    fallbackPublicationPairs,
    findings: deduplicateFindings(findings),
    latestMatrix,
  };
}

function applyMigrationPlan(
  connection: Database.Database,
  plan: MigrationPlan,
  hooks: PortalSceneMigrationHooks,
) {
  let firstMutation = true;
  const mutated = () => {
    if (!firstMutation) return;
    firstMutation = false;
    hooks.afterFirstMutation?.();
  };
  const upsertMetadata = connection.prepare(`
      INSERT INTO "GuidePortalAssetMetadata" (
        "assetId", "category", "width", "height", "frameCount", "decodedCostBytes",
        "inspectionStatus", "incompatibilityReason", "inspectedAt"
      ) VALUES (
        @assetId, @category, @width, @height, @frameCount, @decodedCostBytes,
        @inspectionStatus, @incompatibilityReason, @inspectedAt
      )
      ON CONFLICT("assetId") DO UPDATE SET
        "category" = excluded."category",
        "width" = excluded."width",
        "height" = excluded."height",
        "frameCount" = excluded."frameCount",
        "decodedCostBytes" = excluded."decodedCostBytes",
        "inspectionStatus" = excluded."inspectionStatus",
        "incompatibilityReason" = excluded."incompatibilityReason",
        "inspectedAt" = excluded."inspectedAt"
  `);
  for (const metadata of plan.metadataChanges) {
    upsertMetadata.run(metadata);
    mutated();
  }

  const convertDraft = connection.prepare(`
      UPDATE "GuidePortalDraft"
      SET
        "sceneVersion" = 1,
        "scene" = ?,
        "legacyElements" = CASE
          WHEN "legacyElements" IS NULL THEN "elements"
          ELSE "legacyElements"
        END,
        "draftRevision" = "draftRevision" + 1
      WHERE "id" = ? AND "sceneVersion" = 0
  `);
  for (const parsed of plan.draftConversions) {
    if (convertDraft.run(JSON.stringify(parsed.scene), parsed.row.id).changes !== 1) {
      throw new Error("Portal draft changed concurrently during migration");
    }
    mutated();
  }

  const convertPublication = connection.prepare(`
      UPDATE "GuidePortalPublication"
      SET
        "sceneVersion" = 1,
        "scene" = ?,
        "legacyElements" = CASE
          WHEN "legacyElements" IS NULL THEN "elements"
          ELSE "legacyElements"
        END
      WHERE "id" = ? AND "sceneVersion" = 0
  `);
  for (const parsed of plan.publicationConversions) {
    if (convertPublication.run(JSON.stringify(parsed.scene), parsed.row.id).changes !== 1) {
      throw new Error("Portal publication changed concurrently during migration");
    }
    mutated();
  }

  const deleteReferences = connection.prepare(`
      DELETE FROM "GuidePortalAssetReference"
      WHERE (@draftId IS NOT NULL AND "draftId" = @draftId)
         OR (@publicationId IS NOT NULL AND "publicationId" = @publicationId)
  `);
  const insertReference = connection.prepare(`
      INSERT INTO "GuidePortalAssetReference" (
        "id", "assetId", "draftId", "publicationId", "elementId"
      ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const replacement of plan.referenceReplacements) {
    deleteReferences.run({
      draftId: replacement.draftId ?? null,
      publicationId: replacement.publicationId ?? null,
    });
    for (const reference of replacement.references) {
      insertReference.run(
        randomUUID(),
        reference.assetId,
        replacement.draftId ?? null,
        replacement.publicationId ?? null,
        reference.elementId,
      );
    }
    mutated();
  }
}

function parseSceneRow(row: RawSceneRow): ParsedSceneRow {
  try {
    if (row.sceneVersion !== 0 && row.sceneVersion !== 1) {
      throw new Error("Unsupported portal scene version");
    }
    const elements = JSON.parse(String(row.elements));
    let sceneInput: unknown = undefined;
    if (row.sceneVersion === 1) {
      sceneInput = JSON.parse(String(row.scene));
      if (
        !sceneInput
        || typeof sceneInput !== "object"
        || Array.isArray(sceneInput)
        || (sceneInput as { viewport?: unknown }).viewport !== row.viewport
      ) {
        throw new Error("Stored V1 viewport does not match its row");
      }
    }
    if (!VIEWPORTS.includes(row.viewport as PortalViewportInput)) {
      throw new Error("Invalid portal viewport");
    }
    const scene = parseStoredPortalScene({
      viewport: row.viewport,
      sceneVersion: row.sceneVersion,
      scene: sceneInput,
      elements,
    });
    return {
      row,
      scene,
      references: extractSceneAssetReferences(scene),
    };
  } catch {
    return { row, scene: null, references: null };
  }
}

async function inspectStoredAsset(
  assetId: string,
  asset: RawAsset | undefined,
  privateRoot: string,
  category: string,
): Promise<AssetInspectionPlan> {
  if (!asset) return invalidInspection(assetId, null, category, "ASSET_RECORD_MISSING");
  if (asset.kind !== "PORTAL_IMAGE") {
    return invalidInspection(assetId, asset, category, "ASSET_KIND_INVALID");
  }
  const lexical = resolvePrivateAssetPath(asset.storageKey, privateRoot);
  if (!lexical) return invalidInspection(assetId, asset, category, "ASSET_PATH_UNSAFE");
  try {
    const details = lstatSync(lexical);
    if (details.isSymbolicLink()) {
      return invalidInspection(assetId, asset, category, "ASSET_PATH_UNSAFE");
    }
    if (!details.isFile()) {
      return invalidInspection(assetId, asset, category, "ASSET_NOT_REGULAR");
    }
    if (details.size > MAX_PORTAL_IMAGE_BYTES) {
      return invalidInspection(assetId, asset, category, "ASSET_FILE_TOO_LARGE");
    }
  } catch {
    return invalidInspection(assetId, asset, category, "ASSET_FILE_MISSING");
  }
  const absolutePath = await resolvePrivateAssetPathSecure(asset.storageKey, privateRoot);
  if (!absolutePath) {
    return invalidInspection(assetId, asset, category, "ASSET_PATH_UNSAFE");
  }
  try {
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    let before;
    let after;
    try {
      before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        return invalidInspection(assetId, asset, category, "ASSET_NOT_REGULAR");
      }
      if (before.size > BigInt(MAX_PORTAL_IMAGE_BYTES)) {
        return invalidInspection(assetId, asset, category, "ASSET_FILE_TOO_LARGE");
      }
      bytes = await handle.readFile();
      after = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    const fileIdentity = assetFileIdentity(after, actualSha256);
    if (!sameOpenFileIdentity(before, after)) {
      return invalidInspection(
        assetId,
        asset,
        category,
        "ASSET_INVALID",
        fileIdentity,
      );
    }
    if (bytes.byteLength !== asset.sizeBytes) {
      return invalidInspection(
        assetId,
        asset,
        category,
        "ASSET_SIZE_MISMATCH",
        fileIdentity,
      );
    }
    if (actualSha256 !== asset.sha256) {
      return invalidInspection(
        assetId,
        asset,
        category,
        "ASSET_SHA256_MISMATCH",
        fileIdentity,
      );
    }
    try {
      const inspected = inspectPortalImage({
        fileName: asset.originalName,
        mimeType: asset.mimeType,
        bytes,
      });
      return verifiedInspection({
        assetId,
        asset,
        valid: true,
        category,
        width: inspected.width,
        height: inspected.height,
        frameCount: inspected.frameCount,
        decodedCostBytes: inspected.decodedCostBytes,
        inspectionStatus: "VALID",
        incompatibilityReason: null,
        inspectedAt: new Date().toISOString(),
        fileIdentity,
      });
    } catch {
      return invalidInspection(
        assetId,
        asset,
        category,
        "ASSET_INVALID",
        fileIdentity,
      );
    }
  } catch {
    return invalidInspection(assetId, asset, category, "ASSET_INVALID");
  }
}

function invalidInspection(
  assetId: string,
  asset: RawAsset | null,
  category: string,
  findingCode: MigrationFindingCode,
  fileIdentity: AssetFileIdentity | null = null,
): AssetInspectionPlan {
  return verifiedInspection({
    assetId,
    asset,
    valid: false,
    findingCode,
    category,
    width: null,
    height: null,
    frameCount: null,
    decodedCostBytes: null,
    inspectionStatus: "LEGACY_UNINSPECTED",
    incompatibilityReason: findingCode,
    inspectedAt: null,
    fileIdentity,
  });
}

function verifiedInspection(
  inspection: Omit<AssetInspectionPlan, "verificationFingerprint">,
): AssetInspectionPlan {
  const verificationFingerprint = createHash("sha256").update(JSON.stringify({
    assetId: inspection.assetId,
    asset: inspection.asset,
    valid: inspection.valid,
    findingCode: inspection.findingCode ?? null,
    category: inspection.category,
    width: inspection.width,
    height: inspection.height,
    frameCount: inspection.frameCount,
    decodedCostBytes: inspection.decodedCostBytes,
    inspectionStatus: inspection.inspectionStatus,
    incompatibilityReason: inspection.incompatibilityReason,
    fileIdentity: inspection.fileIdentity,
  })).digest("hex");
  return {
    ...inspection,
    verificationFingerprint,
  };
}

function assetFileIdentity(
  details: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  actualSha256: string,
): AssetFileIdentity {
  return {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: details.size.toString(),
    modifiedNanoseconds: details.mtimeNs.toString(),
    changedNanoseconds: details.ctimeNs.toString(),
    actualSha256,
  };
}

function sameOpenFileIdentity(
  before: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  after: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function verifyPlannedAssetFiles(
  plan: MigrationPlan,
  privateRoot: string,
) {
  for (const expected of plan.assetInspections) {
    const current = await inspectStoredAsset(
      expected.assetId,
      expected.asset ?? undefined,
      privateRoot,
      expected.category,
    );
    if (current.verificationFingerprint !== expected.verificationFingerprint) {
      throw new Error("Portal asset file changed after inspection; migration was rolled back");
    }
  }
}

function deriveAssetCategories(rows: ParsedSceneRow[]) {
  const categories = new Map<string, string>();
  for (const { row, scene } of rows) {
    if (!scene) continue;
    if (row.sceneVersion === 0) {
      try {
        const elements = JSON.parse(String(row.elements)) as unknown;
        if (Array.isArray(elements)) {
          for (const element of elements) {
            if (
              element
              && typeof element === "object"
              && "assetId" in element
              && typeof element.assetId === "string"
              && "kind" in element
              && element.kind === "LOGO"
            ) {
              categories.set(element.assetId, "LOGO");
            }
          }
        }
      } catch {
        // Invalid legacy rows stay on v0 and are reported by the row parser.
      }
    }
    if (scene.background.assetId) categories.set(scene.background.assetId, "BACKGROUND");
    for (const element of scene.elements) {
      if (element.type === "IMAGE" && !categories.has(element.assetId)) {
        categories.set(element.assetId, "IMAGE");
      }
    }
  }
  return categories;
}

function rowAssetsAreSafe(
  parsed: ParsedSceneRow,
  inspections: Map<string, AssetInspectionPlan>,
) {
  return parsed.references !== null
    && parsed.references.every(({ assetId }) => inspections.get(assetId)?.valid === true);
}

function sceneIsEmpty(scene: PortalSceneV1) {
  return scene.background.assetId === null
    && !scene.elements.some((element) =>
      !element.hidden
      && element.opacity > 0
      && (element.type !== "TEXT" || element.text.trim().length > 0)
    );
}

function groupPublications(publications: ParsedSceneRow[]) {
  const groups = new Map<string, {
    city: string;
    version: number;
    rows: ParsedSceneRow[];
  }>();
  for (const publication of publications) {
    const version = publication.row.version!;
    const key = `${publication.row.city}\0${version}`;
    const group = groups.get(key) ?? {
      city: publication.row.city,
      version,
      rows: [],
    };
    group.rows.push(publication);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.city.localeCompare(right.city) || left.version - right.version
  );
}

function buildReferenceReplacements(
  connection: Database.Database,
  rows: ParsedSceneRow[],
  assetById: Map<string, RawAsset>,
) {
  const replacements: ReferenceReplacement[] = [];
  for (const parsed of rows) {
    if (parsed.references === null) continue;
    const references = parsed.references.filter(({ assetId }) =>
      assetById.get(assetId)?.kind === "PORTAL_IMAGE"
    );
    const parent = parsed.row.version === undefined
      ? { draftId: parsed.row.id }
      : { publicationId: parsed.row.id };
    const existing = readParentReferences(connection, parent);
    if (referenceSignature(existing) !== referenceSignature(references)) {
      replacements.push({ ...parent, references });
    }
  }
  return replacements;
}

function readParentReferences(
  connection: Database.Database,
  parent: { draftId?: string; publicationId?: string },
) {
  const column = parent.draftId ? "draftId" : "publicationId";
  const id = parent.draftId ?? parent.publicationId;
  return connection.prepare(
    `SELECT "assetId", "elementId" FROM "GuidePortalAssetReference"
     WHERE "${column}" = ? ORDER BY "elementId", "assetId"`,
  ).all(id) as SceneAssetReference[];
}

function referenceSignature(references: SceneAssetReference[]) {
  return references
    .map(({ assetId, elementId }) => `${elementId}\0${assetId}`)
    .sort()
    .join("\n");
}

function metadataDiffers(
  current: RawMetadata | undefined,
  desired: AssetInspectionPlan,
) {
  if (!current) return true;
  return current.category !== desired.category
    || current.width !== desired.width
    || current.height !== desired.height
    || current.frameCount !== desired.frameCount
    || Number(current.decodedCostBytes) !== Number(desired.decodedCostBytes)
    || current.inspectionStatus !== desired.inspectionStatus
    || current.incompatibilityReason !== desired.incompatibilityReason
    || (desired.valid && current.inspectedAt === null)
    || (!desired.valid && current.inspectedAt !== null);
}

function latestPublicationMatrix(
  publications: ParsedSceneRow[],
  convertingIds: Set<string>,
): PortalSceneMigrationReport["latestMatrix"] {
  return CITIES.flatMap((city) =>
    VIEWPORTS.map((viewport) => {
      const latest = publications
        .filter(({ row }) => row.city === city && row.viewport === viewport)
        .sort((left, right) => right.row.version! - left.row.version!)[0];
      const status = !latest
        ? "NO_PUBLICATION" as const
        : latest.row.sceneVersion === 1 || convertingIds.has(latest.row.id)
          ? "V1" as const
          : "V0_FALLBACK" as const;
      return { city, viewport, status };
    })
  );
}

function reportForPlan(
  plan: MigrationPlan,
  status: PortalSceneMigrationReport["status"],
  backupFile: string | null,
  backupSha256: string | null,
  auditFile: string | null,
  auditState: PortalSceneMigrationReport["auditState"],
  auditWarning: PortalSceneMigrationReport["auditWarning"],
): PortalSceneMigrationReport {
  return {
    status,
    convertedDrafts: plan.draftConversions.length,
    convertedPublications: plan.publicationConversions.length,
    fallbackPublicationPairs: plan.fallbackPublicationPairs,
    metadataChanges: plan.metadataChanges.length,
    referenceChanges: plan.referenceReplacements.length,
    latestMatrix: plan.latestMatrix,
    findings: plan.findings,
    backupFile,
    backupSha256,
    auditFile,
    auditState,
    auditWarning,
  };
}

async function createPendingAudit(
  auditPath: string,
  pending: PendingAudit,
) {
  const handle = await open(auditPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(pending, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(auditPath));
}

async function replacePendingAudit(
  auditPath: string,
  pending: PendingAudit,
) {
  await replaceJsonFile(auditPath, pending, true);
}

async function finalizeAudit(
  auditPath: string,
  report: PortalSceneMigrationReport,
) {
  await replaceJsonFile(auditPath, report, false);
}

async function replaceJsonFile(
  targetPath: string,
  value: PendingAudit | PortalSceneMigrationReport,
  syncAfterRename: boolean,
) {
  const temporaryPath = `${targetPath}.tmp-${randomUUID().slice(0, 8)}`;
  let renamed = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(path.dirname(targetPath));
    await rename(temporaryPath, targetPath);
    renamed = true;
    if (syncAfterRename) await syncDirectory(path.dirname(targetPath));
  } finally {
    if (!renamed) await rm(temporaryPath, { force: true });
  }
}

async function recoverPendingAudits(
  databaseDirectory: string,
  currentFingerprint: string,
) {
  const entries = await readdir(databaseDirectory);
  const pendingNames = entries.filter((name) =>
    /^portal-scene-v1-\d{14}-[a-f0-9]{8}\.json$/.test(name)
  );
  for (const name of pendingNames) {
    const auditPath = path.join(databaseDirectory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(auditPath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecoverablePendingAudit(parsed, name)) continue;
    if (parsed.targetFingerprint !== currentFingerprint) continue;
    await finalizeAudit(auditPath, {
      ...parsed.report,
      auditState: "COMMITTED",
      auditWarning: null,
    });
  }
}

function isRecoverablePendingAudit(
  value: unknown,
  expectedAuditFile: string,
): value is PendingAudit & { targetFingerprint: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingAudit>;
  if (
    candidate.protocolVersion !== 1
    || candidate.state !== "PENDING"
    || !/^[a-f0-9]{64}$/.test(candidate.sourceFingerprint ?? "")
    || !/^[a-f0-9]{64}$/.test(candidate.targetFingerprint ?? "")
    || !candidate.report
    || typeof candidate.report !== "object"
    || Array.isArray(candidate.report)
  ) {
    return false;
  }
  const report = candidate.report as Partial<PortalSceneMigrationReport>;
  if (
    report.auditFile !== expectedAuditFile
    || !Array.isArray(report.findings)
    || !report.findings.every((finding) =>
      finding
      && typeof finding === "object"
      && (
        finding.assetRef === undefined
        || /^[a-f0-9]{16}$/.test(finding.assetRef)
      )
    )
    || (
      report.backupFile !== null
      && (
        typeof report.backupFile !== "string"
        || !/^portal-scene-v1-\d{14}-[a-f0-9]{8}\.backup\.sqlite$/.test(
          report.backupFile,
        )
      )
    )
  ) {
    return false;
  }
  return true;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function rowFinding(
  code: MigrationFindingCode,
  row: RawSceneRow,
): PortalSceneMigrationFinding {
  return {
    code,
    city: row.city,
    viewport: row.viewport,
    ...(row.version === undefined ? {} : { version: row.version }),
  };
}

function anonymizeAssetId(assetId: string) {
  return createHash("sha256")
    .update("portal-scene-migration-asset-ref-v1\0")
    .update(assetId)
    .digest("hex")
    .slice(0, 16);
}

function assertSupportedCities(rows: ParsedSceneRow[]) {
  if (rows.some(({ row }) => !CITIES.includes(row.city as CityInput))) {
    throw new Error("Portal migration found an unsupported city outside the four-city scope");
  }
}

function deduplicateFindings(findings: PortalSceneMigrationFinding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readDrafts(connection: Database.Database) {
  return connection.prepare(`
    SELECT
      "id", "city", "viewport", "elements", "sceneVersion", "scene",
      "legacyElements", "draftRevision"
    FROM "GuidePortalDraft"
    ORDER BY "city", "viewport", "id"
  `).all() as RawSceneRow[];
}

function readPublications(connection: Database.Database) {
  return connection.prepare(`
    SELECT
      "id", "city", "viewport", "version", "elements", "sceneVersion",
      "scene", "legacyElements"
    FROM "GuidePortalPublication"
    ORDER BY "city", "version", "viewport", "id"
  `).all() as RawSceneRow[];
}

function readAssets(connection: Database.Database) {
  return connection.prepare(`
    SELECT
      "id", "kind", "storageKey", "originalName", "mimeType", "sizeBytes", "sha256"
    FROM "FileAsset"
    ORDER BY "id"
  `).all() as RawAsset[];
}

function readMetadata(connection: Database.Database) {
  const rows = connection.prepare(`
    SELECT
      "assetId", "category", "width", "height", "frameCount",
      "decodedCostBytes", "inspectionStatus", "incompatibilityReason", "inspectedAt"
    FROM "GuidePortalAssetMetadata"
    ORDER BY "assetId"
  `).all() as RawMetadata[];
  return new Map(rows.map((metadata) => [metadata.assetId, metadata]));
}

function databaseFingerprint(connection: Database.Database) {
  const snapshot = {
    drafts: connection.prepare(`
      SELECT "id", "city", "viewport", "elements", "sceneVersion", "scene",
             "legacyElements", "draftRevision", "updatedBySnapshot", "updatedAt"
      FROM "GuidePortalDraft" ORDER BY "id"
    `).all(),
    publications: connection.prepare(`
      SELECT "id", "city", "viewport", "version", "elements", "sceneVersion",
             "scene", "legacyElements", "publishedBySnapshot", "createdAt"
      FROM "GuidePortalPublication" ORDER BY "id"
    `).all(),
    assets: readAssets(connection),
    metadata: [...readMetadata(connection).values()],
    references: connection.prepare(`
      SELECT "id", "assetId", "draftId", "publicationId", "elementId"
      FROM "GuidePortalAssetReference" ORDER BY "id"
    `).all(),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function assertPortalSchemaReady(connection: Database.Database) {
  if (!tableExists(connection, "_prisma_migrations")) {
    throw new Error("Portal migration prerequisite is missing the Prisma migration ledger");
  }
  for (const table of [
    "GuidePortalDraft",
    "GuidePortalPublication",
    "GuidePortalAssetMetadata",
    "GuidePortalAssetReference",
    "FileAsset",
  ]) {
    if (!tableExists(connection, table)) {
      throw new Error(`Portal migration prerequisite is missing table ${table}`);
    }
  }
  for (const [table, columns] of [
    ["GuidePortalDraft", ["sceneVersion", "scene", "legacyElements", "draftRevision"]],
    ["GuidePortalPublication", ["sceneVersion", "scene", "legacyElements"]],
  ] as const) {
    const actual = new Set(
      (connection.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    for (const column of columns) {
      if (!actual.has(column)) {
        throw new Error(`Portal migration prerequisite is missing ${table}.${column}`);
      }
    }
  }
  const ledger = connection.prepare(`
    SELECT
      "migration_name" AS "migrationName", "checksum",
      "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
    FROM "_prisma_migrations"
  `).all() as Array<{
    migrationName: string;
    checksum: string;
    finishedAt: string | null;
    rolledBackAt: string | null;
  }>;
  const counts = new Map<string, number>();
  for (const row of ledger) {
    counts.set(row.migrationName, (counts.get(row.migrationName) ?? 0) + 1);
    if (row.finishedAt === null || row.rolledBackAt !== null) {
      throw new Error("Prisma migration ledger contains an unfinished or rolled-back entry");
    }
  }
  for (const migration of PORTAL_DDL_MIGRATIONS) {
    const row = ledger.find(({ migrationName }) => migrationName === migration);
    if (!row || counts.get(migration) !== 1) {
      throw new Error(`Portal migration prerequisite is missing ${migration}`);
    }
    const expected = createHash("sha256")
      .update(readFileSync(path.join(migrationsRoot, migration, "migration.sql")))
      .digest("hex");
    if (row.checksum !== expected) {
      throw new Error(`Portal migration checksum mismatch for ${migration}`);
    }
  }
}

function assertDatabaseIntegrity(connection: Database.Database) {
  const integrity = connection.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  const foreignKeys = connection.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length !== 0) throw new Error("SQLite foreign key check failed");
}

function assertV1PublicationPairs(connection: Database.Database) {
  const invalid = connection.prepare(`
    SELECT "city", "version"
    FROM "GuidePortalPublication"
    WHERE "sceneVersion" = 1
    GROUP BY "city", "version"
    HAVING COUNT(*) <> 2
       OR SUM(CASE WHEN "viewport" = 'DESKTOP' THEN 1 ELSE 0 END) <> 1
       OR SUM(CASE WHEN "viewport" = 'MOBILE' THEN 1 ELSE 0 END) <> 1
  `).all();
  if (invalid.length > 0) throw new Error("V1 portal publication pair invariant failed");
}

async function backupLockedDatabase(
  databasePath: string,
  backupPath: string,
  hooks: PortalSceneMigrationHooks,
) {
  await hooks.beforeBackupReservation?.(backupPath);
  const reservation = await open(
    backupPath,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_RDWR
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let identity: BackupIdentity | null = null;
  try {
    const details = await reservation.stat({ bigint: true });
    identity = { device: details.dev, inode: details.ino };
    if (!details.isFile() || Number(details.mode & 0o777n) !== 0o600) {
      throw new Error("Reserved portal migration backup is not a secure 0600 regular file");
    }
    await reservation.sync();
  } catch (error) {
    await reservation.close();
    if (identity) await removeOwnedBackup(backupPath, identity);
    throw error;
  }
  await reservation.close();
  if (!identity) throw new Error("Portal migration backup reservation has no file identity");

  try {
    assertSecureBackupTarget(backupPath, identity);
    await hooks.backupTargetReserved?.(backupPath);
    assertSecureBackupTarget(backupPath, identity);

    const snapshot = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await snapshot.backup(backupPath, {
        progress: (progress) => {
          assertSecureBackupTarget(backupPath, identity);
          hooks.backupProgress?.(backupPath, progress);
          return 100;
        },
      });
    } finally {
      snapshot.close();
    }
    assertSecureBackupTarget(backupPath, identity);
    return identity;
  } catch (error) {
    await removeOwnedBackup(backupPath, identity);
    throw error;
  }
}

function assertSecureBackupTarget(
  backupPath: string,
  identity: BackupIdentity,
) {
  const details = lstatSync(backupPath, { bigint: true });
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.dev !== identity.device
    || details.ino !== identity.inode
    || Number(details.mode & 0o777n) !== 0o600
  ) {
    throw new Error("Portal migration backup target changed or is not a secure 0600 file");
  }
}

async function removeOwnedBackup(
  backupPath: string,
  identity: BackupIdentity,
) {
  try {
    const details = lstatSync(backupPath, { bigint: true });
    if (
      details.isFile()
      && !details.isSymbolicLink()
      && details.dev === identity.device
      && details.ino === identity.inode
    ) {
      await rm(backupPath, { force: true });
    }
  } catch {
    // The reserved path is already absent or no longer belongs to this run.
  }
}

async function removeBackupIfInsecure(
  backupPath: string,
  identity: BackupIdentity,
) {
  try {
    assertSecureBackupTarget(backupPath, identity);
  } catch {
    await removeOwnedBackup(backupPath, identity);
  }
}

function validateBackup(backupPath: string) {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  backup.pragma("foreign_keys = ON");
  try {
    assertDatabaseIntegrity(backup);
  } finally {
    backup.close();
  }
}

async function acquireLock(lockPath: string) {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Portal migration maintenance lock already exists");
    }
    throw error;
  }
}

function validateFilePath(value: string, label: string) {
  assertAbsolute(value, label);
  let details;
  try {
    details = lstatSync(value);
  } catch {
    throw new Error(`${label} must name an existing regular file`);
  }
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!details.isFile()) throw new Error(`${label} must name a regular file`);
  return realpathSync(value);
}

function validateDirectoryPath(value: string, label: string) {
  assertAbsolute(value, label);
  let details;
  try {
    details = lstatSync(value);
  } catch {
    throw new Error(`${label} must name an existing directory`);
  }
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!details.isDirectory()) throw new Error(`${label} must name a directory`);
  return realpathSync(value);
}

function assertAbsolute(value: string, label: string) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path`);
}

function tableExists(connection: Database.Database, table: string) {
  return Boolean(connection.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table));
}

function hashFile(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function formatTimestamp(value: Date) {
  return value.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function parseCliArguments(argv: string[]) {
  let databasePath: string | undefined;
  let privateRoot: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--database" || argument === "--private-root") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === "--database") databasePath = value;
      else privateRoot = value;
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: pnpm portal:migrate -- --database /absolute/database.db --private-root /absolute/private-root [--dry-run]",
    );
  }
  if (!databasePath || !privateRoot) {
    throw new Error("Both --database and --private-root are required");
  }
  return { databasePath, privateRoot, dryRun };
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runPortalSceneMigration(parseCliArguments(process.argv.slice(2)))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Portal migration failed");
      process.exitCode = 1;
    });
}
