import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express from "express";
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
import { clearMonth, currentRoster, generateRoster, persistGenerated } from "./engine.ts";
import { exportWorkbook } from "./excel.ts";
import { distDir } from "./paths.ts";

const PORT = Number(process.env.PORT ?? 8787);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  const next = { ...DEFAULT_SETTINGS, ...getSettings(), ...req.body } as Settings;
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
  if (!date || !name || !kind) {
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
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const rows = queryAll<{ id: number; person_id: number; date: string; reason: string }>(
    "SELECT id, person_id, date, reason FROM leaves WHERE date LIKE ? ORDER BY date, person_id",
    [`${prefix}-%`],
  );
  res.json(rows.map((r) => ({ id: r.id, personId: r.person_id, date: r.date, reason: r.reason })));
});

app.post("/api/leaves", (req, res) => {
  const { personId, date, reason = "" } = req.body ?? {};
  if (!personId || !date) {
    res.status(400).json({ error: "人员和日期必填" });
    return;
  }
  runMany(() => {
    execSql(
      "INSERT INTO leaves (person_id, date, reason) VALUES (?, ?, ?) ON CONFLICT(person_id, date) DO UPDATE SET reason = excluded.reason",
      [personId, date, reason],
    );
    execSql("DELETE FROM assignments WHERE person_id = ? AND date = ?", [personId, date]);
    execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ?", [personId, date]);
    execSql("DELETE FROM rest_wishes WHERE person_id = ? AND date = ?", [personId, date]);
  });
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
  if (!year || !month) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  res.json(currentRoster(year, month));
});

app.post("/api/roster/generate", (req, res) => {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  const keepLocked = req.body?.keepLocked !== false;
  if (!year || !month) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  const seed = Number(req.body?.seed);
  const result = generateRoster({
    year,
    month,
    keepLocked,
    seed: Number.isFinite(seed) && seed ? seed : undefined,
  });
  persistGenerated(year, month, result.roster, keepLocked);
  res.json(result);
});

app.post("/api/roster/clear", (req, res) => {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  if (!year || !month) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  clearMonth(year, month, req.body?.all === true || req.body?.includeFlags === true);
  res.json(currentRoster(year, month));
});

