import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import capabilityManifest from "../capability.json" with { type: "json" };
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { CapabilityItem, ItemCompanyView } from "../contracts/index.js";
import { AddCompaniesModal } from "./AddCompaniesModal.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { CompanyProfileForm } from "./CompanyProfileModal.js";
import { CompanyIdentityConfirmationModal } from "./CompanyIdentityConfirmationModal.js";
import { ImportCompaniesModal } from "./ImportCompaniesModal.js";
import { ResearchItemModal } from "./ResearchItemModal.js";
import { BatchCompanyResearchModal } from "./BatchCompanyResearchModal.js";
import { OperationProgress } from "./OperationProgress.js";
import { useOperationProgress } from "./use-operation-progress.js";
import type { CapabilityUiNavigation, CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import { CompanyFormView } from "./CompanyFormView.js";
import type { PreparedResearch } from "../actions/drafts.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { ResearchDraftConflictError } from "./research-error-presentation.js";
import { reportRevision } from "./report-revision.js";
import { hasUnknownCompanyProfileFields } from "../application/company-profile-completeness.js";

export interface IndustryResearchCapabilityProps {
  interactionEditor?: CapabilityInteractionEditor;
  navigation?: CapabilityUiNavigation;
  api: DesktopApi;
  onClose(): void;
  active?: boolean;
  onOpenSettings?(module: "llm" | "search"): void;
}
type OpenModal = "create" | "edit" | "add" | "import" | "batch" | undefined;
type Confirmation =
  | { kind: "delete-items"; items: CapabilityItem[] }
  | { kind: "remove-company"; company: ItemCompanyView }
  | { kind: "remove-batch" }
  | undefined;

function newestFirst(items: CapabilityItem[]): CapabilityItem[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function companiesByName(companies: ItemCompanyView[]): ItemCompanyView[] {
  return [...companies].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }));
}

