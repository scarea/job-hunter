export type Platform = "boss" | "zhaopin" | "liepin" | "tencent" | "official";

/** 采集器输出的统一岗位结构 */
export interface RawJob {
  platform: Platform;
  externalId: string;
  title: string;
  company: string;
  salaryRaw: string;
  city?: string;
  district?: string;
  tags: string[];
  jd?: string;
  url: string;
  query?: string;
}

/** 解析后的薪资 */
export interface SalaryInfo {
  salaryMin: number | null; // 单位：千元/月
  salaryMax: number | null;
  months: number | null;    // 13/14/15/16 薪
}

export interface ScoreDims {
  tech: number;     // 0-30 技术匹配
  salary: number;   // 0-25 薪资达标
  weekend: number;  // 0-20 双休可能
  company: number;  // 0-15 公司质量
  growth: number;   // 0-10 成长性
}

export type Verdict = "建议投" | "可投" | "不投";

export interface ScoreResult {
  total: number;
  dims: ScoreDims;
  verdict: Verdict;
  reason: string;
  rejectRule?: string;
  aiRaw?: string;
  /** cacheHit：命中 DeepSeek 前缀缓存的输入 token（单价低很多） */
  usage?: { input: number; output: number; cacheHit?: number };
  /** 适合的岗位：LLM 建议的搜索关键词（喂给关键词策略） */
  searchKeywords?: string[];
  /** LLM 调用失败（结果是临时的规则分）：不要入库，下次重试 */
  failed?: boolean;
}

export interface Collector {
  platform: Platform;
  /** 只读采集：导航 + 读取 DOM，绝不点击投递/打招呼 */
  collect(query: string, opts: { maxPages: number; page: any }): Promise<RawJob[]>;
}
