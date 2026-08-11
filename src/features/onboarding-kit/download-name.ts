const CONTROL_OR_HEADER_SYNTAX = /[\0-\x1f\x7f"':]/g;
const PATH_SYNTAX = /[\\/]+/g;

export function createSafeDownloadName(input: string, fallback: string): string {
  const cleaned = input
    .normalize("NFC")
    .replace(CONTROL_OR_HEADER_SYNTAX, "")
    .replace(PATH_SYNTAX, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  return fallback.replace(CONTROL_OR_HEADER_SYNTAX, "").replace(PATH_SYNTAX, "").replace(/^\.+/, "").trim() || "download";
}

function asciiFallback(input: string) {
  return input
    .replace(/[^\x20-\x7e]/g, "")
    .replace(CONTROL_OR_HEADER_SYNTAX, "")
    .replace(PATH_SYNTAX, "")
    .replace(/^\.+/, "")
    .trim() || "download";
}

function rfc5987(input: string) {
  return encodeURIComponent(input).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function createAttachmentDisposition(input: string, fallback: string) {
  const safe = createSafeDownloadName(input, fallback);
  const ascii = asciiFallback(createSafeDownloadName(fallback, "download"));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(safe)}`;
}
