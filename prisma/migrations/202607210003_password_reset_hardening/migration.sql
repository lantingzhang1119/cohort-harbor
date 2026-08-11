ALTER TABLE "PasswordResetToken" ADD COLUMN "deliveredAt" DATETIME;
ALTER TABLE "PasswordResetToken" ADD COLUMN "deliveryFailedAt" DATETIME;

CREATE TRIGGER "PasswordResetToken_throttle_insert"
BEFORE INSERT ON "PasswordResetToken"
FOR EACH ROW
WHEN (
  SELECT COUNT(*)
  FROM "PasswordResetToken"
  WHERE "requestFingerprint" = NEW."requestFingerprint"
    AND julianday("createdAt") >= julianday(NEW."createdAt") - (15.0 / 1440.0)
    AND julianday("createdAt") <= julianday(NEW."createdAt")
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'PASSWORD_RESET_THROTTLED');
END;
