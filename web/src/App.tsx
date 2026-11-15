import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Action, type Meeting, type MeetingSummary, type OwnerLoad, type Status } from "./api";

type View = { name: "meetings" } | { name: "meeting"; id: number } | { name: "board" } | { name: "people" };

const STATUSES: { key: Status; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (a: Action) => a.status !== "done" && !!a.dueDate && a.dueDate < today();

export default function App() {
  const [view, setView] = useState<View>({ name: "meetings" });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="shell">
      <header className="top">
        <h1>Meeting Action Tracker</h1>
        <nav>
          <button className={view.name.startsWith("meeting") ? "tab on" : "tab"} onClick={() => setView({ name: "meetings" })}>Meetings</button>
          <button className={view.name === "board" ? "tab on" : "tab"} onClick={() => setView({ name: "board" })}>Action board</button>
          <button className={view.name === "people" ? "tab on" : "tab"} onClick={() => setView({ name: "people" })}>People</button>
        </nav>
      </header>
      {error && <div className="error" role="alert" onClick={() => setError(null)}>{error}</div>}
      <main>
        {view.name === "meetings" && <Meetings onOpen={(id) => setView({ name: "meeting", id })} onError={setError} />}
        {view.name === "meeting" && <MeetingDetail id={view.id} onBack={() => setView({ name: "meetings" })} onError={setError} />}
        {view.name === "board" && <Board onError={setError} />}
        {view.name === "people" && <People onError={setError} />}
      </main>
    </div>
  );
}

