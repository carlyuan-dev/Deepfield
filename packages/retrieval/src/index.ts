export {
  UrlPolicy,
  isPublicAddress,
  type CheckedTarget,
  type DnsAnswer,
  type DnsLookup,
  type PolicyFailureCode,
  type UrlCheckResult,
} from "./url-policy.js";
export {
  SafeHttpTransport,
  TransportError,
  createSafeHttpTransport,
  type FetchOptions,
  type FetchResult,
  type HostTimer,
  type RequestOptions,
  type RequestTarget,
  type SafeHttpTransportOptions,
  type TransportAdapter,
  type TransportFailureCode,
  type TransportResponse,
} from "./http-transport.js";
export { createNodeHttpAdapter } from "./node-http-adapter.js";
export {
  ResourceStore,
  ResourceStoreError,
  zeroFillBuffer,
  type ResourceMetadata,
  type ResourceScope,
} from "./resource-store.js";
export {
  MAX_HTML_BYTES,
  MAX_PDF_BYTES,
  createFetchPdfDefinition,
  createFetchUrlDefinition,
  scopeFromContext,
  FetchInputSchema,
  FetchOutputSchema,
  type FetchInput,
  type FetchOutput,
  type FetchToolDeps,
} from "./fetch-tools.js";
export {
  createCheckLinkAccessibilityDefinition,
  LinkInputSchema,
  LinkOutputSchema,
  MAX_LINK_FALLBACK_BYTES,
  type LinkInput,
  type LinkOutput,
  type LinkToolDeps,
} from "./link-tool.js";
export {
  createParseHtmlDefinition,
  ParseHtmlInputSchema,
  ParseHtmlOutputSchema,
  HtmlLinkSchema,
  HtmlLocatorSchema,
  type HtmlLink,
  type HtmlLocator,
  type ParseHtmlDeps,
  type ParseHtmlInput,
  type ParseHtmlOutput,
} from "./html-tool.js";
export {
  decodeHtml,
  normalizeWhitespace,
  safeResolveUrl,
  MAX_HREF,
  MAX_LINK_TEXT,
  MAX_LOCATORS,
  MAX_LOCATOR_PATH,
  MAX_LOCATOR_TEXT,
  MAX_TITLE,
} from "./html-extraction.js";
export {
  joinPageText,
  joinPageTextBounded,
  MAX_PDF_CHARS,
  MAX_PDF_PAGES,
  MAX_PDF_METADATA_LENGTH,
  type TextItem,
} from "./pdf-text.js";
export {
  createParsePdfDefinition,
  ParsePdfInputSchema,
  ParsePdfOutputSchema,
  PdfPageTextSchema,
  type ParsePdfDeps,
  type ParsePdfInput,
  type ParsePdfOutput,
  type PdfPageText,
} from "./pdf-tool.js";
export {
  createAbortGuard,
  createMemoizedDestroy,
  type PdfDocumentLike,
  type PdfLoader,
  type PdfLoadingTaskLike,
  type PdfPageLike,
} from "./pdf-lifecycle.js";
export {
  normalizeSearchResults,
  SearchProviderError,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  MAX_RESULT_URL_LENGTH,
  MAX_RESULT_TITLE_LENGTH,
  MAX_RESULT_SNIPPET_LENGTH,
  type NormalizedSearchResponse,
  type NormalizedSearchResult,
  type RawSearchResult,
  type SearchProvider,
  type SearchProviderErrorCode,
  type SearchRequest,
} from "./search-provider.js";
export {
  ProviderHttpClient,
  parseRetryAfter,
  type ProviderEndpoint,
  type ProviderHttpClientDeps,
  type ProviderHttpRequestOptions,
  type ProviderHttpResponse,
  type ProviderTransport,
  type ProviderTransportRequest,
  type ProviderTransportResponse,
} from "./provider-http-client.js";
export { createNodeProviderTransport } from "./provider-node-transport.js";
export { createBraveProvider, type BraveProviderDeps } from "./providers/brave.js";
export { createTavilyProvider, type TavilyProviderDeps } from "./providers/tavily.js";
export { createSerperProvider, type SerperProviderDeps } from "./providers/serper.js";
export {
  createSearchWebDefinition,
  SearchWebInputSchema,
  SearchWebOutputSchema,
  SearchWebResultSchema,
  type SearchWebInput,
  type SearchWebOutput,
} from "./search-tool.js";
export { QUERIES_V1, readQueriesV1, type BenchmarkQueryV1, type QuerySetV1 } from "./benchmark/queries.js";
export {
  REFERENCE_COMPANIES_V1,
  readReferenceCompaniesV1,
  type CompanyCategory,
  type ReferenceCompanyV1,
  type ReferenceSetV1,
} from "./benchmark/reference-companies.js";
export {
  BENCHMARK_CANDIDATES_V1,
  KEYCHAIN_SERVICES,
  LIVE_PROVIDER_ENV_KEYS,
  SUPPORTED_PROVIDER_IDS,
  requireBenchmarkCandidateAssembly,
  type LiveProviderId,
  type SupportedProviderId,
} from "./providers/provider-catalog.js";

export {
  parseProviderPricingJson,
  resolveProviderPricing,
  type PriceCurrency,
  type ProviderPrice,
  type ResolvedProviderPricing,
} from "./benchmark/pricing.js";

export {
  assertValidScoringInput,
  linkValidityFromEvidence,
  scoreBenchmark,
  matchesCompanyDomain,
  normalizeDomain,
  percentile,
  urlHostname,
  WEIGHTS,
  type BenchmarkedRun,
  type BenchmarkScoringInput,
  type BenchmarkScoringResult,
  type HardGateStatus,
  type LinkEvidence,
  type ProviderRawMetrics,
  type ProviderScore,
} from "./benchmark/scoring.js";
export {
  writeBenchmarkReport,
  REPORT_FILENAME,
  type BenchmarkReport,
  type ProviderConfigSummary,
} from "./benchmark/report.js";
