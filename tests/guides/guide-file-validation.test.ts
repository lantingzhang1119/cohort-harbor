import { describe, expect, it } from "vitest";

import { GuideImageError, validateGuideImage } from "@/features/guides/guide-file-validation";

describe("guide image validation", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  it("accepts a matching PNG extension, MIME and signature", () => {
    expect(() => validateGuideImage({ fileName: "seat-map.png", mimeType: "image/png", bytes: png })).not.toThrow();
  });

  it("rejects mismatched extension, MIME, signature and oversize files", () => {
    expect(() => validateGuideImage({ fileName: "seat-map.jpg", mimeType: "image/png", bytes: png })).toThrow(GuideImageError);
    expect(() => validateGuideImage({ fileName: "seat-map.png", mimeType: "image/jpeg", bytes: png })).toThrow(GuideImageError);
    expect(() => validateGuideImage({ fileName: "seat-map.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) })).toThrow(GuideImageError);
    expect(() => validateGuideImage({ fileName: "seat-map.png", mimeType: "image/png", bytes: png }, 4)).toThrow(GuideImageError);
  });
});
