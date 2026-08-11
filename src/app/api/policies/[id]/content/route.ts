import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { createPolicyPreviewResponse, findReadyPolicyPreview } from "@/features/policies/policy-preview-response";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export function createPolicyContentRoute(
  dependencies: { db: PrismaClient; privateRoot?: string },
  policyId: string,
) {
  return async function GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(dependencies.db, request, EmployeeModuleKey.POLICIES);
      const policy = await findReadyPolicyPreview(dependencies.db, policyId, { publishedOnly: true });
      const version = policy?.versions[0];
      if (!version) return new Response("Not found", { status: 404 });
      const response = await createPolicyPreviewResponse(
        request,
        version,
        dependencies.privateRoot ?? defaultPrivateRoot,
      );
      if (response.ok || response.status === 206) {
        await dependencies.db.policyViewLog.create({
          data: { policyVersionId: version.id, userId: session.user.id },
        });
      }
      return response;
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createPolicyContentRoute({ db: prisma }, id)(request);
}
