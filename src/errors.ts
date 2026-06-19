/**
 * Error normalization for channel plugins.
 *
 * Every plugin had an ad-hoc ladder that tried `instanceof Error`, then
 * `typeof error === "object"`, then fell back to `String(error)`. That
 * ladder lived in five slightly-different forms across bot.ts files and
 * drifted over time. Centralize it here.
 */

const MESSAGE_KEYS = [
  "message",
  "error",
  "detail",
  "details",
  "reason",
  "description",
  "statusText",
] as const;

const DETAIL_KEYS = ["code", "status", "statusCode", "type"] as const;

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Handles JSON-RPC/fetch-style error shapes (`{ code, message, data }`,
 * `{ error, status }`) by flattening useful fields into the output so users
 * see real causes instead of `[object Object]`. Prefers explicit message-like
 * fields, then nested `data` / `cause`, then a non-circular JSON dump.
 */
export function extractErrorMessage(e: unknown): string {
  return formatErrorValue(e, new Set()) ?? "Unknown error";
}

function formatErrorValue(value: unknown, seen: Set<unknown>): string | null {
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) return null;

  if (value instanceof Error) {
    const parts: string[] = [];
    const message = clean(value.message);
    if (message) parts.push(message);

    const data = (value as unknown as { data?: unknown }).data;
    const detail = formatErrorValue(data, seen);
    if (detail && !parts.includes(detail)) parts.push(detail);

    const cause = (value as unknown as { cause?: unknown }).cause;
    if (cause && cause !== value) {
      const causeMessage = formatErrorValue(cause, seen);
      if (causeMessage && !parts.includes(causeMessage)) {
        parts.push(`cause: ${causeMessage}`);
      }
    }

    if (parts.length > 0) return parts.join("\n");
    return clean(value.name);
  }

  if (typeof value !== "object") return clean(String(value));
  if (seen.has(value)) return null;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const message = MESSAGE_KEYS
    .map((key) => formatErrorValue(record[key], seen))
    .find((part): part is string => Boolean(part));
  const details = DETAIL_KEYS
    .map((key) => {
      const detail = primitiveDetail(record[key]);
      return detail ? `${key}: ${detail}` : null;
    })
    .filter((part): part is string => Boolean(part));
  const data = formatErrorValue(record.data, seen);

  const parts: string[] = [];
  if (message) {
    parts.push(details.length > 0 ? `${message} (${details.join(", ")})` : message);
  } else if (details.length > 0) {
    parts.push(details.join(", "));
  }
  if (data && !parts.includes(data)) parts.push(data);
  if (parts.length > 0) return parts.join("\n");

  return clean(safeJsonStringify(value));
}

function primitiveDetail(value: unknown): string | null {
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "[object Object]") return null;
  return trimmed;
}

function safeJsonStringify(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") return String(nestedValue);
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  } catch {
    return null;
  }
}
