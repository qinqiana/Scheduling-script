import { DEFAULT_SETTINGS, type Settings } from "../shared/types.ts";

export function validMonth(year: number, month: number): boolean {
  return Number.isInteger(year) && year >= 1000 && year <= 9999 &&
    Number.isInteger(month) && month >= 1 && month <= 12;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return validMonth(year, month) && day >= 1 && day <= new Date(year, month, 0).getDate();
}

export function validateSettings(settings: Settings): void {
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = settings[key];
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof value !== typeof fallback) throw new Error(`规则 ${key} 类型不正确`);
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`规则 ${key} 必须为非负整数`);
    }
    if (typeof value === "string" && !value.trim()) throw new Error(`规则 ${key} 不能为空`);
  }
  if (settings.maxWorkPerWeek < 1 || settings.maxWorkPerWeek > 7) throw new Error("每周工作天数须为 1～7");
  if (settings.maxConsecutiveWork < 1 || settings.maxConsecutiveWork > 31) throw new Error("连续工作天数须为 1～31");
  if (settings.sheetName.length > 31 || /[\\/*?:\[\]]/.test(settings.sheetName) || /^'|'$/.test(settings.sheetName)) {
    throw new Error("工作表名称不能超过 31 字，也不能包含 Excel 禁用字符");
  }
}
