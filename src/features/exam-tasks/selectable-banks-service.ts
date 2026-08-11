import type { PrismaClient } from "@/generated/prisma/client";
import type { SelectableQuestionBankDto } from "@/features/exam-tasks/dto";
import { listSelectableQuestionBanks } from "@/features/exam-tasks/snapshot-builder";

export async function getSelectableQuestionBanksForPublish(
  db: PrismaClient,
): Promise<{ banks: SelectableQuestionBankDto[]; defaultBankId: string | null }> {
  const banks = await listSelectableQuestionBanks(db);
  const dtos: SelectableQuestionBankDto[] = banks.map((bank) => ({
    id: bank.id,
    name: bank.name,
    description: bank.description,
    isDefault: bank.isDefault,
    status: bank.status,
    versionNumber: bank.versionNumber,
    enabledScore: bank.enabledScore,
    questionCount: bank.questionCount,
    updatedAt: bank.updatedAt.toISOString(),
  }));
  const defaultBank = dtos.find((bank) => bank.isDefault) ?? null;
  return {
    banks: dtos,
    defaultBankId: defaultBank?.id ?? (dtos.length === 1 ? dtos[0]!.id : null),
  };
}
