import { useEffect, useState } from "react";
import type { CompanyResearchApi } from "../contracts/api.js";
import type { ResearchEvidenceView } from "../contracts/research-evidence.js";
import { isSafeHttpUrl, UrlPopoverLink } from "../../../apps/desktop/src/renderer/components/UrlPopoverLink.js";
const reasons = { none: "无", item_limit: "单片段容量上限", total_limit: "总容量上限", entry_limit: "条目数上限" };
export function ResearchEvidenceDetails({ api, itemId, companyId, runId }: { api: CompanyResearchApi; itemId: string; companyId: string; runId: string }) {
  const key = `${itemId}:${companyId}:${runId}`;
  const [result, setResult] = useState<{ key: string; view?: ResearchEvidenceView; error?: boolean }>();
  useEffect(() => {
    let current = true;
    void api.companyResearch.getEvidence(itemId, companyId, runId).then(view => { if (current) setResult({ key, view }); }, () => { if (current) setResult({ key, error: true }); });
    return () => { current = false; };
  }, [api, itemId, companyId, runId, key]);
  if (result?.key !== key || result.view?.status === "legacy_missing") return null;
  if (result.view?.status === "evidence_incomplete") return <p role="status">检索依据不完整（evidence_incomplete），请重新联网调研。</p>;
  if (result.error) return <p role="status" className="muted">检索依据读取失败，请重新加载报告。</p>;
  const view = result.view;
  if (!view) return null;
  return <details className="research-evidence"><summary>检索依据</summary>
    <p>{view.status === "partial" ? "检索依据部分留存" : "检索依据已留存"}：已存 / 已发送可见 {view.counts.savedEntries} / {view.counts.visibleEntries} 条，{view.counts.savedBytes} / {view.counts.visibleBytes} 字节；省略 {view.counts.omittedEntries} 条、{view.counts.omittedBytes} 字节。</p>
    <p className="muted">按模型请求的工具输出分组；来源关联不代表片段支持报告中的具体事实。已发送 {view.counts.dispatched} 次，准备但未发送 {view.counts.prepared} 次。</p>
    {view.groups.map(group => <section key={group.modelRequestId}>
      <h4>{group.phase === "synthesis" ? "收尾请求" : "普通请求"} · {group.responseState === "not_sent" ? "准备但未发送" : group.responseState === "failed" ? "已发送，响应失败" : group.responseState === "pending" ? "已发送，响应未完成" : "已发送，响应成功"}</h4>
      {group.projections.map((p, index) => <article key={`${p.evidenceId}:${index}`}>
        <p>{p.toolName === "web_search" ? "搜索结果组" : "工具输出"} · 采集时间 {p.capturedAt}{p.mapping === "unmapped" && " · 来源定位不完整"}</p>
        {p.sources.map((source, i) => <div key={i}>
          {source.kind === "page_excerpt" && <span>返回的规范 / 来源链接：</span>}
          {isSafeHttpUrl(source.url) ? <UrlPopoverLink href={source.url}>{source.title || source.url}</UrlPopoverLink> : <span>{source.title}（链接不可打开）</span>}
          {([ ["请求链接", source.requestedUrl], ["实际获取链接", source.finalUrl] ] as const).map(([label, url]) => url && <p key={label}>{label}：{isSafeHttpUrl(url) ? <UrlPopoverLink href={url}>{url}</UrlPopoverLink> : <span>链接不可打开</span>}</p>)}
          <p className="muted">{source.kind === "page_excerpt" ? "网页摘录" : source.kind === "search_snippet" ? "搜索片段" : "材料类型未知"} · {source.sourceDate?.status === "valid" && source.sourceDate.nature === "published" ? `发表日期 ${source.sourceDate.normalizedValue}（精度：${source.sourceDate.precision === "day" ? "日" : "日期时间"}）` : "发表日期未知"}
            {source.sourceDate && <> · 日期出处：{source.sourceDate.evidenceSource === "provider_metadata" ? "服务商元数据" : "未知"} / {source.sourceDate.provider}{source.sourceDate.fieldName && ` / ${source.sourceDate.fieldName}`} · 状态：{source.sourceDate.status}{source.sourceDate.rawValue !== undefined && <> · 原字段：{source.sourceDate.rawValue}{source.sourceDate.rawValueTruncated && "（原字段已截断）"}</>}</>}
          </p>
        </div>)}
        {p.archiveClipping.reason !== "none" && <p>摘录已截断 / 省略：{reasons[p.archiveClipping.reason]}，省略 {p.archiveClipping.omittedBytes} 字节。</p>}
        {[p.formatting, p.modelClipping].filter(c => c && (c.beforeHash !== c.afterHash || c.beforeBytes !== c.afterBytes || (c.omittedItems !== null && c.omittedItems > 0))).map((c, i) => c && <p key={i}>{group.responseState === "not_sent" ? "准备发送的结果已裁剪" : "模型收到的结果已裁剪"}：{c.beforeBytes} → {c.afterBytes} 字节，省略条目 {c.omittedItems ?? "未知"}。</p>)}
        <pre>{p.savedText || "此投影未保存文本。"}</pre>
      </article>)}
    </section>)}
  </details>;
}
