/**
 * Permission-request helpers:
 *
 *   - `generateCallbackId` — monotonic short id for the pending-request map.
 *   - `fallbackOptionId`   — safe fallback for automatic cancellation.
 *   - `tryParsePermissionAnswer` — parse a user text reply into an optionId.
 *
 * These live outside `BlockRenderer` so bots that parse replies ahead of time
 * (or that implement a custom renderer) can reuse the same matching logic.
 */

let callbackCounter = 0;

export function generateCallbackId(): string {
  callbackCounter = (callbackCounter + 1) % 0xffffff;
  return `p${Date.now().toString(36)}${callbackCounter.toString(36)}`;
}

/**
 * Pick the only safe automatic fallback. `reject_always` records a persistent
 * user choice, so render failures and implicit cancellation must never select
 * it on the user's behalf.
 */
export function fallbackOptionId(
  options: ReadonlyArray<{ kind: string; optionId: string }> | undefined,
): string | null {
  return options?.find((option) => option.kind === "reject_once")?.optionId ?? null;
}

// ---------------------------------------------------------------------------
// Text → permission option parsing
// ---------------------------------------------------------------------------

/** Normalize a string for loose matching: lowercase, collapse whitespace,
 *  strip separator chars so `allow_once` / `allow-once` / `allow once` all
 *  match the same canonical form. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "").trim();
}

/**
 * Map of lowercased keyword → ACP permission kind.
 * Bilingual (EN/zh) + common single-letter / numeric shortcuts.
 */
const KEYWORD_TO_KIND: Record<string, string> = {
  allow: "allow_once",
  allowonce: "allow_once",
  yes: "allow_once",
  y: "allow_once",
  ok: "allow_once",
  confirm: "allow_once",
  同意: "allow_once",
  允许: "allow_once",
  "是": "allow_once",
  确认: "allow_once",
  好: "allow_once",

  allowalways: "allow_always",
  always: "allow_always",
  alwaysallow: "allow_always",
  总是允许: "allow_always",
  一直允许: "allow_always",

  reject: "reject_once",
  rejectonce: "reject_once",
  deny: "reject_once",
  no: "reject_once",
  n: "reject_once",
  cancel: "reject_once",
  stop: "reject_once",
  拒绝: "reject_once",
  "否": "reject_once",
  不: "reject_once",
  取消: "reject_once",
  算了: "reject_once",

  rejectalways: "reject_always",
  never: "reject_always",
  alwaysreject: "reject_always",
  alwaysdeny: "reject_always",
  总是拒绝: "reject_always",
  一直拒绝: "reject_always",
};

/**
 * Try to parse a user text reply as a permission option answer.
 *
 * Strategy (first match wins):
 *   1. Pure number `1..N` → `options[N-1]`
 *   2. Keyword (case-insensitive, EN/zh) → find option with matching kind
 *   3. Direct optionId match (case-insensitive, ignoring separators)
 *   4. Option `name` prefix match (case-insensitive)
 *
 * Returns the matched `optionId`, or `null` if no match.
 */
export function tryParsePermissionAnswer(
  text: string,
  options: ReadonlyArray<{ kind: string; optionId: string; name: string }>,
): string | null {
  const raw = text.trim();
  if (!raw || options.length === 0) return null;

  // 1. Number
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= options.length) return options[n - 1].optionId;
    return null; // out-of-range number is not an implicit match
  }

  const norm = normalizeForMatch(raw);
  if (!norm) return null;

  // 2. Keyword → kind
  const mappedKind = KEYWORD_TO_KIND[norm];
  if (mappedKind) {
    const opt = options.find((o) => o.kind === mappedKind);
    if (opt) return opt.optionId;
  }

  // 3. Direct optionId match
  for (const opt of options) {
    if (normalizeForMatch(opt.optionId) === norm) return opt.optionId;
  }

  // 4. Name prefix/equals match
  for (const opt of options) {
    if (normalizeForMatch(opt.name) === norm) return opt.optionId;
  }

  return null;
}
