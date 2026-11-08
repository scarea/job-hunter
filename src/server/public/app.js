const api = (p) => fetch(p).then((r) => r.json());
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sc = (v) => v >= 70 ? "s70" : v >= 50 ? "s50" : "s0";

const charts = {};

/** 打开岗位链接（新标签页）；空链接给出提示而不是静默失败 */
function openJob(url) {
  if (!url) { alert("这个岗位没有可用链接（可能是官网接口没给详情地址）。"); return; }
  window.open(url, "_blank", "noopener");
}

/* ================= 标签 ================= */
const MODE_LABEL = { mark: "仅标记", only: "仅看", exclude: "不看" };
const SCOPE_LABEL = { basic: "标题/公司", all: "含 JD 正文" };
let TAGS = [];          // [{id,name,keywords,mode,scope,hits}]
let TAG_MODE = {};      // name → mode，渲染岗位上的标签用

// 「应用过滤」开关只存在本浏览器（localStorage 可能不可用，失败就默认开）
function tagFilterOn() {
  try { return localStorage.getItem("jh.tagFilter") !== "0"; } catch { return true; }
}
const tq = () => (tagFilterOn() ? "" : "tagFilter=0");
const withTq = (url) => { const q = tq(); return q ? url + (url.includes("?") ? "&" : "?") + q : url; };

function tagPills(names) {
  if (!names || !names.length) return "";
  return names.map((n) => `<span class="tpill m-${TAG_MODE[n] || "mark"}">#${esc(n)}</span>`).join("");
}

