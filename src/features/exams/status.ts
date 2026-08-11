import { AssignmentStatus } from "@/generated/prisma/enums";

export function assignmentStatusAfterSubmission(passed: boolean) {
  return passed ? AssignmentStatus.PASSED : AssignmentStatus.FAILED;
}
