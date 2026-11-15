/**
 * Resolve natural-language deadlines ("by Friday", "end of month", "20/11")
 * relative to the meeting date. All arithmetic is done in UTC on calendar
 * dates so results don't drift with the server's timezone.
 */

export interface DueDate {
  date: string; // YYYY-MM-DD
  phrase: string;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export function parseISODate(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`invalid date '${s}', expected YYYY-MM-DD`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new Error(`invalid date '${s}'`);
  return d;
}

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function nextWeekday(from: Date, target: number, forceNextWeek: boolean): Date {
  let diff = (target - from.getUTCDay() + 7) % 7;
  if (diff === 0) diff = 7;
  if (forceNextWeek) {
    // "next Friday" said on a Monday means the Friday of the following week.
    const mondayOfNextWeek = addDays(from, ((8 - from.getUTCDay()) % 7) || 7);
    return addDays(mondayOfNextWeek, (target + 6) % 7);
  }
  return addDays(from, diff);
}

function explicitDate(day: number, monthIdx: number, base: Date): Date | null {
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  let year = base.getUTCFullYear();
  let d = new Date(Date.UTC(year, monthIdx, day));
  if (d.getUTCMonth() !== monthIdx) return null;
  // A date well in the past most likely refers to next year ("Jan 5" said in December).
  if (d.getTime() < base.getTime() - 60 * 86_400_000) {
    year += 1;
    d = new Date(Date.UTC(year, monthIdx, day));
  }
  return d;
}

type Rule = [RegExp, (m: RegExpMatchArray, base: Date) => Date | null];

const RULES: Rule[] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => { try { return parseISODate(`${m[1]}-${m[2]}-${m[3]}`); } catch { return null; } }],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, "i"),
    (m, b) => explicitDate(+m[1], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), b)],
  [new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"),
    (m, b) => explicitDate(+m[2], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), b)],
  [/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/, (m, b) => explicitDate(+m[1], +m[2] - 1, b)], // DD/MM (India)
  [/\b(?:today|tonight|eod|end of (?:the )?day|by close of business|cob)\b/i, (_, b) => b],
  [/\bday after tomorrow\b/i, (_, b) => addDays(b, 2)],
  [/\b(?:tomorrow|tmrw)\b/i, (_, b) => addDays(b, 1)],
  [/\b(?:end of (?:the |this )?week|eow|this week)\b/i, (_, b) => nextWeekday(addDays(b, -1), 5, false)],
  [/\bnext week\b/i, (_, b) => nextWeekday(b, 1, false)],
  [/\b(?:end of (?:the |this )?month|eom|this month)\b/i,
    (_, b) => new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0))],
  [/\bin (\d{1,2}|a|one|two|three) (day|week)s?\b/i, (m, b) => {
    const n = ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[m[1].toLowerCase()] ?? +m[1];
    return addDays(b, n * (m[2].toLowerCase() === "week" ? 7 : 1));
  }],
  [/\b(next|this|on|by|before|until)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    (m, b) => nextWeekday(b, DAYS.indexOf(m[2].toLowerCase()), m[1]?.toLowerCase() === "next")],
];

export function resolveDue(text: string, meetingDate: Date): DueDate | null {
  let best: { index: number; date: Date; phrase: string } | null = null;
  for (const [re, fn] of RULES) {
    const m = text.match(re);
    if (!m || m.index === undefined) continue;
    const date = fn(m, meetingDate);
    if (!date) continue;
    // Earlier rules are more specific; only the first matching rule is used.
    best = { index: m.index, date, phrase: m[0].trim() };
    break;
  }
  return best ? { date: toISO(best.date), phrase: best.phrase } : null;
}