async function send(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function loadTags() {
  TAGS = await api("/api/tags");
  TAG_MODE = Object.fromEntries(TAGS.map((t) => [t.name, t.mode]));
  const cb = $("#tagFilterOn"); if (cb) cb.checked = tagFilterOn();
  $("#tagList").innerHTML = TAGS.length ? TAGS.map((t) => `
    <div class="tchip m-${t.mode}">
      <b>#${esc(t.name)}</b>
      <span class="kw" title="${esc(t.keywords.join("、"))}">${esc(t.keywords.join("、"))}</span>
      <span class="hits">命中 ${t.hits}</span>
      <span class="seg">${["mark", "only", "exclude"].map((m) =>
        `<button class="${t.mode === m ? "on m-" + m : ""}" onclick="setTag(${t.id},{mode:'${m}'})">${MODE_LABEL[m]}</button>`).join("")}</span>
      <select onchange="setTag(${t.id},{scope:this.value})">${["basic", "all"].map((sc) =>
        `<option value="${sc}" ${t.scope === sc ? "selected" : ""}>${SCOPE_LABEL[sc]}</option>`).join("")}</select>
      <button class="x" title="修改关键词" onclick="editTagKeywords(${t.id})">✎</button>
      <button class="x" title="删除" onclick="removeTag(${t.id})">×</button>
    </div>`).join("")
    : `<div class="hint">还没有标签。例：标签「外包」关键词「外包,驻场,外派」设为「不看」；标签「Agent」设为「仅看」。</div>`;
}

function tagMsg(text, bad) {
  const el = $("#tagMsg"); el.textContent = text; el.style.color = bad ? "#ff8b8b" : "";
  if (!bad) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

async function addTag() {
  const name = $("#tagName").value.trim();
  if (!name) return tagMsg("先填标签名", true);
  try {
    await send("POST", "/api/tags", { name, keywords: $("#tagKw").value, mode: $("#tagMode").value, scope: $("#tagScope").value });
    $("#tagName").value = ""; $("#tagKw").value = "";
    tagMsg("✅ 已添加");
    await reloadAfterTagChange();
  } catch (e) { tagMsg(e.message, true); }
}

async function setTag(id, patch) {
  try { await send("PATCH", `/api/tags/${id}`, patch); await reloadAfterTagChange(); }
  catch (e) { tagMsg(e.message, true); }
}

async function editTagKeywords(id) {
  const t = TAGS.find((x) => x.id === id); if (!t) return;
  const v = prompt(`标签「${t.name}」的关键词（逗号分隔，留空=标签名）`, t.keywords.join(","));
  if (v === null) return;
  await setTag(id, { keywords: v });
}

async function removeTag(id) {
  const t = TAGS.find((x) => x.id === id); if (!t) return;
  if (!confirm(`删除标签「${t.name}」？`)) return;
  try { await send("DELETE", `/api/tags/${id}`); await reloadAfterTagChange(); }
  catch (e) { tagMsg(e.message, true); }
}

function toggleTagFilter(on) {
  try { localStorage.setItem("jh.tagFilter", on ? "1" : "0"); } catch { /* 无痕模式等 */ }
  reloadAfterTagChange();
}

async function reloadAfterTagChange() {
  await loadTags();
  await send("POST", "/api/today/rebuild").catch(() => {});
  await Promise.all([loadToday(), loadTop(), loadJobs(0)]);
}

function chart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($("#" + id), cfg);
}

async function loadStats() {
  const s = await api("/api/stats");
  $("#kpis").innerHTML = [
    ["岗位总数", s.total],
    ["今日新增", s.todayNew],
    ["已打分", s.scored],
    ["平均分", s.avgScore],
    ["建议投(≥70)", s.goodCount],
    ["累计成本", "¥" + s.costYuan],
  ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
}

async function loadTop() {
  const rows = await api(withTq("/api/top?limit=20"));
  $("#topTable tbody").innerHTML = rows.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="score ${sc(r.total)}">${Number(r.total).toFixed(1)}</td>
      <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>` : esc(r.title)} ${tagPills(r.matchedTags)}</td>
      <td>${esc(r.company)}</td>
      <td>${esc(r.salaryText || r.salary_raw || "面议")}</td>
      <td>${esc(r.city || "")}</td>
      <td class="reason">${esc(r.reason || "")}</td>
    </tr>`).join("") || `<tr><td colspan="7" style="color:#8b93a1">还没有数据，先跑 pnpm collect && pnpm score</td></tr>`;
}

async function loadJobs(offset = 0) {
  const q = $("#q").value.trim();
  const plat = $("#plat").value;
  const minScore = $("#minScore").value;
  const params = new URLSearchParams({ limit: "200", offset: String(offset) });
  if (q) params.set("q", q);
  if (plat) params.set("platform", plat);
  if (minScore) params.set("minScore", minScore);
  if (!tagFilterOn()) params.set("tagFilter", "0");
  const { rows, total, hidden } = await api("/api/jobs?" + params);
  $("#jobsMeta").textContent = `共 ${total} 条${hidden ? `，标签过滤掉 ${hidden} 条` : ""}`;
  $("#jobTable tbody").innerHTML = rows.map((r) => `
    <tr>
      <td class="score ${sc(r.total ?? 0)}">${r.total != null ? Number(r.total).toFixed(1) : "—"}</td>
      <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>` : esc(r.title)} ${tagPills(r.matchedTags)}</td>
      <td>${esc(r.company)}</td>
      <td>${esc(r.salaryText || r.salary_raw || "面议")}</td>
      <td>${esc(r.city || "")}</td>
      <td><span class="pill">${esc(r.platform)}</span></td>
      <td class="reason">${esc(r.reason || "")}</td>
    </tr>`).join("");
}

async function loadCharts() {
  const [plats, dist, trend] = await Promise.all([
    api("/api/platforms"), api("/api/distribution"), api("/api/trend"),
  ]);

  chart("cPlatform", {
    type: "doughnut",
    data: {
      labels: plats.map((p) => p.platform),
      datasets: [{
        data: plats.map((p) => p.n),
        backgroundColor: ["#4f8cff", "#22c55e", "#f59e0b", "#a855f7"],
        borderColor: "#171a21", borderWidth: 2,
      }],
    },
    options: { plugins: { legend: { labels: { color: "#8b93a1" } } } },
  });

  chart("cDist", {
    type: "bar",
    data: {
      labels: dist.map((d) => d.range),
      datasets: [{ label: "岗位数", data: dist.map((d) => d.count), backgroundColor: "#4f8cff" }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b93a1" }, grid: { color: "#252a34" } },
        y: { ticks: { color: "#8b93a1" }, grid: { color: "#252a34" } },
      },
    },
  });

  chart("cTrend", {
    type: "line",
    data: {
      labels: trend.map((t) => t.d),
      datasets: [{
        label: "新增岗位", data: trend.map((t) => t.n),
        borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.15)", fill: true, tension: .3,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b93a1" }, grid: { color: "#252a34" } },
        y: { ticks: { color: "#8b93a1" }, grid: { color: "#252a34" } },
      },
    },
  });
}

async function loadVersions() {
  const vs = await api("/api/versions");
  $("#ver").textContent = vs.length ? `打分卡 ${vs[0].v}` : "打分卡 —";
  const opts = vs.map((v) => `<option value="${v.v}">${v.v} (${v.n} 条, 均分 ${v.avg})</option>`).join("");
  $("#v1").innerHTML = opts; $("#v2").innerHTML = opts;
  if (vs.length > 1) $("#v1").selectedIndex = 1;
}

async function loadCompare() {
  const v1 = $("#v1").value, v2 = $("#v2").value;
  if (!v1 || !v2) return;
  const rows = await api(`/api/compare?v1=${v1}&v2=${v2}`);
  $("#cmpTable tbody").innerHTML = rows.map((r) => {
    const d = Number(r.delta);
    const color = d > 0 ? "#22c55e" : d < 0 ? "#ef4444" : "#8b93a1";
    return `<tr>
      <td>${esc(r.title)}</td><td>${esc(r.company)}</td>
      <td>${Number(r.t1).toFixed(1)}</td><td>${Number(r.t2).toFixed(1)}</td>
      <td style="color:${color};font-weight:600">${d > 0 ? "+" : ""}${d.toFixed(1)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#8b93a1">两个版本没有重叠岗位</td></tr>`;
}

const STATUS_LABEL = { new: "", later: "稍后再看", applied: "已投递", ignored: "不感兴趣" };
const PLAT_LABEL = { boss: "BOSS", zhaopin: "智联", liepin: "猎聘", tencent: "腾讯", official: "官网" };

function jobCard(r, i, opts = {}) {
  const cls = r.total >= 70 ? "s70" : r.total >= 50 ? "s50" : "s0";
  const done = r.status === "applied" || r.status === "ignored";
  const btn = (st, label, title) =>
    `<button class="act ${r.status === st ? "on" : ""}" title="${title}" onclick="event.stopPropagation();setJobStatus(${r.id},'${r.status === st ? "new" : st}')">${label}</button>`;
  const url = esc(r.url || "");
  return `<div class="tcard ${done ? "done" : ""}" id="job-${r.id}" onclick="openJob('${url}')" title="点击打开岗位详情">
    <div class="${!opts.backlog && i < 3 ? "trank hot" : "trank"}">${opts.backlog ? "·" : i + 1}</div>
    <div class="tmain">
      <div class="ttitle"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>
        ${r.status !== "new" ? `<span class="spill st-${r.status}">${STATUS_LABEL[r.status]}</span>` : ""}</div>
      <div class="tmeta">
        <span><b>${esc(r.company || "—")}</b></span>
        <span>${esc(r.salaryText || r.salary_raw || "面议")}</span>
        <span>${esc(r.city || "")}</span>
        <span class="pill">${esc(PLAT_LABEL[r.platform] || r.platform)}</span>
        ${tagPills(r.matchedTags)}
      </div>
      <div class="treason">${esc(r.reason || "")}</div>
    </div>
    <div class="tside">
      <div class="tscore ${cls}">${Number(r.total).toFixed(1)}</div>
      <div class="acts">
        <button class="topener" onclick="event.stopPropagation();openJob('${url}')" title="在新标签页打开岗位">↗ 打开</button>
        ${btn("applied", "✓ 已投", "标记为已投递")}${btn("later", "⏰ 稍后", "放进待处理")}${btn("ignored", "✕", "不感兴趣，以后不再推荐")}
      </div>
    </div>
  </div>`;
}

async function loadToday() {
  const d = await api(withTq("/api/today"));
  $("#todayDate").textContent = d.isToday ? d.date : `${d.date}（今天还没跑）`;
  const lr = d.lastRun;
  $("#todayMeta").textContent = lr
    ? `最后运行 ${new Date(lr.finished_at || Date.now()).toLocaleString("zh-CN", { hour12: false }).slice(0, 16)} · 今日采集 ${d.todayCount} 条 · 每天 04:00 自动更新`
    : "还没有跑过采集，点上面「立即运行一轮」";
  const pending = d.rows.filter((r) => r.status === "new");
  const hot = pending.filter((r) => r.total >= 70).length;
  $("#todayBadge").textContent = `${pending.length}/${d.rows.length} 待看 · ${hot} 个 ≥70${d.hidden ? ` · 标签过滤掉 ${d.hidden} 个` : ""}`;

  // 没处理的排前面，已投 / 不感兴趣的沉底
  const order = { new: 0, later: 1, applied: 2, ignored: 3 };
  const rows = [...d.rows].sort((a, b) => order[a.status] - order[b.status] || b.total - a.total);
  $("#todayList").innerHTML = rows.length
    ? rows.map((r, i) => jobCard(r, i)).join("")
    : `<div class="empty">今天没有新的推荐岗位<br><span style="font-size:12px">每天 04:00 自动更新；改了标签可以点「换一批」</span></div>`;

  $("#backlogCount").textContent = d.backlog.length;
  $("#backlogWrap").style.display = d.backlog.length ? "" : "none";
  $("#backlogList").innerHTML = d.backlog.map((r, i) => jobCard(r, i, { backlog: true })).join("");
}

async function setJobStatus(id, status) {
  try { await send("POST", `/api/jobs/${id}/status`, { status }); }
  catch (e) { alert(e.message); return; }
  await Promise.all([loadToday(), loadTop()]);
}

async function rebuildToday() {
  const r = await send("POST", "/api/today/rebuild");
  await loadToday();
  if (!r.added) alert("没有更多符合条件的新岗位了");
}

function toggleBacklog() {
  const el = $("#backlogList");
  el.style.display = el.style.display === "none" ? "" : "none";
  $("#backlogArrow").textContent = el.style.display === "none" ? "▸" : "▾";
}

/* ================= 关键词策略 ================= */
const QSTATUS = { active: "活跃", candidate: "试用中", retired: "已淘汰" };
const QSOURCE = { seed: "种子", ai: "AI", user: "手动" };
const ACTION_TEXT = { add: "新增", retire: "淘汰", promote: "转正", retest: "重新测试", review: "复盘", skip: "保留" };

async function loadStrategy() {
  const d = await api("/api/strategy");
  $("#stratPlan").innerHTML = d.plan.length
    ? d.plan.map((p) => `<span class="tpill" title="${esc(p.why)}">${esc(p.keyword)}</span>`).join("") + `<span class="hint">（共 ${d.plan.length}/${d.budget} 个）</span>`
    : "—";
  $("#stratTable tbody").innerHTML = d.queries.map((q) => {
    const k = esc(JSON.stringify(q.keyword));
    const acts = [
      `<button class="x" title="${q.pinned ? "取消钉住" : "钉住：每轮必搜、永不淘汰"}" onclick='stratDo(${k},"${q.pinned ? "unpin" : "pin"}")'>${q.pinned ? "📌" : "📍"}</button>`,
      q.status === "retired"
        ? `<button class="x" onclick='stratDo(${k},"activate")'>恢复</button>`
        : q.source !== "seed" ? `<button class="x" onclick='stratDo(${k},"retire")'>淘汰</button>` : "",
    ].join(" ");
    return `<tr style="${q.status === "retired" ? "opacity:.5" : ""}">
      <td><b>${esc(q.keyword)}</b>${q.nextRun ? ` <span class="hint" title="${esc(q.nextRun)}">●</span>` : ""}</td>
      <td><span class="st-badge ${q.status}">${QSTATUS[q.status]}</span></td>
      <td>${QSOURCE[q.source] || q.source}</td>
      <td>${q.runs} 轮</td>
      <td class="score">${q.runs ? q.mean : "—"}</td>
      <td>${q.totalNew} / ${q.totalGood}</td>
      <td class="reason">${esc(q.reason || "")}</td>
      <td style="white-space:nowrap">${acts}</td>
    </tr>`;
  }).join("");
  $("#stratSugg").innerHTML = d.suggestions.length
    ? d.suggestions.map((s) => `<span class="chip" title="来自 ${s.jobs} 个高分岗位，点击加入词表" onclick='stratDo(${esc(JSON.stringify(s.keyword))},"add")'>+ ${esc(s.keyword)} <b>${s.weight}</b></span>`).join("")
    : `<span class="hint">还没有。下一轮打分后会出现。</span>`;
  $("#stratLog").innerHTML = d.log.length
    ? d.log.map((l) => `<div>${esc(l.run_key.replace("T", " "))} · <b>${ACTION_TEXT[l.action] || l.action}</b> ${esc(l.keyword)} <span>${esc(l.reason)}</span></div>`).join("")
    : `<span class="hint">还没有调整记录。</span>`;
}

async function stratDo(keyword, action) {
  try {
    const r = await send("POST", "/api/strategy/query", { keyword, action });
    if (!r.ok) $("#stratMsg").textContent = action === "add" ? "已在词表里" : "没有变化";
  } catch (e) { $("#stratMsg").textContent = e.message; }
  loadStrategy();
}

function stratAdd() {
  const k = $("#stratKw").value.trim();
  if (!k) return;
  $("#stratKw").value = "";
  stratDo(k, "add");
}

function toggleStrategy() {
  const el = $("#stratBody");
  el.style.display = el.style.display === "none" ? "" : "none";
  $("#stratArrow").textContent = el.style.display === "none" ? "▸" : "▾";
}

/* ================= 平台状态 / 一键处理 ================= */
const STATE_TEXT = { ok: "正常", need_verify: "需要验证", need_login: "需要登录", unknown: "未运行" };

async function loadPlatformStatus() {
  const list = await api("/api/platform-status");
  $("#platStrip").innerHTML = list.map((s) => {
    const label = s.kind === "api" ? "公开接口 · 免登录"
      : s.state === "ok" ? (s.loggedIn ? "已登录 · 正常" : "匿名可用") : STATE_TEXT[s.state];
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false }).slice(5, 16) : "";
    let action = "";
    if (s.kind === "browser") {
      if (s.queued) action = `<button class="pbtn" onclick="doStop()">取消</button>`;
      else if (s.handling) action = `<button class="pbtn" onclick="platformDone('${s.platform}')">我已完成</button>`;
      else if (s.state === "need_verify" || s.state === "need_login") action = `<button class="pbtn hot" onclick="resolvePlatform('${s.platform}')">去处理</button>`;
      else if (!s.loggedIn) action = `<button class="pbtn" onclick="resolvePlatform('${s.platform}','login')">登录</button>`;
    }
    return `<div class="pcard st-${s.kind === "api" ? "ok" : s.state}">
      <div class="pname">${esc(s.name)}</div>
      <div class="pstate">${s.queued ? "⏳ 排队中：每日任务结束后自动弹出窗口" : s.handling ? "窗口已打开，处理中…" : esc(label)}</div>
      <div class="preason" title="${esc(s.reason)}">${esc(s.reason || (s.lastFound != null ? `上次采到 ${s.lastFound} 条` : ""))}${when ? ` · ${when}` : ""}</div>
      ${action}
    </div>`;
  }).join("");
}

