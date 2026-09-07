import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories, migrate, openDatabase } from "./index.js";
import type { Repositories } from "./index.js";

function openTestRepos(): { repos: Repositories; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-tx-"));
  const db = openDatabase(join(dir, "deepfield.sqlite"));
  migrate(db);
  const repos = createRepositories(db);
  return {
    repos,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const open: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of open.splice(0)) {
    cleanup();
  }
});

describe("repository transactions", () => {
  it("rolls back all writes when work throws and preserves the original error", () => {
    const { repos, cleanup } = openTestRepos();
    open.push(cleanup);
    const conversation = repos.conversations.create();

    const boom = new Error("boom in the middle");
    expect(() =>
      repos.runInTransaction(() => {
        repos.messages.append(conversation.id, "user", "first");
        throw boom;
      }),
    ).toThrowError(boom);
    expect(repos.messages.listByConversation(conversation.id)).toEqual([]);
  });

  it("commits all writes when work succeeds", () => {
    const { repos, cleanup } = openTestRepos();
    open.push(cleanup);
    const conversation = repos.conversations.create();

    const result = repos.runInTransaction(() => {
      repos.messages.append(conversation.id, "user", "a");
      return repos.messages.append(conversation.id, "assistant", "b");
    });
    expect(result.role).toBe("assistant");
    const messages = repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content)).toEqual(["a", "b"]);
  });

  it("exposes runInTransaction through the public Repositories API", () => {
    const { repos, cleanup } = openTestRepos();
    open.push(cleanup);
    expect(typeof repos.runInTransaction).toBe("function");
  });
});
