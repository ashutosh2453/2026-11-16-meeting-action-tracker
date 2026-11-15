/**
 * Transcript parsing for the formats meeting tools actually export:
 * WebVTT (Teams, Zoom, Google Meet), SubRip (.srt) and plain "Speaker: text".
 */

export interface Utterance {
  index: number;
  speaker: string;
  text: string;
  start?: string; // HH:MM:SS when the source has timestamps
}

export type TranscriptFormat = "vtt" | "srt" | "plain";

const CUE_TIME = /^(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;
const SPEAKER_PREFIX = /^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,3})\s*:\s+(.+)$/u;
const VOICE_TAG = /^<v(?:\.[^\s>]+)?\s+([^>]+)>(.*?)(?:<\/v>)?$/;
const UNKNOWN = "Unknown";

export function detectFormat(raw: string): TranscriptFormat {
  const head = raw.trimStart();
  if (head.startsWith("WEBVTT")) return "vtt";
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return "srt";
  return "plain";
}

function normaliseTime(t: string): string {
  const clean = t.split(/[.,]/)[0];
  const parts = clean.split(":").map((p) => p.padStart(2, "0"));
  while (parts.length < 3) parts.unshift("00");
  return parts.join(":");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function splitSpeaker(line: string): { speaker?: string; text: string } {
  const voice = line.match(VOICE_TAG);
  if (voice) return { speaker: voice[1].trim(), text: stripTags(voice[2]) };
  const m = line.match(SPEAKER_PREFIX);
  if (m) return { speaker: m[2].trim(), text: m[3].trim() };
  return { text: stripTags(line) };
}

function parseCues(raw: string): Utterance[] {
  const out: Utterance[] = [];
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => CUE_TIME.test(l));
    if (timeIdx === -1) continue;
    const start = normaliseTime(lines[timeIdx].split("-->")[0].trim());
    const body = lines.slice(timeIdx + 1);
    if (!body.length) continue;
    const first = splitSpeaker(body[0]);
    const rest = body.slice(1).map((l) => splitSpeaker(l).text);
    const text = stripTags([first.text, ...rest].join(" "));
    if (!text) continue;
    const speaker = first.speaker ?? out.at(-1)?.speaker ?? UNKNOWN;
    out.push({ index: out.length, speaker, text, start });
  }
  return out;
}

function parsePlain(raw: string): Utterance[] {
  const out: Utterance[] = [];
  for (const rawLine of raw.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(SPEAKER_PREFIX);
    if (m) {
      out.push({ index: out.length, speaker: m[2].trim(), text: m[3].trim(), ...(m[1] ? { start: normaliseTime(m[1]) } : {}) });
    } else if (out.length) {
      out[out.length - 1].text += " " + line; // continuation of the previous speaker
    } else {
      out.push({ index: 0, speaker: UNKNOWN, text: line });
    }
  }
  return out;
}

export function parseTranscript(raw: string, format: TranscriptFormat = detectFormat(raw)): Utterance[] {
  const utterances = format === "plain" ? parsePlain(raw) : parseCues(raw);
  // Merge consecutive cues from the same speaker: VTT exports split sentences mid-thought.
  const merged: Utterance[] = [];
  for (const u of utterances) {
    const prev = merged.at(-1);
    if (prev && prev.speaker === u.speaker && format !== "plain" && !/[.!?]$/.test(prev.text)) {
      prev.text += " " + u.text;
    } else {
      merged.push({ ...u, index: merged.length });
    }
  }
  return merged;
}

export function participants(utterances: Utterance[]): string[] {
  return [...new Set(utterances.map((u) => u.speaker).filter((s) => s !== UNKNOWN))];
}
