import { describe, expect, it } from "vitest";
import { parseISODate, resolveDue } from "../src/dates.js";
import { extract } from "../src/extractor.js";
import { detectFormat, parseTranscript, participants } from "../src/transcript.js";

const MON = parseISODate("2026-11-16"); // a Monday
const due = (s: string) => resolveDue(s, MON)?.date ?? null;

describe("dates", () => {
  it.each([
    ["send it today", "2026-11-16"],
    ["by EOD", "2026-11-16"],
    ["tomorrow morning", "2026-11-17"],
    ["day after tomorrow", "2026-11-18"],
    ["by Friday", "2026-11-20"],
    ["next Friday", "2026-11-27"],
    ["on Monday", "2026-11-23"],
    ["end of the week", "2026-11-20"],
    ["next week", "2026-11-23"],
    ["end of month", "2026-11-30"],
    ["in 3 days", "2026-11-19"],
    ["in two weeks", "2026-11-30"],
    ["by Nov 25th", "2026-11-25"],
    ["by 5th December", "2026-12-05"],
    ["by 2026-12-01", "2026-12-01"],
    ["by 28/11", "2026-11-28"],
    ["by Jan 10", "2027-01-10"],
  ])("%s -> %s", (text, expected) => expect(due(text)).toBe(expected));

  it("returns null when there is no date or the date is impossible", () => {
    expect(due("update the docs")).toBeNull();
    expect(due("by 31/02")).toBeNull();
  });

  it("rejects malformed meeting dates", () => {
    expect(() => parseISODate("2026-02-30")).toThrow();
    expect(() => parseISODate("16-11-2026")).toThrow();
  });
});

describe("transcript parsing", () => {
  it("parses Teams-style VTT with voice tags and merges split cues", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Priya Sharma>I'll send the revised deck</v>

00:00:04.000 --> 00:00:06.500
<v Priya Sharma>by Friday.</v>

00:00:07.000 --> 00:00:09.000
<v Rahul>Sounds good.</v>`;
    expect(detectFormat(vtt)).toBe("vtt");
    const u = parseTranscript(vtt);
    expect(u).toHaveLength(2);
    expect(u[0]).toMatchObject({ speaker: "Priya Sharma", text: "I'll send the revised deck by Friday.", start: "00:00:01" });
    expect(participants(u)).toEqual(["Priya Sharma", "Rahul"]);
  });

  it("parses SRT with speaker prefixes", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Anita: Can you share the logs?

2
00:00:03,500 --> 00:00:05,000
Vikram: Sure.`;
    expect(detectFormat(srt)).toBe("srt");
    expect(parseTranscript(srt).map((x) => x.speaker)).toEqual(["Anita", "Vikram"]);
  });

  it("parses plain text with timestamps and continuation lines", () => {
    const u = parseTranscript("[10:02] Meera: We should ship.\nAlso the docs.\nJoe Bloggs: Agreed.");
    expect(u).toEqual([
      { index: 0, speaker: "Meera", text: "We should ship. Also the docs.", start: "00:10:02" },
      { index: 1, speaker: "Joe Bloggs", text: "Agreed." },
    ]);
  });
});

function run(text: string) {
  const u = parseTranscript(text);
  return extract(u, MON, participants(u));
}

describe("action extraction", () => {
  it("extracts a self-commitment with owner, due date and clean task text", () => {
    const { actions } = run("Priya: Um, I'll send the revised pricing deck to the client by Friday.");
    expect(actions).toEqual([expect.objectContaining({
      task: "Send the revised pricing deck to the client", owner: "Priya", dueDate: "2026-11-20",
      duePhrase: "by Friday", kind: "commitment", priority: "medium",
    })]);
  });

  it("assigns a named request to the addressee", () => {
    const { actions } = run("Anita: Rahul, can you look into the login crash ASAP?\nRahul: Yep.");
    expect(actions[0]).toMatchObject({ owner: "Rahul", task: "Look into the login crash ASAP", priority: "high", kind: "request" });
  });

  it("assigns an unnamed request to whoever says yes next", () => {
    const { actions } = run("Anita: Could you send me the Q3 numbers tomorrow?\nVikram: Sure, will do.");
    expect(actions[0]).toMatchObject({ owner: "Vikram", task: "Send Anita the Q3 numbers", dueDate: "2026-11-17", priority: "high" });
  });

  it("leaves an unanswered request unassigned", () => {
    const { actions } = run("Anita: Could you update the onboarding guide?\nVikram: Hmm, not sure.");
    expect(actions[0].owner).toBeNull();
  });

  it("handles explicit markers and assignments", () => {
    const { actions } = run("Meera: Action item: Joe to draft the incident report by 20/11.\nMeera: Joe will also book the retro room.\nJoe: Fine.");
    expect(actions.map((a) => [a.owner, a.task, a.kind])).toEqual([
      ["Joe", "Draft the incident report", "explicit"],
      ["Joe", "Book the retro room", "assignment"],
    ]);
    expect(actions[0].dueDate).toBe("2026-11-20");
  });

  it("captures team tasks and decisions", () => {
    const { actions, decisions } = run("Meera: We need to fix the flaky payment tests before launch. We've decided to go with Stripe for India.");
    expect(actions[0]).toMatchObject({ owner: null, kind: "team", task: "Fix the flaky payment tests before launch" });
    expect(decisions).toEqual([{ text: "We've decided to go with Stripe for India", speaker: "Meera", sourceIndex: 0 }]);
  });

  it("ignores non-tasks: questions, pleasantries and hedges about speech", () => {
    const { actions } = run("Joe: I'll be honest, that was rough. I think so. Can you hear me? I'll see you all tomorrow. Will we need to?");
    expect(actions).toEqual([]);
  });

  it("lowers confidence for hedged commitments and low priority for no-rush asks", () => {
    const { actions } = run("Joe: I'll maybe try to clean up the backlog. No rush, but Priya, could you review the style guide when you get a chance?");
    expect(actions[0].confidence).toBeLessThan(0.7);
    expect(actions[1]).toMatchObject({ owner: "Priya", priority: "low" });
  });

  it("splits compound assignments and folds short restatements into the detailed task", () => {
    const { actions } = run("Anita: I'll send the updated API contract to the mobile team.\nPriya: To recap, Rahul will fix the timeout bug and Anita will send the API contract.");
    expect(actions.map((a) => [a.owner, a.task])).toEqual([
      ["Anita", "Send the updated API contract to the mobile team"],
      ["Rahul", "Fix the timeout bug"],
    ]);
  });

  it("rewrites first-person words to the requester and drops politeness padding", () => {
    const { actions } = run("Anita: Rahul, could you review my pagination PR when you get a chance?");
    expect(actions[0]).toMatchObject({ owner: "Rahul", task: "Review Anita's pagination PR", priority: "low" });
  });

  it("merges a task restated during the wrap-up, keeping the due date", () => {
    const { actions } = run("Priya: I'll update the migration runbook.\nMeera: To recap, Priya will update the migration runbook by Thursday.");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ owner: "Priya", dueDate: "2026-11-19" });
  });
});
