export type Cleanup = () => void | Promise<void>;

export interface ResourceScopeIssue {
  readonly code: "cleanup_failed";
}

export interface ResourceScope {
  defer(cleanup: Cleanup): void;
  dispose(): Promise<void>;
  readonly issues: readonly ResourceScopeIssue[];
}

export function createResourceScope(): ResourceScope {
  const cleanups: Cleanup[] = [];
  const issues: ResourceScopeIssue[] = [];
  let disposal: Promise<void> | undefined;

  return {
    defer(cleanup) {
      if (disposal !== undefined) throw new Error("resource_scope_disposed");
      cleanups.push(cleanup);
    },
    dispose() {
      disposal ??= (async () => {
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch {
            issues.push({ code: "cleanup_failed" });
          }
        }
        cleanups.length = 0;
      })();
      return disposal;
    },
    get issues() {
      return issues.map((issue) => ({ ...issue }));
    },
  };
}