function Meetings({ onOpen, onError }: { onOpen: (id: number) => void; onError: (e: string) => void }) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.meetings().then(setMeetings).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load]);

  async function readFile(file: File) {
    setTranscript(await file.text());
    if (!title) setTitle(file.name.replace(/\.(vtt|srt|txt)$/i, "").replace(/[-_]/g, " "));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { meeting } = await api.createMeeting({ title, meetingDate: date, transcript });
      onOpen(meeting.id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Add a meeting</h2>
        <form onSubmit={submit} className="stack">
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Sprint 42 planning" /></label>
          <label>Meeting date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          <label>Transcript file (.vtt, .srt, .txt)
            <input type="file" accept=".vtt,.srt,.txt" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
          </label>
          <label>…or paste the transcript
            <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} required rows={10}
              placeholder={"Priya: I'll send the deck by Friday.\nRahul, can you fix the login bug tomorrow?"} />
          </label>
          <button className="primary" disabled={busy}>{busy ? "Extracting…" : "Extract action items"}</button>
        </form>
      </section>
      <section className="card">
        <h2>Meetings</h2>
        {!meetings.length && <p className="muted">No meetings yet. Add one, or try <code>samples/sprint-planning.vtt</code>.</p>}
        <ul className="list">
          {meetings.map((m) => (
            <li key={m.id}>
              <button className="link" onClick={() => onOpen(m.id)}>{m.title}</button>
              <span className="muted">{m.meetingDate} · {m.participants.length} people · {m.openCount}/{m.actionCount} open</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function MeetingDetail({ id, onBack, onError }: { id: number; onBack: () => void; onError: (e: string) => void }) {
  const [data, setData] = useState<{ meeting: Meeting; actions: Action[] } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const load = useCallback(() => api.meeting(id).then(setData).catch((e) => onError(e.message)), [id, onError]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="muted">Loading…</p>;
  const { meeting, actions } = data;
  const sourceLines = new Set([...actions.map((a) => a.sourceIndex), ...meeting.decisions.map((d) => d.sourceIndex)]);

  async function remove() {
    if (!confirm(`Delete "${meeting.title}" and its ${actions.length} action items?`)) return;
    await api.deleteMeeting(meeting.id).catch((e) => onError(e.message));
    onBack();
  }

  return (
    <div className="stack">
      <div className="row between">
        <button className="link" onClick={onBack}>← All meetings</button>
        <div className="row">
          <a className="button" href={`/api/meetings/${meeting.id}/minutes.md`} download={`${meeting.title}.md`}>Download minutes</a>
          <button className="danger" onClick={remove}>Delete</button>
        </div>
      </div>
      <h2>{meeting.title} <span className="muted">· {meeting.meetingDate}</span></h2>
      <p className="muted">Participants: {meeting.participants.join(", ")}</p>
      <div className="grid">
        <section className="card">
          <h3>Action items ({actions.length})</h3>
          {actions.map((a) => <ActionRow key={a.id} action={a} onChange={load} onError={onError} onFocus={() => setFocus(a.sourceIndex)} />)}
          {!actions.length && <p className="muted">No action items detected.</p>}
          <h3>Decisions</h3>
          {meeting.decisions.length ? (
            <ul>{meeting.decisions.map((d, i) => <li key={i}><button className="link" onClick={() => setFocus(d.sourceIndex)}>{d.text}</button> <span className="muted">({d.speaker})</span></li>)}</ul>
          ) : <p className="muted">None recorded.</p>}
        </section>
        <section className="card transcript">
          <h3>Transcript</h3>
          {meeting.utterances.map((u) => (
            <p key={u.index} className={`${sourceLines.has(u.index) ? "src" : ""} ${focus === u.index ? "focus" : ""}`}
              ref={(el) => { if (el && focus === u.index) el.scrollIntoView({ block: "center", behavior: "smooth" }); }}>
              {u.start && <span className="muted">{u.start} </span>}<b>{u.speaker}:</b> {u.text}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}

function ActionRow({ action: a, onChange, onError, onFocus }: { action: Action; onChange: () => void; onError: (e: string) => void; onFocus?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(a.owner ?? "");
  const [due, setDue] = useState(a.dueDate ?? "");

  async function patch(p: Parameters<typeof api.updateAction>[1]) {
    try { await api.updateAction(a.id, p); onChange(); } catch (e) { onError((e as Error).message); }
  }

  return (
    <div className={`action ${a.status} ${isOverdue(a) ? "overdue" : ""}`}>
      <div className="row between">
        <strong className={a.status === "done" ? "struck" : ""}>{a.task}</strong>
        <span className={`pill ${a.priority}`}>{a.priority}</span>
      </div>
      {editing ? (
        <div className="row">
          <input aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" />
          <input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button onClick={() => { setEditing(false); patch({ owner: owner.trim() || null, dueDate: due || null }); }}>Save</button>
        </div>
      ) : (
        <div className="meta">
          <span>{a.owner ?? <em className="warn">unassigned</em>}</span>
          <span>{a.dueDate ? `due ${a.dueDate}` : "no due date"}{isOverdue(a) && <b className="warn"> overdue</b>}</span>
          <span title="Extraction confidence">{Math.round(a.confidence * 100)}% · {a.kind}</span>
        </div>
      )}
      <div className="row">
        <select aria-label="Status" value={a.status} onChange={(e) => patch({ status: e.target.value as Status })}>
          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {!editing && <button onClick={() => setEditing(true)}>Edit</button>}
        {onFocus ? <button className="link" onClick={onFocus}>Show in transcript</button> : <span className="muted small">from {a.meetingTitle}</span>}
      </div>
    </div>
  );
}

function Board({ onError }: { onError: (e: string) => void }) {
  const [actions, setActions] = useState<Action[]>([]);
  const [owner, setOwner] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const load = useCallback(() => api.actions().then(setActions).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load]);

  const owners = useMemo(() => [...new Set(actions.map((a) => a.owner ?? "(unassigned)"))].sort(), [actions]);
  const visible = actions.filter((a) => (!owner || (a.owner ?? "(unassigned)") === owner) && (!overdueOnly || isOverdue(a)));

  return (
    <div className="stack">
      <div className="row">
        <select aria-label="Filter by owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone</option>
          {owners.map((o) => <option key={o}>{o}</option>)}
        </select>
        <label className="row"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        <a className="button" href="/api/actions.ics" download="actions.ics">Export to calendar (.ics)</a>
      </div>
      <div className="board">
        {STATUSES.map((s) => {
          const col = visible.filter((a) => a.status === s.key);
          return (
            <section key={s.key} className="column">
              <h3>{s.label} <span className="muted">{col.length}</span></h3>
              {col.map((a) => <ActionRow key={a.id} action={a} onChange={load} onError={onError} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function People({ onError }: { onError: (e: string) => void }) {
  const [rows, setRows] = useState<OwnerLoad[]>([]);
  useEffect(() => { api.owners().then(setRows).catch((e) => onError(e.message)); }, [onError]);
  return (
    <section className="card">
      <h2>Workload by person</h2>
      <table>
        <thead><tr><th>Owner</th><th>Open</th><th>In progress</th><th>Done</th><th>Overdue</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.owner}><td>{r.owner}</td><td>{r.open}</td><td>{r.inProgress}</td><td>{r.done}</td><td className={r.overdue ? "warn" : ""}>{r.overdue}</td></tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="muted">No action items yet.</p>}
    </section>
  );
}
