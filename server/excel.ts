import { existsSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { MonthCell, Person, RosterCell, Settings } from "../shared/types.ts";
import { daysInMonth } from "./calendar.ts";
import type { currentRoster } from "./engine.ts";
import { templatesDir } from "./paths.ts";

const TEMPLATE_CANDIDATES = [
  join(templatesDir(), "考勤表模板.xlsx"),
  "d:\\个人文件\\项目\\排班\\考勤表模板.xlsx",
  "D:\\工作\\2026\\综调集中化\\考核绩效相关\\考勤表\\考勤表模板.xlsx",
];

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function findTemplate(): string | undefined {
  return TEMPLATE_CANDIDATES.find((p) => existsSync(p));
}

function headerDay(value: unknown): number | null {
  if (value == null) return null;
  let text = "";
  if (typeof value === "number") text = String(value);
  else if (typeof value === "string") text = value;
  else if (typeof value === "object" && value && "richText" in value) {
    text = (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
  } else if (typeof value === "object" && value && "result" in value) {
    text = String((value as ExcelJS.CellFormulaValue).result ?? "");
  } else {
    text = String(value);
  }
  const n = Number(text.trim().split(/\D/)[0]);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

function extraDayColumns(ws: ExcelJS.Worksheet, days: number): number[] {
  const found = new Map<number, number>();
  for (const rowNumber of [1, 2, 3]) {
    ws.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, col) => {
      const day = headerDay(cell.value);
      if (day != null && day > days && !found.has(day)) found.set(day, col);
    });
  }
  if (found.size === 0) {
    return Array.from({ length: 31 - days }, (_, i) => 4 + days + i);
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, col]) => col);
}

function removeExtraDayColumns(ws: ExcelJS.Worksheet, days: number): void {
  for (const col of extraDayColumns(ws, days)) {
    const column = ws.getColumn(col);
    column.hidden = true;
    column.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = null;
    });
  }
}

function excelMark(cell: RosterCell | undefined): string | undefined {
  if (!cell) return undefined;
  if (cell.compRest) return "补休";
  if (cell.overtime && (cell.mark === "早" || cell.mark === "晚")) return "加班";
  if (cell.mark === "早" || cell.mark === "晚" || cell.mark === "假" || cell.mark === "休") return cell.mark;
  return undefined;
}

function styleHeader(cell: ExcelJS.Cell): void {
  cell.font = { name: "微软雅黑", bold: true, size: 10 };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E2D6" } };
}

function thinBorder(cell: ExcelJS.Cell): void {
  cell.border = {
    top: { style: "thin", color: { argb: "FFB8B0A4" } },
    left: { style: "thin", color: { argb: "FFB8B0A4" } },
    bottom: { style: "thin", color: { argb: "FFB8B0A4" } },
    right: { style: "thin", color: { argb: "FFB8B0A4" } },
  };
}

async function fillExistingTemplate(
  templatePath: string,
  data: ReturnType<typeof currentRoster>,
  year: number,
  month: number,
): Promise<ExcelJS.Workbook | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const sheetName = data.settings.sheetName;
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  if (!ws) return null;

  const nameToRow = new Map<string, number>();
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < 3) return;
    const name = String(row.getCell(2).value ?? "").trim();
    if (name && name !== "合计") nameToRow.set(name, rowNumber);
  });

  const missing = data.people.filter((p) => !nameToRow.has(p.name));
  if (missing.length > 0) return null;

  for (const person of data.people) {
    const rowNumber = nameToRow.get(person.name);
    if (!rowNumber) continue;
    for (const cell of data.cells) {
      const col = 3 + cell.day;
      const mark = data.roster.find((r) => r.personId === person.id && r.date === cell.date);
      ws.getCell(rowNumber, col).value = excelMark(mark) ?? null;
    }
  }

  const title = ws.getCell(1, 1);
  if (typeof title.value === "string" || title.value == null) {
    title.value = `${data.settings.title} ${year}年${month}月`;
  }
  removeExtraDayColumns(ws, daysInMonth(year, month));
  return wb;
}

