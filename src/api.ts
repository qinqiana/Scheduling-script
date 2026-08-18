import type {
  Holiday,
  Leave,
  Person,
  Settings,
} from "../shared/types";
import type { RosterPayload } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (body: Settings) =>
    req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  people: () => req<Person[]>("/api/people"),
  addPerson: (body: Partial<Person> & { name: string; groupName: string }) =>
    req<{ id: number }>("/api/people", { method: "POST", body: JSON.stringify(body) }),
  updatePerson: (id: number, body: Partial<Person>) =>
    req<{ ok: boolean }>(`/api/people/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePerson: (id: number) => req<{ ok: boolean }>(`/api/people/${id}`, { method: "DELETE" }),
  importPeople: (csv: string) =>
    req<{ added: number }>("/api/people/import", { method: "POST", body: JSON.stringify({ csv }) }),
  holidays: (year?: number) =>
    req<Holiday[]>(year ? `/api/holidays?year=${year}` : "/api/holidays"),
  addHoliday: (body: Holiday) =>
    req<{ ok: boolean }>("/api/holidays", { method: "POST", body: JSON.stringify(body) }),
  deleteHoliday: (date: string) =>
    req<{ ok: boolean }>(`/api/holidays/${date}`, { method: "DELETE" }),
  leaves: (year: number, month: number) =>
    req<Leave[]>(`/api/leaves?year=${year}&month=${month}`),
  addLeave: (body: { personId: number; date: string; reason?: string }) =>
    req<{ ok: boolean }>("/api/leaves", { method: "POST", body: JSON.stringify(body) }),
  deleteLeave: (id: number) => req<{ ok: boolean }>(`/api/leaves/${id}`, { method: "DELETE" }),
  deleteLeaveCell: (personId: number, date: string) =>
    req<{ ok: boolean }>(`/api/leaves/cell/${personId}/${date}`, { method: "DELETE" }),
  roster: (year: number, month: number) =>
    req<RosterPayload>(`/api/roster?year=${year}&month=${month}`),
  generate: (year: number, month: number, keepLocked: boolean) =>
    req<RosterPayload>("/api/roster/generate", {
      method: "POST",
      body: JSON.stringify({ year, month, keepLocked }),
    }),
  setCell: (body: { personId: number; date: string; shift: "早" | "晚" | "休"; locked: boolean }) =>
    req<RosterPayload>("/api/roster/cell", { method: "PUT", body: JSON.stringify(body) }),
};

export function exportUrl(year: number, month: number): string {
  return `/api/export?year=${year}&month=${month}`;
}
