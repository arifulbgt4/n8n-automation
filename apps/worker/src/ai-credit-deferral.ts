const AI_DAILY_CREDIT_LIMIT_CODE = "AI_DAILY_CREDIT_LIMIT_REACHED";
const RESET_SAFETY_BUFFER_MS = 30_000;

/** Return a safe retry timestamp for a platform AI allowance error. */
export function aiAllowanceRetryAt(error: unknown, now = Date.now()): number | null {
  const apiError = (error as { body?: { error?: { code?: unknown; details?: { resetAt?: unknown } } } } | null)?.body?.error;
  if (apiError?.code !== AI_DAILY_CREDIT_LIMIT_CODE || typeof apiError.details?.resetAt !== "string") return null;

  const resetAt = Date.parse(apiError.details.resetAt);
  if (!Number.isFinite(resetAt)) return null;
  return Math.max(now + 1_000, resetAt + RESET_SAFETY_BUFFER_MS);
}
