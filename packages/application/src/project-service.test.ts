import { afterEach, describe, expect, it } from "vitest";
import type { CreateProjectInput } from "@deepfield/contracts";
import { ProjectService, ProjectServiceError } from "./project-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("project service", () => {
  it("creates a direct-ui project with a silent activity and never creates a Conversation", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new ProjectService(db.repos);

    const project = service.create({
      industry: "人形机器人",
      scope: {},
      launchSource: "direct-ui",
    });

    expect(project.industry).toBe("人形机器人");
    expect(project.status).toBe("draft");

    const conversationCount = db.db
      .prepare("SELECT count(*) AS n FROM conversations")
      .get() as unknown as { n: number };
    expect(conversationCount.n).toBe(0);

    const activities = db.repos.activities.listByProject(project.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      type: "project.created",
      source: "direct-ui",
      importance: "silent",
    });

    expect(db.repos.conversations.listRecent()).toEqual([]);
  });

  it("re-validates the input and rejects blank industries, invalid scope and launch source", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new ProjectService(db.repos);

    expect(() =>
      service.create({ industry: "   ", scope: {}, launchSource: "direct-ui" }),
    ).toThrow(ProjectServiceError);
    expect(() =>
      service.create({
        industry: "x",
        scope: { focus: 1 },
        launchSource: "direct-ui",
      } as unknown as CreateProjectInput),
    ).toThrow(ProjectServiceError);
    expect(() =>
      service.create({
        industry: "x",
        scope: {},
        launchSource: "ui",
      } as unknown as CreateProjectInput),
    ).toThrow(ProjectServiceError);

    expect(db.repos.projects.list()).toHaveLength(0);
  });

  it("delegates list to the repository", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new ProjectService(db.repos);
    service.create({ industry: "人形机器人", scope: {}, launchSource: "chat" });
    service.create({ industry: "低空经济", scope: {}, launchSource: "chat" });
    expect(service.list()).toHaveLength(2);
  });
});
