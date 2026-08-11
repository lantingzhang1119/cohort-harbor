import type { ValidatedUpload } from "@/features/onboarding-kit/file-types";
import { storeStagedPrivateUpload } from "@/lib/storage/private-upload-validation";

export function storeOnboardingUpload(upload: ValidatedUpload, privateRoot: string) {
  return storeStagedPrivateUpload(upload.stagedPath, {
    privateRoot,
    namespace: "onboarding/materials",
    extension: upload.extension,
  });
}
