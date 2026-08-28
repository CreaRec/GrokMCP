import { request as httpRequest } from "node:http";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { logInfo, logError, logErrorWithCause, logWarn } from "./telemetry.js";

const DOCKER_API_VERSION = "v1.41";

/** Default: allow slow CPU model warm on first boot. */
export const DEFAULT_DOCLING_HEALTHY_TIMEOUT_MS = 300_000;

export interface DoclingSidecarConfig {
  containerName: string;
  doclingServeUrl: string;
  dockerSocketPath: string;
  healthyTimeoutMs: number;
}

export interface DoclingSidecarLifecycleOptions {
  leaveRunning?: boolean;
  onStart?: () => void;
  onStop?: () => void;
}

interface DockerApiResponse {
  statusCode: number;
  body: string;
}

export type DockerSocketAccessResult =
  | { accessible: true }
  | { accessible: false; reason: "missing" }
  | { accessible: false; reason: "permission_denied" };

export interface DoclingSidecarDeps {
  dockerRequest?: (method: string, path: string) => Promise<DockerApiResponse>;
  fetchHealth?: (url: string) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  checkSocketAccess?: (path: string) => Promise<DockerSocketAccessResult>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check whether the Docker socket exists and is readable/writable. */
export async function checkDockerSocketAccess(
  socketPath: string,
): Promise<DockerSocketAccessResult> {
  try {
    await access(socketPath, constants.F_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { accessible: false, reason: "missing" };
    }
    return { accessible: false, reason: "missing" };
  }

  try {
    await access(socketPath, constants.R_OK | constants.W_OK);
    return { accessible: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return { accessible: false, reason: "permission_denied" };
    }
    return { accessible: false, reason: "permission_denied" };
  }
}

function dockerSocketUnavailableError(
  socketPath: string,
  containerName: string,
  reason: "missing" | "permission_denied",
): Error {
  const prefix =
    `Docker socket unavailable at ${socketPath}; cannot start Docling sidecar ${containerName}.`;
  if (reason === "missing") {
    return new Error(
      `${prefix} Mount /var/run/docker.sock into synology-indexer (see docker-compose.yml).`,
    );
  }
  return new Error(
    `${prefix} Socket is mounted but not readable/writable (EACCES). ` +
      "Add the host docker group to synology-indexer via group_add and set DOCKER_GID in .env " +
      "(host: stat -c %g /var/run/docker.sock or getent group docker; see .env.example).",
  );
}

function createDockerRequest(socketPath: string) {
  return (method: string, path: string): Promise<DockerApiResponse> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path: `/${DOCKER_API_VERSION}${path}`,
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
}

function encodeContainerName(name: string): string {
  return encodeURIComponent(name.startsWith("/") ? name : `/${name}`);
}

/** True when dirty work includes docling-routed files. */
export function indexRunNeedsDocling(
  routes: Iterable<{ route: string }>,
): boolean {
  for (const item of routes) {
    if (item.route === "docling") {
      return true;
    }
  }
  return false;
}

export async function inspectDoclingContainer(
  config: DoclingSidecarConfig,
  deps: DoclingSidecarDeps = {},
): Promise<{ exists: boolean; running: boolean }> {
  const dockerRequest =
    deps.dockerRequest ?? createDockerRequest(config.dockerSocketPath);
  const encoded = encodeContainerName(config.containerName);

  const response = await dockerRequest("GET", `/containers/${encoded}/json`);
  if (response.statusCode === 404) {
    return { exists: false, running: false };
  }
  if (response.statusCode !== 200) {
    throw new Error(
      `Docker inspect failed for ${config.containerName}: HTTP ${response.statusCode}`,
    );
  }

  const info = JSON.parse(response.body) as { State?: { Running?: boolean } };
  return { exists: true, running: info.State?.Running === true };
}

export async function startDoclingContainer(
  config: DoclingSidecarConfig,
  deps: DoclingSidecarDeps = {},
): Promise<void> {
  const checkSocketAccess = deps.checkSocketAccess ?? checkDockerSocketAccess;
  const socketAccess = await checkSocketAccess(config.dockerSocketPath);
  if (!socketAccess.accessible) {
    throw dockerSocketUnavailableError(
      config.dockerSocketPath,
      config.containerName,
      socketAccess.reason,
    );
  }

  const dockerRequest =
    deps.dockerRequest ?? createDockerRequest(config.dockerSocketPath);
  const encoded = encodeContainerName(config.containerName);

  const inspect = await inspectDoclingContainer(config, deps);
  if (!inspect.exists) {
    throw new Error(
      `Docling container ${config.containerName} not found. ` +
        "Create it once with: docker compose --profile docling up --no-start docling-serve",
    );
  }

  if (inspect.running) {
    logInfo("docling sidecar already running", { container: config.containerName });
    return;
  }

  logInfo("docling sidecar starting", { container: config.containerName });
  const response = await dockerRequest("POST", `/containers/${encoded}/start`);
  if (response.statusCode !== 204 && response.statusCode !== 304) {
    throw new Error(
      `Docker start failed for ${config.containerName}: HTTP ${response.statusCode}`,
    );
  }
}

export async function stopDoclingContainer(
  config: DoclingSidecarConfig,
  deps: DoclingSidecarDeps = {},
): Promise<void> {
  const dockerRequest =
    deps.dockerRequest ?? createDockerRequest(config.dockerSocketPath);
  const encoded = encodeContainerName(config.containerName);

  const inspect = await inspectDoclingContainer(config, deps);
  if (!inspect.exists) {
    logWarn("docling sidecar stop skipped; container missing", {
      container: config.containerName,
    });
    return;
  }

  if (!inspect.running) {
    logInfo("docling sidecar already stopped", { container: config.containerName });
    return;
  }

  logInfo("docling sidecar stopping", { container: config.containerName });
  const response = await dockerRequest("POST", `/containers/${encoded}/stop?t=30`);
  if (response.statusCode !== 204 && response.statusCode !== 304) {
    throw new Error(
      `Docker stop failed for ${config.containerName}: HTTP ${response.statusCode}`,
    );
  }
  logInfo("docling sidecar stopped", { container: config.containerName });
}

export async function waitForDoclingHealthy(
  doclingServeUrl: string,
  timeoutMs: number = DEFAULT_DOCLING_HEALTHY_TIMEOUT_MS,
  pollIntervalMs: number = 3000,
  deps: Pick<DoclingSidecarDeps, "fetchHealth" | "sleep"> = {},
): Promise<void> {
  const fetchHealth = deps.fetchHealth ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const base = doclingServeUrl.replace(/\/$/, "");
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetchHealth(`${base}/ready`);
      if (response.ok) {
        logInfo("docling sidecar healthy");
        return;
      }
    } catch {
      // Connection refused while booting — keep polling.
    }

