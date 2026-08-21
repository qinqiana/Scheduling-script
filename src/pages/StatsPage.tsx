import { useEffect, useState } from "react";
import { api } from "../api";
import type { RosterPayload } from "../types";

export function StatsPage({
  year,
  month,
  setYear,
  setMonth,
  tick,
}: {
  year: number;
  month: number;
  setYear: (n: number) => void;
  setMonth: (n: number) => void;
  tick: number;
}) {
  const [data, setData] = useState<RosterPayload | null>(null);

  useEffect(() => {
    void api.roster(year, month).then(setData);
  }, [year, month, tick]);

  const nightDiff = (() => {
    if (!data?.stats.people.length) return 0;
    const byGroup = new Map<string, number[]>();
    for (const p of data.stats.people) {
      const list = byGroup.get(p.groupName) ?? [];
      list.push(p.night);
      byGroup.set(p.groupName, list);
    }
    let best = 0;
    for (const nights of byGroup.values()) {
      if (nights.length < 2) continue;
      best = Math.max(best, Math.max(...nights) - Math.min(...nights));
    }
    return best;
  })();
  const generated = data?.generated === true;
  const gaps = generated ? (data?.stats.days.filter((d) => d.gap) ?? []) : [];

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>统计</h1>
          <p className="hint">
            看出勤、早/晚、周末次数、连班、加班和缺口。无请假无特殊加班时每人休息天数相同。放假日按国务院通知全员休息，调休上班日算法定工作日。无请假时目标为所选{" "}
            {year} 年 {month} 月法定工作日
            {data
              ? ` ${data.cells.filter((c) => c.kind === "workday" || c.kind === "makeup").length} 天`
              : "（按该自然月自动识别）"}
            。格子上的加班 / 补休会加减应出勤，其它规则不变。
          </p>
        </div>
        <div className="actions">
          <label className="field">
            年
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <label className="field">
            月
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} 月
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="legend">
        <span>同组每人晚班极差 {nightDiff} 天（上限 {data?.settings.maxNightDiff ?? 3}）</span>
        <span>缺口天数 {gaps.length}</span>
        <span>硬冲突 {generated ? (data?.conflicts.filter((c) => c.severity === "hard").length ?? 0) : 0}</span>
      </div>

      <div className="card">
        <table className="list">
          <thead>
            <tr>
              <th>姓名</th>
              <th>组别</th>
              <th>出勤</th>
              <th>目标</th>
              <th>早班</th>
              <th>晚班</th>
              <th>周末</th>
              <th>节假日</th>
              <th>休息</th>
              <th>请假</th>
              <th>加班</th>
              <th>最长连班</th>
              <th>单周最多</th>
            </tr>
          </thead>
          <tbody>
            {data?.stats.people.map((p) => (
              <tr key={p.personId}>
                <td>{p.name}</td>
                <td>{p.groupName}</td>
                <td>{p.workDays}</td>
                <td>{p.targetDays}</td>
                <td>{p.morning}</td>
                <td>{p.night}</td>
                <td>{p.weekendWork}</td>
                <td>{p.holidayWork}</td>
                <td>{p.restDays}</td>
                <td>{p.leaveDays}</td>
                <td>{p.overtimeDays}</td>
                <td style={{ color: p.maxConsecutive > (data.settings.maxConsecutiveWork) ? "#b42318" : undefined }}>
                  {p.maxConsecutive}
                </td>
                <td style={{ color: p.maxWeekWork > data.settings.maxWorkPerWeek ? "#8a2b12" : undefined }}>
                  {p.maxWeekWork}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <strong>每日覆盖</strong>
          <table className="list">
            <thead>
              <tr>
                <th>日期</th>
                <th>出勤</th>
                <th>早</th>
                <th>晚</th>
                <th>缺口</th>
              </tr>
            </thead>
            <tbody>
              {data?.stats.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date.slice(8)}</td>
                  <td>{d.totalWork}</td>
                  <td>{d.totalMorning}</td>
                  <td>{d.totalNight}</td>
                  <td>{d.gap ? "是" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <strong>冲突清单</strong>
          <ul className="conflict-list">
            {(!generated || (data?.conflicts.length ?? 0) === 0) && <li>当前没有冲突</li>}
            {generated &&
              data?.conflicts.map((c) => (
                <li key={c.message} className={c.severity}>
                  {c.severity === "hard" ? "硬 · " : "软 · "}
                  {c.message}
                </li>
              ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
