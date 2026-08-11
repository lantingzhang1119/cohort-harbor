CREATE UNIQUE INDEX "OnboardingMailDelivery_active_manual_recipient_key"
ON "OnboardingMailDelivery"("recipientId")
WHERE "source" = 'MANUAL'
  AND "status" <> 'CANCELLED'
  AND "recipientId" IS NOT NULL;
