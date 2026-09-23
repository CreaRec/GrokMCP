/**
 * Flood-wait helpers for Findvid Telegram GetHistory polling.
 * GramJS can auto-sleep on FLOOD_WAIT; repeated GetHistory every ~1.5s stacks sleeps
 * and burns FINDVID_WAIT_TIMEOUT_MS before the movie card lands.
 */

export interface FloodStats {
  getHistoryCalls: number;
  floodWaitEvents: number;
  totalFloodWaitSeconds: number;
  lastFloodWaitSeconds?: number;
  /** Epoch ms when the next GetHistory is allowed. */
  nextHistoryAllowedAtMs: number;
}

export function parseFloodWaitSeconds(message: string): number | undefined {
  const patterns = [
    /FLOOD_WAIT_(\d+)/i,
    /FLOOD_PREMIUM_WAIT_(\d+)/i,
    /A wait of (\d+) seconds is required/i,
    /Sleeping(?: for)? (\d+)\s*s(?:ec(?:onds)?)?(?:\s+on)?\s+flood wait/i,
    /Sleeping(?: for)? (\d+)\s*s/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

export function extractFloodWaitSeconds(err: unknown): number | undefined {
  if (err && typeof err === "object" && "seconds" in err) {
    const seconds = Number((err as { seconds?: unknown }).seconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return parseFloodWaitSeconds(message);
}

export class FloodWaitTracker {
  private getHistoryCalls = 0;
  private floodWaitEvents = 0;
  private totalFloodWaitSeconds = 0;
  private lastFloodWaitSeconds: number | undefined;
  private nextHistoryAllowedAtMs = 0;
  /** Flood sleep charged since last consume (for extending wait deadlines). */
  private pendingFloodSleepMs = 0;

  recordHistoryCall(): void {
    this.getHistoryCalls += 1;
  }

  /**
   * Record a Telegram FLOOD_WAIT. Adds a small buffer so we do not immediately
   * re-hit the same limit on the next poll.
   */
  recordFloodWait(seconds: number, options: { bufferMs?: number; nowMs?: number } = {}): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const now = options.nowMs ?? Date.now();
    const bufferMs = options.bufferMs ?? 1_000;
    const waitMs = Math.ceil(seconds * 1000) + bufferMs;
    this.floodWaitEvents += 1;
    this.totalFloodWaitSeconds += seconds;
    this.lastFloodWaitSeconds = seconds;
    this.nextHistoryAllowedAtMs = Math.max(this.nextHistoryAllowedAtMs, now + waitMs);
    this.pendingFloodSleepMs += waitMs;
  }

  /** Enforce a minimum spacing between successful GetHistory calls. */
  noteSuccessfulFetch(options: { minIntervalMs: number; nowMs?: number } = { minIntervalMs: 1_500 }): void {
    const now = options.nowMs ?? Date.now();
    this.nextHistoryAllowedAtMs = Math.max(
      this.nextHistoryAllowedAtMs,
      now + Math.max(0, options.minIntervalMs),
    );
  }

  msUntilHistoryAllowed(nowMs = Date.now()): number {
    return Math.max(0, this.nextHistoryAllowedAtMs - nowMs);
  }

  /** Adaptive sleep between polls: at least pollInterval, or remaining flood backoff. */
  nextPollDelayMs(pollIntervalMs: number, nowMs = Date.now()): number {
    return Math.max(pollIntervalMs, this.msUntilHistoryAllowed(nowMs));
  }

  /** Return and clear flood-sleep ms to add onto wait deadlines. */
  consumePendingFloodSleepMs(): number {
    const ms = this.pendingFloodSleepMs;
    this.pendingFloodSleepMs = 0;
    return ms;
  }

  snapshot(): FloodStats {
    return {
      getHistoryCalls: this.getHistoryCalls,
      floodWaitEvents: this.floodWaitEvents,
      totalFloodWaitSeconds: this.totalFloodWaitSeconds,
      lastFloodWaitSeconds: this.lastFloodWaitSeconds,
      nextHistoryAllowedAtMs: this.nextHistoryAllowedAtMs,
    };
  }

  reset(): void {
    this.getHistoryCalls = 0;
    this.floodWaitEvents = 0;
    this.totalFloodWaitSeconds = 0;
    this.lastFloodWaitSeconds = undefined;
    this.nextHistoryAllowedAtMs = 0;
    this.pendingFloodSleepMs = 0;
  }
}

export function formatFloodStats(stats: FloodStats): string {
  return (
    `getHistory_calls=${stats.getHistoryCalls} ` +
    `flood_wait_events=${stats.floodWaitEvents} ` +
    `flood_wait_seconds=${stats.totalFloodWaitSeconds}` +
    (stats.lastFloodWaitSeconds !== undefined
      ? ` last_flood_wait_seconds=${stats.lastFloodWaitSeconds}`
      : "")
  );
}
