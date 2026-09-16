import { toPublicError } from "@deepfield/contracts";

/** Presentation stays in the UI; raw exception messages are never display input. */
export function configurationErrorText(value: unknown, context: "diagnostic" | "research", service?: "llm" | "search"): string | undefined {
  const error = toPublicError(value);
  const name = (error.context?.service ?? service) === "llm" ? "LLM" : (error.context?.service ?? service) === "search" ? "Search" : "服务";
  switch (error.code) {
    case "CONFIG.CREDENTIAL_MISSING": return context === "diagnostic" ? `${name} 未填写 API Key，请填写后测试连接。` : `请先在设置中填写当前 ${name} Profile 的 API Key。`;
    case "CONFIG.PROFILE_MISSING": return `请先在设置中配置并选择当前 ${name} Profile。`;
    case "CONFIG.INVALID": return `${name} 配置无效，请检查服务地址、模型及必填项。`;
    case "EXTERNAL.AUTHENTICATION_FAILED": return `${name} 认证失败，请检查 API Key 是否有效及其权限。`;
    case "EXTERNAL.TIMEOUT": return `${name} 请求超时，请检查网络后重试。`;
    case "EXTERNAL.RATE_LIMITED": return `${name} 请求过于频繁，请稍后重试。`;
    case "EXTERNAL.UNAVAILABLE": return `${name} 连接不可用，请检查配置和网络后重试。`;
    default: return undefined;
  }
}

export function diagnosticErrorText(value: unknown, service: "llm" | "search"): string {
  return configurationErrorText(value, "diagnostic", service) ?? "暂时无法完成连接检测，请稍后重试。";
}
