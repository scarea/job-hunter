// ==UserScript==
// @name         Job Hunter · 浏览即采集
// @namespace    http://127.0.0.1:5173
// @version      1.2.0
// @description  被动转发招聘网站自己发出的岗位接口响应到本地看板。不主动请求、不点击、不修改页面。
// @match        https://www.zhipin.com/*
// @match        https://www.liepin.com/*
// @match        https://www.zhaopin.com/*
// @run-at       document-start
// @grant        none
// @updateURL    http://127.0.0.1:5173/job-hunter.user.js
// @downloadURL  http://127.0.0.1:5173/job-hunter.user.js
// ==/UserScript==

/**
 * ⚠️ 设计边界（请勿修改）：
 *  - 只「旁听」页面自己已经发出的 XHR / fetch 响应，读一份副本，不影响页面
 *  - 不向招聘网站发起任何请求（包括补详情）。要 JD：在搜索页点开岗位卡片，页面自己会请求详情，脚本旁听即可
 *  - 不点击、不滚动、不填表单、不修改页面内容（右下角徽标除外）
 *  - 唯一的外发请求是 POST 到本机 127.0.0.1:5173
 *
 * 这份文件是唯一源码；MV3 插件的 extension/content.js 由 scripts/build-extension.sh 从这里生成。
 */
(function () {
  "use strict";

  const API = "http://127.0.0.1:5173/api/manual-jobs";
  const SENT = new Set();  // 去重：同一个响应只转发一次
  let listCount = 0, detailCount = 0, lastErr = "";

  // ---------- 识别要旁听的接口 ----------
  const RULES = [
    { platform: "boss",    kind: "list",   re: /\/wapi\/zpgeek\/search\/joblist\.json/i },
    { platform: "boss",    kind: "detail", re: /\/wapi\/zpgeek\/job\/detail\.json/i },
    { platform: "liepin",  kind: "list",   re: /api-c\.liepin\.com.*pc-search-job(?!-cond-init)/i },
    { platform: "zhaopin", kind: "list",   re: /\/(c\/i\/search\/positions|api\/.*search.*position)/i },
  ];
  const match = (url) => (url ? RULES.find((r) => r.re.test(url)) || null : null);

  /** 从接口请求本身取「实际搜索词」，取不到再退回页面地址 */
  function keywordOf(url, bodyText) {
    const fromParams = (u) => {
      for (const k of ["query", "key", "keyword", "kw", "searchKey"]) {
        const v = u.searchParams.get(k);
        if (v) return v;
      }
      return "";
    };
    try { const v = fromParams(new URL(url, location.href)); if (v) return v; } catch (e) {}
    if (bodyText) {
      try {
        const j = JSON.parse(bodyText);
        for (const k of ["keyword", "key", "query", "searchKey", "kw"]) {
          const v = (j && j[k]) || (j && j.data && j.data[k]) || (j && j.data && j.data.mainSearchPcConditionForm && j.data.mainSearchPcConditionForm[k]);
          if (typeof v === "string" && v) return v;
        }
      } catch (e) {}
    }
    try { return fromParams(new URL(location.href)); } catch (e) { return ""; }
  }

  // ---------- 转发 ----------
  function forward(rule, url, json, bodyText) {
    // 去重 key 保留完整 URL 和请求体：BOSS 的页码在 URL 里，猎聘的页码在请求体里，
    // 去掉任何一个都会把第 2 页起当成重复丢掉
    const key = rule.platform + "|" + rule.kind + "|" + url + "|" + (bodyText || "");
    if (SENT.has(key)) return;
    SENT.add(key);
    if (SENT.size > 500) SENT.clear();

    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        __jobhunter: 1, platform: rule.platform, kind: rule.kind,
        query: keywordOf(url, bodyText), pageUrl: location.href, raw: json,
      }),
    }).then((r) => r.json()).then((d) => {
      if (d && d.ok) {
        if (rule.kind !== "list") detailCount += d.updated ? 1 : 0;
        else listCount += d.count || 0;
        lastErr = "";
      } else {
        lastErr = (d && (d.error || d.note)) || "未知";
      }
      badge();
    }).catch(() => { lastErr = "连不上看板（看板没启动，或浏览器没允许访问本地网络）"; badge(); });
  }

  // ---------- 旁听 fetch ----------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const bodyText = init && typeof init.body === "string" ? init.body : "";
      const rule = match(url);
      const p = origFetch.apply(this, arguments);
      if (rule) {
        p.then((res) => {
          try { res.clone().json().then((j) => forward(rule, url, j, bodyText)).catch(() => {}); } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---------- 旁听 XHR ----------
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__jh_url = url;
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      const url = this.__jh_url || "";
      const rule = match(url);
      if (rule) {
        this.addEventListener("load", function () {
          try {
            if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
            const json = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            forward(rule, url, json, typeof body === "string" ? body : "");
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // ---------- 详情页：读你正在看的这一页上的 JD（服务端渲染，没有详情接口可旁听） ----------
  // 只读当前页面已经显示的文字，不发任何请求
  function captureDetailPage() {
    const href = location.href.split(/[?#]/)[0];
    let platform = "", id = "", m;
    if ((m = href.match(/zhipin\.com\/job_detail\/([^./]+)\.html/))) { platform = "boss"; id = m[1]; }
    else if ((m = href.match(/liepin\.com\/(job|a)\/(\d+)\.shtml/))) { platform = "liepin"; id = m[1] === "a" ? "a" + m[2] : m[2]; }
    if (!platform) return;
    const selectors = platform === "boss"
      ? [".job-sec-text", ".job-detail-section .text"]
      : ['[data-selector="job-intro-content"]', ".job-intro-container", "[class*=job-intro]", "[class*=job-description]"];
    const read = (n) => {
      let jd = "";
      for (const sel of selectors) {
        const e = document.querySelector(sel);
        if (e && (e.innerText || "").trim().length > 40) { jd = e.innerText.trim(); break; }
      }
      if (!jd) { if (n < 6) setTimeout(() => read(n + 1), 1500); return; }
      const sm = (document.body.innerText || "").match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?[Kk万](?:·\d+薪)?/);
      forward({ platform, kind: "detail-dom" }, href, { externalId: id, jd: jd.slice(0, 3000), salaryRaw: sm ? sm[0] : "" }, "");
    };
    setTimeout(() => read(0), 1200);
  }

  // ---------- 右下角小徽标 ----------
  let el;
  function badge() {
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.style.cssText =
        "position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#12151c;color:#c9d3e3;" +
        "border:1px solid #2b3242;border-radius:8px;padding:6px 10px;font:12px/1.4 -apple-system,sans-serif;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.4);user-select:none;pointer-events:none";
      document.documentElement.appendChild(el);
    }
    el.textContent = lastErr
      ? `Job Hunter ⚠️ ${lastErr}`
      : `Job Hunter ✅ 列表 ${listCount} 条 · 详情 ${detailCount} 个`;
  }
  const onReady = () => { try { badge(); captureDetailPage(); } catch (e) {} };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady);
  else onReady();
})();
