import type { Metadata } from "next";

import { MailCenter } from "@/features/onboarding-mail/components/mail-center";

export const metadata: Metadata = { title: "新人欢迎邮件中心" };

export default function AdminOnboardingMailPage() {
  return <MailCenter />;
}
