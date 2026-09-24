# companies.update

先用 companies.get 取得当前资料和 profileRevision。提交当前主题 itemId、companyId、expectedRevision（取该 profileRevision）及 profile 中要改的字段；未提供的字段保持原值。legalName、headquarters、foundedAt、businessTags 可传 null 清空，aliases、stockListings 可传空数组清空。officialWebsite 传 URL 表示已知，传 null 表示已确认无官网，传 {"state":"unknown"} 明确重置为未知；省略仍表示保持原值。更新的是公司共享基本资料，其他主题中的同一公司也会看到修改。确认卡展示修改后的所有资料；若确认前资料被别人修改，操作拒绝并要求重新读取。
