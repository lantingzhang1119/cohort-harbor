import "server-only";

import sanitizeHtml from "sanitize-html";

export type TemplateBoundary = "DRAFT_SAVE" | "PREVIEW" | "PUBLISH" | "SEND";

export type RenderTemplateInput = {
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  allowedPlaceholders: string[];
  allowedContentIds?: string[];
  boundary?: TemplateBoundary;
  values: Record<string, string>;
};

export type RenderedTemplateContent = { subject: string; html: string; text: string };

export class MailTemplateRenderError extends Error {
  constructor(
    public readonly code:
      | "MALFORMED_PLACEHOLDER"
      | "UNKNOWN_PLACEHOLDER"
      | "MISSING_PLACEHOLDER_VALUE"
      | "INVALID_IMAGE_SOURCE"
      | "INVALID_SUBJECT",
    message: string,
    public readonly placeholder?: string,
  ) {
    super(message);
    this.name = "MailTemplateRenderError";
  }
}

const PLACEHOLDER = /{{([A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*)}}/g;
const BOUNDARIES = new Set<TemplateBoundary>(["DRAFT_SAVE", "PREVIEW", "PUBLISH", "SEND"]);
const TEXT_ENTITY_VALUES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": "\u00a0",
};

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "strong", "em", "u", "s", "ul", "ol", "li", "blockquote",
    "h1", "h2", "h3", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "span", "div",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "cid"] },
  allowProtocolRelative: false,
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
      "background-color": [/^#[0-9a-f]{3,8}$/i],
      "background-image": [/^url\(cid:[A-Za-z0-9][A-Za-z0-9._@-]{0,126}\)$/],
      "background-repeat": [/^(?:no-repeat|repeat|repeat-x|repeat-y)$/],
      "background-size": [/^(?:auto|cover|contain)$/],
      "text-align": [/^(?:left|right|center|justify)$/],
      "font-size": [/^\d+(?:px|pt|em|rem|%)$/],
      "font-weight": [/^(?:normal|bold|[1-9]00)$/],
    },
  },
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: {
        ...attributes,
        ...(attributes.target === "_blank" ? { rel: "noopener noreferrer" } : {}),
      },
    }),
  },
};

export function sanitizeTemplateHtml(
  html: string,
  boundary: TemplateBoundary,
  options: { allowedContentIds?: string[] } = {},
): string {
  if (!BOUNDARIES.has(boundary)) throw new TypeError("未知模板清洗边界");
  const allowedContentIds = new Set(options.allowedContentIds ?? []);
  const sanitized = sanitizeHtml(html, {
    ...SANITIZE_OPTIONS,
    allowedSchemesByTag: { img: ["cid"] },
    transformTags: {
      ...SANITIZE_OPTIONS.transformTags,
      img: (_tagName, attributes) => {
        const source = attributes.src;
        const contentId = source?.startsWith("cid:") ? source.slice(4) : "";
        if (!contentId || !allowedContentIds.has(contentId)) {
          throw new MailTemplateRenderError("INVALID_IMAGE_SOURCE", "图片必须引用本模板已验证的 CID 素材", contentId || undefined);
        }
        return { tagName: "img", attribs: attributes };
      },
    },
  });
  return sanitized.replace(
    /style="([^"]*)"/g,
    (_attribute, declarations: string) => {
      for (const match of declarations.matchAll(/url\(cid:([A-Za-z0-9][A-Za-z0-9._@-]{0,126})\)/g)) {
        if (!allowedContentIds.has(match[1])) {
          throw new MailTemplateRenderError("INVALID_IMAGE_SOURCE", "背景图片必须引用本模板已验证的 CID 素材", match[1]);
        }
      }
      return `style="${declarations.replace(/(^|;)([a-z-]+):\s*/g, "$1$2: ")}"`;
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function interpolate(
  template: string,
  allowed: Set<string>,
  values: Record<string, string>,
  context: "HTML" | "TEXT",
): string {
  if (template.includes("{{{") || template.includes("}}}")) {
    throw new MailTemplateRenderError("MALFORMED_PLACEHOLDER", "占位符格式无效");
  }
  const matchedRanges: Array<[number, number]> = [];
  const result = template.replace(PLACEHOLDER, (token, placeholder: string, offset: number) => {
    matchedRanges.push([offset, offset + token.length]);
    if (!allowed.has(placeholder)) {
      throw new MailTemplateRenderError("UNKNOWN_PLACEHOLDER", "模板包含未知占位符", placeholder);
    }
    if (!Object.hasOwn(values, placeholder)) {
      throw new MailTemplateRenderError("MISSING_PLACEHOLDER_VALUE", "占位符缺少解析值", placeholder);
    }
    return context === "HTML" ? escapeHtml(values[placeholder]) : values[placeholder];
  });

  let remainder = template;
  for (const [start, end] of matchedRanges.toReversed()) {
    remainder = remainder.slice(0, start) + remainder.slice(end);
  }
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw new MailTemplateRenderError("MALFORMED_PLACEHOLDER", "占位符格式无效");
  }
  return result;
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|h[1-3]|blockquote|li|div|tr)>/gi, "\n\n");
  const encodedPlain = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  const plain = encodedPlain.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const normalized = entity.toLowerCase();
    if (TEXT_ENTITY_VALUES[normalized] !== undefined) return TEXT_ENTITY_VALUES[normalized];
    const numeric = normalized.startsWith("&#x")
      ? Number.parseInt(normalized.slice(3, -1), 16)
      : Number.parseInt(normalized.slice(2, -1), 10);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
  return plain
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderTemplateContent(input: RenderTemplateInput): RenderedTemplateContent {
  const allowed = new Set(input.allowedPlaceholders);
  const subject = interpolate(input.subject, allowed, input.values, "TEXT");
  if (/[\r\n]/.test(subject)) {
    throw new MailTemplateRenderError("INVALID_SUBJECT", "渲染后的邮件主题不能包含换行符");
  }
  const renderedHtml = interpolate(input.htmlBody, allowed, input.values, "HTML");
  const html = sanitizeTemplateHtml(renderedHtml, input.boundary ?? "SEND", {
    allowedContentIds: input.allowedContentIds,
  });
  const textTemplate = input.textBody?.trim();
  const text = textTemplate
    ? interpolate(input.textBody!, allowed, input.values, "TEXT")
    : htmlToText(html);
  return { subject, html, text };
}
