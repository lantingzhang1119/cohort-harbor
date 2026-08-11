/** Soft-deleted content remains recoverable for this many days before purge. */
export const RECYCLE_RETENTION_DAYS = 30;

export const RECYCLE_RETENTION_MS = RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type PublishOutcome = "ROLLED_BACK" | "UNPUBLISHED" | "UNCHANGED";
