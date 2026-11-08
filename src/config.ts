import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 打分卡配置 —— 改这里就能迭代评分模型
 * 改了规则 / 权重 / prompt 请 bump RULES_VERSION；
 * 简历（profile/resume.md）变了会自动换版本号，所有岗位按新简历重新打分。
 */
const RULES_VERSION = "v6-2026-11-08";

/** 简历原文：打分时整段给 LLM 对照 */
export const RESUME_PATH = path.resolve(process.cwd(), "profile", "resume.md");
export function loadResume(): string {
  try {
    // 去掉 HTML 注释（说明文字），只留简历本身
    return fs.readFileSync(RESUME_PATH, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch { return ""; }
}
const resumeHash = (t: string) => (t ? crypto.createHash("sha1").update(t).digest("hex").slice(0, 6) : "none");

export const SCORING_VERSION = `${RULES_VERSION}-cv${resumeHash(loadResume())}`;

/** 五维权重，合计 100 */
export const WEIGHTS = {
  tech: 30,     // 技术匹配
  salary: 25,   // 薪资达标
  weekend: 20,  // 双休可能
  company: 15,  // 公司质量
  growth: 10,   // 成长性
} as const;

/**
 * 求职者的硬条件（期望薪资、城市等）。都在 .env 里配置，不写进代码：
 *   TARGET_SALARY_MIN=25  TARGET_SALARY_IDEAL=30   千元/月
 *   CITIES=深圳            多个用逗号分隔
 *   ACCEPT_REMOTE=true
 *   MUST_HAVE=双休
 *   AVOID=外包,驻场,数据标注,算法研究岗（偏论文）,纯 CRUD 业务
 * 具体经历写在 profile/resume.md（简历原文，不入库）。
 */
const list = (v: string | undefined, d: string) => (v || d).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
export const PROFILE = {
  targetSalaryMin: parseFloat(process.env.TARGET_SALARY_MIN || "25"),
  targetSalaryIdeal: parseFloat(process.env.TARGET_SALARY_IDEAL || "30"),
  cities: list(process.env.CITIES, "深圳"),
  acceptRemote: process.env.ACCEPT_REMOTE !== "false",
  mustHave: list(process.env.MUST_HAVE, "双休"),
  avoid: list(process.env.AVOID, "外包,驻场,数据标注,算法研究岗（偏论文）,纯 CRUD 业务"),
};

/**
 * 一票否决规则（命中即 0 分，不进 TOP20）
 * 优先级最高，先于 LLM 判断
 */
/** 常见外包 / 人力派遣公司（公司名命中即否决；按需补充） */
export const OUTSOURCE_COMPANIES = /外企德科|中软国际|软通动力|文思海辉|博彦科技|法本信息|汉克时代|诚迈科技|佰钧成|柯莱特|科锐国际|任仕达|万宝盛华|中智经济|中智上海|北京外企|FESCO|易才集团|仕邦人力|华拓数码|纬创软件|拓保软件|润和软件|中电金信|宇信科技|天阳宏业|人力资源(服务)?有限公司|劳务派遣|人才服务有限公司/;

/** 外地城市：标题或城市字段出现这些、又没出现目标城市 → 不是给你的岗位 */
const OTHER_CITIES = /北京|上海|广州|杭州|成都|武汉|南京|西安|苏州|重庆|天津|长沙|合肥|厦门|青岛|济南|郑州|东莞|珠海|佛山|无锡|宁波|福州|大连|沈阳|香港|新加坡/;

export const REJECT_RULES: { id: string; label: string; test: (j: { title: string; company: string; jd: string; tags: string[]; city?: string }) => boolean }[] = [
  {
    id: "outsource",
    label: "外包/驻场",
    // 公司名就是外包 / 人力公司的直接否决；JD 里常见「非外包」「不接受外包」，先去掉否定说法再判断
    test: (j) => OUTSOURCE_COMPANIES.test(j.company) || /外包|驻场|外派|人力派遣|劳务派遣/.test(
      (j.title + " " + j.company + " " + j.jd).replace(/(非|不是|无|拒绝|不接受|不招|并非)\s*(外包|驻场|外派)/g, "")),
  },
  {
    id: "labeling",
    label: "数据标注/训练师",
    test: (j) => /标注|训练师|数据审核|抽卡|剪辑/.test(j.title),
  },
  {
    id: "sales",
    label: "销售/BD/采购",
    test: (j) => /销售|BD|商务|采购|客户经理|渠道经理|大客户/.test(j.title),
  },
  {
    id: "fae",
    label: "FAE/售前/交付",
    test: (j) => /FAE|现场应用|售前|售后|交付工程师|技术支持|实施工程师/.test(j.title),
  },
  {
    id: "pm",
    label: "产品/运营/项目管理",
    test: (j) => /产品经理|产品专家|产品总监|运营|项目经理|项目管理|策划/.test(j.title),
  },
  {
    id: "assistant",
    label: "助理/文职",
    test: (j) => /助理|秘书|文员|行政|专员(?!.*开发)/.test(j.title),
  },
  {
    id: "city",
    label: "城市不符",
    // 标题里写的城市最可靠（「xx工程师-杭州」），城市字段可能是采集时的默认值
    test: (j) => {
      const has = (t: string) => PROFILE.cities.some((c) => t.includes(c));
      if (has(j.title)) return false;
      if (PROFILE.acceptRemote && /远程|remote/i.test(j.title)) return false;
      if (OTHER_CITIES.test(j.title)) return true;
      const city = j.city ?? "";
      return !!city && !has(city) && OTHER_CITIES.test(city);
    },
  },
  {
    id: "intern",
    label: "实习/应届专项",
    test: (j) => /实习|应届|校招|24届|25届|26届/.test(j.title),
  },
  {
    id: "research",
    label: "纯算法研究（博士级）",
    test: (j) => /研究员|博士|算法专家|科学家/.test(j.title) && !/工程/.test(j.title),
  },
];

/** 技术匹配关键词分级 */
export const TECH_KEYWORDS = {
  /** 直接对口：命中即高分 */
  high: [
    "MaaS", "模型平台", "model platform", "推理服务", "推理平台", "inference",
    "模型接入", "模型网关", "AI网关", "算力网关", "provider", "多模型", "模型路由",
    "分流", "流量调度", "Temporal", "Agent", "MCP", "LLM平台", "大模型平台",
    "模型部署", "vLLM", "SGLang", "ComfyUI", "量化", "推理优化",
  ],
  /** 相关：同一栈的不同切面 */
  mid: [
    "大模型", "LLM", "AIGC", "RAG", "后端", "服务端", "平台",
    "Node.js", "TypeScript", "Python", "Go", "Golang", "微服务", "分布式",
    "K8s", "Kubernetes", "Docker", "高并发", "中间件",
  ],
  /** 弱相关 */
  low: ["Java", "C++", "前端", "Vue", "React", "全栈", "数据", "测试", "运维"],
};

/** 双休信号 */
export const WEEKEND_SIGNALS = {
  positive: ["双休", "周末双休", "五天工作制", "朝九晚六", "不加班", "Work Life Balance", "WLB"],
  negative: ["大小周", "单休", "996", "六天", "加班多", "周六上班"],
};

/** 公司质量分级（按规模/融资/知名度） */
/**
 * 重点盯的公司（用于看板高亮 + 打分加权，不用于自动搜索）
 * 名单是个人求职信息，写在本地 .env：TARGET_COMPANIES=公司A,公司B,…
 *
 * ⚠️ 试过用公司名去智联搜，效果很差：招聘网站的公司名匹配是模糊的，
 *    搜「万兴科技」会把「杭州万兴科技」（通信工程公司）整页带出来，
 *    真正的万兴科技（Wondershare）反而不在智联上。所以只作为标签用。
 */
export const TARGET_COMPANIES: string[] = (process.env.TARGET_COMPANIES || [
  // —— AIGC 视频/图像生成（2026 融资最热赛道，单笔均值全赛道第一）——
  "生数科技", "爱诗科技", "Sand.ai", "LiblibAI", "Pexo", "Noiz AI", "VAST", "智象未来",
  "右脑科技", "稀宇科技", "MiniMax", "智谱", "月之暗面", "阶跃星辰", "DeepSeek", "硅基流动", "无问芯穹",
  // —— 具身智能（2026 融资事件最多的赛道）——
  "自变量机器人", "智平方", "千寻智能", "极佳视界", "星海图", "银河通用", "星动纪元", "大晓机器人", "眸深智能",
  // —— 深圳本地 / 硬件 + AI ——
  "万兴科技", "深信服", "影石", "大疆", "优必选", "云天励飞", "思谋科技", "元象",
  "雷鸟创新", "韶音", "追觅", "安克创新", "传音", "货拉拉", "微众银行", "金蝶", "商汤", "云从科技", "云知声", "米哈游",
  // —— 已接入官网的大厂 ——
  "腾讯", "字节跳动", "阿里巴巴", "美团", "百度", "华为", "网易", "京东", "小米",
].join(",")).split(",").map((x) => x.trim()).filter(Boolean);

/** 今天该搜哪几家（按日期轮转，保证雨露均沾） */
export function companiesForToday(count = 3): string[] {
  if (!TARGET_COMPANIES.length) return [];
  const day = Math.floor(Date.now() / 86400_000);
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, TARGET_COMPANIES.length); i++) {
    out.push(TARGET_COMPANIES[(day + i) % TARGET_COMPANIES.length]);
  }
  return out;
}

export const COMPANY_TIERS = {
  /** 一线大厂 */
  s: ["腾讯", "字节", "阿里", "华为", "美团", "百度", "京东", "网易", "小米", "OPPO", "vivo", "大疆", "比亚迪"],
  /** 知名上市/独角兽 */
  a: ["深信服", "云天励飞", "商汤", "Anker", "安克", "传音", "金蝶", "微众", "货拉拉", "SHEIN", "影石", "优必选", "元象", "思谋", "万兴", "米哈游", "金山", "用友"],
  /** 有融资的 AI 公司 */
  b: ["MiniMax", "月之暗面", "智谱", "百川", "零一万物", "阶跃", "爱诗", "PixVerse", "生数", "无问芯穹", "硅基流动"],
};