app.put("/api/roster/wish", (req, res) => {
  const { personId, date, want } = req.body ?? {};
  if (!personId || !date) {
    res.status(400).json({ error: "人员和日期必填" });
    return;
  }
  const leave = queryOne("SELECT id FROM leaves WHERE person_id = ? AND date = ?", [personId, date]);
  const flag = queryOne<{ kind: string }>(
    "SELECT kind FROM attendance_flags WHERE person_id = ? AND date = ?",
    [personId, date],
  );
  runMany(() => {
    if (want) {
      execSql(
        "INSERT INTO rest_wishes (person_id, date) VALUES (?, ?) ON CONFLICT(person_id, date) DO NOTHING",
        [personId, date],
      );
      if (!leave && flag?.kind !== "overtime") {
        const locked = queryOne<{ locked: number }>(
          "SELECT locked FROM assignments WHERE person_id = ? AND date = ?",
          [personId, date],
        );
        if (!locked?.locked) {
          execSql(
            `INSERT INTO assignments (person_id, date, shift, locked)
             VALUES (?, ?, '休', 0)
             ON CONFLICT(person_id, date) DO UPDATE SET shift = '休'`,
            [personId, date],
          );
        }
      }
    } else {
      execSql("DELETE FROM rest_wishes WHERE person_id = ? AND date = ?", [personId, date]);
    }
  });
  const [year, month] = String(date).split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.put("/api/roster/cell", (req, res) => {
  const { personId, date, shift, locked } = req.body ?? {};
  if (!personId || !date || !shift) {
    res.status(400).json({ error: "人员、日期、班次必填" });
    return;
  }
  if (!["早", "晚", "休"].includes(shift)) {
    res.status(400).json({ error: "班次只能是 早 / 晚 / 休" });
    return;
  }
  const leave = queryOne("SELECT id FROM leaves WHERE person_id = ? AND date = ?", [personId, date]);
  if (leave) {
    res.status(400).json({ error: "该日已请假，先撤销请假再改班" });
    return;
  }
  const flag = queryOne<{ kind: string }>(
    "SELECT kind FROM attendance_flags WHERE person_id = ? AND date = ?",
    [personId, date],
  );
  const lock = Boolean(locked) || flag?.kind === "overtime";
  runMany(() => {
    execSql(
      `INSERT INTO assignments (person_id, date, shift, locked)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(person_id, date) DO UPDATE SET shift = excluded.shift, locked = excluded.locked`,
      [personId, date, shift, lock ? 1 : 0],
    );
    if (shift === "休") {
      execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ? AND kind = 'overtime'", [
        personId,
        date,
      ]);
    } else {
      execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ? AND kind = 'comp_rest'", [
        personId,
        date,
      ]);
    }
  });
  const [year, month] = date.split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.post("/api/roster/cell/clear", (req, res) => {
  const { personId, date } = req.body ?? {};
  if (!personId || !date) {
    res.status(400).json({ error: "人员和日期必填" });
    return;
  }
  const leave = queryOne("SELECT id FROM leaves WHERE person_id = ? AND date = ?", [personId, date]);
  if (leave) {
    res.status(400).json({ error: "该日已请假，先撤销请假再清空" });
    return;
  }
  runMany(() => {
    execSql("DELETE FROM assignments WHERE person_id = ? AND date = ?", [personId, date]);
    execSql("DELETE FROM rest_wishes WHERE person_id = ? AND date = ?", [personId, date]);
    execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ?", [personId, date]);
  });
  const [year, month] = String(date).split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.put("/api/roster/flag", (req, res) => {
  const { personId, date, kind } = req.body ?? {};
  if (!personId || !date) {
    res.status(400).json({ error: "人员和日期必填" });
    return;
  }
  if (kind != null && kind !== "overtime" && kind !== "comp_rest") {
    res.status(400).json({ error: "标记只能是加班或补休" });
    return;
  }
  const leave = queryOne("SELECT id FROM leaves WHERE person_id = ? AND date = ?", [personId, date]);
  if (leave) {
    res.status(400).json({ error: "该日已请假，先撤销请假再改" });
    return;
  }
  runMany(() => {
    execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ?", [personId, date]);
    if (kind === "overtime") {
      execSql("DELETE FROM rest_wishes WHERE person_id = ? AND date = ?", [personId, date]);
      execSql("INSERT INTO attendance_flags (person_id, date, kind) VALUES (?, ?, 'overtime')", [
        personId,
        date,
      ]);
      const cur = queryOne<{ shift: string; locked: number }>(
        "SELECT shift, locked FROM assignments WHERE person_id = ? AND date = ?",
        [personId, date],
      );
      if (cur && (cur.shift === "早" || cur.shift === "晚")) {
        execSql("UPDATE assignments SET locked = 1 WHERE person_id = ? AND date = ?", [
          personId,
          date,
        ]);
      } else {
        execSql(
          `INSERT INTO assignments (person_id, date, shift, locked)
           VALUES (?, ?, '早', 1)
           ON CONFLICT(person_id, date) DO UPDATE SET shift = '早', locked = 1`,
          [personId, date],
        );
      }
    } else if (kind === "comp_rest") {
      execSql("INSERT INTO attendance_flags (person_id, date, kind) VALUES (?, ?, 'comp_rest')", [
        personId,
        date,
      ]);
      const locked = queryOne<{ locked: number }>(
        "SELECT locked FROM assignments WHERE person_id = ? AND date = ?",
        [personId, date],
      );
      if (!locked?.locked) {
        execSql(
          `INSERT INTO assignments (person_id, date, shift, locked)
           VALUES (?, ?, '休', 0)
           ON CONFLICT(person_id, date) DO UPDATE SET shift = '休'`,
          [personId, date],
        );
      }
    }
  });
  const [year, month] = String(date).split("-").map(Number);
  res.json(currentRoster(year, month));
});

app.get("/api/export", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) {
    res.status(400).json({ error: "需要 year 和 month" });
    return;
  }
  const data = currentRoster(year, month);
  const { buffer, filename } = await exportWorkbook(data, year, month);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
});

app.get("/api/backup", (_req, res) => {
  persist();
  const bak = `${getDbPath()}.bak`;
  backupTo(bak);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=data.db");
  res.send(readFileSync(getDbPath()));
});

app.post("/api/restore", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) {
    res.status(400).json({ error: "请上传 data.db" });
    return;
  }
  restoreFrom(req.file.buffer);
  await getDb();
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

export async function startServer(preferredPort = PORT): Promise<number> {
  await getDb();
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
  console.log(`入网审核排班  http://127.0.0.1:${actual}`);
  return actual;
}

if (!process.env.ELECTRON_RUN) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
