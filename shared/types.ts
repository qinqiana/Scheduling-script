export type ShiftMark = "早" | "晚" | "休" | "假";
export type WeekPref = "less" | "more" | "normal";
export type ConflictSeverity = "hard" | "soft";

export interface Settings {
  requiredWorkDays: number;
  maxNightDiff: number;
  maxConsecutiveWork: number;
  minPerGroupPerDay: number;
  minMorningPerGroupPerDay: number;
  minNightPerGroupPerDay: number;
  maxWorkPerWeek: number;
  leanStartDay: number;
  leanEndDay: number;
  busyAfterDay: number;
  monthEndNightAfterDay: number;
  monthEndExtraNights: number;
  weekendNeedWork: boolean;
  nightRestRequired: boolean;
  week2Preference: WeekPref;
  lastWeekPreference: WeekPref;
  title: string;
  sheetName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  requiredWorkDays: 23,
  maxNightDiff: 5,
  maxConsecutiveWork: 6,
  minPerGroupPerDay: 2,
  minMorningPerGroupPerDay: 1,
  minNightPerGroupPerDay: 1,
  maxWorkPerWeek: 5,
  leanStartDay: 10,
  leanEndDay: 20,
  busyAfterDay: 20,
  monthEndNightAfterDay: 20,
  monthEndExtraNights: 1,
  weekendNeedWork: true,
  nightRestRequired: false,
  week2Preference: "less",
  lastWeekPreference: "more",
  title: "外包-省综调（入网审核岗考勤）",
  sheetName: "外包-省综调（入网审核岗考勤）",
};

export interface Person {
  id: number;
  name: string;
  groupName: string;
  active: boolean;
  targetDays: number | null;
  canNight: boolean;
  sortOrder: number;
}

export interface Holiday {
  date: string;
  name: string;
  kind: "holiday" | "workday_makeup";
}

export interface Leave {
  id: number;
  personId: number;
  date: string;
  reason: string;
}

export interface Assignment {
  id: number;
  personId: number;
  date: string;
  shift: "早" | "晚" | "休";
  locked: boolean;
}

export interface Conflict {
  severity: ConflictSeverity;
  date?: string;
  personId?: number;
  groupName?: string;
  message: string;
}

export interface MonthCell {
  date: string;
  day: number;
  weekday: number;
  weekNum: number;
  kind: "workday" | "weekend" | "holiday" | "makeup";
  holidayName?: string;
}

export interface RosterCell {
  personId: number;
  date: string;
  mark: ShiftMark;
  locked: boolean;
  leaveReason?: string;
}

export interface PersonStat {
  personId: number;
  name: string;
  groupName: string;
  workDays: number;
  morning: number;
  night: number;
  weekendWork: number;
  holidayWork: number;
  restDays: number;
  leaveDays: number;
  maxConsecutive: number;
  maxWeekWork: number;
  targetDays: number;
}

export interface DayCover {
  date: string;
  groups: Record<string, { work: number; morning: number; night: number; gap: boolean }>;
  totalWork: number;
  totalMorning: number;
  totalNight: number;
  gap: boolean;
}
