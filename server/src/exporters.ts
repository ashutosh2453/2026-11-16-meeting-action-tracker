import type { Action, Meeting } from "./db.js";

/** Markdown meeting minutes: decisions, actions grouped by owner, unassigned items called out. */
export function minutesMarkdown(meeting: Meeting, actions: Action[]): string {
  const lines = [
    `# ${meeting.title}`,
    "",
    `**Date:** ${meeting.meetingDate}  `,
    `**Participants:** ${meeting.participants.join(", ") || "n/a"}`,
    "",
    "## Decisions",
    "",
    ...(meeting.decisions.length ? meeting.decisions.map((d) => `- ${d.text} (${d.speaker})`) : ["- None recorded"]),
    "",
    "## Action items",
    "",
  ];
  const byOwner = new Map<string, Action[]>();
  for (const a of actions) {
    const key = a.owner ?? "Unassigned";
    byOwner.set(key, [...(byOwner.get(key) ?? []), a]);
  }
  if (!actions.length) lines.push("- None recorded");
  for (const [owner, items] of [...byOwner].sort(([a], [b]) => (a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b)))) {
    lines.push(`### ${owner}`, "");
    for (const a of items) {
      const meta = [a.dueDate && `due ${a.dueDate}`, a.priority !== "medium" && `${a.priority} priority`].filter(Boolean).join(", ");
      lines.push(`- [${a.status === "done" ? "x" : " "}] ${a.task}${meta ? ` (${meta})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold lines to 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** iCalendar feed with one all-day event per open action that has a due date. */
export function actionsIcs(actions: Action[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//meeting-action-tracker//EN", "CALSCALE:GREGORIAN"];
  for (const a of actions) {
    if (!a.dueDate || a.status === "done") continue;
    const day = a.dueDate.replace(/-/g, "");
    const next = new Date(Date.parse(a.dueDate) + 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:action-${a.id}@meeting-action-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${icsEscape(`${a.owner ? a.owner + ": " : ""}${a.task}`)}`,
      `DESCRIPTION:${icsEscape(`From "${a.meetingTitle}". Priority: ${a.priority}. Quote: ${a.quote}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