function localReportTime(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function IndustryResearchCapability({ api, onClose, active = true, onOpenSettings, navigation, interactionEditor }: IndustryResearchCapabilityProps) {
  const [items, setItems] = useState<CapabilityItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<CapabilityItem>();
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>();
  const [companies, setCompanies] = useState<ItemCompanyView[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [itemError, setItemError] = useState<string>();
  const [companyError, setCompanyError] = useState<string>();
  const [profileUpdateError, setProfileUpdateError] = useState<string>();
  const [openModal, setOpenModal] = useState<OpenModal>();
  const [editingItem, setEditingItem] = useState<CapabilityItem>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [selecting, setSelecting] = useState(false);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [selectingItems, setSelectingItems] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [editingCompanyProfile, setEditingCompanyProfile] = useState(false);
  const [confirmingIdentity, setConfirmingIdentity] = useState<ItemCompanyView>();
  const companyRequest = useRef(0);
  const itemsRequest = useRef(0);
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const [requestedRevision, setRequestedRevision] = useState<string>();
  const [researchRefreshToken, setResearchRefreshToken] = useState(0);
  const [externalDraft, setExternalDraft] = useState<PreparedResearch>();
  const draftCurrent = useRef<PreparedResearch | undefined>(undefined);
  const draftInvalidation = useRef<Promise<void> | undefined>(undefined);
  const draftConflict = useRef(false);
  const dirty = useRef(false);
  const panelDirty = useRef(false);
  const formDirty = useRef(false);
  const currentEditor = useRef(interactionEditor);
  currentEditor.current = interactionEditor;
  const hydratedItem = useRef<string | undefined>(undefined);
  dirty.current = !!(openModal || editingCompanyProfile || confirmingIdentity || confirmation || externalDraft);
  useEffect(() => navigation?.register({
    canLeave: () => !dirty.current && !panelDirty.current && !(currentEditor.current && formDirty.current),
    async open(_target, { view, signal, commit }) {
      if (dirty.current || panelDirty.current) return { status: "blocked", message: "请先完成或关闭正在编辑的内容。" };
      try {
        const input = view.input as Record<string, string>;
        if (view.viewId === "topic-preview") return { status: "not_found" };
        if (view.viewId === "form") return { status: "unsupported" };
        let prepared: PreparedResearch | undefined;
        if (view.viewId === "research-draft") {
          if (!api.researchDraft) return { status: "unsupported" };
          const result = await api.researchDraft.get({ capabilityId: "company-research", draftId: input.draftId!, revision: input.revision! });
          if (!result.ok || !result.prepared) return { status: "blocked", message: "草稿已修改，请刷新草稿。" };
          prepared = result.prepared;
        }
        const itemId = prepared?.parameters.itemId ?? input.itemId;
        const companyId = prepared?.parameters.companyId ?? input.companyId;
        const item = itemId ? await api.industryResearch.getItem(itemId) : undefined;
        if (itemId && !item) return { status: "not_found" };
        const loaded = item ? await api.industryResearch.listCompanies(item.id) : [];
        const refreshedItems = await api.industryResearch.listItems();
        if (companyId && !loaded.some(company => company.id === companyId)) return { status: "not_found" };
        if (view.viewId === "report") {
          const run = await api.companyResearch.getRun(itemId!, companyId!, input.runId!);
          if (!run || run.id !== input.runId || run.itemId !== itemId || run.companyId !== companyId) return { status: "not_found" };
          if (await reportRevision(run) !== input.revision) return { status: "blocked", message: "报告内容已更新，请重新打开最新报告引用。" };
        }
        if (signal.aborted) return { status: "blocked" };
        const opened = commit(() => {
          ++companyRequest.current;
          hydratedItem.current = item?.id;
          ++itemsRequest.current;
          setItems(newestFirst(refreshedItems)); setLoadingItems(false); setItemError(undefined);
          setSelectedItem(item); setCompanies(companiesByName(loaded)); setSelectedCompanyId(companyId);
          setLoadingCompanies(false); setCompanyError(undefined);
          setRequestedRunId(view.viewId === "report" ? input.runId : undefined);
          setRequestedRevision(view.viewId === "report" ? input.revision : undefined);
          if (view.viewId === "company") setResearchRefreshToken(value => value + 1);
          setExternalDraft(prepared); draftCurrent.current = prepared;
          draftInvalidation.current = undefined; draftConflict.current = false;
          panelDirty.current = false; dirty.current = !!prepared;
          setSelecting(false); setSelectedCompanyIds(new Set());
        });
        return { status: opened ? "opened" : "blocked" };
      } catch { return { status: "not_found" }; }
    },
  }), [api, navigation]);
  const companyProfileStatuses = useRef(new Map<string, ItemCompanyView["profileStatus"]>());

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);
  const selectedCompanyNeedsIdentityConfirmation = selectedCompany?.profileStatus === "failed" && (
    selectedCompany.profileIdentityHint !== undefined ||
    (selectedCompany.profileProvenance?.identity.disposition !== undefined && selectedCompany.profileProvenance.identity.disposition !== "matched")
  );
  const profileUpdatePending = selectedCompany?.profileStatus === "pending" || selectedCompany?.profileStatus === "enriching";
  const profileUpdateHint = profileUpdateError ?? (profileUpdatePending ? "信息更新中" : selectedCompany?.profileStatus === "failed" ? "更新未完成，可再次更新信息" : selectedCompany && hasUnknownCompanyProfileFields(selectedCompany) ? "部分信息未知，可更新信息" : "信息已更新");
  const sortedItems = useMemo(() => newestFirst(items), [items]);
  const listVisible = active && selectedCompanyId === undefined && selectedItem !== undefined;
  const operation = useOperationProgress(api, selectedItem?.id ?? "", listVisible);
  const previousList = useRef({ visible: listVisible, itemId: selectedItem?.id });

  const loadItems = useCallback(async (): Promise<void> => {
    const request = ++itemsRequest.current;
    setLoadingItems(true);
    setItemError(undefined);
    try { const loaded = await api.industryResearch.listItems(); if (itemsRequest.current === request) setItems(newestFirst(loaded)); }
    catch { if (itemsRequest.current === request) setItemError("加载调研列表失败，请重试"); }
    finally { if (itemsRequest.current === request) setLoadingItems(false); }
  }, [api]);

  const loadCompanies = useCallback(async (item: CapabilityItem, quiet = false): Promise<void> => {
    const request = ++companyRequest.current;
    if (!quiet) setLoadingCompanies(true);
    setCompanyError(undefined);
    try {
      const loaded = await api.industryResearch.listCompanies(item.id);
      if (companyRequest.current === request) {
        for (const company of loaded) companyProfileStatuses.current.delete(company.id);
        setCompanies(companiesByName(loaded));
      }
    } catch {
      if (companyRequest.current === request) setCompanyError("加载公司列表失败，请重试");
    } finally {
      if (companyRequest.current === request) setLoadingCompanies(false);
    }
  }, [api]);

  useEffect(() => {
    if (listVisible && !previousList.current.visible && selectedItem?.id === previousList.current.itemId && selectedItem) void loadCompanies(selectedItem, true);
    previousList.current = { visible: listVisible, itemId: selectedItem?.id };
  }, [listVisible, loadCompanies, selectedItem]);
  useEffect(() => api.companyResearch.subscribe(event => {
    if (event.type === "state_changed" && selectedItem?.id === event.itemId) void loadCompanies(selectedItem, true);
  }), [api, loadCompanies, selectedItem]);

  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => api.industryResearch.subscribeCompanyProfiles((event) => {
    companyProfileStatuses.current.set(event.companyId, event.status);
    setCompanies((current) => {
      const exists = current.some((company) => company.id === event.companyId);
      if (exists) companyProfileStatuses.current.delete(event.companyId);
      return current.map((company) => {
        if (company.id !== event.companyId) return company;
        const { profileIssue: _issue, ...rest } = company;
        return { ...rest, profileStatus: event.status,
          ...(event.issue ? { profileIssue: event.issue } : {}) };
      });
    });
    if ((event.status === "ready" || event.status === "failed" || event.status === "pending") && selectedItem !== undefined) {
      void loadCompanies(selectedItem);
    }
  }), [api, loadCompanies, selectedItem?.id]);
  useEffect(() => {
    if (selectedItem === undefined) {
      companyRequest.current += 1;
      setCompanies([]);
      setCompanyError(undefined);
      return;
    }
    if (hydratedItem.current === selectedItem.id) { hydratedItem.current = undefined; return () => { companyRequest.current += 1; }; }
    setCompanies([]);
    void loadCompanies(selectedItem);
    return () => { companyRequest.current += 1; };
  }, [loadCompanies, selectedItem?.id]);

  const leaveItem = (): void => {
    setSelectedItem(undefined);
    setSelectedCompanyId(undefined);
    setSelecting(false);
    setSelectedCompanyIds(new Set());
  };

  const handleSaved = (item: CapabilityItem): void => {
    setItems((current) => newestFirst([...current.filter((entry) => entry.id !== item.id), item]));
    if (openModal === "create") setSelectedItem(item);
    else if (selectedItem?.id === item.id) setSelectedItem(item);
    setEditingItem(undefined);
    setOpenModal(undefined);
  };

  const handleCompaniesAdded = (added: ItemCompanyView[]): void => {
    companyRequest.current += 1;
    setLoadingCompanies(false);
    setCompanyError(undefined);
    setCompanies((current) => {
      const byId = new Map(current.map((company) => [company.id, company]));
      for (const company of added) {
        const status = companyProfileStatuses.current.get(company.id);
        byId.set(company.id, status === undefined ? company : { ...company, profileStatus: status });
        companyProfileStatuses.current.delete(company.id);
      }
      return companiesByName([...byId.values()]);
    });
  };

  const handleCompanySaved = (saved: ItemCompanyView): void => {
    setCompanies((current) => companiesByName(current.map((company) =>
      company.id === saved.id ? { ...saved, itemId: company.itemId, ...(company.note !== undefined ? { note: company.note } : {}), ...(company.reportSummary ? { reportSummary: company.reportSummary } : {}) } : company,
    )));
    setEditingCompanyProfile(false);
  };

  const updateCompanyProfile = async (company: ItemCompanyView): Promise<void> => {
    if (company.profileStatus === "pending" || company.profileStatus === "enriching") return;
    setProfileUpdateError(undefined);
    setCompanies((current) => current.map((entry) =>
      entry.id === company.id ? { ...entry, profileStatus: "pending" } : entry,
    ));
    try {
      const accepted = await api.industryResearch.retryCompanyProfile(company.id);
      if (!accepted && selectedItem !== undefined) await loadCompanies(selectedItem);
    } catch {
      setCompanies((current) => current.map((entry) =>
        entry.id === company.id ? { ...entry, profileStatus: company.profileStatus } : entry,
      ));
      setProfileUpdateError("更新未启动，请稍后再试");
    }
  };

  const handleIdentityConfirmed = (): void => {
    setConfirmingIdentity(undefined);
  };

  const beginConfirmation = (value: Exclude<Confirmation, undefined>): void => {
    setDeleteError(undefined);
    setConfirmation(value);
  };

  const confirmDeletion = async (): Promise<void> => {
    if (deleting || confirmation === undefined) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      if (confirmation.kind === "delete-items") {
        await api.industryResearch.deleteItems(confirmation.items.map((item) => item.id));
        const deletedIds = new Set(confirmation.items.map((item) => item.id));
        setItems((current) => current.filter((item) => !deletedIds.has(item.id)));
        setSelectingItems(false);
        setSelectedItemIds(new Set());
        setConfirmation(undefined);
        return;
      }
      if (selectedItem === undefined) return;
      const ids = confirmation.kind === "remove-batch"
        ? [...selectedCompanyIds]
        : [confirmation.company.id];
      if (confirmation.kind === "remove-batch") await api.industryResearch.removeCompanies(selectedItem.id, ids);
      else await api.industryResearch.removeCompany(selectedItem.id, confirmation.company.id);
      setCompanies((current) => current.filter((company) => !ids.includes(company.id)));
      if (selectedCompanyId !== undefined && ids.includes(selectedCompanyId)) setSelectedCompanyId(undefined);
      if (confirmation.kind === "remove-batch") {
        setSelecting(false);
        setSelectedCompanyIds(new Set());
      }
      setConfirmation(undefined);
    } catch {
      setDeleteError("删除失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  const toggleCompany = (companyId: string): void => {
    setSelectedCompanyIds((current) => {
      const next = new Set(current);
      if (next.has(companyId)) next.delete(companyId); else next.add(companyId);
      return next;
    });
  };

  const toggleItem = (itemId: string): void => {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const confirmationProps = confirmation === undefined ? undefined
    : confirmation.kind === "delete-items"
      ? { title: "删除主题", message: `确认删除${confirmation.items.map((item) => `“${item.industry}”`).join("、")}吗？`, confirmLabel: `确认删除 ${confirmation.items.length} 个主题` }
      : confirmation.kind === "remove-company"
        ? { title: "移除公司", message: `确认从“${selectedItem?.industry ?? ""}”主题移除“${confirmation.company.name}”吗？`, confirmLabel: "确认移除" }
        : { title: "批量移除公司", message: `确认从“${selectedItem?.industry ?? ""}”主题移除已选的 ${selectedCompanyIds.size} 家公司吗？`, confirmLabel: `确认移除 ${selectedCompanyIds.size} 家公司` };

  const breadcrumb = `能力 / ${capabilityManifest.name} / 研究主题${selectedItem !== undefined ? ` / ${selectedItem.industry}` : ""}${selectedCompany !== undefined ? ` / ${selectedCompany.name}` : ""}`;
  const contextualReturn = selectedCompany !== undefined
    ? { label: "‹ 返回公司列表", onClick: () => setSelectedCompanyId(undefined) }
    : selectedItem !== undefined
      ? { label: "‹ 返回调研列表", onClick: leaveItem }
      : undefined;

  return (
    <section className="capability" aria-label="研究主题">
      <div className="capability-navigation">
        <header className="capability-header">
          <span className="breadcrumb" title={breadcrumb}>{breadcrumb}</span>
          <button className="capability-close" aria-label="关闭 Capability" onClick={onClose}>×</button>
        </header>
        {contextualReturn !== undefined && (
          <nav className="capability-contextual-navigation" aria-label="研究导航">
            <button className="back-button" onClick={contextualReturn.onClick}>{contextualReturn.label}</button>
          </nav>
        )}
      </div>

      <div className="capability-body">
        <div className="capability-body-inner">
        {selectedItem === undefined ? (
        <>
          <div className="capability-page-heading">
            <div><h1 className="capability-title">研究主题</h1><p className="muted">管理研究主题与候选公司。</p></div>
            <div className="capability-actions">
              {selectingItems ? <>
                <button
                  className="danger-button"
                  disabled={selectedItemIds.size === 0}
                  onClick={() => beginConfirmation({ kind: "delete-items", items: sortedItems.filter((item) => selectedItemIds.has(item.id)) })}
                >确认删除（{selectedItemIds.size}）</button>
                <button onClick={() => { setSelectingItems(false); setSelectedItemIds(new Set()); }}>取消</button>
              </> : <>
                <button className="primary-button" onClick={() => setOpenModal("create")}>新建主题</button>
                <button disabled={sortedItems.length === 0} onClick={() => setSelectingItems(true)}>删除主题</button>
              </>}
            </div>
          </div>
          {itemError !== undefined && <p className="error" role="alert">{itemError}</p>}
          {loadingItems ? <p className="muted">加载调研列表…</p> : sortedItems.length === 0 ? (
            <div className="capability-empty"><p>还没有研究主题</p><span className="muted">新建一个主题，开始整理目标公司。</span></div>
          ) : (
            <div className="research-item-list">{sortedItems.map((item) => selectingItems ? (
              <label className="research-item-select-row" key={item.id}>
                <input type="checkbox" aria-label={`选择 ${item.industry}`} checked={selectedItemIds.has(item.id)} onChange={() => toggleItem(item.id)} />
                <span><strong>{item.industry}</strong><small>{item.researchScope ?? "未填写研究范围"}</small></span>
              </label>
            ) : (
              <div className="research-item-row" key={item.id}>
                <button className="research-item-card" onClick={() => setSelectedItem(item)}><strong>{item.industry}</strong><span>{item.researchScope ?? "未填写研究范围"}</span></button>
                <button className="research-item-edit-button" aria-label={`编辑 ${item.industry}`} onClick={() => { setEditingItem(item); setOpenModal("edit"); }}>编辑</button>
              </div>
            ))}</div>
          )}
        </>
      ) : selectedCompany !== undefined ? (
        <>
          <div className="capability-page-heading"><div><h1 className="capability-title">{selectedCompany.name}</h1></div><div className="capability-actions"><small className="company-profile-update-hint" role="status">{profileUpdateHint}</small><button className="company-detail-action" disabled={profileUpdatePending} onClick={() => void updateCompanyProfile(selectedCompany)}>{profileUpdatePending ? "更新中…" : "更新信息"}</button>{!editingCompanyProfile && <button className="company-detail-action" onClick={() => setEditingCompanyProfile(true)}>编辑信息</button>}<button className="danger-button company-detail-action" onClick={() => beginConfirmation({ kind: "remove-company", company: selectedCompany })}>删除公司</button></div></div>
          {editingCompanyProfile ? <CompanyProfileForm api={api} company={selectedCompany} onCancel={() => setEditingCompanyProfile(false)} onSaved={(saved) => handleCompanySaved({ ...saved, itemId: selectedCompany.itemId, ...(selectedCompany.note !== undefined ? { note: selectedCompany.note } : {}) })} /> : <dl className="company-detail">
            <div className="scope-row"><dt>公司名称</dt><dd>{selectedCompany.name}</dd></div>
            <div className="scope-row"><dt>法定名称</dt><dd>{selectedCompany.legalName ?? "未知"}</dd></div>
            <div className="scope-row"><dt>别名</dt><dd>{selectedCompany.aliases === undefined ? "未知" : selectedCompany.aliases.length === 0 ? "无" : selectedCompany.aliases.join("、")}</dd></div>
            <div className="scope-row"><dt>总部</dt><dd>{selectedCompany.headquarters ?? "未知"}</dd></div>
            <div className="scope-row"><dt>成立时间</dt><dd>{selectedCompany.foundedAt ?? "未知"}</dd></div>
            <div className="scope-row"><dt>官方网站</dt><dd>{selectedCompany.officialWebsite === undefined ? "未知" : selectedCompany.officialWebsite === null ? "无" : <a href={selectedCompany.officialWebsite} target="_blank" rel="noreferrer">{selectedCompany.officialWebsite}</a>}</dd></div>
            <div className="scope-row"><dt>上市信息</dt><dd>{selectedCompany.stockListings === undefined ? "未知" : selectedCompany.stockListings.length === 0 ? "未上市" : selectedCompany.stockListings.map((listing) => `${listing.exchange}:${listing.ticker}`).join("、")}</dd></div>
            <div className="scope-row"><dt>业务标签</dt><dd>{selectedCompany.businessTags?.join("、") ?? "未知"}</dd></div>
            <div className="scope-row"><dt>候选备注</dt><dd>{selectedCompany.note ?? "未填写"}</dd></div>
          </dl>}
          {selectedCompanyNeedsIdentityConfirmation && <div><button className="company-profile-confirm" aria-label={`${selectedCompany.profileIdentityHint ? "修改" : "确认"}主体 ${selectedCompany.name}`} onClick={() => setConfirmingIdentity(selectedCompany)}>{selectedCompany.profileIdentityHint ? "修改主体" : "确认主体"}</button></div>}
          {!editingCompanyProfile && selectedCompany.profileProvenance && <details>
            <summary>资料核实来源</summary>
            <p className="muted">{selectedCompany.profileProvenance.identity.disposition === "matched" ? "本次来源用于身份及部分字段核实，未确认字段保持未知。" : "身份尚未确认，请核对公司名称并确认主体或更新信息。"}</p>
            <ul>{selectedCompany.profileProvenance.sources.map((source) => <li key={`${source.kind}:${source.url}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>（{source.kind === "opened_page" ? "已读取网页" : "搜索摘要"}）</li>)}</ul>
          </details>}
          <CompanyResearchPanel
            key={`${selectedItem.id}:${selectedCompany.id}`}
            api={api}
            itemId={selectedItem.id}
            companyId={selectedCompany.id}
            refreshToken={researchRefreshToken}
            {...(requestedRunId ? { requestedRunId } : {})}
            {...(requestedRevision ? { requestedRevision } : {})}
            navigationDirtyRef={panelDirty}
            topicName={selectedItem.industry}
            companyName={selectedCompany.name}
            active={active}
            {...(() => { const queueEntry = operation.queue?.entries.find((entry) => (entry.status === "pending" || entry.status === "running") && entry.companyId === selectedCompany.id); return queueEntry ? { queueEntry } : {}; })()}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            {...(selectedItem.researchScope !== undefined ? { topicScope: selectedItem.researchScope } : {})}
            {...(selectedCompany.note !== undefined ? { companyNote: selectedCompany.note } : {})}
          />
        </>
      ) : (
        <>
          <div className="capability-page-heading">
            <div><h1 className="capability-title">{selectedItem.industry}</h1>{(selectedItem.researchScope !== undefined || selectedItem.notes !== undefined) && <dl className="scope-summary">{selectedItem.researchScope !== undefined && <div className="scope-row"><dt>研究范围</dt><dd>{selectedItem.researchScope}</dd></div>}{selectedItem.notes !== undefined && <div className="scope-row"><dt>备注</dt><dd>{selectedItem.notes}</dd></div>}</dl>}</div>
          </div>
          <div className="company-operations-toolbar">
          <OperationProgress batch={operation.batch} profile={operation.profile} onCancel={api.companyResearchBatch.cancel} onResume={async (batchId) => { await api.companyResearchBatch.resume(batchId); }} {...(onOpenSettings ? { onOpenSettings } : {})} />
          <div className="company-toolbar">
            {!selecting && <button onClick={() => setOpenModal("batch")}>批量调研公司</button>}
            {selecting ? <><button onClick={() => setSelectedCompanyIds(selectedCompanyIds.size === companies.length ? new Set() : new Set(companies.map((company) => company.id)))}>{selectedCompanyIds.size === companies.length && companies.length > 0 ? "清空" : "全选"}</button><button className="danger-button" disabled={selectedCompanyIds.size === 0} onClick={() => beginConfirmation({ kind: "remove-batch" })}>删除已选（{selectedCompanyIds.size}）</button><button onClick={() => { setSelecting(false); setSelectedCompanyIds(new Set()); }}>取消</button></> : <><button onClick={() => setOpenModal("add")}>添加公司</button><button disabled={companies.length === 0} onClick={() => setSelecting(true)}>批量删除</button><button className="primary-button" onClick={() => setOpenModal("import")}>一键导入公司</button></>}
          </div>
          </div>
          {companyError !== undefined && <div className="error" role="alert">{companyError} <button onClick={() => void loadCompanies(selectedItem)}>重新加载</button></div>}
          <section className="company-panel" aria-labelledby="company-list-title">
            <h2 id="company-list-title">当前公司</h2>
            {loadingCompanies ? <p className="muted">加载公司列表…</p> : companies.length === 0 ? <p className="muted">暂无公司，可手动添加或从文本识别。</p> : (
              <ul className="company-list">{companies.map((company) => {
                const batchEntry = operation.batch?.entries.find((entry) => (entry.status === "pending" || entry.status === "running") && entry.companyId === company.id);
                const batchEntryActive = batchEntry?.status === "running" && operation.batch?.status === "running";
                const batchEntryStatus = batchEntry?.status === "pending" ? "等待调研"
                  : batchEntry?.status === "running" && operation.batch?.status === "paused" ? "已暂停"
                    : batchEntry?.status === "running" && operation.batch?.status === "cancelling" ? "正在取消"
                      : batchEntryActive ? (batchEntry.stage === "structure" ? "正在整理调研结果" : "正在收集调研资料") : undefined;
                const reportTime = company.reportSummary && company.reportSummary.count > 0 ? localReportTime(company.reportSummary.latestCreatedAt) : undefined;
                return <li key={company.id}>{selecting
                  ? <label className="company-select-row"><input type="checkbox" aria-label={`选择 ${company.name}`} checked={selectedCompanyIds.has(company.id)} onChange={() => toggleCompany(company.id)} /><span><strong>{company.name}</strong>{company.headquarters !== undefined && <> · {company.headquarters}</>}</span></label>
                  : <div className="company-list-row">
                    <button className="company-row-button" aria-label={`查看 ${company.name}`} onClick={() => { setEditingCompanyProfile(false); setProfileUpdateError(undefined); setRequestedRunId(undefined); setRequestedRevision(undefined); setSelectedCompanyId(company.id); }}>
                      <strong>{company.name}</strong>
                      {company.headquarters !== undefined && <span>{company.headquarters}</span>}
                      {company.note !== undefined && <small>{company.note}</small>}
                      {batchEntryStatus && <small className={batchEntryActive ? "company-research-active-status" : undefined}>{batchEntryStatus}</small>}
                    </button>
                    {batchEntryActive && <span className="company-profile-spinner" role="status" aria-label={`${company.name} ${batchEntryStatus}`} />}
                    {company.reportSummary && company.reportSummary.count > 0 && reportTime && <small className="company-report-summary muted" aria-label={`报告 ${company.reportSummary.count} 份 · 最新创建于 ${reportTime}`}>
                        <span className="company-report-count">报告 {company.reportSummary.count} 份</span>
                        <span className="company-report-separator" aria-hidden="true">·</span>
                        <span className="company-report-time">最新创建于 <time dateTime={company.reportSummary.latestCreatedAt}>{reportTime}</time></span>
                      </small>}
                    <button className="company-remove-button" aria-label={`删除公司 ${company.name}`} onClick={(event) => { event.stopPropagation(); beginConfirmation({ kind: "remove-company", company }); }}>×</button>
                  </div>}
                </li>;
              })}</ul>
            )}
          </section>
        </>
      )}
        </div>
      </div>

      {interactionEditor && <CompanyFormView api={api} editor={interactionEditor} active={active} dirtyRef={formDirty}
        onItemSaved={handleSaved} onCompaniesAdded={handleCompaniesAdded} onCompanySaved={handleCompanySaved}
        onResearchStarted={() => { if (selectedItem) void loadCompanies(selectedItem, true); setResearchRefreshToken(value => value + 1); }} />}
      {openModal === "create" && <ResearchItemModal api={api} active={active} onClose={() => setOpenModal(undefined)} onSaved={handleSaved} />}
      {externalDraft && selectedItem && selectedCompany && <CompanyResearchModal
        initial={externalDraft.parameters} topicName={selectedItem.industry} companyName={selectedCompany.name} active={active}
        onClose={() => { setExternalDraft(undefined); dirty.current = false; }}
        onEdited={() => {
          if (draftInvalidation.current || !draftCurrent.current || !api.researchDraft) return;
          // One invalidation per opened form makes the previous chat reference stale immediately.
          draftInvalidation.current = api.researchDraft.invalidate(draftCurrent.current.draftRef).then(result => {
            if (result.ok && result.prepared) draftCurrent.current = result.prepared;
            else draftConflict.current = true;
          }).catch(() => { draftConflict.current = true; });
        }}
        onStart={async input => {
          await draftInvalidation.current;
          if (draftConflict.current || !draftCurrent.current || !api.researchDraft) throw new ResearchDraftConflictError();
          const current = draftCurrent.current;
          const updated = await api.researchDraft.update({ draftRef: current.draftRef, parameters: { ...input, itemId: current.parameters.itemId, companyId: current.parameters.companyId } });
          if (!updated.ok || !updated.prepared) throw new ResearchDraftConflictError();
          draftCurrent.current = updated.prepared;
          const result = await api.researchDraft.submit(updated.prepared);
          if (!result.ok) throw new ResearchDraftConflictError();
        }} {...(onOpenSettings ? { onOpenSettings } : {})}
      />}
      {openModal === "edit" && editingItem !== undefined && <ResearchItemModal api={api} active={active} item={editingItem} onClose={() => { setOpenModal(undefined); setEditingItem(undefined); }} onSaved={handleSaved} />}
      {openModal === "add" && selectedItem !== undefined && <AddCompaniesModal api={api} active={active} itemId={selectedItem.id} onClose={() => setOpenModal(undefined)} onCompaniesAdded={handleCompaniesAdded} />}
      {openModal === "import" && selectedItem !== undefined && <ImportCompaniesModal api={api} active={active} itemId={selectedItem.id} onClose={() => setOpenModal(undefined)} onCompaniesAdded={handleCompaniesAdded} />}
      {openModal === "batch" && selectedItem !== undefined && <BatchCompanyResearchModal api={api} item={selectedItem} companies={companies} companyResearchStatuses={new Map(operation.queue?.entries.flatMap((entry) => {
        if (entry.status === "pending") return [[entry.companyId, "等待调研"]];
        if (entry.status !== "running") return [];
        const status = operation.queue?.status === "paused" ? "已暂停"
          : operation.queue?.status === "cancelling" ? "正在取消"
            : entry.stage === "structure" ? "正在整理调研结果" : "正在收集调研资料";
        return [[entry.companyId, status]];
      }) ?? [])} active={active} onClose={() => setOpenModal(undefined)} onStarted={() => {}} {...(onOpenSettings ? { onOpenSettings } : {})} />}
      {confirmingIdentity !== undefined && <CompanyIdentityConfirmationModal api={api} company={confirmingIdentity} active={active} onClose={() => setConfirmingIdentity(undefined)} onConfirmed={handleIdentityConfirmed} />}
      {confirmationProps !== undefined && <ConfirmModal {...confirmationProps} active={active} busy={deleting} error={deleteError} onClose={() => { if (!deleting) { setConfirmation(undefined); setDeleteError(undefined); } }} onConfirm={() => void confirmDeletion()} />}
    </section>
  );
}
