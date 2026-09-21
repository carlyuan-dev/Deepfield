import { Type, type Static } from "typebox";

export const RESEARCH_DIRECTIONS = Object.freeze([
  "product_and_technology",
  "market_and_commercialization",
  "value_chain_and_competition",
  "operations_and_performance",
] as const);
export type ResearchDirection = typeof RESEARCH_DIRECTIONS[number];
// Keep tuple inference: a mapped array produces Static<...> = never in TypeBox 1.
export const ResearchDirectionSchema = Type.Union([
  Type.Literal(RESEARCH_DIRECTIONS[0]),
  Type.Literal(RESEARCH_DIRECTIONS[1]),
  Type.Literal(RESEARCH_DIRECTIONS[2]),
  Type.Literal(RESEARCH_DIRECTIONS[3]),
]);

export const CompanyResearchTemplateSnapshotSchema = Type.Immutable(Type.Object({
  templateId: ResearchDirectionSchema,
  templateVersion: Type.Literal(1),
  title: Type.String({ minLength: 1, maxLength: 1000 }),
  sections: Type.Array(Type.Object({
    sectionId: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    coreQuestion: Type.String({ minLength: 1, maxLength: 4000 }),
    coverage: Type.String({ minLength: 1, maxLength: 4000 }),
    boundary: Type.String({ minLength: 1, maxLength: 4000 }),
  }, { additionalProperties: false }), { minItems: 5, maxItems: 5 }),
}, { additionalProperties: false }));
export type CompanyResearchTemplateSnapshot = Static<typeof CompanyResearchTemplateSnapshotSchema>;

