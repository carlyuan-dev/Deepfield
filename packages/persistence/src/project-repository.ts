import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreateProjectInput, ConversationId, Project, ProjectId } from "@deepfield/contracts";
import { createActivityRepository } from "./activity-repository.js";
import { insertConversationRow } from "./conversation-repository.js";
import { toProject } from "./mappers.js";
import type { ProjectRepository, ProjectRow } from "./types.js";

export function insertProjectRow(db: DatabaseSync, project: Project): void {
  db.prepare(
    "INSERT INTO projects(id, industry, scope_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    project.id,
    project.industry,
    JSON.stringify(project.scope),
    project.status,
    project.createdAt,
    project.updatedAt,
  );
}

export function createProjectRepository(db: DatabaseSync): ProjectRepository {
  const activities = createActivityRepository(db);

  return {
    createWithConversation(input: CreateProjectInput): Project {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID() as ProjectId,
        industry: input.industry,
        scope: input.scope,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };

      db.exec("BEGIN IMMEDIATE;");
      try {
        insertProjectRow(db, project);
        insertConversationRow(db, {
          id: randomUUID() as ConversationId,
          projectId: project.id,
          hasUserMessage: false,
          createdAt: now,
          updatedAt: now,
        });
        activities.append(
          project.id,
          "project.created",
          input.launchSource,
          "silent",
          `创建项目：${project.industry}`,
        );
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      return project;
    },

    list(): Project[] {
      const rows = db
        .prepare("SELECT * FROM projects ORDER BY created_at ASC")
        .all() as unknown as ProjectRow[];
      return rows.map(toProject);
    },

    getById(projectId: ProjectId): Project | undefined {
      const row = db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(projectId) as unknown as ProjectRow | undefined;
      return row ? toProject(row) : undefined;
    },
  };
}
