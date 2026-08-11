import { describe, expect, it } from "vitest";

import { createAttachmentDisposition, createSafeDownloadName } from "@/features/onboarding-kit/download-name";

describe("safe onboarding-kit download names", () => {
  it("keeps a readable Chinese name in filename* and a safe ASCII fallback", () => {
    const header = createAttachmentDisposition("CohortHarbor入职资料包_20260722.zip", "onboarding-kit.zip");
    expect(header).toBe("attachment; filename=\"onboarding-kit.zip\"; filename*=UTF-8''CohortHarbor%E5%85%A5%E8%81%8C%E8%B5%84%E6%96%99%E5%8C%85_20260722.zip");
  });

  it("strips header injection, path syntax, quotes and control characters", () => {
    expect(createSafeDownloadName("../evil\r\nX-Test: yes/制度\".pdf", "material.pdf"))
      .toBe("evilX-Test yes制度.pdf");
    const header = createAttachmentDisposition("制度\r\nContent-Length: 0.pdf", "asset.pdf");
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain("Content-Length:");
    expect(header).toContain("filename=\"asset.pdf\"");
  });
});
