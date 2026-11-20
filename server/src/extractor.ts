/**
 * Rule-based action-item and decision extraction.
 *
 * Meeting speech has a small set of commitment patterns that cover most
 * real action items: self-commitments ("I'll send the deck"), requests
 * ("Priya, can you check the logs?"), assignments ("Rahul will update
 * the doc"), explicit markers ("Action item: ...") and team tasks ("we need
 * to ..."). Each pattern carries a confidence; owners are resolved from the
 * speaker, a vocative name, or an affirmative reply in the next turn.
 */

import { resolveDue } from "./dates.js";
import type { Utterance } from "./transcript.js";

export type Priority = "high" | "medium" | "low";

export interface ExtractedAction {
  task: string;
  owner: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  priority: Priority;
  confidence: number;
  kind: "explicit" | "commitment" | "request" | "assignment" | "team";
  sourceIndex: number;
  quote: string;
}

export interface Decision {
  text: string;
  speaker: string;
  sourceIndex: number;
}

export interface Extraction {
  actions: ExtractedAction[];
  decisions: Decision[];
}

const FILLERS = /\b(?:um+|uh+|you know|like,|basically|actually|just)\b,?\s*/gi;
const AFFIRMATIVE = /^(?:sure|yes|yeah|yep|ok(?:ay)?|will do|on it|no problem|got it|absolutely|definitely|i can do that|i'll do it|consider it done)\b/i;
const NON_TASK_VERBS = /^(?:be|think|say|admit|guess|bet|see you|talk to you|try to remember|leave it there|hand (?:it )?(?:back|over) to)\b/i;
const HIGH = /\b(?:urgent(?:ly)?|asap|as soon as possible|blocker|blocking|critical|immediately|top priority|p0)\b/i;
const LOW = /\b(?:when you (?:get|have) a (?:chance|minute)|no rush|eventually|nice to have|low priority|at some point)\b/i;
const DECISION = /\b(?:we(?:'ve| have)? (?:decided|agreed)|(?:it's|it is) decided|let's go with|we(?:'ll| will) go with|decision(?: is)?:|final call|we are going with|agreed to)\b/i;

const LOW_PHRASES = /,?\s*(?:when you (?:get|have) a (?:chance|minute)|if you (?:get|have) (?:a chance|time)|no rush|at some point)\b/gi;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Normalise a task. When someone else owns it, first-person words refer to the speaker. */
function cleanTask(raw: string, speakerIsOwner: boolean, speaker = ""): string {
  let t = raw.replace(FILLERS, "").replace(LOW_PHRASES, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:and|so|also|then|please|maybe)\s+/i, "").replace(/\s*(?:please|for me)\s*([.?!]*)$/i, "$1");
  t = t.replace(/[.?!]+$/, "").trim();
  if (!speakerIsOwner) {
    const name = speaker && speaker !== "Unknown" ? speaker.split(/\s+/)[0] : null;
    t = t
      .replace(/\bmy\b/gi, name ? `${name}'s` : "their")
      .replace(/\bmyself\b/gi, name ?? "them")
      .replace(/\bme\b/gi, name ?? "them");
  }
  return capitalise(t);
}

function findName(fragment: string, people: string[]): string | null {
  const lower = fragment.toLowerCase();
  for (const p of people) {
    const first = p.split(/\s+/)[0].toLowerCase();
    if (lower === p.toLowerCase() || lower === first) return p;
  }
  // A capitalised word used as an address is probably a person even if they never spoke.
  return /^[A-Z][a-z]+$/.test(fragment) && !NOT_NAMES.test(fragment) ? fragment : null;
}

const NOT_NAMES = /^(?:So|And|Okay|Ok|Also|Then|Well|Right|Great|Team|Everyone|Everybody|Guys|Folks|Hey|Hi|It|This|That|There|These|Those|We|They|He|She|You|Someone|Somebody|Nobody|Everything|Nothing|Which|What|Who|Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Yes|No|Sure|Thanks|But|If|When|The|Our|My|Your)$/;

/** "Rahul will fix X and Anita will send Y" -> two clauses, each with its own owner. */
function clauses(s: string): string[] {
  return s
    .split(/,?\s+(?:and|while|then)\s+(?=[A-Z][\p{L}]+\s+(?:will|to|is going to|needs to|should)\b)/u)
    .map((c) => c.trim())
    .filter(Boolean);
}

interface Match {
  kind: ExtractedAction["kind"];
  task: string;
  owner: string | null | "speaker" | "next-affirmative";
  confidence: number;
}

