export type ToolMeterCategory = "search" | "fetch" | "link_check" | "parse" | "none";

export interface BudgetDimensionSnapshot {
  limit?: number;
  reserved: number;
  consumed: number;
  remaining?: number;
  exhausted: boolean;
}

export interface ToolBudgetSnapshot {
  total: BudgetDimensionSnapshot;
  categories: Record<ToolMeterCategory, BudgetDimensionSnapshot>;
}
