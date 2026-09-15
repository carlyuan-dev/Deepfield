import { useEffect, useRef, useState } from "react";
import { DEFAULT_DEEPSEEK_MODEL_ID, LLM_PROVIDER_PRESETS, type DesktopApi, type DiagnosticResult, type LlmProfileDraft, type SearchProfileDraft, type SettingsView as SettingsData } from "@deepfield/contracts";

export interface SettingsViewProps { api: DesktopApi; onKeySaved(): void }
type Module = "llm" | "search";
type DiagnosticState = DiagnosticResult | "testing";
const newLlm = (): LlmProfileDraft => ({ name: "DeepSeek", provider: "deepseek", protocol: "openai_compatible", baseUrl: LLM_PROVIDER_PRESETS.deepseek.baseUrl, modelId: DEFAULT_DEEPSEEK_MODEL_ID, contextWindow: 128000 });
const llmDraft = (p: SettingsData["llm"]["profiles"][number]): LlmProfileDraft => ({ id: p.id, name: p.name, provider: p.provider, protocol: p.protocol, baseUrl: p.baseUrl, modelId: p.modelId, contextWindow: p.contextWindow });
const searchDraft = (p: SettingsData["search"]["profiles"][number]): SearchProfileDraft => ({ id: p.id, name: p.name, provider: p.provider, baseUrl: p.baseUrl, options: p.options });

function Diagnostic({ value }: { value: DiagnosticResult | "testing" | undefined }) {
  if (!value) return <span className="diagnostic idle">未检测</span>;
  if (value === "testing") return <span className="diagnostic testing">检测中…</span>;
  return value.ok ? <span className="diagnostic success">连接正常 · {value.latencyMs}ms</span> : <span className="diagnostic failure">连接失败 · {value.message}</span>;
}

export function SettingsView({ api, onKeySaved }: SettingsViewProps) {
  const [module, setModule] = useState<Module>("llm");
  const [data, setData] = useState<SettingsData>();
  const [llm, setLlm] = useState<LlmProfileDraft>(newLlm);
  const [search, setSearch] = useState<SearchProfileDraft>();
  const [llmUiKey, setLlmUiKey] = useState("new:llm:initial");
  const [searchUiKey, setSearchUiKey] = useState("new:search:initial");
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticState>>({});
  const [error, setError] = useState<string>();
  const requestIds = useRef(new Map<string, number>());
  const temporarySequence = useRef(0);

  useEffect(() => { void api.settings.get().then((view) => {
    setData(view);
    const lp = view.llm.profiles.find((p) => p.id === view.llm.activeProfileId) ?? view.llm.profiles[0];
    if (lp) { setLlm(llmDraft(lp)); setLlmUiKey(lp.id); }
    const sp = view.search.profiles.find((p) => p.id === view.search.activeProfileId) ?? view.search.profiles[0];
    if (sp) { setSearch(searchDraft(sp)); setSearchUiKey(sp.id); }
    else if (view.search.manifests[0]) setSearch({ name: view.search.manifests[0].displayName, provider: view.search.manifests[0].id, baseUrl: view.search.manifests[0].defaultBaseUrl, options: {} });
  }, () => setError("无法读取设置，请重试")); }, [api]);

  const diagnosticKey = `${module}:${module === "llm" ? llmUiKey : searchUiKey}`;
  const diagnostic = diagnostics[diagnosticKey];
  const reset = () => {
    requestIds.current.set(diagnosticKey, (requestIds.current.get(diagnosticKey) ?? 0) + 1);
    setDiagnostics((values) => {
      if (!(diagnosticKey in values)) return values;
      const next = { ...values };
      delete next[diagnosticKey];
      return next;
    });
  };
  const updateLlm = (patch: Partial<LlmProfileDraft>) => { setLlm((value) => ({ ...value, ...patch })); reset(); };
  const updateSearch = (patch: Partial<SearchProfileDraft>) => { setSearch((value) => value ? ({ ...value, ...patch }) : value); reset(); };
  const updateLlmApiKey = (apiKey: string) => {
    setLlm((value) => {
      const { apiKey: _apiKey, ...withoutApiKey } = value;
      return apiKey ? { ...withoutApiKey, apiKey } : withoutApiKey;
    });
    reset();
  };
  const updateSearchApiKey = (apiKey: string) => {
    setSearch((value) => {
      if (!value) return value;
      const { apiKey: _apiKey, ...withoutApiKey } = value;
      return apiKey ? { ...withoutApiKey, apiKey } : withoutApiKey;
    });
    reset();
  };
  const accept = (view: SettingsData) => { setData(view); onKeySaved(); };
  const diagnose = async () => {
    const kind = module; const key = diagnosticKey;
    const id = (requestIds.current.get(key) ?? 0) + 1;
    requestIds.current.set(key, id);
    setDiagnostics((values) => ({ ...values, [key]: "testing" }));
    const result = kind === "llm" ? await api.settings.diagnoseLlm(llm) : await api.settings.diagnoseSearch(search!);
    if (id === requestIds.current.get(key)) setDiagnostics((values) => ({ ...values, [key]: result }));
  };
  const manifest = data?.search.manifests.find((item) => item.id === search?.provider);
  const profiles = module === "llm" ? data?.llm.profiles : data?.search.profiles;
  const selectedId = module === "llm" ? llm.id : search?.id;
  const activeId = module === "llm" ? data?.llm.activeProfileId : data?.search.activeProfileId;

  return <section className="settings-view" aria-label="设置">
    <header className="settings-header"><div><h2>模型与搜索</h2><p>配置运行时使用的模型和联网搜索服务。</p></div></header>
    <nav className="settings-modules" aria-label="设置模块"><button className={module === "llm" ? "active" : ""} onClick={() => setModule("llm")}>LLM</button><button className={module === "search" ? "active" : ""} onClick={() => setModule("search")}>Search</button></nav>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="settings-layout">
      <aside className="profile-list"><button onClick={() => { const key = `new:${module}:${++temporarySequence.current}`; if (module === "llm") { setLlm(newLlm()); setLlmUiKey(key); } else if (manifest) { setSearch({ name: manifest.displayName, provider: manifest.id, baseUrl: manifest.defaultBaseUrl, options: {} }); setSearchUiKey(key); } }}>＋ 新建 Profile</button>{profiles?.map((profile) => <button key={profile.id} className={selectedId === profile.id ? "selected" : ""} onClick={() => { if (module === "llm") { setLlm(llmDraft(profile as SettingsData["llm"]["profiles"][number])); setLlmUiKey(profile.id); } else { setSearch(searchDraft(profile as SettingsData["search"]["profiles"][number])); setSearchUiKey(profile.id); } }}>{profile.name}{profile.id === activeId ? " · 当前" : ""}</button>)}</aside>
      <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); void (module === "llm" ? api.settings.saveLlmProfile(llm) : api.settings.saveSearchProfile(search!)).then(accept, () => setError("保存失败，请重试")); }}>
        {module === "llm"
          ? <LlmEditor value={llm} saved={data?.llm.profiles.find((p) => p.id === llm.id)?.hasCredential ?? false} update={updateLlm} updateApiKey={updateLlmApiKey}/>
          : search && (
            <SearchEditor value={search} manifests={data?.search.manifests ?? []} saved={data?.search.profiles.find((p) => p.id === search.id)?.hasCredential ?? false} update={updateSearch} updateApiKey={updateSearchApiKey} replace={(next) => { setSearch(next); reset(); }}/>
          )}
        <div className="diagnostic-row"><Diagnostic value={diagnostic}/><button type="button" onClick={() => void diagnose()} disabled={diagnostic === "testing" || (module === "search" && !search)}>测试连接</button></div>
        <div className="editor-actions"><button type="submit">保存</button><button type="button" disabled={!selectedId || activeId === selectedId} onClick={() => void (module === "llm" ? api.settings.activateLlmProfile(llm.id!) : api.settings.activateSearchProfile(search!.id!)).then(accept)}>设为当前</button><button type="button" disabled={!selectedId || activeId === selectedId} onClick={() => void (module === "llm" ? api.settings.deleteLlmProfile(llm.id!) : api.settings.deleteSearchProfile(search!.id!)).then(accept)}>删除</button></div>
      </form>
    </div>
  </section>;
}

