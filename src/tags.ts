import { db } from "./db.js";

/**
 * 标签过滤系统
 *
 * 一个标签 = 名字 + 若干关键词（默认就是名字本身）+ 模式 + 匹配范围
 *   mode   mark    只打标，不影响推荐
 *          only    仅看：存在任何「仅看」标签时，岗位至少要命中其中一个才会被推荐
 *          exclude 不看：命中任何一个就不推荐（优先级最高，压过「仅看」）
 *   scope  basic   只匹配 标题 / 公司 / 平台标签（默认，误伤少）
 *          all     额外匹配 JD 正文（JD 里常有「非外包」「对接阿里云」这类干扰词，慎用于「不看」）
 * 匹配方式：不区分大小写的子串匹配。
 */
export type TagMode = "mark" | "only" | "exclude";
export type TagScope = "basic" | "all";
export const TAG_MODES: TagMode[] = ["mark", "only", "exclude"];
export const TAG_SCOPES: TagScope[] = ["basic", "all"];

export interface Tag {
  id: number;
  name: string;
  keywords: string[];
  mode: TagMode;
  scope: TagScope;
  createdAt: string;
}

/** 参与匹配的岗位字段；tags 可能是 DB 里的 JSON 字符串，也可能已经是数组 */
export interface TaggableJob {
  title?: string | null;
  company?: string | null;
  tags?: string | string[] | null;
  jd?: string | null;
}

db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  keywords TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mark',
  scope TEXT NOT NULL DEFAULT 'basic',
  created_at TEXT NOT NULL
);
`);

interface TagRow { id: number; name: string; keywords: string; mode: string; scope: string; created_at: string }

function fromRow(r: TagRow): Tag {
  let keywords: string[] = [];
  try { keywords = JSON.parse(r.keywords); } catch { /* ignore */ }
  return {
    id: r.id, name: r.name, keywords,
    mode: TAG_MODES.includes(r.mode as TagMode) ? (r.mode as TagMode) : "mark",
    scope: TAG_SCOPES.includes(r.scope as TagScope) ? (r.scope as TagScope) : "basic",
    createdAt: r.created_at,
  };
}

/** "外包, 驻场，外派" → ["外包","驻场","外派"]（去空、去重；空的时候用标签名） */
export function parseKeywords(input: unknown, fallbackName: string): string[] {
  const raw = Array.isArray(input) ? input.join(",") : String(input ?? "");
  const list = raw.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [fallbackName.trim()];
}

export function listTags(): Tag[] {
  return (db.prepare("SELECT * FROM tags ORDER BY id").all() as TagRow[]).map(fromRow);
}

export class TagError extends Error {}

function validate(input: { name?: unknown; mode?: unknown; scope?: unknown }) {
  if (input.name != null) {
    const n = String(input.name).trim();
    if (!n) throw new TagError("标签名不能为空");
    if (n.length > 30) throw new TagError("标签名最多 30 个字");
  }
  if (input.mode != null && !TAG_MODES.includes(input.mode as TagMode)) throw new TagError(`mode 只能是 ${TAG_MODES.join("/")}`);
  if (input.scope != null && !TAG_SCOPES.includes(input.scope as TagScope)) throw new TagError(`scope 只能是 ${TAG_SCOPES.join("/")}`);
}

export function createTag(input: { name: unknown; keywords?: unknown; mode?: unknown; scope?: unknown }): Tag {
  validate(input);
  const name = String(input.name ?? "").trim();
  if (!name) throw new TagError("标签名不能为空");
  if (db.prepare("SELECT 1 FROM tags WHERE name = ?").get(name)) throw new TagError(`标签「${name}」已存在`);
  const info = db.prepare("INSERT INTO tags (name, keywords, mode, scope, created_at) VALUES (?,?,?,?,?)").run(
    name, JSON.stringify(parseKeywords(input.keywords, name)),
    (input.mode as TagMode) ?? "mark", (input.scope as TagScope) ?? "basic", new Date().toISOString()
  );
  return getTag(Number(info.lastInsertRowid))!;
}

export function getTag(id: number): Tag | null {
  const r = db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as TagRow | undefined;
  return r ? fromRow(r) : null;
}

export function updateTag(id: number, input: { name?: unknown; keywords?: unknown; mode?: unknown; scope?: unknown }): Tag {
  const cur = getTag(id);
  if (!cur) throw new TagError("标签不存在");
  validate(input);
  const name = input.name != null ? String(input.name).trim() : cur.name;
  if (name !== cur.name && db.prepare("SELECT 1 FROM tags WHERE name = ? AND id != ?").get(name, id)) {
    throw new TagError(`标签「${name}」已存在`);
  }
  const keywords = input.keywords !== undefined ? parseKeywords(input.keywords, name) : cur.keywords;
  db.prepare("UPDATE tags SET name=?, keywords=?, mode=?, scope=? WHERE id=?").run(
    name, JSON.stringify(keywords), (input.mode as TagMode) ?? cur.mode, (input.scope as TagScope) ?? cur.scope, id
  );
  return getTag(id)!;
}

export function deleteTag(id: number): boolean {
  return db.prepare("DELETE FROM tags WHERE id = ?").run(id).changes > 0;
}

// ---------------- 匹配 & 过滤 ----------------

function platformTags(t: TaggableJob["tags"]): string[] {
  if (Array.isArray(t)) return t;
  if (!t) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** 岗位命中了哪些标签 */
export function matchTags(job: TaggableJob, tags: Tag[]): Tag[] {
  if (!tags.length) return [];
  const basic = [job.title ?? "", job.company ?? "", ...platformTags(job.tags)].join(" ").toLowerCase();
  let all: string | null = null; // JD 只在需要时才拼
  return tags.filter((tag) => {
    const hay = tag.scope === "all" ? (all ??= `${basic} ${(job.jd ?? "").toLowerCase()}`) : basic;
    return tag.keywords.some((k) => k && hay.includes(k.toLowerCase()));
  });
}

export interface TagFilterResult<T> {
  rows: (T & { matchedTags: string[] })[];
  /** 被过滤掉的条数 */
  hidden: number;
}

/**
 * 按标签过滤推荐结果：
 *   1. 命中任何「不看」标签 → 去掉
 *   2. 存在「仅看」标签时，没命中任何一个 → 去掉
 * apply=false 时只打标不过滤（看板上的「临时关闭过滤」）
 */
export function applyTagFilter<T extends TaggableJob>(rows: T[], tags: Tag[] = listTags(), apply = true): TagFilterResult<T> {
  const onlyTags = tags.filter((t) => t.mode === "only");
  const out: (T & { matchedTags: string[] })[] = [];
  let hidden = 0;
  for (const row of rows) {
    const hit = matchTags(row, tags);
    if (apply) {
      if (hit.some((t) => t.mode === "exclude")) { hidden++; continue; }
      if (onlyTags.length && !hit.some((t) => t.mode === "only")) { hidden++; continue; }
    }
    out.push({ ...row, matchedTags: hit.map((t) => t.name) });
  }
  return { rows: out, hidden };
}

/** 标签管理页用：每个标签在全部岗位里命中多少条 */
export function tagHitCounts(tags: Tag[] = listTags()): Record<number, number> {
  const jobs = db.prepare("SELECT title, company, tags, jd FROM jobs").all() as TaggableJob[];
  const counts: Record<number, number> = Object.fromEntries(tags.map((t) => [t.id, 0]));
  for (const j of jobs) for (const t of matchTags(j, tags)) counts[t.id]++;
  return counts;
}
