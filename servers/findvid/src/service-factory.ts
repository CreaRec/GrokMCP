import type { FindvidConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { FindvidService } from "./findvid-service.js";
import { GramJsTelegramPort, type TelegramPort } from "./telegram-port.js";

let sharedService: FindvidService | null = null;
let sharedConfig: FindvidConfig | null = null;

export async function getFindvidService(options?: {
  config?: FindvidConfig;
  telegram?: TelegramPort;
  refresh?: boolean;
}): Promise<FindvidService> {
  if (options?.config && options?.telegram) {
    return new FindvidService(options.config, options.telegram);
  }

  if (sharedService && !options?.refresh) {
    return sharedService;
  }

  const config = options?.config ?? (await resolveConfig());
  const telegram = options?.telegram ?? new GramJsTelegramPort(config);
  sharedConfig = config;
  sharedService = new FindvidService(config, telegram);
  return sharedService;
}

export function getSharedConfig(): FindvidConfig | null {
  return sharedConfig;
}

export function resetFindvidServiceForTests(): void {
  sharedService = null;
  sharedConfig = null;
}
