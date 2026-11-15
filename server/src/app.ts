import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { parseISODate, toISO } from "./dates.js";
import type { Store } from "./db.js";
import { actionsIcs, minutesMarkdown } from "./exporters.js";
import { extract } from "./extractor.js";
import { parseTranscript, participants } from "./transcript.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").refine((s) => {
  try { parseISODate(s); return true; } catch { return false; }
}, "not a real calendar date");

const MeetingIn = z.object({
  title: z.string().trim().min(1).max(200),
  meetingDate: isoDate,
  transcript: z.string().min(1).max(1_000_000),
  format: z.enum(["vtt", "srt", "plain"]).optional(),
});

const ActionPatch = z.object({
  task: z.string().trim().min(1).max(500).optional(),
  owner: z.string().trim().min(1).max(100).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(["open", "in_progress", "done"]).optional(),
}).strict().refine((p) => Object.keys(p).length > 0, "patch must change at least one field");

const ActionQuery = z.object({
  owner: z.string().optional(),
  status: z.enum(["open", "in_progress", "done"]).optional(),
  meetingId: z.coerce.number().int().positive().optional(),
  overdue: z.enum(["true", "false"]).optional(),
  unassigned: z.enum(["true", "false"]).optional(),
});

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "id must be a positive integer");
  return id;
};

export interface AppOptions {
  today?: () => string; // injectable clock for deterministic tests
  staticDir?: string;
}

export function createApp(store: Store, opts: AppOptions = {}) {
  const today = opts.today ?? (() => toISO(new Date()));
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/meetings", (req, res) => {
    const body = MeetingIn.parse(req.body);
    const utterances = parseTranscript(body.transcript, body.format);
    if (!utterances.length) throw new HttpError(422, "transcript contains no recognisable speech");
    const people = participants(utterances);
    const { actions, decisions } = extract(utterances, parseISODate(body.meetingDate), people);
    const result = store.createMeeting(
      { title: body.title, meetingDate: body.meetingDate, participants: people, decisions, utterances },
      actions,
    );
    res.status(201).json(result);
  });

  app.get("/api/meetings", (_req, res) => {
    res.json(store.listMeetings());
  });

  app.get("/api/meetings/:id", (req, res) => {
    const meeting = store.getMeeting(idParam(req));
    if (!meeting) throw new HttpError(404, "meeting not found");
    res.json({ meeting, actions: store.listActions({ meetingId: meeting.id }) });
  });

  app.get("/api/meetings/:id/minutes.md", (req, res) => {
    const meeting = store.getMeeting(idParam(req));
    if (!meeting) throw new HttpError(404, "meeting not found");
    res.type("text/markdown").send(minutesMarkdown(meeting, store.listActions({ meetingId: meeting.id })));
  });

  app.delete("/api/meetings/:id", (req, res) => {
    if (!store.deleteMeeting(idParam(req))) throw new HttpError(404, "meeting not found");
    res.status(204).end();
  });

  app.get("/api/actions", (req, res) => {
    const q = ActionQuery.parse(req.query);
    res.json(store.listActions({
      owner: q.owner, status: q.status, meetingId: q.meetingId,
      overdueAsOf: q.overdue === "true" ? today() : undefined,
      unassigned: q.unassigned === "true",
    }));
  });

  app.get("/api/actions.ics", (_req, res) => {
    res.type("text/calendar").send(actionsIcs(store.listActions()));
  });

  app.patch("/api/actions/:id", (req, res) => {
    const updated = store.updateAction(idParam(req), ActionPatch.parse(req.body));
    if (!updated) throw new HttpError(404, "action not found");
    res.json(updated);
  });

  app.get("/api/owners", (_req, res) => {
    res.json(store.ownerSummary(today()));
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not found")));

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(staticDir, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(422).json({ error: "validation failed", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "malformed JSON body" });
    } else if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "request body too large" });
    } else {
      console.error(err);
      res.status(500).json({ error: "internal server error" });
    }
  });

  return app;
}
