import { AppError, type AppErrorCode } from "@deepfield/contracts";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";

const MESSAGES = {
  llm: "请先在设置中配置 LLM，选择当前 Profile 并填写 API Key。",
  search: "请先在设置中配置 Search，选择当前 Profile 并填写 API Key。",
  both: "请先在设置中配置 LLM 和 Search，选择当前 Profile 并填写 API Key。",
  unavailable: "无法读取配置，请稍后重试或前往设置检查。",
} as const;

export class ResearchReadinessError extends AppError {
  constructor(code: keyof typeof MESSAGES, identity: AppErrorCode = "INTERNAL.UNKNOWN") {
    super(identity, code === "llm" || code === "search" ? { service: code } : undefined);
    this.message = MESSAGES[code];
    this.name = "ResearchReadinessError";
  }
}

/** UI preflight only; the application service still enforces runtime readiness. */
export async function assertResearchReady(api: DesktopApi, needs: { search: boolean }): Promise<void> {
  let settings;
  try {
    settings = await api.settings.get();
  } catch {
    throw new ResearchReadinessError("unavailable");
  }
  const llmProfile = settings.llm.profiles.find((profile) => profile.id === settings.llm.activeProfileId);
  const searchProfile = settings.search.profiles.find((profile) => profile.id === settings.search.activeProfileId);
  const llm = llmProfile?.hasCredential === true;
  const search = !needs.search || searchProfile?.hasCredential === true;
  if (!llm || !search) throw new ResearchReadinessError(
    !llm && !search ? "both" : !llm ? "llm" : "search",
    !llmProfile || (needs.search && !searchProfile) ? "CONFIG.PROFILE_MISSING" : "CONFIG.CREDENTIAL_MISSING",
  );
}
