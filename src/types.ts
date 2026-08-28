import type {
  Conflict,
  DayCover,
  Holiday,
  Leave,
  MonthCell,
  Person,
  PersonStat,
  RosterCell,
  Settings,
  ShiftMark,
} from "../shared/types";

export type PageId = "calendar" | "people" | "rules" | "stats";

export interface RosterPayload {
  people: Person[];
  cells: MonthCell[];
  roster: RosterCell[];
  conflicts: Conflict[];
  stats: { people: PersonStat[]; days: DayCover[] };
  settings: Settings;
  generated?: boolean;
}

export interface ImportResult {
  imported: number;
  shifts: number;
  leaves: number;
  overtimes: number;
  compRests: number;
  skippedUnknown: string[];
  unmatchedNames: string[];
  rosterCells: RosterPayload;
}

export type {
  Conflict,
  DayCover,
  Holiday,
  Leave,
  MonthCell,
  Person,
  PersonStat,
  RosterCell,
  Settings,
  ShiftMark,
};