// Section IDs, titles and semantics follow the approved discussion §6;
// concise question/coverage/boundary wording follows its prompt assembly §21.3.
const templates: Record<ResearchDirection, CompanyResearchTemplateSnapshot> = {
  product_and_technology: {
    templateId: "product_and_technology", templateVersion: 1, title: "产品与技术",
    sections: [
      {
        sectionId: "products_and_positioning", title: "主要产品与定位",
        coreQuestion: "公司围绕研究主题具体提供什么产品，面向谁、用于什么场景、解决什么问题，在相关业务中处于什么定位？",
        coverage: "已发布、在研或停止的产品；型号、版本和产品组合；目标用户与场景；自研、联合开发或贴牌关系。",
        boundary: "不重复公司简介，不罗列无关产品线，不系统研究销量、收入或市场份额；销量仅可用于证明产品阶段或定位。",
      },
      {
        sectionId: "technology_and_metrics", title: "核心技术与指标",
        coreQuestion: "产品采用什么技术路线，关键指标怎样，技术由谁提供，有什么可核查的验证证据？",
        coverage: "架构、材料、算法和工艺；关键性能指标及条件；自研、采购、授权与合作关系；专利、标准、认证、测试；相对上一代或主流方案的变化。",
        boundary: "严格区分宣传、实验室或样机数据、第三方测试和量产实际表现；测试条件不同的数字不得直接比较。",
      },
      {
        sectionId: "development_and_readiness", title: "研发与产品阶段",
        coreQuestion: "产品或技术目前走到哪一步，有哪些证据证明其成熟度？",
        coverage: "概念验证、研发、样机、测试、认证、试产、量产；发布、延期、交付和迭代时间；与成熟度相关的产能、良率、真实客户和应用案例；下一阶段计划。",
        boundary: "只判断产品与技术成熟度，不系统研究销量、定价和收入。",
      },
      {
        sectionId: "competitive_position", title: "竞争力与替代方案",
        coreQuestion: "相对现有方案，公司产品或技术的优势是否成立，又可能被什么替代？",
        coverage: "现有方案痛点；性能、成本、体验和部署差异；技术壁垒及证据；替代技术、供应商或产品；第三方验证情况。",
        boundary: "竞品只用于定位目标公司的技术竞争力，不扩展为多公司横评，不系统研究市场份额。",
      },
      {
        sectionId: "constraints_and_roadmap", title: "技术瓶颈与路线图",
        coreQuestion: "产品还受什么技术限制，公司准备如何迭代，外部技术变化会怎样影响路线？",
        coverage: "性能、可靠性、安全、功耗、良率和规模化瓶颈；关键依赖；失败、延期、降级或未达预期；明确迭代计划；行业技术变化的影响。",
        boundary: "成本只在直接构成技术或量产障碍时进入；原材料价格与供应链成本归产业链方向。",
      },
    ],
  },
  market_and_commercialization: {
    templateId: "market_and_commercialization", templateVersion: 1, title: "市场与商业化",
    sections: [
      {
        sectionId: "target_market_and_customers", title: "目标市场与客户",
        coreQuestion: "相关产品真正面向哪些客户、用户、地区、场景和细分市场？",
        coverage: "目标用户与客户类型；应用场景；地区与细分市场；已确认客户或用户群体。",
        boundary: "只保留与目标公司直接相关的市场信息，不展开通用行业报告。",
      },
      {
        sectionId: "commercialization_progress", title: "商业化阶段与进展",
        coreQuestion: "产品从测试走向实际交易和规模销售到了哪一步？",
        coverage: "测试、试点、发布、签约、量产交付、规模销售及重要商业节点。",
        boundary: "严格区分合作意向与正式合同、产品发布与实际销售、试点与付费客户、订单与交付及收入确认。",
      },
      {
        sectionId: "sales_and_adoption", title: "销售与采用情况",
        coreQuestion: "产品取得了哪些可量化的市场采用结果？",
        coverage: "销量、出货量、订单、客户数、用户数、渗透率、复购率、活跃度等。",
        boundary: "所有数字注明时间、地区和统计口径；订单、出货、零售销量和激活量不得混用。",
      },
      {
        sectionId: "pricing_and_business_model", title: "价格与商业模式",
        coreQuestion: "产品卖多少钱，公司通过什么方式变现？",
        coverage: "官方定价、实际成交价、价格变化与补贴；硬件销售、订阅、服务费、授权费等收入模式。",
        boundary: "不系统展开原材料成本，除非它直接导致调价或改变商业模式。",
      },
      {
        sectionId: "drivers_barriers_and_outlook", title: "增长动力与障碍",
        coreQuestion: "什么推动或阻碍产品商业化，未来增长判断建立在什么依据上？",
        coverage: "需求动力；价格、渠道、体验、接受度、监管和竞争障碍；公司销售目标与外部市场预测。",
        boundary: "目标与预测必须标明性质；不系统分析公司整体营收、利润和现金流。",
      },
    ],
  },
  value_chain_and_competition: {
    templateId: "value_chain_and_competition", templateVersion: 1, title: "产业链与竞争格局",
    sections: [
      {
        sectionId: "value_chain_position", title: "产业链位置",
        coreQuestion: "公司处于产业链哪个环节，主要提供什么价值，与上下游怎样连接？",
        coverage: "研发、生产、零部件、平台、渠道或服务位置；主要价值来源；关键上下游关系。",
        boundary: "只建立解释目标公司所需的产业位置，不绘制完整行业地图。",
      },
      {
        sectionId: "key_relationships", title: "客户、供应商与合作关系",
        coreQuestion: "公司依赖哪些重要客户、供应商、代工方、渠道和技术伙伴，关系有多实？",
        coverage: "合作对象、合作内容、依赖程度和关系变化。",
        boundary: "严格区分正式披露与传闻、战略合作与真实采购、单次合作与长期关系、客户名单与收入贡献。",
      },
      {
        sectionId: "competitors_and_differentiation", title: "竞争者与差异化",
        coreQuestion: "公司与谁直接竞争，面对哪些替代产品或技术，差异在哪里？",
        coverage: "直接竞争者、替代产品和替代技术；产品、技术、价格、渠道和资源差异。",
        boundary: "竞争者只用于解释目标公司位置，不扩展为完整横评。",
      },
      {
        sectionId: "supply_cost_and_resources", title: "供应、成本与关键资源",
        coreQuestion: "哪些原材料、零部件、产能、数据、人才或牌照决定公司的供应稳定性和成本？",
        coverage: "关键资源及来源；供应稳定性；成本变化；产能和议价能力。",
        boundary: "严格区分规划与实际产能、设计产能与实际产量、行业价格与公司采购成本、短期波动与长期依赖。",
      },
      {
        sectionId: "opportunities_and_risks", title: "产业机会与风险",
        coreQuestion: "外部产业变化会给目标公司带来哪些可解释的机会和风险？",
        coverage: "政策、监管、技术路线、供需周期、地缘因素和产业迁移的影响。",
        boundary: "所有行业事实必须回扣目标公司；技术性能归产品方向，产品销量和消费者接受度归市场方向。",
      },
    ],
  },
  operations_and_performance: {
    templateId: "operations_and_performance", templateVersion: 1, title: "公司经营与业绩",
    sections: [
      {
        sectionId: "financial_performance", title: "核心财务表现",
        coreQuestion: "公司在报告期内的核心经营结果怎样、发生了什么变化？",
        coverage: "收入、利润、毛利率、费用、现金流及同比、环比变化。",
        boundary: "注明期间、币种、单位和会计口径，区分正式财报、业绩预告和市场预测；不讨论股价与投资评级。",
      },
      {
        sectionId: "business_mix_and_topic_contribution", title: "业务结构与主题贡献",
        coreQuestion: "公司靠哪些业务贡献业绩，研究主题相关业务实际贡献了多少？",
        coverage: "业务板块的收入、利润或资源占比；主题相关业务对整体业绩的贡献。",
        boundary: "未单独披露的数据只能记录无法拆分，不能自行估算为确定数字。",
      },
      {
        sectionId: "operating_indicators", title: "关键经营指标",
        coreQuestion: "哪些非财务指标能够解释公司的经营状态？",
        coverage: "根据业务模式选择出货量、订单、产能利用率、客户数、门店数、订阅用户等关键指标。",
        boundary: "只保留能够解释经营结果的指标，不堆积无关数据。",
      },
      {
        sectionId: "performance_drivers", title: "业绩变化原因",
        coreQuestion: "收入、利润和现金流变化由哪些因素造成，证据强度怎样？",
        coverage: "销量、价格、产品结构、成本、费用、汇率、减值和一次性因素。",
        boundary: "区分管理层解释、第三方判断、数据可验证变化和未证实推测。",
      },
      {
        sectionId: "guidance_and_risks", title: "经营指引与风险",
        coreQuestion: "公司对未来给出什么指引，哪些风险会影响兑现？",
        coverage: "收入、利润、产能、资本开支等明确指引，以及相关经营风险。",
        boundary: "规划、目标和预测必须与已实现数据分开；产品只在能够解释经营结果时进入，不重新制作技术报告。",
      },
    ],
  },
};

for (const template of Object.values(templates)) {
  for (const section of template.sections) Object.freeze(section);
  Object.freeze(template.sections);
  Object.freeze(template);
}
export const COMPANY_RESEARCH_TEMPLATES = Object.freeze(templates);

/** Safe to share: each plain-data snapshot and all its descendants are frozen. */
export function getCompanyResearchTemplate(direction: ResearchDirection): CompanyResearchTemplateSnapshot {
  return COMPANY_RESEARCH_TEMPLATES[direction];
}
