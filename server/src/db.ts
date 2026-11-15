import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision, ExtractedAction, Priority } from "./extractor.js";
import type { Utterance } from "./transcript.js";

export type Status = "open" | "in_progress" | "done";

export interface Meeting {
  id: number;
  title: string;
  meetingDate: string;
  participants: string[];
  decisions: Decision[];
  utterances: Utterance[];
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface ActionFilter {
  owner?: string;
  status?: Status;
  meetingId?: number;
  overdueAsOf?: string; // YYYY-MM-DD
  unassigned?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  meeting_date  TEXT NOT NULL,
  participants  TEXT NOT NULL,   -- JSON array
  decisions     TEXT NOT NULL,   -- JSON array
  utterances    TEXT NOT NULL,   -- JSON array (parsed transcript)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  task          TEXT NOT NULL,
  owner         TEXT,
  due_date      TEXT,
  due_phrase    TEXT,
  priority      TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  confidence    REAL NOT NULL,
  kind          TEXT NOT NULL,
  source_index  INTEGER NOT NULL,
  quote         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_owner ON actions(owner COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_actions_status_due ON actions(status, due_date);
CREATE INDEX IF NOT EXISTS idx_actions_meeting ON actions(meeting_id);
`;

type Row = Record<string, unknown>;

function toMeeting(r: Row): Meeting {
  return {
    id: Number(r.id),
    title: String(r.title),
    meetingDate: String(r.meeting_date),
    participants: JSON.parse(String(r.participants)),
    decisions: JSON.parse(String(r.decisions)),
    utterances: JSON.parse(String(r.utterances)),
    createdAt: String(r.created_at),
  };
}

function toAction(r: Row): Action {
  return {
    id: Number(r.id),
    meetingId: Number(r.meeting_id),
    meetingTitle: String(r.meeting_title ?? ""),
    task: String(r.task),
    owner: (r.owner as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    duePhrase: (r.due_phrase as string | null) ?? null,
    priority: r.priority as Priority,
    status: r.status as Status,
    confidence: Number(r.confidence),
    kind: String(r.kind),
    sourceIndex: Number(r.source_index),
    quote: String(r.quote),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const ACTION_SELECT = `SELECT a.*, m.title AS meeting_title FROM actions a JOIN meetings m ON m.id = a.meeting_id`;

export class Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  createMeeting(m: Omit<Meeting, "id" | "createdAt">, actions: ExtractedAction[]): { meeting: Meeting; actions: Action[] } {
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare("INSERT INTO meetings (title, meeting_date, participants, decisions, utterances) VALUES (?, ?, ?, ?, ?)")
        .run(m.title, m.meetingDate, JSON.stringify(m.participants), JSON.stringify(m.decisions), JSON.stringify(m.utterances));
      const meetingId = Number(res.lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT INTO actions (meeting_id, task, owner, due_date, due_phrase, priority, confidence, kind, source_index, quote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of actions) {
        insert.run(meetingId, a.task, a.owner, a.dueDate, a.duePhrase, a.priority, a.confidence, a.kind, a.sourceIndex, a.quote);
      }
      this.db.exec("COMMIT");
      return { meeting: this.getMeeting(meetingId)!, actions: this.listActions({ meetingId }) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getMeeting(id: number): Meeting | null {
    const r = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
    return r ? toMeeting(r) : null;
  }

  listMeetings(): (Omit<Meeting, "utterances" | "decisions"> & { actionCount: number; openCount: number })[] {
    const rows = this.db.prepare(
      `SELECT m.*, COUNT(a.id) AS action_count, SUM(CASE WHEN a.status != 'done' THEN 1 ELSE 0 END) AS open_count
       FROM meetings m LEFT JOIN actions a ON a.meeting_id = m.id
       GROUP BY m.id ORDER BY m.meeting_date DESC, m.id DESC`,
    ).all() as Row[];
    return rows.map((r) => {
      const { utterances: _u, decisions: _d, ...rest } = toMeeting(r);
      return { ...rest, actionCount: Number(r.action_count), openCount: Number(r.open_count ?? 0) };
    });
  }

  deleteMeeting(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id).changes) > 0;
  }

  listActions(f: ActionFilter = {}): Action[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.owner) { where.push("a.owner = ? COLLATE NOCASE"); params.push(f.owner); }
    if (f.unassigned) where.push("a.owner IS NULL");
    if (f.status) { where.push("a.status = ?"); params.push(f.status); }
    if (f.meetingId) { where.push("a.meeting_id = ?"); params.push(f.meetingId); }
    if (f.overdueAsOf) { where.push("a.status != 'done' AND a.due_date IS NOT NULL AND a.due_date < ?"); params.push(f.overdueAsOf); }
    const sql = `${ACTION_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE a.status WHEN 'done' THEN 1 ELSE 0 END, a.due_date IS NULL, a.due_date,
               CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toAction);
  }

  getAction(id: number): Action | null {
    const r = this.db.prepare(`${ACTION_SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    return r ? toAction(r) : null;
  }

  updateAction(id: number, patch: Partial<Pick<Action, "task" | "owner" | "dueDate" | "priority" | "status">>): Action | null {
    const cols: Record<string, string> = { task: "task", owner: "owner", dueDate: "due_date", priority: "priority", status: "status" };
    const sets: string[] = [];
    const params: (string | null | number)[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) { sets.push(`${col} = ?`); params.push((patch as Record<string, string | null>)[k]); }
    }
    if ("dueDate" in patch) sets.push("due_phrase = NULL");
    if (!sets.length) return this.getAction(id);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    const res = this.db.prepare(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return Number(res.changes) ? this.getAction(id) : null;
  }

  ownerSummary(asOf: string): { owner: string; open: number; inProgress: number; done: number; overdue: number }[] {
    const rows = this.db.prepare(
      `SELECT COALESCE(owner, '(unassigned)') AS owner,
              SUM(status = 'open') AS open, SUM(status = 'in_progress') AS in_progress, SUM(status = 'done') AS done,
              SUM(status != 'done' AND due_date IS NOT NULL AND due_date < ?) AS overdue
       FROM actions GROUP BY COALESCE(owner, '(unassigned)') ORDER BY overdue DESC, open DESC, owner`,
    ).all(asOf) as Row[];
    return rows.map((r) => ({
      owner: String(r.owner), open: Number(r.open), inProgress: Number(r.in_progress), done: Number(r.done), overdue: Number(r.overdue),
    }));
  }

  close(): void {
    this.db.close();
  }
}
