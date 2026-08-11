import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliveryStatus } from "@/generated/prisma/enums";
import type { DeliveryTransport } from "@/features/onboarding-mail/delivery-service";
import {
  claimDueDeliveries,
  createMailAttachmentCache,
  processDelivery,
  releaseUndispatchedDeliveryClaims,
  renewUndispatchedDeliveryClaims,
  sanitizeMailErrorSummary,
} from "@/features/onboarding-mail/delivery-service";
import {
  shanghaiCalendarDate,
  shanghaiDateRange,
  validatedWelcomeMailLookbackDays,
} from "@/features/onboarding-mail/eligibility-service";
import {
  enqueueDueWelcomeMail,
  WelcomeMailBulkConfirmationError,
} from "@/features/onboarding-mail/scheduler";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";
import { cleanupStalePrivateUploads, resolveMailValidationTempRoot } from "@/lib/storage/private-upload-validation";

export type WorkerOptions = {
  db?: PrismaClient;
  transport: DeliveryTransport;
  workerId: string;
  now?: () => Date;
  runtimeEnabled?: boolean;
  enqueueAutomatic?: boolean;
  localDate?: string;
  confirmBulk?: boolean;
  batchSize?: number;
  leaseDurationMs?: number;
  transportHardTimeoutMs?: number;
  safetyMarginMs?: number;
  retryLimit?: number;
  retryBaseMs?: number;
  lookbackDays?: number;
  bulkConfirmThreshold?: number;
  companyName?: string;
  privateRoot?: string;
  onError?: (diagnostic: WorkerDeliveryErrorDiagnostic) => void | Promise<void>;
};

export type WorkerDeliveryErrorDiagnostic =
  | {
    deliveryId: string;
    code: "UNCAUGHT_PROCESSING_ERROR";
    errorType: "TypeError" | "RangeError" | "Error" | "NonErrorThrow";
    errorSummary: string;
  }
  | { deliveryId: string; code: "ACCEPTED_STALE" }
  | {
    deliveryId: string;
    code: "UNKNOWN" | "FAILED" | "STALE";
    failureCode: string | null;
  };

export type WorkerSummary = {
  runtimeEnabled: boolean;
  bulkConfirmationRequired: number | null;
  bulkConfirmationDates: Array<{ localDate: string; count: number }>;
  enqueued: number;
  claimed: number;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  unknown: number;
  stale: number;
  acceptedStale: number;
  errors: number;
};

function automaticEnqueueDates(localDate: string | undefined, instant: Date, lookbackDays: number): string[] {
  if (localDate) return [localDate];
  const today = shanghaiCalendarDate(instant);
  const { start } = shanghaiDateRange(today);
  return Array.from({ length: lookbackDays + 1 }, (_, index) => shanghaiCalendarDate(new Date(
    start.getTime() - (lookbackDays - index) * 86_400_000,
  )));
}

function diagnosticErrorType(error: unknown): Extract<WorkerDeliveryErrorDiagnostic, { code: "UNCAUGHT_PROCESSING_ERROR" }>["errorType"] {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof Error) return "Error";
  return "NonErrorThrow";
}

