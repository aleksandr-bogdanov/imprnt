import { emptyAnswer, safeValue, type Language } from "./lines.ts";

export function prepareReply(text: string, platform: string, language: Language): string[] {
  if (!text.trim()) return [emptyAnswer(language)];
  const limit = platform === "telegram" ? 4000 : 2000;
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export interface PlatformFailure {
  kind: "permanent" | "transient" | "uncertain";
  code: string;
  cause: string;
  detail?: string;
}

export function classifyPlatformError(error: unknown): PlatformFailure {
  const data = error as { status?: number; code?: string; sent?: boolean; message?: string } | null;
  const status = Number(data?.status);
  const uncertain = data?.sent === true;
  const code = safeValue(data?.code ?? (status ? `http-${status}` : "platform-failed"));
  const detail = safeValue(data?.message ?? "operation failed");
  const cause = uncertain ? "delivery outcome unknown" : status === 403 ? "access denied" : status === 404 ? "chat missing" : status === 401 ? "login refused" : detail || "operation failed";
  return { kind: uncertain ? "uncertain" : [400, 401, 403, 404].includes(status) ? "permanent" : "transient", code, cause, detail };
}
