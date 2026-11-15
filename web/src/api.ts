export type Status = "open" | "in_progress" | "done";
export type Priority = "high" | "medium" | "low";

export interface Utterance { index: number; speaker: string; text: string; start?: string }
export interface Decision { text: string; speaker: string; sourceIndex: number }

export interface MeetingSummary {
  id: number;
  title: string;
  meetingDate: string;
  participants: string[];
  actionCount: number;
  openCount: number;
}

export interface Meeting {
  id: number;
  title: string;
  meetingDate: string;
  participants: string[];
  decisions: Decision[];
  utterances: Utterance[];
}

export interface Action {
  id: number;
  meetingId: number;
  meetingTitle: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  priority: Priority;
  status: Status;
  confidence: number;
  kind: string;
  sourceIndex: number;
  quote: string;
}

export interface OwnerLoad { owner: string; open: number; inProgress: number; done: number; overdue: number }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.details?.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join("; ");
    throw new Error(detail || body.error || res.statusText);
  }
  return body as T;
}

export const api = {
  meetings: () => call<MeetingSummary[]>("/api/meetings"),
  meeting: (id: number) => call<{ meeting: Meeting; actions: Action[] }>(`/api/meetings/${id}`),
  createMeeting: (data: { title: string; meetingDate: string; transcript: string }) =>
    call<{ meeting: Meeting; actions: Action[] }>("/api/meetings", { method: "POST", body: JSON.stringify(data) }),
  deleteMeeting: (id: number) => call<void>(`/api/meetings/${id}`, { method: "DELETE" }),
  actions: (params: Record<string, string> = {}) => call<Action[]>(`/api/actions?${new URLSearchParams(params)}`),
  updateAction: (id: number, patch: Partial<Pick<Action, "task" | "owner" | "dueDate" | "priority" | "status">>) =>
    call<Action>(`/api/actions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  owners: () => call<OwnerLoad[]>("/api/owners"),
};