async function emitWorkerDiagnostic(
  onError: WorkerOptions["onError"],
  diagnostic: WorkerDeliveryErrorDiagnostic,
  timeoutMs: number,
): Promise<void> {
  if (!onError) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const sink = Promise.resolve()
    .then(() => onError(diagnostic))
    .catch(() => undefined);
  await Promise.race([
    sink,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

function outcomeFailureCode(result: Awaited<ReturnType<typeof processDelivery>>): string | null {
  return result.outcome && result.outcome.kind !== "accepted" ? result.outcome.failureCode : null;
}

function transportCannotContinue(
  transport: DeliveryTransport,
  result?: Awaited<ReturnType<typeof processDelivery>>,
): boolean {
  try {
    if (transport.isUsable?.() === false) return true;
  } catch {
    return true;
  }
  return result?.outcome?.kind === "definite-retryable"
    && result.outcome.protocolStage === "PRE_DATA"
    && ["SMTP_HARD_TIMEOUT", "SMTP_TRANSPORT_POISONED"].includes(result.outcome.failureCode);
}

export async function runOnboardingMailCycle(options: WorkerOptions): Promise<WorkerSummary> {
  const lookbackDays = validatedWelcomeMailLookbackDays(options.lookbackDays);
  const summary: WorkerSummary = {
    runtimeEnabled: options.runtimeEnabled === true,
    bulkConfirmationRequired: null,
    bulkConfirmationDates: [],
    enqueued: 0,
    claimed: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    unknown: 0,
    stale: 0,
    acceptedStale: 0,
    errors: 0,
  };
  if (!summary.runtimeEnabled) return summary;
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const privateRoot = options.privateRoot ?? defaultPrivateRoot;
  const mailValidationTempRoot = resolveMailValidationTempRoot(privateRoot);
  await cleanupStalePrivateUploads({ privateRoot, tempRoot: mailValidationTempRoot });
  const attachmentCache = createMailAttachmentCache();
  if (options.enqueueAutomatic !== false) {
    const cycleInstant = now();
    const enqueueNow = () => cycleInstant;
    const localDates = automaticEnqueueDates(options.localDate, cycleInstant, lookbackDays);
    for (const localDate of localDates) {
      try {
        const enqueue = await enqueueDueWelcomeMail(localDate, undefined, {
          db,
          now: enqueueNow,
          lookbackDays,
          bulkConfirmThreshold: options.bulkConfirmThreshold,
          confirmBulk: options.confirmBulk,
          companyName: options.companyName,
        });
        summary.enqueued += enqueue.enqueued;
      } catch (error) {
        if (!(error instanceof WelcomeMailBulkConfirmationError)) throw error;
        summary.bulkConfirmationRequired = (summary.bulkConfirmationRequired ?? 0) + error.count;
        summary.bulkConfirmationDates.push({ localDate, count: error.count });
      }
    }
  }
  const leaseDurationMs = options.leaseDurationMs ?? 180_000;
  const diagnosticTimeoutMs = Math.min(
    5_000,
    Math.max(1, Math.floor((options.safetyMarginMs ?? 30_000) / 2)),
  );
  const claimed = await claimDueDeliveries(options.workerId, now(), {
    db,
    batchSize: options.batchSize,
    leaseDurationMs,
    transportHardTimeoutMs: options.transportHardTimeoutMs,
    safetyMarginMs: options.safetyMarginMs,
  });
  summary.claimed = claimed.length;
  for (const [index, delivery] of claimed.entries()) {
    let stopForUnusableTransport = false;
    let diagnostic: WorkerDeliveryErrorDiagnostic | null = null;
    try {
      const result = await processDelivery(delivery.id, options.workerId, {
        db,
        transport: options.transport,
        now,
        retryLimit: options.retryLimit,
        retryBaseMs: options.retryBaseMs,
        leaseDurationMs,
        lookbackDays,
        companyName: options.companyName,
        privateRoot,
        attachmentCache,
      });
      summary.processed += 1;
      if (result.status === OnboardingMailDeliveryStatus.SENT) summary.sent += 1;
      else if (result.status === OnboardingMailDeliveryStatus.FAILED) {
        summary.failed += 1;
        diagnostic = {
          deliveryId: delivery.id,
          code: "FAILED",
          failureCode: outcomeFailureCode(result),
        };
      }
      else if (result.status === OnboardingMailDeliveryStatus.SKIPPED) summary.skipped += 1;
      else if (result.status === OnboardingMailDeliveryStatus.CANCELLED) summary.cancelled += 1;
      else if (result.status === OnboardingMailDeliveryStatus.UNKNOWN) {
        summary.unknown += 1;
        diagnostic = {
          deliveryId: delivery.id,
          code: "UNKNOWN",
          failureCode: outcomeFailureCode(result),
        };
      }
      else if (result.status === "STALE") {
        summary.stale += 1;
        diagnostic = {
          deliveryId: delivery.id,
          code: "STALE",
          failureCode: outcomeFailureCode(result),
        };
      }
      else if (result.status === "ACCEPTED_STALE") {
        summary.acceptedStale += 1;
        diagnostic = { deliveryId: delivery.id, code: "ACCEPTED_STALE" };
      }
      stopForUnusableTransport = transportCannotContinue(options.transport, result);
    } catch (error) {
      summary.errors += 1;
      diagnostic = {
        deliveryId: delivery.id,
        code: "UNCAUGHT_PROCESSING_ERROR",
        errorType: diagnosticErrorType(error),
        errorSummary: sanitizeMailErrorSummary(error),
      };
      stopForUnusableTransport = transportCannotContinue(options.transport);
    }
    const remainingClaims = claimed.slice(index + 1);
    if (stopForUnusableTransport) {
      await releaseUndispatchedDeliveryClaims(options.workerId, remainingClaims, { db });
    } else if (remainingClaims.length > 0) {
      await renewUndispatchedDeliveryClaims(
        options.workerId,
        remainingClaims,
        new Date(now().getTime() + leaseDurationMs),
        { db },
      );
    }
    if (diagnostic) await emitWorkerDiagnostic(options.onError, diagnostic, diagnosticTimeoutMs);
    if (stopForUnusableTransport) break;
  }
  return summary;
}
