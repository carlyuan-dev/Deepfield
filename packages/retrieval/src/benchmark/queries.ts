import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BenchmarkQueryV1 {
  id: string;
  query: string;
}

export interface QuerySetV1 {
  version: string;
  queries: readonly BenchmarkQueryV1[];
}

const QUERY_FILE = join(import.meta.dirname, "..", "..", "..", "..", "benchmarks", "humanoid-robot", "queries-v1.json");

/** Frozen v1 query set (10 approved queries; see design spec section 15). */
export const QUERIES_V1: readonly BenchmarkQueryV1[] = [
  { id: "q1", query: "人形机器人 公司" },
  { id: "q2", query: "人形机器人 整机 企业" },
  { id: "q3", query: "人形机器人 产业链 核心零部件 公司" },
  { id: "q4", query: "人形机器人 减速器 企业" },
  { id: "q5", query: "人形机器人 伺服电机 企业" },
  { id: "q6", query: "人形机器人 传感器 企业" },
  { id: "q7", query: "具身智能 人形机器人 创业公司" },
  { id: "q8", query: "humanoid robot companies official website" },
  { id: "q9", query: "humanoid robot startup company" },
  { id: "q10", query: "humanoid robot actuator supplier" },
];

export function readQueriesV1(): QuerySetV1 {
  const parsed = JSON.parse(readFileSync(QUERY_FILE, "utf8")) as {
    version?: unknown;
    queries?: unknown;
  };
  if (parsed.version !== "v1" || !Array.isArray(parsed.queries)) {
    throw new Error("invalid queries-v1.json");
  }
  const queries: BenchmarkQueryV1[] = [];
  for (const entry of parsed.queries) {
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.query !== "string") {
      throw new Error("invalid query entry");
    }
    queries.push({ id: item.id, query: item.query });
  }
  return { version: "v1", queries };
}
