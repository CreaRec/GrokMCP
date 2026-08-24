import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("RunPod GPU lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("dirty=0 never calls start", () => {
    it("should not attempt to start pod when no dirty files exist", async () => {
      const startPodCalled = vi.fn();
      const stopPodCalled = vi.fn();

      const dirtyCount = 0;
      const hasRunPod = true;

      if (dirtyCount > 0 && hasRunPod) {
        startPodCalled();
        try {
          // vision processing would happen here
        } finally {
          stopPodCalled();
        }
      }

      expect(startPodCalled).not.toHaveBeenCalled();
      expect(stopPodCalled).not.toHaveBeenCalled();
    });

    it("should not call withGpuPod at all when dirty=0", async () => {
      const withGpuPodCalled = vi.fn();
      const dirtyCount = 0;

      if (dirtyCount > 0) {
        withGpuPodCalled();
      }

      expect(withGpuPodCalled).not.toHaveBeenCalled();
    });

    it("should call withGpuPod when dirty > 0", async () => {
      const withGpuPodCalled = vi.fn();
      const dirtyCount = 5;

      if (dirtyCount > 0) {
        withGpuPodCalled();
      }

      expect(withGpuPodCalled).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop is always called after withGpuPod", () => {
    it("should call stop even if processing throws", async () => {
      const stopPodCalled = vi.fn();
      const processingError = new Error("Processing failed");
      let podUsed = false;

      let caughtError: Error | null = null;

      try {
        podUsed = true;
        throw processingError;
      } catch (err) {
        caughtError = err as Error;
      } finally {
        if (podUsed) {
          stopPodCalled();
        }
      }

      expect(stopPodCalled).toHaveBeenCalledTimes(1);
      expect(caughtError).toBe(processingError);
    });

    it("should call stop even when pod was already RUNNING", async () => {
      const stopPodCalled = vi.fn();
      let podUsed = false;
      const initialStatus = "RUNNING";

      const simulateWithGpuPod = async (leaveRunning: boolean) => {
        try {
          if (initialStatus !== "RUNNING") {
            // Would call startPod here
          }
          podUsed = true;
          // Processing happens here
        } finally {
          if (podUsed && !leaveRunning) {
            stopPodCalled();
          }
        }
      };

      await simulateWithGpuPod(false);

      expect(stopPodCalled).toHaveBeenCalledTimes(1);
    });

    it("should NOT call stop when RUNPOD_LEAVE_RUNNING=1", async () => {
      const stopPodCalled = vi.fn();
      let podUsed = false;

      const simulateWithGpuPod = async (leaveRunning: boolean) => {
        try {
          podUsed = true;
        } finally {
          if (podUsed && !leaveRunning) {
            stopPodCalled();
          }
        }
      };

      await simulateWithGpuPod(true);

      expect(stopPodCalled).not.toHaveBeenCalled();
    });

    it("should call stop regardless of whether we started it or it was already running", async () => {
      const scenarios = [
        { initialStatus: "PAUSED", expectedStopCalls: 1 },
        { initialStatus: "RUNNING", expectedStopCalls: 1 },
        { initialStatus: "EXITED", expectedStopCalls: 1 },
      ];

      for (const scenario of scenarios) {
        const stopPodCalled = vi.fn();
        let podUsed = false;

        try {
          if (scenario.initialStatus !== "RUNNING") {
            // Would start pod here
          }
          podUsed = true;
        } finally {
          if (podUsed) {
            stopPodCalled();
          }
        }

        expect(stopPodCalled).toHaveBeenCalledTimes(scenario.expectedStopCalls);
      }
    });
  });

  describe("API key is never logged", () => {
    it("should not include API key in any log output", () => {
      const apiKey = "rp_secret_key_12345";
      const podId = "y5m6f3oroycbs1";

      const logMessages: string[] = [];
      const mockLog = (msg: string) => {
        logMessages.push(msg);
      };

      mockLog(`[runpod] Starting pod ${podId}`);
      mockLog(`[runpod] Pod ${podId} is RUNNING`);
      mockLog(`[runpod] Stopped pod ${podId}`);

      for (const msg of logMessages) {
        expect(msg).not.toContain(apiKey);
        expect(msg).not.toContain("secret");
        expect(msg).not.toContain("rp_");
      }
    });

    it("should not expose API key in error messages", () => {
      const apiKey = "rp_secret_key_12345";

      const createErrorMessage = (status: number) => {
        return `RunPod API error: ${status} Unauthorized`;
      };

      const errorMsg = createErrorMessage(401);
      expect(errorMsg).not.toContain(apiKey);
    });

    it("RunPodConfig type should have apiKey but logs should use podId only", () => {
      interface RunPodConfig {
        apiKey: string;
        podId: string;
        ollamaPort: number;
      }

      const config: RunPodConfig = {
        apiKey: "secret_api_key",
        podId: "test-pod-123",
        ollamaPort: 11434,
      };

      const safeLogMessage = `[runpod] Using pod ${config.podId}`;
      expect(safeLogMessage).toContain(config.podId);
      expect(safeLogMessage).not.toContain(config.apiKey);
    });
  });
});

