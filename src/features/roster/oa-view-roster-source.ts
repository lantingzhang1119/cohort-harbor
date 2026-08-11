import type { RosterSource } from "@/features/roster/roster-source";
import type {
  NormalizedRosterRow,
  RosterBatchMetadata,
  RosterValidationResult,
} from "@/features/roster/types";

export class OaSourceNotConfiguredError extends Error {
  readonly code = "OA_SOURCE_NOT_CONFIGURED";
}

export class OaViewRosterSource implements RosterSource<never> {
  getSourceName() {
    return "OaViewRosterSource";
  }

  private unavailable(): never {
    throw new OaSourceNotConfiguredError("本地 Demo 未配置 OA 数据源");
  }

  async load(): Promise<NormalizedRosterRow[]> {
    return this.unavailable();
  }

  async validate(): Promise<RosterValidationResult> {
    return this.unavailable();
  }

  async createBatchMetadata(): Promise<RosterBatchMetadata> {
    return this.unavailable();
  }
}
