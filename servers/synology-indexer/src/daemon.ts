import { msUntilNextRun } from "./schedule.js";

export type IndexRunReason = "scheduled" | "manual";

export interface LogAttributes {
  [key: string]: string | number | boolean;
}

export interface IndexDaemonDeps {
  hour: number;
  minute: number;
  timezone: string;
  indexDailyAt: string;
  runIndex: (reason: IndexRunReason) => Promise<void>;
  now?: () => Date;
  /**
   * Sleep until `ms` elapses or `signal` aborts.
   * Resolves `"timer"` on timeout, `"manual"` on abort.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<"timer" | "manual">;
  logInfo?: (body: string, attributes?: LogAttributes) => void;
  logWarn?: (body: string, attributes?: LogAttributes) => void;
  logErrorWithCause?: (body: string, err: unknown, attributes?: LogAttributes) => void;
}

export interface IndexDaemon {
  /** Run the wait → index loop until `stop()` is called. */
  run(): Promise<void>;
  /**
   * Request an immediate index run (e.g. SIGUSR2).
   * No-ops with a warning if a run is already in flight.
   */
  requestManualRun(): void;
  /** Abort the current wait and exit the loop after any in-flight run. */
  stop(): void;
  /** True while `runIndex` is executing. */
  isRunning(): boolean;
}

function hoursUntilRun(ms: number): number {
  return Math.round((ms / 1000 / 60 / 60) * 10) / 10;
}

export async function defaultSleep(
  ms: number,
  signal: AbortSignal,
): Promise<"timer" | "manual"> {
  if (signal.aborted) {
    return "manual";
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve("manual");
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("timer");
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Daemon loop: sleep until INDEX_DAILY_AT (IANA timezone), run index, repeat.
 * A manual trigger aborts the wait, runs once with reason=manual, then resumes
 * waiting for the *next* INDEX_DAILY_AT (cadence is not shifted).
 */
export function createIndexDaemon(deps: IndexDaemonDeps): IndexDaemon {
  const nowFn = deps.now ?? (() => new Date());
  const sleepFn = deps.sleep ?? defaultSleep;
  const logInfo = deps.logInfo ?? (() => undefined);
  const logWarn = deps.logWarn ?? (() => undefined);
  const logErrorWithCause =
    deps.logErrorWithCause ??
    ((_body: string, _err: unknown) => undefined);

  let indexInFlight = false;
  let stopped = false;
  let waitAbort: AbortController | null = null;

  const requestManualRun = (): void => {
    logInfo("manual trigger received");
    if (indexInFlight) {
      logWarn("manual trigger ignored; index already running");
      return;
    }
    if (!waitAbort) {
      logWarn("manual trigger ignored; not waiting for schedule");
      return;
    }
    waitAbort.abort();
  };

  const stop = (): void => {
    stopped = true;
    waitAbort?.abort();
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      const now = nowFn();
      const msToWait = msUntilNextRun(
        deps.hour,
        deps.minute,
        deps.timezone,
        now,
      );
      const hoursToWait = hoursUntilRun(msToWait);
      logInfo("scheduled run waiting", {
        hours_until_run: hoursToWait,
        index_daily_at: deps.indexDailyAt,
        timezone: deps.timezone,
      });

      waitAbort = new AbortController();
      let wake: "timer" | "manual";
      try {
        wake = await sleepFn(msToWait, waitAbort.signal);
      } finally {
        waitAbort = null;
      }

      if (stopped) {
        break;
      }

      // stop() also aborts wait; treat that as exit, not a manual run.
      if (wake === "manual" && stopped) {
        break;
      }

      const reason: IndexRunReason = wake === "manual" ? "manual" : "scheduled";

      indexInFlight = true;
      try {
        await deps.runIndex(reason);
      } catch (err) {
        logErrorWithCause("index run failed", err, { reason });
      } finally {
        indexInFlight = false;
      }
      // Loop continues: next wait is recomputed from wall clock → next INDEX_DAILY_AT
    }
  };

  return {
    run,
    requestManualRun,
    stop,
    isRunning: () => indexInFlight,
  };
}