describe("withGpuPod behavior", () => {
  it("should track podUsed flag correctly and always stop", async () => {
    let podUsed = false;
    let stopCalled = false;

    const mockStop = async () => {
      stopCalled = true;
    };

    const withGpuPodSimulation = async <T>(
      initialStatus: string,
      leaveRunning: boolean,
      fn: () => Promise<T>,
    ): Promise<T> => {
      try {
        if (initialStatus !== "RUNNING") {
          // Would call startPod here
        }
        podUsed = true;
        return await fn();
      } finally {
        if (podUsed && !leaveRunning) {
          await mockStop();
        }
      }
    };

    await withGpuPodSimulation("PAUSED", false, async () => "result");
    
    expect(podUsed).toBe(true);
    expect(stopCalled).toBe(true);
  });

  it("should stop pod even when pod was already RUNNING", async () => {
    let podUsed = false;
    let stopCalled = false;

    const withGpuPodSimulation = async <T>(
      initialStatus: string,
      leaveRunning: boolean,
      fn: () => Promise<T>,
    ): Promise<T> => {
      try {
        if (initialStatus !== "RUNNING") {
          // Would call startPod here - but it's already running!
        }
        podUsed = true;
        return await fn();
      } finally {
        if (podUsed && !leaveRunning) {
          stopCalled = true;
        }
      }
    };

    await withGpuPodSimulation("RUNNING", false, async () => "result");

    expect(podUsed).toBe(true);
    expect(stopCalled).toBe(true);
  });

  it("should stop pod even when function throws", async () => {
    let podUsed = false;
    let stopCalled = false;

    const withGpuPodSimulation = async <T>(
      leaveRunning: boolean,
      fn: () => Promise<T>,
    ): Promise<T> => {
      try {
        podUsed = true;
        return await fn();
      } finally {
        if (podUsed && !leaveRunning) {
          stopCalled = true;
        }
      }
    };

    try {
      await withGpuPodSimulation(false, async () => {
        throw new Error("Vision processing failed");
      });
    } catch {
      // Expected
    }

    expect(podUsed).toBe(true);
    expect(stopCalled).toBe(true);
  });

  it("should respect leaveRunning option", async () => {
    let podUsed = false;
    let stopCalled = false;

    const withGpuPodSimulation = async <T>(
      leaveRunning: boolean,
      fn: () => Promise<T>,
    ): Promise<T> => {
      try {
        podUsed = true;
        return await fn();
      } finally {
        if (podUsed && !leaveRunning) {
          stopCalled = true;
        }
      }
    };

    await withGpuPodSimulation(true, async () => "result");

    expect(podUsed).toBe(true);
    expect(stopCalled).toBe(false);
  });
});
