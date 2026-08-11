import { randomBytes } from "node:crypto";

import { after, NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import {
  publicPasswordResetResult,
  requestPasswordReset,
} from "@/features/auth/password-reset-service";
import {
  createPasswordResetSender,
  type PasswordResetSender,
} from "@/features/auth/password-reset-sender";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const inputSchema = z.object({ identifier: z.string().trim() });

type Dependencies = {
  db: PrismaClient;
  sender: PasswordResetSender;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  defer?: (work: () => Promise<void>) => void;
  tokenHashSecret: string;
};

const DIRECT_REQUEST_SOURCE = "direct";

export function createForgotPasswordRoute(dependencies: Dependencies) {
  return async function handleForgotPassword(request: Request) {
    try {
      assertSameOrigin(request);
    } catch (error) {
      return authErrorResponse(error);
    }

    const body = await request.json().catch(() => ({}));
    const parsed = inputSchema.safeParse(body);
    const input = {
      identifier: parsed.success ? parsed.data.identifier : "",
      requestSource: DIRECT_REQUEST_SOURCE,
    };

    if (dependencies.sender.mode !== "DEVELOPMENT_SIMULATION") {
      const work = async () => {
        await requestPasswordReset(dependencies, input).catch(() => undefined);
      };
      try {
        (dependencies.defer ?? after)(work);
      } catch {
        // The public response deliberately does not expose scheduling failures.
      }
      return NextResponse.json(publicPasswordResetResult());
    }

    try {
      return NextResponse.json(await requestPasswordReset(dependencies, input));
    } catch {
      return NextResponse.json(publicPasswordResetResult());
    }
  };
}

export async function POST(request: Request) {
  const env = getEnv();
  const sender = createPasswordResetSender({
    db: prisma,
    env: process.env,
  });
  return createForgotPasswordRoute({
    db: prisma,
    sender,
    randomBytes,
    tokenHashSecret: env.AUTH_TOKEN_SECRET,
  })(request);
}
