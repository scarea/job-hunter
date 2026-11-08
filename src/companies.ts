/**
 * 「值得关注的公司」——数据层
 *
 * 面板原来每次现算（从 jobs 聚合），没法沉淀 AI 的判断，也没法挂官网/招聘页链接。
 * 这里加一张 company_watch 表：每周由 AI 更新一次（见 src/cli/companies.ts），
 * 面板直接读它，点卡片能跳到招聘页/官网。
 */
import { db } from "./db.js";

export interface CompanyWatchRow {
  company: string;
  website: string | null;     // 官网
  careerUrl: string | null;   // 招聘页
  jobs: number;               // 当前在库岗位数
  maxSalary: number | null;
  minSalary: number | null;
  platforms: string[];
  city: string;
  tier: string;               // S / A / B / 成长型
  note: string;               // AI 一句话点评
  watch: number;              // AI 关注度 0-100
  updatedAt: string;
}

db.exec(`
CREATE TABLE IF NOT EXISTS company_watch (
  company    TEXT PRIMARY KEY,
  website    TEXT,
  career_url TEXT,
  jobs       INTEGER NOT NULL DEFAULT 0,
  max_salary REAL,
  min_salary REAL,
  platforms  TEXT NOT NULL DEFAULT '[]',
  city       TEXT NOT NULL DEFAULT '',
  tier       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  watch      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
`);

/**
 * 已知公司的官网 / 招聘页。
 * 招聘页优先填「真的能点进去投递」的地址；没有就退回 BOSS 搜索。
 */
const KNOWN: Record<string, { site?: string; career?: string }> = {
  字节跳动: { site: "https://www.bytedance.com", career: "https://jobs.bytedance.com" },
  腾讯: { site: "https://www.tencent.com", career: "https://careers.tencent.com" },
  阿里巴巴: { site: "https://www.alibaba.com", career: "https://talent.alibaba.com" },
  阿里云: { site: "https://www.aliyun.com", career: "https://talent.alibaba.com" },
  美团: { site: "https://www.meituan.com", career: "https://zhaopin.meituan.com" },
  百度: { site: "https://www.baidu.com", career: "https://talent.baidu.com" },
  华为: { site: "https://www.huawei.com", career: "https://career.huawei.com" },
  网易: { site: "https://www.163.com", career: "https://hr.163.com" },
  京东: { site: "https://www.jd.com", career: "https://zhaopin.jd.com" },
  小米: { site: "https://www.mi.com", career: "https://hr.xiaomi.com" },
  MiniMax: { site: "https://www.minimax.cn", career: "https://vrfi1sk8a0.jobs.feishu.cn/index" },
  生数科技: { site: "https://www.shengshu.com", career: "https://shengshu.jobs.feishu.cn/index" },
  智谱: { site: "https://www.zhipuai.cn", career: "https://www.zhipuai.cn/careers" },
  爱诗科技: { site: "https://pixverse.ai", career: "https://pixverse.ai/zh/careers" },
  月之暗面: { site: "https://www.moonshot.cn", career: "https://moonshot.jobs.feishu.cn" },
  硅基流动: { site: "https://siliconflow.cn", career: "https://siliconflow.cn" },
  LiblibAI: { site: "https://www.liblib.art", career: "https://www.liblib.art" },
  "Sand.ai": { site: "https://sand.ai", career: "https://sand.ai" },
  深信服: { site: "https://www.sangfor.com.cn", career: "https://hr.sangfor.com" },
  深信服科技: { site: "https://www.sangfor.com.cn", career: "https://hr.sangfor.com" },
  影石: { site: "https://www.insta360.com", career: "https://arashivision.jobs.feishu.cn/social" },
  影石Insta360: { site: "https://www.insta360.com", career: "https://arashivision.jobs.feishu.cn/social" },
  大疆: { site: "https://www.dji.com", career: "https://careers.dji.com" },
  万兴科技: { site: "https://www.wondershare.cn", career: "https://wondershare.zhiye.com/social" },
  优必选: { site: "https://www.ubtrobot.com", career: "https://zhaopin.ubtrobot.com" },
  云天励飞: { site: "https://www.intellif.com", career: "https://www.intellif.com" },
  思谋科技: { site: "https://www.smartmore.com", career: "https://www.smartmore.com" },
  元象: { site: "https://www.xverse.cn", career: "https://www.xverse.cn" },
  商汤: { site: "https://www.sensetime.com", career: "https://www.sensetime.com" },
  云从科技: { site: "https://www.cloudwalk.com", career: "https://www.cloudwalk.com" },
  云知声: { site: "https://www.unicloud.ai", career: "https://www.unicloud.ai" },
  米哈游: { site: "https://www.mihoyo.com", career: "https://hr.mihoyo.com" },
  货拉拉: { site: "https://www.huolala.cn", career: "https://hr.huolala.cn" },
  微众银行: { site: "https://www.webank.com", career: "https://hr.webank.com" },
  金蝶: { site: "https://www.kingdee.com", career: "https://www.kingdee.com" },
  安克创新: { site: "https://www.anker.com", career: "https://careers.anker.com" },
  传音: { site: "https://www.transsion.com", career: "https://career.transsion.com" },
  韶音: { site: "https://www.shokz.com", career: "https://www.shokz.com" },
  追觅: { site: "https://www.dreame.tech", career: "https://www.dreame.tech" },
  雷鸟创新: { site: "https://www.rayneo.com", career: "https://www.rayneo.com" },
  锐捷网络: { site: "https://www.ruijie.com.cn", career: "https://www.ruijie.com.cn" },
  迈瑞: { site: "https://www.mindray.com", career: "https://career.mindray.com" },
  元征科技: { site: "https://www.cnlaunch.com", career: "https://www.cnlaunch.com" },
};

