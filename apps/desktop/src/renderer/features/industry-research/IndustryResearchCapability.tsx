import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityItem, DesktopApi, ItemCompanyView } from "@deepfield/contracts";
import { AddCompaniesModal } from "./AddCompaniesModal.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { CompanyProfileForm } from "./CompanyProfileModal.js";
import { ImportCompaniesModal } from "./ImportCompaniesModal.js";
import { ResearchItemModal } from "./ResearchItemModal.js";

export interface IndustryResearchCapabilityProps { api: DesktopApi; }
type OpenModal = "create" | "edit" | "add" | "import" | undefined;
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

export function IndustryResearchCapability({ api }: IndustryResearchCapabilityProps) {
  const [items, setItems] = useState<CapabilityItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<CapabilityItem>();
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>();
  const [companies, setCompanies] = useState<ItemCompanyView[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [itemError, setItemError] = useState<string>();
  const [companyError, setCompanyError] = useState<string>();
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
  const companyRequest = useRef(0);
  const companyProfileStatuses = useRef(new Map<string, ItemCompanyView["profileStatus"]>());

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);
  const sortedItems = useMemo(() => newestFirst(items), [items]);

  const loadItems = useCallback(async (): Promise<void> => {
    setLoadingItems(true);
    setItemError(undefined);
    try { setItems(newestFirst(await api.industryResearch.listItems())); }
    catch { setItemError("加载调研列表失败，请重试"); }
    finally { setLoadingItems(false); }
  }, [api]);

  const loadCompanies = useCallback(async (item: CapabilityItem): Promise<void> => {
    const request = ++companyRequest.current;
    setLoadingCompanies(true);
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

  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => api.industryResearch.subscribeCompanyProfiles((event) => {
    companyProfileStatuses.current.set(event.companyId, event.status);
    setCompanies((current) => {
      const exists = current.some((company) => company.id === event.companyId);
      if (exists) companyProfileStatuses.current.delete(event.companyId);
      return current.map((company) =>
        company.id === event.companyId ? { ...company, profileStatus: event.status } : company,
      );
    });
    if ((event.status === "ready" || event.status === "failed") && selectedItem !== undefined) {
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
      company.id === saved.id ? { ...saved, itemId: company.itemId, ...(company.note !== undefined ? { note: company.note } : {}) } : company,
    )));
    setEditingCompanyProfile(false);
  };

  const retryCompanyProfile = async (company: ItemCompanyView): Promise<void> => {
    setCompanyError(undefined);
    setCompanies((current) => current.map((entry) =>
      entry.id === company.id ? { ...entry, profileStatus: "pending" } : entry,
    ));
    try {
      const accepted = await api.industryResearch.retryCompanyProfile(company.id);
      if (!accepted && selectedItem !== undefined) await loadCompanies(selectedItem);
    } catch {
      setCompanies((current) => current.map((entry) =>
        entry.id === company.id ? { ...entry, profileStatus: "failed" } : entry,
      ));
      setCompanyError(`“${company.name}”重试失败，请稍后再试`);
    }
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

  return (
    <section className="capability" aria-label="研究主题">
      <header className="capability-header"><span className="breadcrumb">能力 / 研究主题{selectedItem !== undefined ? ` / ${selectedItem.industry}` : ""}{selectedCompany !== undefined ? ` / ${selectedCompany.name}` : ""}</span></header>

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
          <button className="back-button" onClick={() => setSelectedCompanyId(undefined)}>‹ 返回公司列表</button>
          <div className="capability-page-heading"><div><h1 className="capability-title">{selectedCompany.name}</h1></div><div className="capability-actions">{!editingCompanyProfile && <button onClick={() => setEditingCompanyProfile(true)}>编辑基本信息</button>}<button className="danger-button" onClick={() => beginConfirmation({ kind: "remove-company", company: selectedCompany })}>删除公司</button></div></div>
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
          <CompanyResearchPanel
            key={`${selectedItem.id}:${selectedCompany.id}`}
            api={api}
            itemId={selectedItem.id}
            companyId={selectedCompany.id}
          />
        </>
      ) : (
        <>
          <button className="back-button" onClick={leaveItem}>‹ 返回调研列表</button>
          <div className="capability-page-heading">
            <div><h1 className="capability-title">{selectedItem.industry}</h1>{(selectedItem.researchScope !== undefined || selectedItem.notes !== undefined) && <dl className="scope-summary">{selectedItem.researchScope !== undefined && <div className="scope-row"><dt>研究范围</dt><dd>{selectedItem.researchScope}</dd></div>}{selectedItem.notes !== undefined && <div className="scope-row"><dt>备注</dt><dd>{selectedItem.notes}</dd></div>}</dl>}</div>
          </div>
          <div className="company-toolbar">
            {selecting ? <><button onClick={() => setSelectedCompanyIds(selectedCompanyIds.size === companies.length ? new Set() : new Set(companies.map((company) => company.id)))}>{selectedCompanyIds.size === companies.length && companies.length > 0 ? "清空" : "全选"}</button><button className="danger-button" disabled={selectedCompanyIds.size === 0} onClick={() => beginConfirmation({ kind: "remove-batch" })}>删除已选（{selectedCompanyIds.size}）</button><button onClick={() => { setSelecting(false); setSelectedCompanyIds(new Set()); }}>取消</button></> : <><button onClick={() => setOpenModal("add")}>添加公司</button><button disabled={companies.length === 0} onClick={() => setSelecting(true)}>批量删除</button><button className="primary-button" onClick={() => setOpenModal("import")}>一键导入公司</button></>}
          </div>
          {companyError !== undefined && <div className="error" role="alert">{companyError} <button onClick={() => void loadCompanies(selectedItem)}>重新加载</button></div>}
          <section className="company-panel" aria-labelledby="company-list-title">
            <h2 id="company-list-title">当前公司</h2>
            {loadingCompanies ? <p className="muted">加载公司列表…</p> : companies.length === 0 ? <p className="muted">暂无公司，可手动添加或从文本识别。</p> : (
              <ul className="company-list">{companies.map((company) => <li key={company.id}>
                {selecting ? <label className="company-select-row"><input type="checkbox" aria-label={`选择 ${company.name}`} checked={selectedCompanyIds.has(company.id)} onChange={() => toggleCompany(company.id)} /><span><strong>{company.name}</strong>{company.profileStatus === "ready" && company.headquarters !== undefined && <> · {company.headquarters}</>}</span></label> : <div className={`company-list-row profile-${company.profileStatus}`}><button className="company-row-button" disabled={company.profileStatus === "pending" || company.profileStatus === "enriching"} aria-label={`查看 ${company.name}`} onClick={() => { setEditingCompanyProfile(false); setSelectedCompanyId(company.id); }}><strong>{company.name}</strong>{company.profileStatus === "ready" && company.headquarters !== undefined && <span>{company.headquarters}</span>}{company.profileStatus === "ready" && company.note !== undefined && <small>{company.note}</small>}</button>{company.profileStatus === "enriching" && <span className="company-profile-spinner" role="status" aria-label={`${company.name} 基本信息补全中`} />}{company.profileStatus === "failed" && <><button className="company-profile-retry" aria-label={`重试补全 ${company.name}`} onClick={() => void retryCompanyProfile(company)}>重试</button><span className="company-profile-failed" role="img" aria-label={`${company.name} 基本信息补全失败`}>!</span></>}<button className="company-remove-button" aria-label={`删除公司 ${company.name}`} onClick={(event) => { event.stopPropagation(); beginConfirmation({ kind: "remove-company", company }); }}>×</button></div>}
              </li>)}</ul>
            )}
          </section>
        </>
      )}

      {openModal === "create" && <ResearchItemModal api={api} onClose={() => setOpenModal(undefined)} onSaved={handleSaved} />}
      {openModal === "edit" && editingItem !== undefined && <ResearchItemModal api={api} item={editingItem} onClose={() => { setOpenModal(undefined); setEditingItem(undefined); }} onSaved={handleSaved} />}
      {openModal === "add" && selectedItem !== undefined && <AddCompaniesModal api={api} itemId={selectedItem.id} onClose={() => setOpenModal(undefined)} onCompaniesAdded={handleCompaniesAdded} />}
      {openModal === "import" && selectedItem !== undefined && <ImportCompaniesModal api={api} itemId={selectedItem.id} onClose={() => setOpenModal(undefined)} onCompaniesAdded={handleCompaniesAdded} />}
      {confirmationProps !== undefined && <ConfirmModal {...confirmationProps} busy={deleting} error={deleteError} onClose={() => { if (!deleting) { setConfirmation(undefined); setDeleteError(undefined); } }} onConfirm={() => void confirmDeletion()} />}
    </section>
  );
}
