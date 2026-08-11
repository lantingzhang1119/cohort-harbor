import { describe, expect, it } from "vitest";

import { assertSameOrigin } from "@/features/auth/origin";

describe("same-origin validation behind the Next.js local proxy", () => {
  it("accepts the browser origin that matches forwarded host and protocol", () => {
    const request = new Request("http://localhost:3100/api/auth/login", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3100",
        "x-forwarded-host": "127.0.0.1:3100",
        "x-forwarded-proto": "http",
      },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("still rejects a foreign origin when forwarded headers are present", () => {
    const request = new Request("http://localhost:3100/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://attacker.invalid",
        "x-forwarded-host": "127.0.0.1:3100",
        "x-forwarded-proto": "http",
      },
    });
    expect(() => assertSameOrigin(request)).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
  });

  it("rejects absent and malformed Origin unless Fetch Metadata proves a same-origin request", () => {
    const missing = new Request("http://localhost:3100/api/admin/portal/SHANGHAI/publish", { method: "POST" });
    expect(() => assertSameOrigin(missing)).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));

    const malformed = new Request("http://localhost:3100/api/admin/portal/SHANGHAI/publish", {
      method: "POST",
      headers: { origin: "not a URL" },
    });
    expect(() => assertSameOrigin(malformed)).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));

    const fetchMetadata = new Request("http://localhost:3100/api/admin/portal/SHANGHAI/publish", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    });
    expect(() => assertSameOrigin(fetchMetadata)).not.toThrow();
  });
});
