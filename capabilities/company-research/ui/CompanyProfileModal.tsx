import { useState, type FormEvent } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { Company, CompanyProfileInput } from "../contracts/index.js";
import { useFormField, useMappedFormField, type FormControl } from "./form-control.js";

export interface CompanyProfileFormProps {
  control?: FormControl;
  api: DesktopApi;
  company: Company;
  onCancel(): void;
  onSaved(company: Company): void;
}

function splitValues(value: string): string[] {
  return value.split(/[,，\n]/u).map((entry) => entry.trim()).filter(Boolean);
}

export function CompanyProfileForm({ api, company, control, onCancel, onSaved }: CompanyProfileFormProps) {
  const [name, setName] = useFormField(control, "name", company.name);
  const [legalName, setLegalName] = useMappedFormField(control, "legalName", company.legalName ?? "", value => value ?? "", value => value || null);
  const [aliases, setAliases] = useMappedFormField(control, "aliases", company.aliases?.join("，") ?? "", value => value?.join("，") ?? "", splitValues);
  const [noAliases, setNoAliases] = useMappedFormField(control, "aliases", company.aliases?.length === 0, value => value?.length === 0, value => value ? [] : splitValues(aliases));
  const [headquarters, setHeadquarters] = useMappedFormField(control, "headquarters", company.headquarters ?? "", value => value ?? "", value => value || null);
  const [foundedAt, setFoundedAt] = useMappedFormField(control, "foundedAt", company.foundedAt ?? "", value => value ?? "", value => value || null);
  const [website, setWebsite] = useMappedFormField<string>(control, "officialWebsite", company.officialWebsite ?? "", value => typeof value === "string" ? value : company.officialWebsite ?? "", value => value);
  const [websiteState, setWebsiteState] = useMappedFormField<"unknown" | "none" | "known">(control, "officialWebsite", company.officialWebsite === undefined ? "unknown" : company.officialWebsite === null ? "none" : "known", value => value === undefined || value?.state === "unknown" ? "unknown" : value === null ? "none" : "known", value => value === "none" ? null : value === "unknown" ? { state: "unknown" } : website.trim());
  const [listings, setListings] = useMappedFormField<string>(control, "stockListings", company.stockListings?.map(listing => `${listing.exchange}:${listing.ticker}`).join("\n") ?? "", value => value?.map((listing: { exchange: string; ticker: string }) => `${listing.exchange}:${listing.ticker}`).join("\n") ?? "", value => value.split("\n").filter(Boolean).map(line => ({ exchange: line.split(":")[0] ?? "", ticker: line.split(":").slice(1).join(":") })));
  const [unlisted, setUnlisted] = useMappedFormField(control, "stockListings", company.stockListings?.length === 0, value => value?.length === 0, value => value ? [] : listings.split("\n").filter(Boolean).map(line => ({ exchange: line.split(":")[0] ?? "", ticker: line.split(":").slice(1).join(":") })));
  const [tags, setTags] = useMappedFormField(control, "businessTags", company.businessTags?.join("，") ?? "", value => value?.join("，") ?? "", splitValues);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("请填写公司名称");
      return;
    }
    const parsedListings = listings.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf(":");
      return separator < 1
        ? undefined
        : { exchange: line.slice(0, separator).trim(), ticker: line.slice(separator + 1).trim() };
    });
    if (!unlisted && parsedListings.some((listing) => listing === undefined || listing.ticker.length === 0)) {
      setError("上市信息请每行填写为“交易所:代码”");
      return;
    }
    const businessTags = splitValues(tags);
    if (businessTags.length > 5) {
      setError("业务标签最多 5 个");
      return;
    }
    const input: CompanyProfileInput = {
      name: trimmedName,
      ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
      ...(noAliases ? { aliases: [] } : aliases.trim() ? { aliases: splitValues(aliases) } : {}),
      ...(headquarters.trim() ? { headquarters: headquarters.trim() } : {}),
      ...(foundedAt.trim() ? { foundedAt: foundedAt.trim() } : {}),
      ...(websiteState === "none"
        ? { officialWebsite: null }
        : websiteState === "known"
          ? { officialWebsite: website.trim() }
          : {}),
      ...(unlisted
        ? { stockListings: [] }
        : parsedListings.length > 0
          ? { stockListings: parsedListings as Array<{ exchange: string; ticker: string }> }
          : {}),
      ...(businessTags.length > 0 ? { businessTags } : {}),
    };
    setSubmitting(true);
    setError(undefined);
    try {
      if (control) { await control.confirm(); return; }
      onSaved(await api.industryResearch.updateCompany(company.id, input));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      setError(/already exists/i.test(message) ? "已有同名公司，无法重命名" : "保存失败，请检查填写内容后重试");
      setSubmitting(false);
    }
  };

  return (
      <form className="company-profile-form" aria-label="编辑公司基本信息" onSubmit={handleSubmit}>
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <label>公司名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>法定名称（可选）<input value={legalName} onChange={(event) => setLegalName(event.target.value)} /></label>
        <label>别名（逗号分隔）<textarea disabled={noAliases} value={aliases} onChange={(event) => setAliases(event.target.value)} rows={2} /></label>
        <label className="inline-check"><input type="checkbox" checked={noAliases} onChange={(event) => setNoAliases(event.target.checked)} />已确认无别名</label>
        <label>总部（可选）<input value={headquarters} onChange={(event) => setHeadquarters(event.target.value)} /></label>
        <label>成立时间（YYYY、YYYY-MM 或 YYYY-MM-DD）<input value={foundedAt} onChange={(event) => setFoundedAt(event.target.value)} /></label>
        <label>官方网站状态<select value={websiteState} onChange={(event) => setWebsiteState(event.target.value as typeof websiteState)}><option value="unknown">未知</option><option value="known">已知</option><option value="none">已确认无官方网站</option></select></label>
        {websiteState === "known" && <label>官方网站<input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} required /></label>}
        <label>上市信息（每行“交易所:代码”）<textarea disabled={unlisted} value={listings} onChange={(event) => setListings(event.target.value)} rows={3} /></label>
        <label className="inline-check"><input type="checkbox" checked={unlisted} onChange={(event) => setUnlisted(event.target.checked)} />已确认未上市</label>
        <label>业务标签（1–5 个，逗号分隔）<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
        <div className="modal-actions"><button type="button" disabled={submitting} onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "保存中…" : "保存"}</button></div>
      </form>
  );
}
