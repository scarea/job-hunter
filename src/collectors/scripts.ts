/**
 * page.evaluate 的注入脚本 —— ⚠️ 必须是字符串
 *
 * 为什么不用函数：tsx 用 esbuild 转译 TS，会给函数注入 __name 辅助函数。
 * 函数被序列化送到浏览器后，__name 在页面上下文不存在 → ReferenceError。
 * 传字符串则完全不经过这个转换，最稳。
 */

export const BOSS_LIST = String.raw`
(() => {
  return Array.from(document.querySelectorAll('.job-card-wrap')).map(function (c) {
    var g = function (s) { var e = c.querySelector(s); return e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
    var a = c.querySelector('a.job-name');
    return {
      title: g('.job-name'),
      salary: g('.job-salary'),
      tags: Array.from(c.querySelectorAll('.tag-list li')).map(function (x) { return (x.textContent || '').trim(); }),
      company: g('.boss-name'),
      loc: g('.company-location'),
      href: a ? a.getAttribute('href') : ''
    };
  });
})()
`;

export const ZHAOPIN_LIST = String.raw`
(() => {
  return Array.from(document.querySelectorAll('.job-card')).map(function (c) {
    var g = function (s) { var e = c.querySelector(s); return e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
    var titleEl = c.querySelector('.job-card__title-main .vue-clamp__text') || c.querySelector('.job-card__title-main');
    var linkEl = c.querySelector('a[href*="/jobdetail/"]') || c.querySelector('a[href*="zhaopin"]');
    var companyLink = c.querySelector('.job-card__company a');
    return {
      title: titleEl ? (titleEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
      salary: g('.job-card__salary'),
      tags: Array.from(c.querySelectorAll('.job-card__skill-tag')).map(function (x) { return (x.textContent || '').trim(); }),
      company: companyLink ? (companyLink.textContent || '').replace(/\s+/g, ' ').trim() : '',
      loc: g('.job-card__city') || g('.job-card__other-info'),
      href: linkEl ? linkEl.getAttribute('href') : ''
    };
  });
})()
`;

export const LIEPIN_LIST = String.raw`
(() => {
  var cards = Array.from(document.querySelectorAll('[data-tlg-elem-id="c_pc_search_job_listcard"]'))
    .filter(function (e) { return e.offsetParent !== null; });
  return cards.map(function (c) {
    var link = c.querySelector('a[data-nick="job-detail-job-info"]');
    var titleBox = c.querySelector('.jobTitleBox');
    var rawTitle = (titleBox && titleBox.querySelector('[title]') ? titleBox.querySelector('[title]').getAttribute('title') : (titleBox ? titleBox.textContent : '')) || '';
    var title = rawTitle.replace(/\s+/g, ' ').trim().replace(/^(招聘|急聘|热招)/, '').trim();
    var salary = '';
    Array.from(c.querySelectorAll('span')).forEach(function (s) {
      var t = (s.textContent || '').trim();
      if (!salary && /^[\d.]+-[\d.]+[kK万]/.test(t) && t.length < 14) salary = t;
    });
    var locEl = titleBox ? titleBox.querySelector('.ellipsis-1:last-child') : null;
    var companyEl = c.querySelector('[class*="companyName"]') || c.querySelector('[class*="compName"]') || c.querySelector('a[href*="/company/"]');
    return {
      title: title,
      salary: salary,
      company: companyEl ? (companyEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
      loc: locEl ? (locEl.textContent || '').replace(/[【】\s]/g, '').trim() : '',
      href: link ? link.getAttribute('href') : ''
    };
  });
})()
`;

export const DETAIL_INFO = String.raw`
((plat) => {
  var txt = (document.body.innerText || '').replace(/\r/g, '');
  var salary = '';
  var m = txt.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?[Kk](?:·\d+薪)?/);
  if (m) salary = m[0];
  if (!salary) {
    var w = txt.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?万(?:·\d+薪)?/);
    if (w) salary = w[0];
  }
  var sel = {
    boss: ['.job-sec-text', '.job-detail-section .text', '[class*=job-sec] .text'],
    zhaopin: ['[class*=describtion]', '[class*=job-detail]', '[class*=position-desc]', '[class*=job-description]',
              '[class*=summary]', '[class*=describe]', '.job-detail-content', '[class*=jobdetail]', '[class*=position-detail]'],
    liepin: ['[class*=job-description]', '[class*=job-intro]', '[class*=content-word]', '.job-description', '[class*=introduce]']
  }[plat] || [];
  var jd = '';
  for (var i = 0; i < sel.length; i++) {
    var el = document.querySelector(sel[i]);
    if (el && (el.innerText || '').length > 40) { jd = el.innerText; break; }
  }
  if (!jd) {
    var blocks = Array.from(document.querySelectorAll('div,section,article'))
      .map(function (e) { return e.innerText || ''; })
      .filter(function (t) { return t.length > 200 && t.length < 4000; });
    blocks.sort(function (a, b) { return b.length - a.length; });
    jd = blocks[0] || txt.slice(0, 2500);
  }
  return { jd: jd.replace(/\n{3,}/g, '\n\n').slice(0, 3000), salaryRaw: salary };
})
`;
