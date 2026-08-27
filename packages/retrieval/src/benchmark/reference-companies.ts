import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CompanyCategory = "chinese" | "overseas";

export interface ReferenceCompanyV1 {
  id: string;
  name: string;
  category: CompanyCategory;
  domains: readonly string[];
}

export interface ReferenceSetV1 {
  version: string;
  companies: readonly ReferenceCompanyV1[];
}

const COMPANY_FILE = join(import.meta.dirname, "..", "..", "..", "..", "benchmarks", "humanoid-robot", "reference-companies-v1.json");

/** Frozen v1 technical reference set (12 companies; see design spec section 15). */
export const REFERENCE_COMPANIES_V1: readonly ReferenceCompanyV1[] = [
  { id: "tesla", name: "Tesla", category: "overseas", domains: ["tesla.com"] },
  { id: "figure-ai", name: "Figure AI", category: "overseas", domains: ["figure.ai"] },
  { id: "agility-robotics", name: "Agility Robotics", category: "overseas", domains: ["agilityrobotics.com"] },
  { id: "apptronik", name: "Apptronik", category: "overseas", domains: ["apptronik.com"] },
  { id: "1x", name: "1X", category: "overseas", domains: ["1x.tech"] },
  { id: "boston-dynamics", name: "Boston Dynamics", category: "overseas", domains: ["bostondynamics.com"] },
  { id: "unitree", name: "宇树科技", category: "chinese", domains: ["unitree.com"] },
  { id: "ubtech", name: "优必选", category: "chinese", domains: ["ubtech.com"] },
  { id: "fourier", name: "傅利叶智能", category: "chinese", domains: ["fft-ai.com"] },
  { id: "agibot", name: "智元机器人", category: "chinese", domains: ["zhiyuan-robot.com"] },
  { id: "galbot", name: "银河通用", category: "chinese", domains: ["galbot.com"] },
  { id: "engineai", name: "众擎机器人", category: "chinese", domains: ["engine-ai.cn"] },
];

export function readReferenceCompaniesV1(): ReferenceSetV1 {
  const parsed = JSON.parse(readFileSync(COMPANY_FILE, "utf8")) as {
    version?: unknown;
    companies?: unknown;
  };
  if (parsed.version !== "v1" || !Array.isArray(parsed.companies)) {
    throw new Error("invalid reference-companies-v1.json");
  }
  const companies: ReferenceCompanyV1[] = [];
  for (const entry of parsed.companies) {
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      (item.category !== "chinese" && item.category !== "overseas") ||
      !Array.isArray(item.domains) ||
      !item.domains.every((domain) => typeof domain === "string")
    ) {
      throw new Error("invalid company entry");
    }
    companies.push({ id: item.id, name: item.name, category: item.category, domains: item.domains as string[] });
  }
  return { version: "v1", companies };
}
