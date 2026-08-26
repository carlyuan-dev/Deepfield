import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectId } from "@deepfield/contracts";
import { toActivity } from "./mappers.js";
import type { ActivityRepository, ActivityRow, ProjectActivityEvent } from "./types.js";

export function createActivityRepository(db: DatabaseSync): ActivityRepository {
  return {
    append(
      projectId: ProjectId,
      type: string,
      source: string,
      importance: string,
      summary: string,
      payload?: unknown,
    ): ProjectActivityEvent {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const payloadJson = payload === undefined ? null : JSON.stringify(payload);
      db.prepare(
        "INSERT INTO project_activity_events(id, project_id, type, source, importance, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, projectId, type, source, importance, summary, payloadJson, createdAt);
      if (payload === undefined) {
        return { id, projectId, type, source, importance, summary, createdAt };
      }
      return { id, projectId, type, source, importance, summary, payload, createdAt };
    },

    listByProject(projectId: ProjectId): ProjectActivityEvent[] {
      const rows = db
        .prepare(
          "SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY created_at ASC",
        )
        .all(projectId) as unknown as ActivityRow[];
      return rows.map(toActivity);
    },
  };
}