function LlmEditor({ value, saved, update, updateApiKey }: { value: LlmProfileDraft; saved: boolean; update(p: Partial<LlmProfileDraft>): void; updateApiKey(value: string): void }) {
  return <><label>名称<input value={value.name} onChange={(e) => update({ name: e.target.value })}/></label><label>Provider<select value={value.provider} onChange={(e) => { const provider = e.target.value as LlmProfileDraft["provider"]; const preset = LLM_PROVIDER_PRESETS[provider]; update({ provider, protocol: preset.protocol, baseUrl: preset.baseUrl, name: preset.displayName }); }}>{Object.entries(LLM_PROVIDER_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.displayName}</option>)}</select></label><label>Protocol<select value={value.protocol} onChange={(e) => update({ protocol: e.target.value as LlmProfileDraft["protocol"] })}><option value="openai_compatible">OpenAI Compatible</option><option value="anthropic_messages">Anthropic Messages</option></select></label><label>Base URL<input value={value.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })}/></label><label>API Key<input type="password" value={value.apiKey ?? ""} onChange={(e) => updateApiKey(e.target.value)} autoComplete="off"/>{saved && !value.apiKey ? <small>已保存（留空则保留）</small> : null}</label><label>Model ID<input value={value.modelId} onChange={(e) => update({ modelId: e.target.value })}/></label><label>Context Window<input type="number" value={value.contextWindow} onChange={(e) => update({ contextWindow: Number(e.target.value) })}/></label></>;
}

function SearchEditor({ value, manifests, saved, update, updateApiKey, replace }: { value: SearchProfileDraft; manifests: SettingsData["search"]["manifests"]; saved: boolean; update(p: Partial<SearchProfileDraft>): void; updateApiKey(value: string): void; replace(v: SearchProfileDraft): void }) {
  const manifest = manifests.find((item) => item.id === value.provider);
  return <><label>名称<input value={value.name} onChange={(e) => update({ name: e.target.value })}/></label><label>Provider<select value={value.provider} onChange={(e) => { const next = manifests.find((item) => item.id === e.target.value); if (next) replace({ name: next.displayName, provider: next.id, baseUrl: next.defaultBaseUrl, options: {} }); }}>{manifests.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label>Base URL<input value={value.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })}/></label><label>API Key<input type="password" value={value.apiKey ?? ""} onChange={(e) => updateApiKey(e.target.value)} autoComplete="off"/>{saved && !value.apiKey ? <small>已保存（留空则保留）</small> : null}</label>{manifest?.optionFields.map((field) => <label key={field.key}>{field.label}{field.type === "select" ? <select value={String(value.options[field.key] ?? "")} onChange={(e) => update({ options: { ...value.options, [field.key]: e.target.value } })}><option value="">默认</option>{field.options?.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select> : <input value={String(value.options[field.key] ?? "")} onChange={(e) => update({ options: { ...value.options, [field.key]: field.type === "number" ? Number(e.target.value) : e.target.value } })}/>}</label>)}</>;
}
