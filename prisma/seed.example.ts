import { Role, UserSource, UserStatus, WorkLocation } from "../src/generated/prisma/enums";
import { mockOnboardingQuestions } from "../src/features/exams/exam-seed-data";

/** Public seed descriptors only. The runtime seed still owns database writes. */
export const mockOrganization = {
  name: "Example Organization",
  slug: "example-organization",
} as const;

export const mockEmployees = [
  {
    employeeNo: "EMP-DEMO-001",
    name: "示例员工",
    email: "employee-001@example.invalid",
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    status: UserStatus.ACTIVE,
    workLocation: WorkLocation.SHANGHAI,
  },
] as const;

export const mockExam = {
  name: "入职学习考试",
  passingScore: 80,
  durationMinutes: 30,
  dueDaysAfterHire: 7,
  questions: mockOnboardingQuestions,
} as const;