    logInfo("docling waiting for sidecar");
    await sleep(pollIntervalMs);
  }

  logError("docling sidecar health timeout", { timeout_ms: timeoutMs });
  throw new Error("Timeout waiting for Docling sidecar to become healthy");
}

/**
 * Start docling-serve, wait until /ready, run fn, then stop the container.
 * Mirrors withGpuPod: ephemeral for the index run unless leaveRunning is set.
 */
export async function withDoclingSidecar<T>(
  config: DoclingSidecarConfig,
  fn: () => Promise<T>,
  options?: DoclingSidecarLifecycleOptions,
  deps: DoclingSidecarDeps = {},
): Promise<T> {
  let started = false;

  try {
    await startDoclingContainer(config, deps);
    started = true;
    options?.onStart?.();

    await waitForDoclingHealthy(
      config.doclingServeUrl,
      config.healthyTimeoutMs,
      3000,
      deps,
    );

    return await fn();
  } finally {
    if (started && !options?.leaveRunning) {
      try {
        await stopDoclingContainer(config, deps);
        options?.onStop?.();
      } catch (err) {
        logErrorWithCause("docling sidecar stop failed", err, {
          container: config.containerName,
        });
      }
    } else if (options?.leaveRunning && started) {
      logInfo("docling leaving sidecar running", { container: config.containerName });
    }
  }
}
