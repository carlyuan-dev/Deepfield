import { describe, expect, it } from "vitest";
import { ToolPolicy, type PolicyDecision, type ToolPolicyRequest } from "./policy.js";
import { ToolSet, ToolSetError, type ToolGrant } from "./tool-set.js";
import type { ToolRunContext } from "./definition.js";
import type { JsonObject, ToolIdentity } from "@deepfield/contracts";

const fetchV1: ToolIdentity = { name: "fetch_url", version: 1 };
const fetchV2: ToolIdentity = { name: "fetch_url", version: 2 };

function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
    identity: { name: "fetch_url", version: 1 },
    actor: "developer_probe",
    effect: "network.read.public",
    ...overrides,
  };
}

function context(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    traceId: "trace-1",
    actor: "developer_probe",
    ...overrides,
  };
}

function request(overrides: Partial<ToolPolicyRequest> = {}): ToolPolicyRequest {
  return {
    identity: fetchV1,
    effect: "network.read.public",
    input: {},
    ...overrides,
  };
}

describe("ToolPolicy deny-by-default", () => {
  const policy = new ToolPolicy();

  function expectDenied(
    req: ToolPolicyRequest,
    ctx: ToolRunContext,
    code: "tool_not_allowed" | "permission_denied",
  ): PolicyDecision {
    const decision = policy.evaluate(req, ctx);
    expect(decision).toEqual({ decision: "deny", code });
    let executorCalls = 0;
    if (decision.decision === "allow") {
      executorCalls += 1;
    }
    expect(executorCalls).toBe(0);
    return decision;
  }

  it("denies when the context carries no ToolSet", () => {
    expectDenied(request(), context(), "tool_not_allowed");
  });

  it("denies when the ToolSet has no grant for the exact version", () => {
    const toolSet = new ToolSet([grant()]);
    expectDenied(request({ identity: fetchV2 }), context({ toolSet }), "tool_not_allowed");
    expectDenied(request(), context({ toolSet: new ToolSet([]) }), "tool_not_allowed");
  });

  it("denies when the actor does not match the grant", () => {
    const toolSet = new ToolSet([grant({ actor: "developer_probe" })]);
    expectDenied(request(), context({ toolSet, actor: "main_agent" }), "permission_denied");
  });

  it("denies when the project does not match the grant", () => {
    const toolSet = new ToolSet([grant({ projectId: "project-1" })]);
    expectDenied(request(), context({ toolSet, projectId: "project-2" }), "permission_denied");
    expectDenied(request(), context({ toolSet }), "permission_denied");
  });

  it("denies when the tool effect is not allowed by the grant", () => {
    const toolSet = new ToolSet([grant({ effect: "network.read.public" })]);
    expectDenied(request({ effect: "project.read" }), context({ toolSet }), "permission_denied");
  });

  it("denies hosts outside the grant host patterns", () => {
    const toolSet = new ToolSet([grant({ hostPatterns: ["*.example.com"] })]);
    expectDenied(request({ input: { url: "https://evil.com" } }), context({ toolSet }), "permission_denied");
  });

  it("denies parameter limits above the grant maximums", () => {
    const toolSet = new ToolSet([grant({ maxResults: 3, maxBytes: 1024 })]);
    expectDenied(request({ input: { maxResults: 5 } }), context({ toolSet }), "permission_denied");
    expectDenied(request({ input: { maxBytes: 2048 } }), context({ toolSet }), "permission_denied");
  });

  it("returns confirmation_required when the grant demands a missing confirmation", () => {
    const toolSet = new ToolSet([grant({ confirmationKind: "developer-probe-ok" })]);
    const decision = policy.evaluate(request(), context({ toolSet }));
    expect(decision).toEqual({
      decision: "confirmation_required",
      confirmationKind: "developer-probe-ok",
    });
    expect(decision.decision).not.toBe("deny");
  });

  it("allows the valid developer probe grant with matching confirmation", () => {
    const toolSet = new ToolSet([
      grant({ confirmationKind: "developer-probe-ok", hostPatterns: ["*.example.com"], maxResults: 3 }),
    ]);
    const decision = policy.evaluate(
      request({ input: { url: "https://news.example.com", maxResults: 2 } }),
      context({ toolSet, confirmations: new Set(["developer-probe-ok"]) }),
    );
    expect(decision).toEqual({ decision: "allow" });
    let executorCalls = 0;
    if (decision.decision === "allow") {
      executorCalls += 1;
    }
    expect(executorCalls).toBe(1);
  });

  it("allows hosts and limits within the grant bounds", () => {
    const toolSet = new ToolSet([grant({ hostPatterns: ["*.example.com"], maxResults: 3 })]);
    expect(
      policy.evaluate(request({ input: { url: "https://example.com" } }), context({ toolSet })),
    ).toEqual({ decision: "allow" });
    expect(
      policy.evaluate(
        request({ input: { url: "https://sub.example.com", maxResults: 3 } }),
        context({ toolSet }),
      ),
    ).toEqual({ decision: "allow" });
  });
});

describe("ToolSet construction", () => {
  it("rejects wildcard and non-positive-integer versions", () => {
    for (const version of [0, -1, 1.5]) {
      expect(() =>
        new ToolSet([grant({ identity: { name: "fetch_url", version } })]),
      ).toThrow(ToolSetError);
    }
    for (const version of ["*", "latest"]) {
      expect(() =>
        new ToolSet([
          grant({ identity: { name: "fetch_url", version } as unknown as ToolIdentity }),
        ]),
      ).toThrow(ToolSetError);
    }
  });

  it("rejects duplicate grants for the same exact identity", () => {
    expect(() => new ToolSet([grant(), grant()])).toThrow(ToolSetError);
  });

  it("rejects unknown actor and effect values", () => {
    expect(() =>
      new ToolSet([grant({ actor: "root" as unknown as ToolGrant["actor"] })]),
    ).toThrow(ToolSetError);
    expect(() =>
      new ToolSet([grant({ effect: "shell.exec" as unknown as ToolGrant["effect"] })]),
    ).toThrow(ToolSetError);
  });

  it("defensively copies grants and is deeply immutable", () => {
    const original = grant({ hostPatterns: ["*.example.com"] });
    const toolSet = new ToolSet([original]);
    original.identity.name = "mutated";
    (original.hostPatterns as string[]).push("*.evil.com");
    const stored = toolSet.get(fetchV1);
    expect(stored).toBeDefined();
    expect(stored!.identity).toEqual({ name: "fetch_url", version: 1 });
    expect(stored!.hostPatterns).toEqual(["*.example.com"]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored!.identity)).toBe(true);
    expect(Object.isFrozen(stored!.hostPatterns)).toBe(true);
    expect(() => {
      stored!.identity.name = "hacked";
    }).toThrow(TypeError);
    expect(() => {
      (stored!.hostPatterns as string[]).push("hacked");
    }).toThrow(TypeError);
  });

  it("matches grants only by exact name and version", () => {
    const toolSet = new ToolSet([grant()]);
    expect(toolSet.has(fetchV1)).toBe(true);
    expect(toolSet.has(fetchV2)).toBe(false);
    expect(toolSet.has({ name: "other", version: 1 })).toBe(false);
  });

  it("an empty ToolSet grants nothing", () => {
    const toolSet = new ToolSet([]);
    expect(toolSet.size).toBe(0);
    expect(toolSet.has(fetchV1)).toBe(false);
  });
});