function matchSentence(s: string, people: string[]): Match | null {
  if (s.length < 8) return null;

  // 1. Explicit markers: "Action item: Priya to send the deck", "TODO - update docs"
  let m = s.match(/^(?:action items?|action|todo|to-do|follow[- ]up|next step)\s*[:\-–]\s*(.+)$/i);
  if (m) {
    const body = m[1];
    const assigned = body.match(/^@?([A-Z][\p{L}]+)(?:\s+(?:to|will|should|needs to|is going to))\s+(.+)$/u);
    if (assigned && findName(assigned[1], people)) {
      return { kind: "explicit", task: assigned[2], owner: findName(assigned[1], people), confidence: 0.95 };
    }
    const at = body.match(/@([\p{L}]+)/u);
    return { kind: "explicit", task: body.replace(/@[\p{L}]+\s*/u, ""), owner: at ? findName(at[1], people) : null, confidence: 0.9 };
  }

  // 2. Self commitments: "I'll send the deck by Friday", "Let me check with legal"
  m = s.match(/\b(?:I'll|I will|I'm going to|I am going to|I can take care of|I'll take care of|I'll handle|let me|I'll make sure (?:to|that)?|I need to|I'll go ahead and)\s+(.+)$/i);
  if (m && !s.trim().endsWith("?") && !NON_TASK_VERBS.test(m[1])) {
    const hedged = /\b(?:maybe|might|probably|try to|if I have time)\b/i.test(s);
    return { kind: "commitment", task: m[1], owner: "speaker", confidence: hedged ? 0.6 : 0.85 };
  }

  // 3. Requests: "Priya, can you look into the crash?", "Could you send me the numbers?"
  m = s.match(/(?:^|[\s,])(?:([A-Z][\p{L}]+),?\s+)?(?:[Cc]an|[Cc]ould|[Ww]ould|[Ww]ill) you(?: please)?\s+(.+?)\??$/u);
  if (m && !NON_TASK_VERBS.test(m[2]) && !/^(?:hear|see|repeat|confirm (?:that )?you)/i.test(m[2])) {
    const named = m[1] ? findName(m[1], people) : null;
    return { kind: "request", task: m[2], owner: named ?? "next-affirmative", confidence: named ? 0.85 : 0.7 };
  }

  // 3b. Vocative imperative: "Rahul, please update the release notes."
  m = s.match(/^([A-Z][\p{L}]+),\s+(?:please\s+)(.+)$/u);
  if (m && findName(m[1], people)) {
    return { kind: "request", task: m[2], owner: findName(m[1], people), confidence: 0.8 };
  }

  // 4. Assignments: "Rahul will update the doc", "Priya needs to sign off on the budget"
  m = s.match(/^(?:[^,]{1,30},\s*)?(?:(?:so|and|okay|then)\s+)?([A-Z][\p{L}]+)\s+(?:will|is going to|needs to|has to|should|to)\s+(.+)$/u);
  if (m && findName(m[1], people) && !NON_TASK_VERBS.test(m[2])) {
    return { kind: "assignment", task: m[2], owner: findName(m[1], people), confidence: 0.8 };
  }

  // 5. Team tasks: "We need to fix the onboarding flow before launch"
  m = s.match(/\b(?:we need to|we have to|we should|we must|someone (?:needs|has) to|somebody should|let's make sure (?:to|we)?)\s+(.+)$/i);
  if (m && !s.trim().endsWith("?")) {
    return { kind: "team", task: m[1], owner: null, confidence: 0.55 };
  }
  return null;
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function isDuplicate(k: ExtractedAction, a: ExtractedAction): boolean {
  if (k.owner && a.owner && k.owner !== a.owner) return false;
  const ta = tokens(k.task), tb = tokens(a.task);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter || 1);
  const containment = inter / (Math.min(ta.size, tb.size) || 1);
  // A short restatement by the same owner ("Anita will send the API contract") folds into the detailed task.
  return jaccard >= 0.6 || (k.owner !== null && k.owner === a.owner && containment >= 0.8);
}

function priorityFor(text: string, due: string | null, meetingDate: Date): Priority {
  if (HIGH.test(text)) return "high";
  if (LOW.test(text)) return "low";
  if (due && (Date.parse(due) - meetingDate.getTime()) / 86_400_000 <= 1) return "high";
  return "medium";
}

export function extract(utterances: Utterance[], meetingDate: Date, people: string[]): Extraction {
  const actions: ExtractedAction[] = [];
  const decisions: Decision[] = [];

  utterances.forEach((u, i) => {
    for (const s of sentences(u.text).flatMap(clauses)) {
      if (DECISION.test(s)) {
        decisions.push({ text: cleanTask(s, true), speaker: u.speaker, sourceIndex: u.index });
        continue;
      }
      const match = matchSentence(s, people);
      if (!match) continue;

      let owner: string | null;
      if (match.owner === "speaker") owner = u.speaker === "Unknown" ? null : u.speaker;
      else if (match.owner === "next-affirmative") {
        const next = utterances[i + 1];
        owner = next && next.speaker !== u.speaker && AFFIRMATIVE.test(next.text.trim()) ? next.speaker : null;
      } else owner = match.owner;

      const due = resolveDue(s, meetingDate);
      let task = match.task;
      if (due) task = task.replace(new RegExp(`\\s*(?:by|on|before|until|for)?\\s*${due.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), "");
      task = cleanTask(task, match.owner === "speaker", u.speaker);
      if (task.split(/\s+/).length < 2) continue;

      actions.push({
        task,
        owner,
        dueDate: due?.date ?? null,
        duePhrase: due?.phrase ?? null,
        priority: priorityFor(s, due?.date ?? null, meetingDate),
        confidence: match.confidence,
        kind: match.kind,
        sourceIndex: u.index,
        quote: s,
      });
    }
  });

  return { actions: dedupe(actions), decisions };
}

/** Collapse near-duplicate tasks (e.g. restated in the meeting wrap-up), keeping the richest one. */
function dedupe(actions: ExtractedAction[]): ExtractedAction[] {
  const kept: ExtractedAction[] = [];
  for (const a of actions) {
    const dup = kept.find((k) => isDuplicate(k, a));
    if (!dup) {
      kept.push(a);
      continue;
    }
    dup.owner ??= a.owner;
    dup.dueDate ??= a.dueDate;
    dup.duePhrase ??= a.duePhrase;
    dup.confidence = Math.max(dup.confidence, a.confidence);
    if (a.priority === "high") dup.priority = "high";
  }
  return kept;
}
