import { RetakeAdmin } from "@/features/exams/components/retake-admin";
import { TaskRetakeAdmin } from "@/features/exam-task-runtime/components/task-retake-admin";

export default async function RetakesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return (
    <>
      <RetakeAdmin initialStatus={Array.isArray(status) ? status[0] : status} />
      <TaskRetakeAdmin />
    </>
  );
}
