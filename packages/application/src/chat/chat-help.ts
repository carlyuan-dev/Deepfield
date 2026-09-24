export interface ChatHelpTool { name: string; description: string }
export interface CapabilityUserHelp { name: string; markdown?: string }

/** Only a whole-message request for an overview is handled without the agent. */
export function isChatHelpRequest(content: string): boolean {
  return content.trim() === "/help";
}

export function renderChatHelp(tools: readonly ChatHelpTool[], capabilities: readonly CapabilityUserHelp[]): string {
  const toolLines = tools.map(tool => `- **${tool.name}**：${tool.description}`);
  const capabilityLines = capabilities.map(entry => `### ${entry.name}${entry.markdown ? `\n\n${entry.markdown.trim()}` : ""}`);
  return `## 工具\n\n${toolLines.length ? toolLines.join("\n") : "当前没有可用工具。"}\n\n## 能力\n\n${capabilityLines.length ? capabilityLines.join("\n\n") : "当前没有可用能力。"}`;
}
