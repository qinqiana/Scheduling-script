import { useEffect, useState } from "react";
import { api } from "../api";
import type { Holiday, Leave, Person, Settings } from "../types";

export function RulesPage({ year, onChange }: { year: number; onChange: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
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
          <label>
            默认出勤天数
            <input
              type="number"
              value={settings.requiredWorkDays}
              onChange={(e) => setSettings({ ...settings, requiredWorkDays: Number(e.target.value) })}
            />
          </label>
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
            每人每周最多上班
            <input
              type="number"
              value={settings.maxWorkPerWeek}
              onChange={(e) => setSettings({ ...settings, maxWorkPerWeek: Number(e.target.value) })}
            />
          </label>
          <label>
            少人区间（号）
            <span className="actions">
              <input
                type="number"
                value={settings.leanStartDay}
                onChange={(e) => setSettings({ ...settings, leanStartDay: Number(e.target.value) })}
              />
              <span>至</span>
              <input
                type="number"
                value={settings.leanEndDay}
                onChange={(e) => setSettings({ ...settings, leanEndDay: Number(e.target.value) })}
              />
            </span>
          </label>
          <label>
            此人日起加人
            <input
              type="number"
              value={settings.busyAfterDay}
              onChange={(e) => setSettings({ ...settings, busyAfterDay: Number(e.target.value) })}
            />
          </label>
          <label>
            此人日后多排晚班
            <input
              type="number"
              value={settings.monthEndNightAfterDay}
              onChange={(e) => setSettings({ ...settings, monthEndNightAfterDay: Number(e.target.value) })}
            />
          </label>
          <label>
            月末每组额外晚班
            <input
              type="number"
              value={settings.monthEndExtraNights}
              onChange={(e) => setSettings({ ...settings, monthEndExtraNights: Number(e.target.value) })}
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
            晚班极差上限（软）
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
              周末 / 节假日必须有人
            </span>
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={settings.nightRestRequired}
                onChange={(e) => setSettings({ ...settings, nightRestRequired: e.target.checked })}
              />{" "}
              晚班后强制休息（默认关，晚班不是通宵）
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
              <li>每组每天至少 1 个早班、1 个晚班（因此每天至少 2 人）。</li>
              <li>每人每个自然周（周一至周日）最多上班 5 天。</li>
              <li>10～20 号可以少人；20 号以后尽量多人。</li>
              <li>20 号以后每组在能留下早班的前提下多排晚班。</li>
              <li>晚班次数尽量均分；请假和锁定格子生成时不改。</li>
            </ul>
          </div>
          <div className="card form" style={{ marginTop: 12 }}>
            <strong>{year} 年节假日</strong>
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