function buildWorkbook(
  data: ReturnType<typeof currentRoster>,
  year: number,
  month: number,
): ExcelJS.Workbook {
  const { people, cells, roster, stats, settings, conflicts } = data;
  const wb = new ExcelJS.Workbook();
  wb.creator = "入网审核排班";
  const sheet = wb.addWorksheet(settings.sheetName, {
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      paperSize: 9,
    },
  });

  const lastDateCol = 3 + cells.length;
  const attendCol = lastDateCol + 1;
  const morningCol = lastDateCol + 2;
  const nightCol = lastDateCol + 3;
  const lastCol = nightCol;
  const lastLetter = colLetter(lastCol);
  const dateStart = colLetter(4);
  const dateEnd = colLetter(lastDateCol);

  sheet.mergeCells(`A1:${lastLetter}1`);
  const title = sheet.getCell("A1");
  title.value = `${settings.title}  ${year}年${month}月`;
  title.font = { name: "微软雅黑", size: 16, bold: true };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 28;

  const headers = ["序号", "姓名", "支撑地市", ...cells.map((c) => c.day), "本月出勤", "早班", "晚班"];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(2, i + 1);
    cell.value = i >= 3 && i < 3 + cells.length ? `${h}\n${WEEKDAY[cells[i - 3].weekday]}` : h;
    styleHeader(cell);
    thinBorder(cell);
  });
  sheet.getRow(2).height = 32;

  const lookup = new Map<string, RosterCell>();
  for (const r of roster) lookup.set(`${r.personId}|${r.date}`, r);

  people.forEach((p, idx) => {
    const row = 3 + idx;
    sheet.getCell(row, 1).value = idx + 1;
    sheet.getCell(row, 2).value = p.name;
    sheet.getCell(row, 3).value = p.groupName;
    for (const c of cells) {
      const mark = lookup.get(`${p.id}|${c.date}`);
      const cell = sheet.getCell(row, 3 + c.day);
      cell.value = excelMark(mark) ?? null;
      if (mark?.mark === "休") {
        cell.font = { name: "微软雅黑", color: { argb: "FF6B6258" } };
      }
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (c.kind === "weekend" || c.kind === "bridge") {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EDE2" } };
      }
      if (c.kind === "holiday") {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8E4D4" } };
      }
      if (mark?.overtime) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8D0C0" } };
        cell.font = { name: "微软雅黑", color: { argb: "FF8A2B12" }, bold: true };
      } else if (mark?.mark === "晚") {
        cell.font = { name: "微软雅黑", color: { argb: "FF2A3A9A" }, bold: true };
      } else if (mark?.mark === "早") {
        cell.font = { name: "微软雅黑", color: { argb: "FF1B5E45" } };
      }
      if (mark?.mark === "假") {
        cell.font = { name: "微软雅黑", color: { argb: "FF9A4E12" } };
      }
    }
    sheet.getCell(row, attendCol).value = {
      formula: `COUNTIF(${dateStart}${row}:${dateEnd}${row},"早")+COUNTIF(${dateStart}${row}:${dateEnd}${row},"晚")+COUNTIF(${dateStart}${row}:${dateEnd}${row},"加班")+COUNTIF(${dateStart}${row}:${dateEnd}${row},"8")+COUNTIF(${dateStart}${row}:${dateEnd}${row},"*出差*")+COUNTIF(${dateStart}${row}:${dateEnd}${row},"*节加*")`,
    };
    sheet.getCell(row, morningCol).value = {
      formula: `COUNTIF(${dateStart}${row}:${dateEnd}${row},"早")`,
    };
    sheet.getCell(row, nightCol).value = {
      formula: `COUNTIF(${dateStart}${row}:${dateEnd}${row},"晚")`,
    };
    for (let col = 1; col <= lastCol; col += 1) {
      const cell = sheet.getCell(row, col);
      thinBorder(cell);
      cell.alignment = { ...cell.alignment, horizontal: cell.alignment?.horizontal ?? "center", vertical: "middle" };
      cell.font = cell.font?.color ? cell.font : { name: "微软雅黑", size: 10 };
    }
  });

  const firstData = 3;
  const lastData = 2 + people.length;
  const sumMorning = lastData + 1;
  const sumNight = lastData + 2;
  sheet.getCell(sumMorning, 2).value = "合计";
  sheet.getCell(sumMorning, 3).value = "早班";
  sheet.getCell(sumNight, 3).value = "晚班";
  for (const c of cells) {
    const letter = colLetter(3 + c.day);
    sheet.getCell(sumMorning, 3 + c.day).value = {
      formula: `COUNTIF(${letter}${firstData}:${letter}${lastData},"早")+COUNTIF(${letter}${firstData}:${letter}${lastData},"8")+COUNTIF(${letter}${firstData}:${letter}${lastData},"*出差*")+COUNTIF(${letter}${firstData}:${letter}${lastData},"*节加*")`,
    };
    sheet.getCell(sumNight, 3 + c.day).value = {
      formula: `COUNTIF(${letter}${firstData}:${letter}${lastData},"晚")`,
    };
  }
  sheet.getCell(sumMorning, attendCol).value = {
    formula: `SUM(${colLetter(attendCol)}${firstData}:${colLetter(attendCol)}${lastData})`,
  };

  for (const row of [sumMorning, sumNight]) {
    for (let col = 1; col <= lastCol; col += 1) {
      const cell = sheet.getCell(row, col);
      thinBorder(cell);
      styleHeader(cell);
    }
  }

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 12;
  for (let i = 0; i < cells.length; i += 1) sheet.getColumn(4 + i).width = 4.2;
  sheet.getColumn(attendCol).width = 10;
  sheet.getColumn(morningCol).width = 8;
  sheet.getColumn(nightCol).width = 8;
  sheet.views = [{ state: "frozen", xSplit: 3, ySplit: 2 }];

  addPersonSheet(wb, people, cells, roster, year, month);
  addStatsSheet(wb, stats, conflicts, settings, year, month);
  return wb;
}

