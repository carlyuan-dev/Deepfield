# companies.get

提供主题 itemId 和公司 companyId。默认返回名称、法定名称、总部、成立时间、官网、资料状态、报告概况及可打开的公司页面，并给出别名、上市信息、业务标签和当前主题备注的数量。需要这些列表时传 section=aliases、stockListings、businessTags 或 note，按 limit（1–20）和 nextCursor 分页读取；note 按每段最多 4000 字符返回。不存在当前主题关联时拒绝。
