import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { newPasswordSchema } from "@/features/auth/password-policy";
import {
  consumePasswordReset,
  PasswordResetError,
} from "@/features/auth/password-reset-service";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  token: z.string().min(1),
  newPassword: newPasswordSchema,
});

export function createResetPasswordRoute(dependencies: {
  db: PrismaClient;
  now?: () => Date;
}) {
  return async function handleResetPassword(request: Request) {
    try {
      assertSameOrigin(request);
      const input = inputSchema.parse(await request.json());
      await consumePasswordReset(dependencies, input);
      return NextResponse.json({
        ok: true,
        message: "密码已重置，请使用新密码登录",
      });
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return NextResponse.json(
          { ok: false, message: error.message },
          { status: 400 },
        );
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { ok: false, message: error.issues[0]?.message ?? "密码格式无效" },
          { status: 400 },
        );
      }
      return authErrorResponse(error);
    }
  };
}

export async function POST(request: Request) {
  return createResetPasswordRoute({ db: prisma })(request);
}
