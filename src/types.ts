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
