/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，凌晨 4 点跑会算成前一天） */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日期当天 0 点对应的 UTC ISO 时间，用来和库里的 ISO 时间戳比较 */
export function localDayStartIso(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}
