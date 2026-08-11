import { describe, expect, it } from "vitest";

import {
  MailTemplateRenderError,
  renderTemplateContent,
  sanitizeTemplateHtml,
  type TemplateBoundary,
} from "@/features/onboarding-mail/template-renderer";

const boundaries: TemplateBoundary[] = ["DRAFT_SAVE", "PREVIEW", "PUBLISH", "SEND"];

describe("safe welcome-mail template renderer", () => {
  it("parses placeholders without evaluating strings and escapes values by output context", () => {
    const rendered = renderTemplateContent({
      subject: "欢迎 {{name}} - {{custom.expression}}",
      htmlBody: "<p>Hello <strong>{{name}}</strong> {{custom.expression}}</p>",
      textBody: "Hello {{name}} {{custom.expression}}",
      allowedPlaceholders: ["name", "custom.expression"],
      values: {
        name: "<img src=x onerror=alert(1)>",
        "custom.expression": "${process.env.SECRET}",
      },
    });

    expect(rendered.subject).toBe("欢迎 <img src=x onerror=alert(1)> - ${process.env.SECRET}");
    expect(rendered.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rendered.html).toContain("${process.env.SECRET}");
    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.text).toContain("<img src=x onerror=alert(1)>");
  });

  it.each(boundaries)("sanitizes malicious HTML, URLs and CSS at the %s boundary", (boundary) => {
    const dirty = [
      '<script>alert(1)</script><p style="color: #123456; position:fixed; background-image:url(javascript:alert(2))">安全</p>',
      '<a href="javascript:alert(3)" target="_blank" onclick="alert(4)">链接</a>',
      '<img src="cid:logo-1" onerror="alert(5)"><img src="data:text/html;base64,PHNjcmlwdD4=">',
      '<svg><foreignObject>bad</foreignObject></svg>',
    ].join("");
    const clean = sanitizeTemplateHtml(dirty.replace('<img src="data:text/html;base64,PHNjcmlwdD4=">', ""), boundary, {
      allowedContentIds: ["logo-1"],
    });

    expect(clean).not.toMatch(/script|javascript:|onclick|onerror|position|background-image|data:text|svg|foreignObject/i);
    expect(clean).toContain("color: #123456");
    expect(clean).toContain('src="cid:logo-1"');
  });

  it.each([
    ["remote", '<img src="https://tracker.example/pixel.png">', ["pixel"]],
    ["data", '<img src="data:image/png;base64,AAAA">', ["hero"]],
    ["unknown CID", '<img src="cid:not-frozen">', ["logo-1"]],
    ["unknown CSS CID", '<div style="background-image:url(cid:not-frozen)">content</div>', ["logo-1"]],
    ["missing src", "<img>", ["logo-1"]],
  ])("rejects %s image sources instead of silently weakening them", (_case, htmlBody, allowedContentIds) => {
    expect(() => sanitizeTemplateHtml(htmlBody, "DRAFT_SAVE", { allowedContentIds }))
      .toThrowError(expect.objectContaining({ code: "INVALID_IMAGE_SOURCE" }));
  });

  it("rejects unknown placeholders and distinguishes configured fields with missing values", () => {
    expect(() => renderTemplateContent({
      subject: "{{unknown}}",
      htmlBody: "<p>ok</p>",
      textBody: "ok",
      allowedPlaceholders: ["name"],
      values: { name: "示例员工" },
    })).toThrowError(expect.objectContaining({ code: "UNKNOWN_PLACEHOLDER", placeholder: "unknown" }));

    expect(() => renderTemplateContent({
      subject: "{{name}}",
      htmlBody: "<p>{{email}}</p>",
      textBody: "",
      allowedPlaceholders: ["name", "email"],
      values: { name: "示例员工" },
    })).toThrowError(expect.objectContaining({ code: "MISSING_PLACEHOLDER_VALUE", placeholder: "email" }));
  });

  it("generates a readable text fallback from sanitized HTML", () => {
    const rendered = renderTemplateContent({
      subject: "欢迎 {{name}}",
      htmlBody: "<h1>欢迎 {{name}}</h1><p>第一天<br>请阅读<a href=\"https://example.com\">手册</a></p>",
      textBody: "   ",
      allowedPlaceholders: ["name"],
      values: { name: "李四" },
    });

    expect(rendered.text).toBe("欢迎 李四\n\n第一天\n请阅读手册");
  });

  it("decodes HTML-context escaping in text fallback without interpreting field values as markup", () => {
    const rendered = renderTemplateContent({
      subject: "欢迎 {{name}}",
      htmlBody: "<p>欢迎 <strong>{{name}}</strong></p>",
      allowedPlaceholders: ["name"],
      values: { name: "A&B/<同事>" },
    });

    expect(rendered.html).toContain("A&amp;B/&lt;同事&gt;");
    expect(rendered.text).toBe("欢迎 A&B/<同事>");
    expect(rendered.text).not.toMatch(/&(?:amp|lt|gt);/);
  });

  it("rejects CR/LF introduced into the final subject by placeholder values", () => {
    expect(() => renderTemplateContent({
      subject: "欢迎 {{name}}",
      htmlBody: "<p>欢迎 {{name}}</p>",
      textBody: "欢迎 {{name}}",
      allowedPlaceholders: ["name"],
      values: { name: "新员工\r\nBcc: attacker@example.invalid" },
    })).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
  });

  it.each(["欢迎 {{ name }}", "欢迎 {{{name}}}", "欢迎 {{name}}}"])(
    "rejects malformed placeholder tokens instead of partially interpreting %s",
    (subject) => {
    expect(() => renderTemplateContent({
      subject,
      htmlBody: "<p>ok</p>",
      textBody: "ok",
      allowedPlaceholders: ["name"],
      values: { name: "王五" },
    })).toThrow(MailTemplateRenderError);
    },
  );
});
