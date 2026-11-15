import { readFileSync } from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";

const SAMPLE = readFileSync(new URL("../../samples/sprint-planning.vtt", import.meta.url), "utf8");

let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(":memory:");
  app = createApp(store, { today: () => "2026-11-25" });
});
afterEach(() => store.close());

async function seed() {
  const res = await request(app).post("/api/meetings").send({ title: "Sprint 42 planning", meetingDate: "2026-11-16", transcript: SAMPLE });
  expect(res.status).toBe(201);
  return res.body as { meeting: { id: number }; actions: { id: number; owner: string | null; task: string; dueDate: string | null; status: string }[] };
}

describe("meetings API", () => {
  it("creates a meeting and extracts owners, dates and decisions from a VTT export", async () => {
    const { meeting, actions } = await seed();
    const detail = await request(app).get(`/api/meetings/${meeting.id}`);
    expect(detail.body.meeting.participants).toEqual(["Priya Sharma", "Rahul Verma", "Anita Desai"]);
    expect(detail.body.meeting.decisions.map((d: { text: string }) => d.text)).toEqual(["On payments, we've decided to go with Razorpay for the India launch"]);
    const summary = actions.map((a) => `${a.owner}|${a.dueDate}|${a.task}`);
    expect(summary).toEqual(expect.arrayContaining([
      "Rahul Verma|2026-11-17|Fix the checkout timeout bug",
      "Anita Desai|2026-11-20|Send the updated API contract to the mobile team",
      "Priya Sharma|2026-11-18|Set up the staging environment",
    ]));
  });

  it("lists meetings with action counts and deletes with cascade", async () => {
    const { meeting, actions } = await seed();
    const list = await request(app).get("/api/meetings");
    expect(list.body[0]).toMatchObject({ id: meeting.id, actionCount: actions.length, openCount: actions.length });
    expect(list.body[0].utterances).toBeUndefined();
    expect((await request(app).delete(`/api/meetings/${meeting.id}`)).status).toBe(204);
    expect((await request(app).get("/api/actions")).body).toEqual([]);
    expect((await request(app).delete(`/api/meetings/${meeting.id}`)).status).toBe(404);
  });

  it("validates input", async () => {
    const bad = await request(app).post("/api/meetings").send({ title: "", meetingDate: "2026-02-30", transcript: "x" });
    expect(bad.status).toBe(422);
    expect(bad.body.details.map((d: { path: string }) => d.path)).toEqual(["title", "meetingDate"]);
    const empty = await request(app).post("/api/meetings").send({ title: "t", meetingDate: "2026-11-16", transcript: "WEBVTT\n\n" });
    expect(empty.status).toBe(422);
    const malformed = await request(app).post("/api/meetings").set("Content-Type", "application/json").send("{oops");
    expect(malformed.status).toBe(400);
    expect((await request(app).get("/api/meetings/abc")).status).toBe(400);
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });
});

describe("actions API", () => {
  it("filters by owner, status, overdue and unassigned", async () => {
    const { actions } = await seed();
    const rahul = await request(app).get("/api/actions?owner=rahul%20verma");
    expect(rahul.body.every((a: { owner: string }) => a.owner === "Rahul Verma")).toBe(true);
    const overdue = await request(app).get("/api/actions?overdue=true");
    expect(overdue.body.length).toBeGreaterThan(0);
    expect(overdue.body.every((a: { dueDate: string }) => a.dueDate < "2026-11-25")).toBe(true);
    const unassigned = await request(app).get("/api/actions?unassigned=true");
    expect(unassigned.body.every((a: { owner: string | null }) => a.owner === null)).toBe(true);
    expect(unassigned.body.length + (await request(app).get("/api/actions?owner=x")).body.length).toBeLessThan(actions.length);
    expect((await request(app).get("/api/actions?status=bogus")).status).toBe(422);
  });

  it("updates status, owner and due date; done items stop being overdue", async () => {
    const { actions } = await seed();
    const target = actions.find((a) => a.dueDate)!;
    const res = await request(app).patch(`/api/actions/${target.id}`).send({ status: "done", owner: "Meera" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "done", owner: "Meera" });
    const overdueIds = (await request(app).get("/api/actions?overdue=true")).body.map((a: { id: number }) => a.id);
    expect(overdueIds).not.toContain(target.id);
    const redate = await request(app).patch(`/api/actions/${target.id}`).send({ dueDate: "2026-12-01" });
    expect(redate.body).toMatchObject({ dueDate: "2026-12-01", duePhrase: null });
  });

  it("rejects bad patches", async () => {
    const { actions } = await seed();
    const id = actions[0].id;
    expect((await request(app).patch(`/api/actions/${id}`).send({})).status).toBe(422);
    expect((await request(app).patch(`/api/actions/${id}`).send({ status: "archived" })).status).toBe(422);
    expect((await request(app).patch(`/api/actions/${id}`).send({ meetingId: 9 })).status).toBe(422);
    expect((await request(app).patch("/api/actions/9999").send({ status: "done" })).status).toBe(404);
  });

  it("summarises workload per owner", async () => {
    await seed();
    const owners = (await request(app).get("/api/owners")).body;
    expect(owners[0]).toHaveProperty("overdue");
    expect(owners.map((o: { owner: string }) => o.owner)).toContain("Rahul Verma");
  });
});

describe("exports", () => {
  it("renders markdown minutes grouped by owner", async () => {
    const { meeting } = await seed();
    const res = await request(app).get(`/api/meetings/${meeting.id}/minutes.md`);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.text).toContain("# Sprint 42 planning");
    expect(res.text).toContain("### Rahul Verma");
    expect(res.text).toMatch(/- \[ \] Fix the checkout timeout bug \(due 2026-11-17, high priority\)/);
  });

  it("produces a valid iCalendar feed with folded lines and escaped text", async () => {
    await seed();
    const res = await request(app).get("/api/actions.ics");
    expect(res.headers["content-type"]).toMatch(/text\/calendar/);
    const ics: string = res.text;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261117");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)!.length).toBe(ics.match(/END:VEVENT/g)!.length);
  });
});
