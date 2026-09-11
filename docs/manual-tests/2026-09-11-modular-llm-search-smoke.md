# Modular LLM and Search smoke checklist

Use test credentials only. While checking each flow, confirm API keys are never shown in normal UI text, errors, tool activity, chat output, or research reports.

- [ ] DeepSeek migration and editing: start with an existing `deepseek.apiKey`, confirm the migrated DeepSeek LLM Profile is available, edit its connection fields, diagnose the unsaved draft, save it, and activate it. Leaving API Key blank while editing must preserve the stored credential.
- [ ] Alternative LLM protocol: create either an Anthropic Messages Profile or a Qwen OpenAI-compatible Profile, enter its model and connection fields, and confirm draft diagnostics succeed without saving first.
- [ ] Search providers: create and diagnose one Profile for each of MetaSo, Baidu, Zhipu, Tavily, and Serper. Confirm provider-specific options appear where applicable and no fallback provider is used after a failure.
- [ ] Chat network boundary: with web search off, send a message and confirm no search/fetch activity appears. With web search on, ask a question requiring several sources and confirm multiple `web_search`/`fetch_url` activities are visible and the final answer contains usable links.
- [ ] Company research stages: start company research and confirm the raw Markdown report succeeds with links and opens by default. Confirm structuring follows automatically and produces no additional web-search or fetch activity.
- [ ] Request snapshot isolation: start one task, change the active LLM or Search Profile, then start another task. Confirm the running task keeps its original Profile and only the new task uses the newly active Profile.