async function resolvePlatform(p, mode) {
  try {
    const r = await send("POST", `/api/platform-status/${p}/resolve`, { mode: mode || "auto" });
    if (!r.ok) { alert(r.message); return; }
  } catch (e) { alert(e.message); return; }
  startPolling();
  setTimeout(loadPlatformStatus, 800);
}

async function platformDone(p) {
  await send("POST", `/api/platform-status/${p}/done`).catch(() => {});
  setTimeout(loadPlatformStatus, 2500);
}

/* ================= 控制面板 ================= */
let pollTimer = null;

async function runDaily() {
  const r = await fetch("/api/run/daily", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((x) => x.json());
  if (!r.ok) { alert(r.message); return; }
  showLog();
  startPolling();
}

/** 按钮旁显示「今天会用策略选出的哪些词」 */
async function loadOpenPlan() {
  try {
    const d = await api("/api/open-searches/plan");
    const el = $("#openPlan");
    if (el) el.innerHTML = (d.keywords && d.keywords.length)
      ? `今日词：<b style="color:#a8b3c4">${d.keywords.join(" / ")}</b>（${d.tabs} 标签页）`
      : "今日词：还没有（先跑一轮采集）";
  } catch { /* 忽略 */ }
}

async function openSearches() {
  const el = $("#openPlan");
  const r = await fetch("/api/open-searches", { method: "POST" }).then((x) => x.json()).catch(() => ({ ok: false, message: "看板没响应" }));
  if (r.ok) {
    if (el) el.innerHTML = `✅ 已打开 ${r.tabs} 个标签页（${(r.keywords || []).join(" / ")}），往下翻几页即可，岗位会自动进看板`;
    setTimeout(loadOpenPlan, 15000);
  } else if (el) el.textContent = "❌ " + (r.message || "打开失败");
}

async function doLogin() {
  const r = await send("POST", "/api/run/login").catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) { alert(r.message); return; }
  startPolling();
}

