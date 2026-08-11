import type {
  NormalizedRosterRow,
  RosterBatchMetadata,
  RosterValidationResult,
} from "@/features/roster/types";

export interface RosterSource<Input> {
  getSourceName(): string;
  load(input: Input): Promise<NormalizedRosterRow[]>;
  validate(rows: NormalizedRosterRow[]): Promise<RosterValidationResult>;
  createBatchMetadata(input: Input): Promise<RosterBatchMetadata>;
}
