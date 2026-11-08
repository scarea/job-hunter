import { loadResume, PROFILE } from "../config.js";

/**
 * 批量初筛（省钱）
 *
 * 完整打分一次要 ~1300 输入 + ~300 输出 token，而实测 60% 的岗位最后都在 50 分以下。
 * 先把 20 个岗位的标题 + JD 开头打包问一次「哪些明显和简历方向无关」，
 * 只有留下的才做完整打分。初筛单条成本约为完整打分的 1/40。
 *
 * 原则：宁可放过，不要错杀 —— 只排除「明显」无关的；拿不准的一律留下。
 * 调用失败时全部留下（退化成没有初筛）。
 */
const BATCH = 20;

export interface TriageItem { id: number; title: string; company: string; jd: string }
export interface TriageUsage { input: number; output: number; cacheHit: number }

export async function triage(items: TriageItem[], opts: { base: string; key: string; model: string }): Promise<{ drop: Map<number, string>; usage: TriageUsage }> {
  const drop = new Map<number, string>();
  const usage: TriageUsage = { input: 0, output: 0, cacheHit: 0 };
  if (!opts.key || !items.length) return { drop, usage };

  // 系统提示固定不变（简历在最前），整段能命中前缀缓存
  const system = `你在帮一位求职者做岗位初筛。只排除【明显】和他方向无关的岗位，拿不准的一律保留。

【求职者简历】
${loadResume().slice(0, 2000) || "（无）"}

【期望】城市 ${PROFILE.cities.join("/")}；不想要：${PROFILE.avoid.join("、")}

【明显无关的例子】销售/客服/运营/设计/行政；纯硬件、嵌入式、芯片、机械；纯前端/客户端/测试；纯算法研究（训练、论文）；与软件开发无关的岗位
【要保留】任何后端/服务端/平台/AI 应用/大模型/Agent/推理/全栈/架构方向，哪怕技术栈不完全一样

只返回 JSON：{"drop":[{"id":数字,"why":"10 字以内"}]}，没有要排除的就返回 {"drop":[]}`;

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const list = chunk.map((j) => `#${j.id} ${j.title}｜${j.company}｜${(j.jd || "").replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
    try {
      const res = await fetch(`${opts.base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: opts.model, temperature: 0, max_tokens: 600, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: list }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      usage.input += data.usage?.prompt_tokens ?? 0;
      usage.output += data.usage?.completion_tokens ?? 0;
      usage.cacheHit += data.usage?.prompt_cache_hit_tokens ?? 0;
      const raw = data.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const ids = new Set(chunk.map((j) => j.id));
      for (const d of Array.isArray(parsed.drop) ? parsed.drop : []) {
        const id = Number(d?.id);
        if (ids.has(id)) drop.set(id, String(d?.why || "方向无关").slice(0, 20));
      }
    } catch { /* 失败就整批保留，交给完整打分 */ }
  }
  return { drop, usage };
}
