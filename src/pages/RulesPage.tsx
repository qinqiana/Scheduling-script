import { useEffect, useState } from "react";
import { api } from "../api";
import type { Holiday, Leave, Person, Settings } from "../types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function legalWorkDaysOfMonth(year: number, month: number, holidays: Holiday[]): number {
  const map = new Map(holidays.map((h) => [h.date, h]));
  const n = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= n; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const weekday = new Date(year, month - 1, day).getDay();
    const h = map.get(date);
    let kind: "workday" | "weekend" | "holiday" | "makeup" = weekday === 0 || weekday === 6 ? "weekend" : "workday";
    if (h?.kind === "holiday") kind = "holiday";
    if (h?.kind === "workday_makeup") kind = "makeup";
    if (kind === "workday" || kind === "makeup") count += 1;
  }
  return count;
}

export function RulesPage({
  year,
  month,
  setMonth,
  onChange,
}: {
  year: number;
  month: number;
  setMonth: (n: number) => void;
  onChange: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [h, setH] = useState({ date: "", name: "", kind: "holiday" as Holiday["kind"] });
  const [leave, setLeave] = useState({ personId: 0, date: "", reason: "" });
  const [msg, setMsg] = useState("");

  const load = async () => {
    const [s, hs, ps, ls] = await Promise.all([
      api.settings(),
      api.holidays(year),
      api.people(),
      api.leaves(year, month),
    ]);
    setSettings(s);
    setHolidays(hs);
    setPeople(ps);
    setLeaves(ls);
    if (!leave.personId && ps[0]) setLeave((x) => ({ ...x, personId: ps[0].id }));
  };

  useEffect(() => {
    void load();
  }, [year, month]);

  const save = async () => {
    if (!settings) return;
    await api.saveSettings(settings);
    setMsg("规则已保存，下次生成生效");
    onChange();
  };

  if (!settings) return <p>加载规则…</p>;

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>规则与节假日</h1>
          <p className="hint">班次为早 / 晚 / 休，请假写假。覆盖优先，公平用权重。</p>
        </div>
        <button className="btn primary" onClick={() => void save()}>
          保存规则
        </button>
      </div>
      {msg && <div className="banner ok">{msg}</div>}

      <div className="grid-2">
        <div className="card form">
          <strong>硬约束 / 软约束</strong>
          <p className="hint">
            无请假时，每人每月出勤必须等于所选自然月的法定工作日（普通工作日，不含周末和 13 天法定节假日）。有请假则减去请假占用的法定工作日。
            {year} 年 {month} 月自动识别为 {legalWorkDaysOfMonth(year, month, holidays)} 天。
          </p>
          <label>
            每组每天最少出勤
            <input
              type="number"
              value={settings.minPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            每组每天最少早班
            <input
              type="number"
              value={settings.minMorningPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minMorningPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            每组每天最少晚班
            <input
              type="number"
              value={settings.minNightPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minNightPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            每周上班天数（满周默认这些天，超过记加班）
            <input
              type="number"
              value={settings.maxWorkPerWeek}
              onChange={(e) => setSettings({ ...settings, maxWorkPerWeek: Number(e.target.value) })}
            />
          </label>
          <label>
            最长连续上班
            <input
              type="number"
              value={settings.maxConsecutiveWork}
              onChange={(e) => setSettings({ ...settings, maxConsecutiveWork: Number(e.target.value) })}
            />
          </label>
          <label>
            每个人每月晚班与同组相差上限（硬，天）
            <input
              type="number"
              value={settings.maxNightDiff}
              onChange={(e) => setSettings({ ...settings, maxNightDiff: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={settings.weekendNeedWork}
                onChange={(e) => setSettings({ ...settings, weekendNeedWork: e.target.checked })}
              />{" "}
              周末必须有人（法定节假日不用上班）
            </span>
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={settings.noMorningAfterNight}
                onChange={(e) => setSettings({ ...settings, noMorningAfterNight: e.target.checked })}
              />{" "}
              晚班后不接早班（可休或再晚）
            </span>
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={settings.preferPairedRest}
                onChange={(e) => setSettings({ ...settings, preferPairedRest: e.target.checked })}
              />{" "}
              每周两天休息尽量连在一起（软，优先级最低）
            </span>
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={settings.nightRestRequired}
                onChange={(e) => setSettings({ ...settings, nightRestRequired: e.target.checked })}
              />{" "}
              晚班后强制休息（默认关，比「不接早班」更严）
            </span>
          </label>
          <label>
            导出表名
            <input value={settings.sheetName} onChange={(e) => setSettings({ ...settings, sheetName: e.target.value })} />
          </label>
        </div>

        <div>
          <div className="card">
            <strong>已对齐的业务规则</strong>
            <ul className="conflict-list">
              <li>班次写「早」「晚」「休」，请假写「假」。</li>
              <li>每组每天至少 1 个早班、1 个晚班（因此每天至少 2 人）。全年法定节假日共 13 天（元旦 1、春节 4、清明 1、劳动节 2、端午 1、中秋 1、国庆 3），这 13 天全员休息、不排班。国务院连休多放的日子按周末或工作日正常排班。</li>
              <li>无请假时，出勤必须等于所选月份的法定工作日（普通工作日，不含周末和上述 13 天）；有请假则减去请假占用的法定工作日。</li>
              <li>同一个自然周（周一至周日）默认上班 5 天、休息 2 天；周内的法定节假日不算应出勤。和其他硬约束冲突时可以多排，多出来的日期记加班。有请假则上班不超过 5 天。月初月末不足一周只限制不超过 5 天。</li>
              <li>晚班后不接早班，可休或再排晚班。</li>
              <li>每周两天休息尽量连在一起（软约束，覆盖和周 5 天优先）。</li>
              <li>同组每个人每月晚班数量相差不能超过 3 天（硬约束）。</li>
              <li>请假和锁定格子生成时不改。</li>
            </ul>
          </div>
          <div className="card form" style={{ marginTop: 12 }}>
            <strong>{year} 年法定节假日（全年 13 天）</strong>
            <div className="actions">
              <input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} />
              <input placeholder="名称" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
              <select value={h.kind} onChange={(e) => setH({ ...h, kind: e.target.value as Holiday["kind"] })}>
                <option value="holiday">放假</option>
                <option value="workday_makeup">调休上班</option>
              </select>
              <button
                className="btn"
                onClick={async () => {
                  await api.addHoliday(h);
                  await load();
                  onChange();
                }}
              >
                添加
              </button>
            </div>
            <table className="list">
              <tbody>
                {holidays.map((item) => (
                  <tr key={item.date}>
                    <td>{item.date}</td>
                    <td>{item.name}</td>
                    <td>{item.kind === "holiday" ? "放假" : "上班"}</td>
                    <td>
                      <button
                        className="btn danger"
                        onClick={async () => {
                          await api.deleteHoliday(item.date);
                          await load();
                          onChange();
                        }}
                      >
                        删
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="topbar">
          <strong>请假 / 调休</strong>
          <label className="field">
            月
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="actions" style={{ marginBottom: 10 }}>
          <select value={leave.personId} onChange={(e) => setLeave({ ...leave, personId: Number(e.target.value) })}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input type="date" value={leave.date} onChange={(e) => setLeave({ ...leave, date: e.target.value })} />
          <input placeholder="原因" value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} />
          <button
            className="btn"
            onClick={async () => {
              await api.addLeave(leave);
              await load();
              onChange();
            }}
          >
            登记
          </button>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>日期</th>
              <th>姓名</th>
              <th>原因</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leaves.map((item) => (
              <tr key={item.id}>
                <td>{item.date}</td>
                <td>{people.find((p) => p.id === item.personId)?.name ?? item.personId}</td>
                <td>{item.reason}</td>
                <td>
                  <button
                    className="btn danger"
                    onClick={async () => {
                      await api.deleteLeave(item.id);
                      await load();
                      onChange();
                    }}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
