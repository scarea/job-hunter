import type { SalaryInfo } from "../types.js";

/**
 * 解析各种薪资写法：
 *  "30-50K·15薪" / "25-50K" / "1.5-2.5万/月" / "40-70K·16薪" / "面议" / "8-10K" / "200-300元/天" / "15001-30000"
 */
export function parseSalary(raw: string): SalaryInfo {
  if (!raw) return { salaryMin: null, salaryMax: null, months: null };
  const s = raw.replace(/\s+/g, "");

  // 月薪数
  const monthsM = s.match(/(\d+)\s*薪/);
  const months = monthsM ? parseInt(monthsM[1], 10) : null;

  // 元/天 → 折算成月（按 21.75 天）
  const dayM = s.match(/(\d+)-(\d+)元\/天/);
  if (dayM) {
    return {
      salaryMin: round((parseInt(dayM[1], 10) * 21.75) / 1000),
      salaryMax: round((parseInt(dayM[2], 10) * 21.75) / 1000),
      months,
    };
  }

  // 万/月
  const wanM = s.match(/([\d.]+)-([\d.]+)万/);
  if (wanM) {
    return { salaryMin: round(parseFloat(wanM[1]) * 10), salaryMax: round(parseFloat(wanM[2]) * 10), months };
  }

  // K / k
  const kM = s.match(/([\d.]+)-([\d.]+)[Kk]/);
  if (kM) {
    return { salaryMin: round(parseFloat(kM[1])), salaryMax: round(parseFloat(kM[2])), months };
  }

  // 单个数字 + K（如 "30K以上"）
  const singleK = s.match(/([\d.]+)[Kk]/);
  if (singleK) {
    const v = round(parseFloat(singleK[1]));
    return { salaryMin: v, salaryMax: v, months };
  }

  // 纯数字，单位是元/月（智联接口："15001-30000"、"8000-12000元/月"）
  const yuanM = s.match(/(\d{3,})-(\d{3,})(?:元)?(?:\/月)?/);
  if (yuanM) {
    const min = parseInt(yuanM[1], 10), max = parseInt(yuanM[2], 10);
    if (max >= 1000) return { salaryMin: round(min / 1000), salaryMax: round(max / 1000), months };
  }

  return { salaryMin: null, salaryMax: null, months };
}

function round(v: number) { return Math.round(v * 10) / 10; }
