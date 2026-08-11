import { AuthError } from "@/features/auth/errors";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site");
    const fetchMode = request.headers.get("sec-fetch-mode");
    if (fetchSite === "same-origin" && (fetchMode === "cors" || fetchMode === "same-origin")) return;
    throw new AuthError("INVALID_ORIGIN", 403);
  }

  const requestUrl = new URL(request.url);
  const expectedOrigins = new Set([requestUrl.origin]);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = request.headers.get("host") ?? forwardedHost;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol ?? requestUrl.protocol.slice(0, -1);
  if (host) {
    try {
      expectedOrigins.add(new URL(`${protocol}://${host}`).origin);
    } catch {
      throw new AuthError("INVALID_ORIGIN", 403);
    }
  }
  if (forwardedHost) {
    try {
      expectedOrigins.add(new URL(`${protocol}://${forwardedHost}`).origin);
    } catch {
      throw new AuthError("INVALID_ORIGIN", 403);
    }
  }
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(origin).origin;
  } catch {
    throw new AuthError("INVALID_ORIGIN", 403);
  }
  if (!expectedOrigins.has(parsedOrigin)) {
    throw new AuthError("INVALID_ORIGIN", 403);
  }
}
