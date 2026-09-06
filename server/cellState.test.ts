import "./testDir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { getDb, queryOne } from "./db.ts";
import { editCell, readCellState, transitionCell, type CellAction, type CellState } from "./cellState.ts";
import { clearMonth, currentRoster } from "./engine.ts";
import { importRosterFromExcel } from "./importRoster.ts";

test("标记转换矩阵始终一致；请假保护；取消标记释放锁定", () => {
  const actions: CellAction[] = [
    { type: "shift", shift: "早", locked: false }, { type: "shift", shift: "晚", locked: true },
    { type: "shift", shift: "休", locked: false }, { type: "wish", want: true }, { type: "wish", want: false },
    { type: "flag", kind: "overtime" }, { type: "flag", kind: "comp_rest" }, { type: "flag", kind: null },
    { type: "leave", reason: "" }, { type: "clear" },
  ];
  const blank: CellState = { locked: false, wish: false };
  for (const first of actions) for (const second of actions) {
    const before = transitionCell(blank, first);
    if ((before.leave !== undefined && second.type !== "leave") || (before.flag && second.type === "shift" && !second.locked &&
      ((second.shift === "休" && before.flag === "comp_rest") || (second.shift !== "休" && before.flag === "overtime")))) {
      assert.throws(() => transitionCell(before, second)); continue;
    }
    const next = transitionCell(before, second);
    if (next.wish) assert.ok(next.shift === "休" && next.locked && !next.flag);
    if (next.flag) assert.ok(next.locked && !next.wish);
    if (next.flag === "overtime") assert.ok(next.shift === "早" || next.shift === "晚");
    if (next.flag === "comp_rest") assert.equal(next.shift, "休");
    if (next.leave !== undefined) assert.ok(!next.shift && !next.flag && !next.wish);
  }
});

test("界面、导入、清空后的数据库状态与显示一致", async () => {
  await getDb();
  const p = queryOne<{ id: number; name: string }>("SELECT id,name FROM people LIMIT 1")!;
  const date = "2026-09-01";
  editCell(p.id, date, { type: "wish", want: true });
  editCell(p.id, date, { type: "shift", shift: "晚", locked: true });
  assert.equal(readCellState(p.id, date).wish, false);
  editCell(p.id, date, { type: "flag", kind: "comp_rest" });
  assert.equal(readCellState(p.id, date).shift, "休");
  clearMonth(2026, 9);
  assert.equal(readCellState(p.id, date).flag, "comp_rest");
  const cell = currentRoster(2026, 9).roster.find((c) => c.personId === p.id && c.date === date)!;
  assert.ok(cell.compRest && cell.mark === "休");
  const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet("导入");
  sheet.getCell("C2").value = 1; sheet.getCell("B3").value = p.name;
  for (const [text, expected] of [["加班", "overtime"], ["补休", "comp_rest"]] as const) {
    sheet.getCell("C3").value = text;
    await importRosterFromExcel(Buffer.from(await wb.xlsx.writeBuffer()), 2026, 9);
    const state = readCellState(p.id, date);
    assert.equal(state.flag, expected); assert.ok(state.locked); assert.equal(state.wish, false);
  }
  editCell(p.id, date, { type: "flag", kind: null });
  assert.equal(readCellState(p.id, date).locked, false);
  clearMonth(2026, 9, true);
  assert.equal(readCellState(p.id, date).shift, undefined);
});
