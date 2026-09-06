import { editCell } from "./cellState.ts";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { DEFAULT_SETTINGS, type Person, type Settings } from "../shared/types.ts";
import {
  backupTo,
  execSql,
  getDb,
  getDbPath,
  getSettings,
  persist,
  queryAll,
  queryOne,
  restoreFrom,
  run,
  runMany,
  saveSettings,
} from "./db.ts";
import { clearMonth, currentRoster } from "./engine.ts";
import { activeJob, cancelGeneration, getJob, startGeneration } from "./generationJobs.ts";
import { importRosterFromExcel } from "./importRoster.ts";
import { exportWorkbook } from "./excel.ts";
import { distDir, templatesDir } from "./paths.ts";
import { validDate, validMonth, validateSettings } from "./validation.ts";
import { InstanceInUse, setInstancePort } from "./instance.ts";

const PORT = Number(process.env.PORT ?? 8787);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export const app = express();
// 界面通过同源请求（开发时走 Vite 代理）访问本地数据。
app.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  if (origin && origin !== `http://${req.get("host")}`) {
    res.status(403).json({ error: "不允许其他网站访问本地排班数据" });
    return;
  }
  next();
});
app.use(express.json({ limit: "4mb" }));
app.use("/api", (req, res, next) => {
  const body = req.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "请求内容必须为对象" });
    return;
  }
  if (body.date !== undefined && !validDate(body.date)) {
    res.status(400).json({ error: "日期必须为有效的 YYYY-MM-DD" });
    return;
  }
  if (body.personId !== undefined && (!Number.isSafeInteger(body.personId) || body.personId < 1 ||
    !queryOne("SELECT id FROM people WHERE id = ?", [body.personId]))) {
    res.status(400).json({ error: "人员不存在或编号无效" });
    return;
  }
  for (const key of ["locked", "want", "active", "canNight", "all", "includeFlags"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      res.status(400).json({ error: `${key} 必须为布尔值` });
      return;
    }
  }
  for (const key of ["name", "groupName"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !body[key].trim()) {
        res.status(400).json({ error: "姓名、组别或名称不能为空" });
        return;
      }
      body[key] = body[key].trim();
    }
  }
  if (body.targetDays != null && (!Number.isInteger(body.targetDays) || body.targetDays < 0 || body.targetDays > 31)) {
    res.status(400).json({ error: "目标出勤天数须为 0～31 的整数" });
    return;
  }
  if (body.sortOrder !== undefined && !Number.isSafeInteger(body.sortOrder)) {
    res.status(400).json({ error: "排序须为整数" });
    return;
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    res.status(400).json({ error: "请假原因须为文字" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  const next = { ...DEFAULT_SETTINGS, ...getSettings(), ...req.body } as Settings;
  try {
    validateSettings(next);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  res.json(saveSettings(next));
});

app.get("/api/people", (_req, res) => {
  const rows = queryAll<{
    id: number;
    name: string;
    group_name: string;
    active: number;
    target_days: number | null;
    can_night: number;
    sort_order: number;
  }>("SELECT * FROM people ORDER BY sort_order, id");
  res.json(
    rows.map(
      (r): Person => ({
        id: r.id,
        name: r.name,
        groupName: r.group_name,
        active: r.active === 1,
        targetDays: r.target_days,
        canNight: r.can_night === 1,
        sortOrder: r.sort_order,
      }),
    ),
  );
});

app.post("/api/people", (req, res) => {
  const { name, groupName, active = true, targetDays = null, canNight = true } = req.body ?? {};
  if (!name || !groupName) {
    res.status(400).json({ error: "姓名和组别必填" });
    return;
  }
  const max = queryOne<{ n: number }>("SELECT COALESCE(MAX(sort_order), 0) AS n FROM people");
  run(
    "INSERT INTO people (name, group_name, active, target_days, can_night, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    [String(name).trim(), String(groupName).trim(), active ? 1 : 0, targetDays, canNight ? 1 : 0, (max?.n ?? 0) + 1],
  );
  const row = queryOne<{ id: number }>("SELECT last_insert_rowid() AS id");
  res.json({ id: row?.id });
});

app.put("/api/people/:id", (req, res) => {
  const id = Number(req.params.id);
  const cur = queryOne<{ id: number }>("SELECT id FROM people WHERE id = ?", [id]);
  if (!cur) {
    res.status(404).json({ error: "人员不存在" });
    return;
  }
  const { name, groupName, active, targetDays, canNight, sortOrder } = req.body ?? {};
  run(
    `UPDATE people SET
      name = COALESCE(?, name),
      group_name = COALESCE(?, group_name),
      active = COALESCE(?, active),
      target_days = ?,
      can_night = COALESCE(?, can_night),
      sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [
      name ?? null,
      groupName ?? null,
      active === undefined ? null : active ? 1 : 0,
      targetDays === undefined ? queryOne<{ target_days: number | null }>("SELECT target_days FROM people WHERE id = ?", [id])?.target_days ?? null : targetDays,
      canNight === undefined ? null : canNight ? 1 : 0,
      sortOrder ?? null,
      id,
    ],
  );
  res.json({ ok: true });
});

app.delete("/api/people/:id", (req, res) => {
  const id = Number(req.params.id);
  runMany(() => {
    execSql("DELETE FROM assignments WHERE person_id = ?", [id]);
    execSql("DELETE FROM leaves WHERE person_id = ?", [id]);
    execSql("DELETE FROM rest_wishes WHERE person_id = ?", [id]);
    execSql("DELETE FROM attendance_flags WHERE person_id = ?", [id]);
    execSql("DELETE FROM people WHERE id = ?", [id]);
  });
  res.json({ ok: true });
});

app.post("/api/people/import", (req, res) => {
  const lines = String(req.body?.csv ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    res.status(400).json({ error: "空表格" });
    return;
  }
  const header = lines[0];
  const start = /姓名/.test(header) ? 1 : 0;
  if (lines.slice(start).some((line) => {
    const [name, groupName, target] = line.split(/[,，\t]/).map((s) => s.trim());
    return name && groupName && target && (!Number.isInteger(Number(target)) || Number(target) < 0 || Number(target) > 31);
  })) {
    res.status(400).json({ error: "目标出勤天数须为 0～31 的整数" });
    return;
  }
  let added = 0;
  runMany(() => {
    const max = queryOne<{ n: number }>("SELECT COALESCE(MAX(sort_order), 0) AS n FROM people");
    let order = max?.n ?? 0;
    for (const line of lines.slice(start)) {
      const parts = line.split(/[,，\t]/).map((s) => s.trim());
      const [name, groupName, target] = parts;
      if (!name || !groupName) continue;
      const exists = queryOne<{ id: number }>("SELECT id FROM people WHERE name = ?", [name]);
      if (exists) {
        execSql("UPDATE people SET group_name = ?, target_days = ? WHERE id = ?", [
          groupName,
          target ? Number(target) : null,
          exists.id,
        ]);
      } else {
        order += 1;
        execSql(
          "INSERT INTO people (name, group_name, active, target_days, can_night, sort_order) VALUES (?, ?, 1, ?, 1, ?)",
          [name, groupName, target ? Number(target) : null, order],
        );
        added += 1;
      }
    }
  });
  res.json({ added });
});

app.get("/api/holidays", (req, res) => {
  const year = req.query.year ? String(req.query.year) : undefined;
  const rows = year
    ? queryAll("SELECT date, name, kind FROM holidays WHERE date LIKE ? ORDER BY date", [`${year}-%`])
    : queryAll("SELECT date, name, kind FROM holidays ORDER BY date");
  res.json(rows);
});

app.post("/api/holidays", (req, res) => {
  const { date, name, kind } = req.body ?? {};
  if (!date || !name || !["holiday", "bridge", "workday_makeup"].includes(kind)) {
    res.status(400).json({ error: "日期、名称、类型必填" });
    return;
  }
  run(
    "INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name, kind = excluded.kind",
    [date, name, kind],
  );
  res.json({ ok: true });
});

app.delete("/api/holidays/:date", (req, res) => {
  run("DELETE FROM holidays WHERE date = ?", [req.params.date]);
  res.json({ ok: true });
});

app.get("/api/leaves", (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!validMonth(year, month)) {
    res.status(400).json({ error: "需要有效的 year 和 month" });
    return;
  }
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const rows = queryAll<{ id: number; person_id: number; date: string; reason: string }>(
    "SELECT id, person_id, date, reason FROM leaves WHERE date LIKE ? ORDER BY date, person_id",
    [`${prefix}-%`],
  );
  res.json(rows.map((r) => ({ id: r.id, personId: r.person_id, date: r.date, reason: r.reason })));
});

app.post("/api/leaves", (req, res) => {
  const { personId, date, reason = "" } = req.body ?? {};
  if (!personId || !date) { res.status(400).json({ error: "人员和日期必填" }); return; }
  editCell(personId, date, { type: "leave", reason });
  res.json({ ok: true });
});

app.delete("/api/leaves/cell/:personId/:date", (req, res) => {
  run("DELETE FROM leaves WHERE person_id = ? AND date = ?", [
    Number(req.params.personId),
    req.params.date,
  ]);
  res.json({ ok: true });
});

app.delete("/api/leaves/:id", (req, res) => {
  run("DELETE FROM leaves WHERE id = ?", [Number(req.params.id)]);
  res.json({ ok: true });
});

app.get("/api/roster", (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!validMonth(year, month)) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  res.json(currentRoster(year, month));
});

app.post("/api/roster/generate", (req, res) => {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  if (!validMonth(year, month)) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  const seed = Number(req.body?.seed);
  const job = startGeneration({
    year,
    month,
    seed: Number.isFinite(seed) && seed ? seed : undefined,
  });
  res.status(202).json(job);
});

app.get("/api/roster/jobs/active", (_req, res) => res.json(activeJob() ?? null));
app.get("/api/roster/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: "生成任务不存在，请刷新班表" }); return; }
  res.json(job);
});
app.delete("/api/roster/jobs/:id", (req, res) => {
  if (!cancelGeneration(req.params.id)) { res.status(409).json({ error: "任务已结束" }); return; }
  res.json({ ok: true });
});

app.post("/api/roster/clear", (req, res) => {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  if (!validMonth(year, month)) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  clearMonth(year, month, req.body?.all === true || req.body?.includeFlags === true);
  res.json(currentRoster(year, month));
});

app.post("/api/roster/import", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) {
    res.status(400).json({ error: "请上传考勤表 xlsx" });
    return;
  }
  try {
    const result = await importRosterFromExcel(
      req.file.buffer,
      req.body?.year,
      req.body?.month,
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "导入失败" });
  }
});

app.put("/api/roster/wish", (req, res) => {
  const { personId, date, want } = req.body ?? {};
  if (!personId || !date || typeof want !== "boolean") { res.status(400).json({ error: "人员、日期和想休状态必填" }); return; }
  editCell(personId, date, { type: "wish", want });
  const [year, month] = date.split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.put("/api/roster/cell", (req, res) => {
  const { personId, date, shift, locked } = req.body ?? {};
  if (!personId || !date || !["早", "晚", "休"].includes(shift) || typeof locked !== "boolean") {
    res.status(400).json({ error: "人员、日期、班次和锁定状态必填" }); return;
  }
  editCell(personId, date, { type: "shift", shift, locked });
  const [year, month] = date.split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.post("/api/roster/cell/clear", (req, res) => {
  const { personId, date } = req.body ?? {};
  if (!personId || !date) { res.status(400).json({ error: "人员和日期必填" }); return; }
  editCell(personId, date, { type: "clear" });
  const [year, month] = date.split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.put("/api/roster/flag", (req, res) => {
  const { personId, date, kind } = req.body ?? {};
  if (!personId || !date || ![null, "overtime", "comp_rest"].includes(kind)) {
    res.status(400).json({ error: "人员、日期和有效加班补休状态必填" }); return;
  }
  editCell(personId, date, { type: "flag", kind });
  const [year, month] = date.split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.get("/api/export", async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!validMonth(year, month)) {
      res.status(400).json({ error: "需要 year 和 month" });
      return;
    }
    const data = currentRoster(year, month);
    const { buffer, filename } = await exportWorkbook(data, year, month);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/backup", (_req, res) => {
  persist();
  const bak = `${getDbPath()}.bak`;
  backupTo(bak);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=data.db");
  res.send(readFileSync(getDbPath()));
});

app.get("/api/roster/import-template", (_req, res) => {
  const file = join(templatesDir(), "考勤表导入模板.xlsx");
  if (!existsSync(file)) {
    res.status(404).json({ error: "考勤表导入模板不存在" });
    return;
  }
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent("考勤表导入模板.xlsx")}`,
  );
  res.send(readFileSync(file));
});

app.post("/api/restore", upload.single("file"), (req, res) => {
  if (!req.file?.buffer) {
    res.status(400).json({ error: "请上传 data.db" });
    return;
  }
  try {
    restoreFrom(req.file.buffer);
  } catch {
    res.status(400).json({ error: "备份无效或恢复失败，原数据已保留" });
    return;
  }
  res.json({ ok: true });
});

const dist = distDir();
app.use(express.static(dist));
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "接口不存在" });
    return;
  }
  const indexFile = join(dist, "index.html");
  if (existsSync(indexFile)) {
    res.sendFile(indexFile);
    return;
  }
  res.status(503).type("html").send(`<!doctype html><meta charset="utf-8"><p>界面尚未打包。请先运行启动脚本或执行 npm run build。</p>`);
});

const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error instanceof multer.MulterError
    ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
    : [400, 409, 413, 422].includes(error.status) ? error.status : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 413 ? "上传内容过大" : error.type === "entity.parse.failed" ? "请求内容无效" : status !== 500 ? error.message : "操作失败，请检查服务日志" });
};
app.use(handleError);

export async function startServer(preferredPort = PORT): Promise<number> {
  try { await getDb(); } catch (error) {
    if (error instanceof InstanceInUse && error.existingPort) {
      console.log(error.message);
      openBrowser(error.existingPort);
      return error.existingPort;
    }
    throw error;
  }
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer(app);
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) {
          void listen(0).then(resolve, reject);
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
  const actual = await listen(preferredPort);
  setInstancePort(actual);
  console.log(`入网审核排班 1.9.2  http://127.0.0.1:${actual}`);
  openBrowser(actual);
  return actual;
}

function openBrowser(port: number): void {
  if (process.env.ROSTER_OPEN_BROWSER !== "1") return;
  const url = `http://127.0.0.1:${port}/`;
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`请手动打开 ${url}`));
  child.unref();
}

if (!process.env.ELECTRON_RUN) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
