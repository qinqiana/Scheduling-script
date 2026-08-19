import { useEffect, useState } from "react";
import { api } from "../api";
import type { Person } from "../types";

const empty = { name: "", groupName: "广州", targetDays: "", canNight: true, active: true };

export function PeoplePage({ onChange }: { onChange: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState(empty);
  const [csv, setCsv] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    setPeople(await api.people());
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setError("");
    try {
      await api.addPerson({
        name: form.name,
        groupName: form.groupName,
        targetDays: form.targetDays ? Number(form.targetDays) : null,
        canNight: form.canNight,
        active: form.active,
      });
      setForm(empty);
      await load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "新增失败");
    }
  };

  const patch = async (p: Person, next: Partial<Person>) => {
    await api.updatePerson(p.id, next);
    await load();
    onChange();
  };

  const remove = async (p: Person) => {
    if (!confirm(`删除 ${p.name}？其请假和排班会一并清掉。`)) return;
    await api.deletePerson(p.id);
    await load();
    onChange();
  };

  const importCsv = async () => {
    setError("");
    try {
      const r = await api.importPeople(csv);
      setMsg(`已导入 / 更新，新增 ${r.added} 人`);
      setCsv("");
      await load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/restore", { method: "POST", body });
    if (!res.ok) {
      setError("恢复失败");
      return;
    }
    setMsg("已从备份恢复");
    await load();
    onChange();
  };

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>人员</h1>
          <p className="hint">现有班组按广州 / 佛山 / 中山清远。可扩到 20～30 人，导入格式：姓名,组别,目标出勤。</p>
        </div>
        <label className="btn">
          恢复 data.db
          <input type="file" hidden accept=".db,.sqlite" onChange={(e) => void restore(e.target.files?.[0])} />
        </label>
      </div>
      {error && <div className="banner">{error}</div>}
      {msg && <div className="banner ok">{msg}</div>}

      <div className="grid-2">
        <div className="card">
          <table className="list">
            <thead>
              <tr>
                <th>姓名</th>
                <th>组别</th>
                <th>目标出勤</th>
                <th>可晚班</th>
                <th>在职</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <input
                      defaultValue={p.groupName}
                      onBlur={(e) => {
                        if (e.target.value !== p.groupName) void patch(p, { groupName: e.target.value });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      style={{ width: 72 }}
                      defaultValue={p.targetDays ?? ""}
                      placeholder="默认"
                      onBlur={(e) => {
                        const v = e.target.value ? Number(e.target.value) : null;
                        if (v !== p.targetDays) void patch(p, { targetDays: v });
                      }}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={p.canNight} onChange={(e) => void patch(p, { canNight: e.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" checked={p.active} onChange={(e) => void patch(p, { active: e.target.checked })} />
                  </td>
                  <td>
                    <button className="btn danger" onClick={() => void remove(p)}>
                      删
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="card form">
            <strong>新增人员</strong>
            <label>
              姓名
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              组别
              <input value={form.groupName} onChange={(e) => setForm({ ...form, groupName: e.target.value })} />
            </label>
            <label>
              目标出勤（空则按当月法定工作日）
              <input value={form.targetDays} onChange={(e) => setForm({ ...form, targetDays: e.target.value })} />
            </label>
            <label>
              <span>
                <input type="checkbox" checked={form.canNight} onChange={(e) => setForm({ ...form, canNight: e.target.checked })} />{" "}
                可排晚班
              </span>
            </label>
            <button className="btn primary" onClick={() => void add()}>
              添加
            </button>
          </div>
          <div className="card form" style={{ marginTop: 12 }}>
            <strong>批量导入</strong>
            <textarea rows={7} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"姓名,组别,目标出勤\n张三,广州,23"} />
            <button className="btn" onClick={() => void importCsv()}>
              导入 CSV
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
