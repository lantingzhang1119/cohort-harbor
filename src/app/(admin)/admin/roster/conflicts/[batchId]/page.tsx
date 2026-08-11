import { redirect } from "next/navigation";

export default function RosterConflictPage() {
  redirect("/admin/roster/import");
}
