// 数据层公共类型（tenant-store 拆分，DESIGN §31）
export interface TenantRow {
  user_id: string;
  status: "active" | "disabled" | "deleted";
  limits_json: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  status: "active" | "archived" | "deleted";
  session_file: string | null;
  model_provider: string | null;
  model_id: string | null;
  entry_count: number;
  created_at: string;
  updated_at: string;
  last_live_at: string | null;
}

export interface TenantLimits {
  maxSessions: number;
  maxConcurrent: number;
  allowedProviders: string[] | null;
  /** 每分钟 prompt 类请求上限（null/0 = 不限） */
  rpm?: number | null;
  /** 月度成本预算 USD（null/0 = 不限，超额后 prompt 402） */
  monthlyBudgetUsd?: number | null;
}