async function doStop() {
  await fetch("/api/stop", { method: "POST" });
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 1500);
  pollStatus();
}

async function pollStatus() {
  let d;
  try { d = await api("/api/run/status"); } catch { return; }

  const st = $("#runStatus");
  st.className = "ctrl-status " + (d.running ? "running" : (d.status === "done" ? "done" : d.status === "error" ? "error" : ""));
  st.textContent = d.running
    ? `运行中 · ${d.kind} · ${d.lines.length} 行日志`
    : d.status === "done" ? `完成 · ${d.kind}` : d.status === "error" ? `失败 · ${d.kind}` : "空闲";

  $("#btnRun").disabled = d.running;
  $("#btnLogin").disabled = d.running;
  $("#btnStop").disabled = !d.running;

  const body = $("#logBody");
  if (body) {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = d.lines.length ? d.lines.join("\n") : "（还没有运行记录）";
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  $("#logMeta").textContent = d.startedAt ? `开始 ${new Date(d.startedAt).toLocaleTimeString("zh-CN")}` : "";

  // 任务结束后自动刷新数据
  if (d.running && d.kind === "login") loadPlatformStatus();
  if (!d.running && window.__wasRunning) loadPlatformStatus();
  window.__wasRunning = d.running;
  if (!d.running && d.status === "done" && !window.__refreshed) {
    window.__refreshed = true;
    setTimeout(() => { window.__refreshed = false; loadAll(); }, 800);
  }
}

function showLog() { $("#logPanel").style.display = "block"; }
function toggleLog() {
  const el = $("#logPanel");
  el.style.display = el.style.display === "none" ? "block" : "none";
  if (el.style.display === "block") pollStatus();
}
function clearLog() { $("#logBody").textContent = "（已清空本地显示）"; }

function toggleCfg() {
  const el = $("#cfgPanel");
  el.style.display = el.style.display === "none" ? "block" : "none";
  if (el.style.display === "block") loadConfig();
}

async function loadConfig() {
  const c = await api("/api/config");
  $("#cfgKey").placeholder = c.hasKey ? `已配置 ${c.keyMasked}` : "sk-...";
  $("#cfgQueries").value = c.queries;
  $("#cfgPages").value = c.maxPages;
  $("#cfgDetail").value = c.detailLimit;
  $("#cfgTop").value = c.topN;
  if ($("#cfgOpenKw")) $("#cfgOpenKw").value = c.openKeywords;
  $("#keyHint").textContent = c.hasKey ? "✅ 已配置" : "⚠️ 未配置（只能用规则分）";
  const r = await api("/api/resume");
  $("#cfgResume").value = r.text;
  window.__resumeOrig = r.text;
  $("#resumeHint").textContent = r.chars ? `当前简历 ${r.chars} 字` : "⚠️ 还没有简历，打分只能按硬条件判断";
}

async function uploadResume(file) {
  if (!file) return;
  $("#resumeHint").textContent = "⏳ 正在提取…";
  try {
    const r = await fetch("/api/resume/upload", {
      method: "POST", headers: { "x-filename": encodeURIComponent(file.name) }, body: file,
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    await loadConfig();
    $("#resumeHint").textContent = `✅ 已从「${file.name}」提取 ${r.chars} 字并保存，下一轮按新简历重新打分`;
  } catch (e) { $("#resumeHint").textContent = "❌ " + e.message; }
  $("#resumeFile").value = "";
}

async function saveConfig() {
  const body = {
    queries: $("#cfgQueries").value,
    maxPages: $("#cfgPages").value,
    detailLimit: $("#cfgDetail").value,
    topN: $("#cfgTop").value,
    openKeywords: $("#cfgOpenKw") ? $("#cfgOpenKw").value : undefined,
  };
  const k = $("#cfgKey").value.trim();
  if (k) body.key = k;
  await fetch("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const resume = $("#cfgResume").value.trim();
  if (resume && resume !== (window.__resumeOrig || "").trim()) {
    try { await send("POST", "/api/resume", { text: resume }); }
    catch (e) { $("#cfgMsg").textContent = "❌ 简历：" + e.message; return; }
  }
  $("#cfgMsg").textContent = "✅ 已保存";
  setTimeout(() => ($("#cfgMsg").textContent = ""), 2500);
  loadConfig();
}

/* ============================================ */

/* ================= 浏览即采集 ================= */
function toggleImport(forceOpen) {
  const el = $("#importBody");
  if (forceOpen === true) { el.style.display = "block"; return; }
  el.style.display = el.style.display === "none" ? "block" : "none";
}

async function doImport() {
  const text = $("#importText").value.trim();
  if (!text) { $("#importMsg").textContent = "先粘贴内容"; return; }
  $("#importMsg").textContent = "导入中…";
  try {
    const r = await fetch("/api/manual-jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((x) => x.json());
    if (r.error) { $("#importMsg").textContent = "❌ " + r.error; return; }
    $("#importMsg").textContent = `✅ 导入 ${r.count} 个（新增 ${r.inserted ?? r.count}）。正在打分…`;
    $("#importText").value = "";
    // 导入后自动跑一轮打分
    await fetch("/api/run/score", { method: "POST" });
    startPolling(); showLog();
    setTimeout(() => { loadAll(); $("#importMsg").textContent = `✅ 已导入 ${r.count} 个并开始打分`; }, 1500);
  } catch (e) {
    $("#importMsg").textContent = "❌ " + e.message;
  }
}

/* ==================================================== */

/* ================= 待补 JD ================= */
let _pendingOpen = true;

async function loadPending() {
  try {
    const d = await api("/api/pending-jd?limit=12");
    const panel = $("#pendingPanel"), body = $("#pendingBody");
    if (!panel || !body) return;
    if (!d.rows || !d.rows.length) { panel.style.display = "none"; return; }
    panel.style.display = "block";
    body.style.display = _pendingOpen ? "grid" : "none";
    body.innerHTML = d.rows.map((r) => `
      <div class="tcard" style="grid-template-columns:1fr auto" onclick="openJob('${esc(r.url || "")}')">
        <div class="tmain">
          <div class="ttitle"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a></div>
          <div class="tmeta">
            <span><b>${esc(r.company || "—")}</b></span>
            <span>${esc(r.salaryText || "面议")}</span>
            <span>${esc(r.city || "")}</span>
            <span class="pill">${esc(r.platform)}</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div class="tscore s0" style="font-size:15px">${r.total != null ? Number(r.total).toFixed(0) : "—"}</div>
          <button class="topener" onclick="event.stopPropagation();openJob('${esc(r.url || "")}')">↗ 打开</button>
        </div>
      </div>`).join("");
  } catch { /* ignore */ }
}

function togglePending() {
  _pendingOpen = !_pendingOpen;
  const b = $("#pendingBody");
  if (b) b.style.display = _pendingOpen ? "grid" : "none";
}

/* ========================================== */

/* ================= 值得关注的公司 ================= */
let _coOpen = true;

async function loadCompanies() {
  try {
    const d = await api("/api/companies?minSalary=25&minJobs=2&limit=24");
    const panel = $("#coPanel"), body = $("#coBody");
    if (!panel || !body) return;
    if (!d.rows || !d.rows.length) { panel.style.display = "none"; return; }
    panel.style.display = "block";
    body.style.display = _coOpen ? "grid" : "none";
    body.innerHTML = d.rows.map((r) => {
      const tierColor = r.tier === "成长型" ? "#7bd88f" : "#6aa6ff";
      return `<div style="border:1px solid var(--line);border-radius:8px;padding:9px 11px;background:#12151c">
        <div style="display:flex;align-items:baseline;gap:6px">
          <b style="font-size:12.5px;color:#dfe6f1">${esc(r.company)}</b>
          <span style="font-size:10px;color:${tierColor};border:1px solid ${tierColor}44;border-radius:4px;padding:0 4px">${r.tier}</span>
        </div>
        <div style="font-size:11.5px;color:#8b97a8;margin-top:4px">
          最高 <b style="color:#f0b429">${r.maxSalary}K</b> · ${r.jobs} 个岗 · ${r.city || "—"}
        </div>
      </div>`;
    }).join("");
  } catch { /* ignore */ }
}

function toggleCompanies() {
  _coOpen = !_coOpen;
  const b = $("#coBody");
  if (b) b.style.display = _coOpen ? "grid" : "none";
}

/* ================================================ */

async function loadAll() {
  await loadTags().catch(() => {});
  loadPlatformStatus().catch(() => {});
  loadStrategy().catch(() => {});
  await Promise.all([loadToday(), loadStats(), loadTop(), loadCharts(), loadVersions()]);
  loadOpenPlan();
  loadPending();
  loadCompanies();
  await loadJobs(0);
}

loadAll();
setTimeout(pollStatus, 600);
