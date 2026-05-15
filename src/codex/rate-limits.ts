export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexRateLimitsSnapshot {
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export function parseRateLimitsFromTokenCountPayload(payload: Record<string, unknown>): CodexRateLimitsSnapshot | null {
  const info = asRecord(payload.info);
  const rateLimits = asRecord(info?.rate_limits) ?? asRecord(payload.rate_limits);
  if (!rateLimits) return null;

  const primary = parseRateLimitWindow(asRecord(rateLimits.primary));
  const secondary = parseRateLimitWindow(asRecord(rateLimits.secondary));
  const planType = typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : undefined;

  if (!primary && !secondary && !planType) return null;
  return {
    planType,
    primary: primary ?? undefined,
    secondary: secondary ?? undefined,
  };
}

function parseRateLimitWindow(input: Record<string, unknown> | null): CodexRateLimitWindow | null {
  if (!input) return null;
  const usedPercentRaw = input.used_percent;
  if (typeof usedPercentRaw !== 'number' || Number.isNaN(usedPercentRaw)) return null;
  const windowMinutes = typeof input.window_minutes === 'number' ? input.window_minutes : undefined;
  const resetsAt = typeof input.resets_at === 'number' ? input.resets_at : undefined;
  return {
    usedPercent: usedPercentRaw,
    windowMinutes,
    resetsAt,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}