function addPersonSheet(
  wb: ExcelJS.Workbook,
  people: Person[],
  cells: MonthCell[],
  roster: RosterCell[],
  year: number,
  month: number,
): void {
  const sheet = wb.addWorksheet("按人");
  sheet.addRow([`${year}年${month}月 个人班表`]);
  sheet.mergeCells(1, 1, 1, 5);
  sheet.addRow(["姓名", "组别", "日期", "星期", "班次"]);
  const lookup = new Map(roster.map((r) => [`${r.personId}|${r.date}`, r]));
  for (const p of people) {
    for (const c of cells) {
      const cell = lookup.get(`${p.id}|${c.date}`);
      const mark = excelMark(cell) ?? "";
      sheet.addRow([p.name, p.groupName, c.date, WEEKDAY[c.weekday], mark]);
    }
  }
  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 12;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 8;
  sheet.getColumn(5).width = 8;
}

function addStatsSheet(
  wb: ExcelJS.Workbook,
  stats: ReturnType<typeof currentRoster>["stats"],
  conflicts: ReturnType<typeof currentRoster>["conflicts"],
  settings: Settings,
  year: number,
  month: number,
): void {
  const sheet = wb.addWorksheet("统计");
  sheet.addRow([`${year}年${month}月 公平性统计`]);
  sheet.addRow([
    "姓名",
    "组别",
    "出勤",
    "目标",
    "早班",
    "晚班",
    "周末出勤",
    "节假日出勤",
    "休息",
    "请假",
    "加班",
    "最长连班",
  ]);
  for (const p of stats.people) {
    sheet.addRow([
      p.name,
      p.groupName,
      p.workDays,
      p.targetDays,
      p.morning,
      p.night,
      p.weekendWork,
      p.holidayWork,
      p.restDays,
      p.leaveDays,
      p.overtimeDays,
      p.maxConsecutive,
    ]);
  }
  sheet.addRow([]);
  sheet.addRow(["规则摘要", `每组每天≥${settings.minMorningPerGroupPerDay}早+${settings.minNightPerGroupPerDay}晚；月末最后三天每组最多休1人且至少2晚（法定假日除外）；放假日按国务院通知不排班，调休上班日算法定工作日；满自然周默认上班${settings.maxWorkPerWeek}天，和其他硬约束冲突时可多排但不再记加班；无请假无特殊加班时出勤=当月法定工作日且休息天数相同`]);
  sheet.addRow(["冲突"]);
  if (!conflicts.length) sheet.addRow(["无"]);
  for (const c of conflicts) sheet.addRow([c.severity === "hard" ? "硬" : "软", c.message]);
  [10, 12, 8, 8, 8, 8, 10, 12, 8, 8, 10].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

export async function exportWorkbook(
  data: ReturnType<typeof currentRoster>,
  year: number,
  month: number,
): Promise<{ buffer: Buffer; filename: string }> {
  const template = findTemplate();
  let wb: ExcelJS.Workbook | null = null;
  if (template) {
    try {
      wb = await fillExistingTemplate(template, data, year, month);
    } catch {
      wb = null;
    }
  }
  if (!wb) wb = buildWorkbook(data, year, month);
  else {
    addPersonSheet(wb, data.people, data.cells, data.roster, year, month);
    addStatsSheet(wb, data.stats, data.conflicts, data.settings, year, month);
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `入网审核排班-${year}年${month}月.xlsx` };
}