/** 关键词匹配（公司名可能带部门后缀，如「深信服·研发体系」） */
function lookup(company: string) {
  const base = company.split(/[·｜|(（]/)[0].trim();
  for (const [name, v] of Object.entries(KNOWN)) {
    if (base.includes(name) || name.includes(base)) return v;
  }
  return null;
}

/** BOSS 搜公司名——没有官网映射时的兜底，至少能点进去看到岗位 */
export function bossSearch(company: string): string {
  const base = company.split(/[·｜|(（]/)[0].trim();
  return `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(base)}&city=101280600`;
}

export function resolveLinks(company: string): { website: string | null; careerUrl: string } {
  const k = lookup(company);
  return { website: k?.site ?? null, careerUrl: k?.career ?? bossSearch(company) };
}

export function saveWatch(rows: Omit<CompanyWatchRow, "tier" | "note" | "watch" | "updatedAt">[] ): void {
  const stmt = db.prepare(`
    INSERT INTO company_watch (company, website, career_url, jobs, max_salary, min_salary, platforms, city, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company) DO UPDATE SET
      website=excluded.website, career_url=excluded.career_url, jobs=excluded.jobs,
      max_salary=excluded.max_salary, min_salary=excluded.min_salary,
      platforms=excluded.platforms, city=excluded.city, updated_at=excluded.updated_at
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((list: typeof rows) => {
    for (const r of list) {
      stmt.run(r.company, r.website, r.careerUrl, r.jobs, r.maxSalary, r.minSalary, JSON.stringify(r.platforms), r.city, now);
    }
  });
  tx(rows);
}

export function setAnnotation(company: string, note: string, watch: number, tier: string): void {
  db.prepare("UPDATE company_watch SET note=?, watch=?, tier=? WHERE company=?").run(note, watch, tier, company);
}

export function listWatch(limit = 60): CompanyWatchRow[] {
  const rows = db.prepare(`
    SELECT * FROM company_watch ORDER BY watch DESC, max_salary DESC, jobs DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map((r) => ({
    company: r.company,
    website: r.website,
    careerUrl: r.career_url,
    jobs: r.jobs,
    maxSalary: r.max_salary,
    minSalary: r.min_salary,
    platforms: (() => { try { return JSON.parse(r.platforms); } catch { return []; } })(),
    city: r.city,
    tier: r.tier,
    note: r.note,
    watch: r.watch,
    updatedAt: r.updated_at,
  }));
}

/** 从 jobs 表现算一遍公司画像（不含 AI 点评），供每周任务用 */
export function aggregateCompanies(minSalary = 25, minJobs = 2): Omit<CompanyWatchRow, "tier" | "note" | "watch" | "updatedAt">[] {
  const rows = db.prepare(`
    SELECT company,
           COUNT(*) AS jobs,
           MAX(salary_max) AS maxSalary,
           MIN(salary_min) AS minSalary,
           GROUP_CONCAT(DISTINCT platform) AS platforms,
           MAX(city) AS city
    FROM jobs
    WHERE salary_max >= ? AND company != '' AND company NOT LIKE '%某%'
      AND (title LIKE '%AI%' OR title LIKE '%算法%' OR title LIKE '%模型%' OR title LIKE '%推理%'
        OR title LIKE '%平台%' OR title LIKE '%后端%' OR title LIKE '%架构%' OR title LIKE '%Agent%'
        OR title LIKE '%大模型%' OR title LIKE '%研发%' OR title LIKE '%工程师%' OR title LIKE '%Infra%')
    GROUP BY company
    HAVING jobs >= ?
    ORDER BY maxSalary DESC, jobs DESC
    LIMIT 200
  `).all(minSalary, minJobs) as any[];

  return rows.map((r) => {
    const links = resolveLinks(r.company);
    return {
      company: r.company,
      website: links.website,
      careerUrl: links.careerUrl,
      jobs: r.jobs,
      maxSalary: r.maxSalary,
      minSalary: r.minSalary,
      platforms: String(r.platforms || "").split(",").filter(Boolean),
      city: r.city || "",
    };
  });
}
