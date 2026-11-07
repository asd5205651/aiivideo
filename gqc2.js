// gqc2.top（共青春影院）— AIIvideo spider
// 列表页结构取自站点真实 HTML（fed-list-item 卡片），详情/播放按 vfed 模板族
// 的通用形态解析（播放地址走 MacCMS 标准 player_xxxx 全局变量）。
__spiderSite = {
  id: 'gqc2',
  name: '共青春影院',
  version: 1,
  requires: '>=1',
  hosts: ['gqc2.top', 'www.gqc2.top', '1.000163.xyz', '2.000163.xyz'],

  async home(ctx) {
    const html = await get(ctx, BASE() + '/');
    const items = parseCards(html);
    if (!items.length) throw new Error('首页没解析到卡片（' + html.length + ' 字节）');
    return { items: items, page: 1, hasMore: true };
  },

  async category(ctx, args) {
    const slug = String(args.slug || '').trim();
    if (!slug) throw new Error('分类缺少 slug');
    const page = Number(args.page) || 1;
    // 分类页：page=1 → /fenlei/<slug>.html；之后 → /fenlei/<slug>-<n>.html
    const url = page <= 1
      ? BASE() + '/fenlei/' + encodeURIComponent(slug) + '.html'
      : BASE() + '/fenlei/' + encodeURIComponent(slug) + '-' + page + '.html';
    const html = await get(ctx, url);
    const items = parseCards(html);
    // 自纠正：拿不到卡片就认为到底了，绝不谎报有下一页
    return { items: items, page: page, hasMore: items.length > 0 };
  },

  async search(ctx, args) {
    const kw = String(args.keyword || '').trim();
    if (!kw) throw new Error('搜索缺少关键词');
    const page = Number(args.page) || 1;
    // 站内搜索：/sousuo/<urlencode>-------------.html（13 个连字符）
    const tail = page <= 1 ? '' : '-' + page;
    const url = BASE() + '/sousuo/' + encodeURIComponent(kw) + '-------------' + tail + '.html';
    const html = await get(ctx, url);
    const items = parseCards(html);
    return { items: items, page: page, hasMore: items.length > 0 };
  },

  async detail(ctx, args) {
    const id = idOf(args.ref);
    const html = await get(ctx, BASE() + '/neirong/' + id + '.html');

    const title = pick(html, [
      /<h1[^>]*>\s*([^<]{1,120})\s*<\/h1>/,
      /<title>\s*([^<]{1,120}?)\s*[-_|｜]\s*共青春影院/,
      /<title>\s*([^<]{1,120})\s*<\/title>/
    ]);
    if (!title) throw new Error('详情没解析到标题（' + html.length + ' 字节）');

    const coverRaw = pick(html, [
      /class="fed-part-poster[^"]*"[\s\S]{0,400}?data-original="([^"]+)"/,
      /property="og:image"[^>]*content="([^"]+)"/,
      /data-original="([^"]+)"/,
      /data-background="([^"]+)"/
    ]);

    const description = pick(html, [
      /class="fed-part-esan[^"]*"[^>]*>([\s\S]{0,1200}?)<\/div>/,
      /class="fed-describe[^"]*"[^>]*>([\s\S]{0,1200}?)<\/div>/,
      /name="description"[^>]*content="([^"]{1,600})"/
    ]);

    // 不认死链接格式：宽泛扫描播放页 URL、m3u8 直链、选集按钮
    const eps = scanEpisodes(html, id);

    // 一条都没扫到：兜底给一集（电影通常就一集），让 play 去详情页找地址。
    // 同时把真实 HTML 的关键片段挂到简介里，方便截图定位结构（诊断用，校准后删）。
    let diag = '';
    if (!eps.length) {
      eps.push({ line: '1', no: 1, ref: id + ':1:1' });
      diag = '\n\n【诊断】未识别到选集结构，以下为页面关键片段：\n' + diagExcerpt(html);
    }

    eps.sort(function (a, b) { return a.no - b.no || String(a.line).localeCompare(String(b.line)); });

    const lines = [];
    const lineSeen = new Set();
    for (const ep of eps) {
      if (lineSeen.has(ep.line)) continue;
      lineSeen.add(ep.line);
      lines.push({ line: ep.line, name: '线路 ' + ep.line });
    }
    if (!lines.length) lines.push({ line: '1', name: '默认线路' });

    return {
      id: id,
      title: title,
      cover: absolute(coverRaw),
      description: stripTags(description || '') + diag,
      tags: [],
      episodeCount: eps.filter(function (e) { return e.line === lines[0].line; }).length,
      episodes: eps.map(function (e) {
        return { no: e.no, ref: e.ref, title: '第' + e.no + '集' };
      }),
      lines: lines
    };
  },

  async play(ctx, args) {
    // ref 形如 "<id>:<线路>:<集号>"，或 "<id>:ep<no>"，或就是 id
    const parts = String(args.ref || '').split(':');
    const id = (parts[0] || '').replace(/\D/g, '');
    let line = parts.length > 2 ? parts[1] : '1';
    let no = parts.length > 2 ? Number(parts[2]) : 0;
    if (!no && parts.length === 2) no = Number(String(parts[1]).replace(/\D/g, ''));
    if (!no) no = Number(args.ep) || 1;

    // 详情页是唯一确认能拿到的页面（detail 已成功），优先从它取地址；
    // 苹果CMS/vfed 常把 player 数据或 m3u8 直接内嵌在详情页里。
    const detailHtml = await get(ctx, BASE() + '/neirong/' + id + '.html');
    let found = extractPlay(detailHtml, line, no);
    let usedDiag = '';

    if (!found.url) {
      // 再试几种常见播放页伪静态格式
      const candidates = [
        BASE() + '/vodplay/' + id + '-' + line + '-' + no + '.html',
        BASE() + '/play/' + id + '-' + line + '-' + no + '.html',
        BASE() + '/vod/' + id + '-' + line + '-' + no + '.html'
      ];
      for (const url of candidates) {
        let h = '';
        try { h = await get(ctx, url); } catch (e) { continue; }
        if (h.length < 600) continue;              // 挑战页/404，跳过
        const r = extractPlay(h, line, no);
        if (r.url) { found = r; break; }
        if (!usedDiag) usedDiag = diagExcerpt(h);
      }
    }

    if (found.url) {
      return {
        url: found.url,
        alts: [{ line: line, name: (found.from ? found.from + ' 线路 ' : '线路 ') + line, url: found.url }],
        episodeNumber: no
      };
    }

    // 全都没取到：给 reason（正确的降级），并把诊断片段放进 note
    return {
      reason: 'no-source',
      note: '详情页 ' + detailHtml.length + ' 字节、播放页也没找到地址。片段：' + (usedDiag || diagExcerpt(detailHtml))
    };
  }
};

// ── 工具 ──────────────────────────────────────────────────────────────
function BASE() {
  return 'https://gqc2.top';
}

async function get(ctx, url) {
  const r = await ctx.net({ url: url });
  if (!r || !r.ok) throw new Error('请求失败：' + url + ' — ' + ((r && r.error) || '无响应'));
  return String(r.body || '');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCharCode(Number(d)); });
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(html, regexes) {
  for (const re of regexes) {
    const m = html.match(re);
    if (m && m[1] && stripTags(m[1])) return stripTags(m[1]);
  }
  return '';
}

function absolute(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https:\/\//i.test(s)) return s;
  if (/^http:\/\//i.test(s)) return 'https://' + s.slice(7);
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (s.charAt(0) === '/') return BASE() + s;
  return s;
}

function idOf(ref) {
  const s = String(ref || '');
  const m = s.match(/(\d{3,})/);
  if (m) return m[1];
  throw new Error('拿不到视频 id：' + s.slice(0, 40));
}

function parseCards(html) {
  const items = [];
  // 一个页面里同一条片子可能出现两次（首页的分区、侧栏榜单独有卡片），按 id 去重
  const seen = new Set();
  const re = /<li class="fed-list-item[^"]*">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const seg = m[1];
    const idm = seg.match(/\/neirong\/(\d+)\.html/);
    if (!idm) continue;
    const id = idm[1];
    if (seen.has(id)) continue;

    const title = pick(seg, [
      /class="fed-list-title[^"]*"[^>]*>([\s\S]{1,200}?)<\/a>/,
      /title="([^"]{1,120})"/
    ]);
    if (!title) continue;

    const coverRaw = (seg.match(/data-original="([^"]+)"/)
      || seg.match(/data-background="([^"]+)"/)
      || seg.match(/src="([^"]+)"/) || [])[1];

    const remarks = pick(seg, [/class="fed-list-remarks[^"]*"[^>]*>([\s\S]{1,40}?)<\/span>/]);
    const year = pick(seg, [/class="fed-list-score[^"]*"[^>]*>([\s\S]{1,12}?)<\/span>/]);
    const actors = pick(seg, [/class="fed-list-desc[^"]*"[^>]*>([\s\S]{1,300}?)<\/span>/]);

    const card = {
      id: id,
      title: title,
      cover: absolute(coverRaw),
      badge: remarks || year || '',
      description: actors || ''
    };
    if (year && /^\d{4}$/.test(year)) card.playAt = year;
    seen.add(id);
    items.push(card);
  }
  return items;
}

/**
 * 宽泛扫描选集：不再认死某一种 URL 格式。
 * vfed / 苹果CMS 常见的几种：
 *   /vodplay/123-1-1.html、/play/123-1-1.html
 *   /neirong/123.html?sid=1&nid=1
 *   href="javascript:..." 配合 data-* 里的集号
 *   播放列表容器里带 "第N集" 文本的 <a>
 */
function scanEpisodes(html, id) {
  const eps = [];
  const seen = new Set();
  const add = (line, no) => {
    const n = Number(no);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return;
    const key = String(line) + '-' + n;
    if (seen.has(key)) return;
    seen.add(key);
    eps.push({ line: String(line), no: n, ref: id + ':' + line + ':' + n });
  };

  // ① 各种带 -线路-集号 的伪静态路径
  const reA = /(?:href|data-[a-z-]*url|url)\s*=\s*["']?\/?(?:vodplay|play|bfq|bofang)\/[^"'\s>]*?(\d+)[-_](\d+)[-_](\d+)\.html/gi;
  let m;
  while ((m = reA.exec(html))) add(m[2], m[3]);

  // ② sid/nid 查询串（sid=线路&nid=集号）
  const reB = /[?&](?:sid|player|from)=(\d+)[^"'\s>]*?[?&](?:nid|ep|num|ji)=(\d+)/gi;
  while ((m = reB.exec(html))) add(m[1], m[2]);

  // ③ 播放列表容器里的 "第N集" 链接（取 href 里的路径当线路，集号取文本）
  if (!eps.length) {
    const reC = /<a[^>]*href="([^"]+)"[^>]*>([^<]{0,20}?第\s*(\d+)\s*集[^<]{0,10})<\/a>/gi;
    while ((m = reC.exec(html))) {
      const href = m[1];
      const lm = href.match(/(\d+)[-_](\d+)[-_](\d+)\.html/) || href.match(/[-/](\d+)\.html/);
      add(lm ? lm[1] : '1', m[3]);
    }
  }

  return eps;
}

/** 从一段 HTML 里尽力提取可播地址，返回 {url, from} */
function extractPlay(html, line, no) {
  const out = { url: '', from: '' };

  // ① MacCMS player_xxxx = {...}
  const pv = html.match(/player_[a-z0-9_]+\s*=\s*(\{[\s\S]{0,6000}?\})\s*;?/i);
  if (pv) {
    try {
      const d = JSON.parse(pv[1]);
      const raw = d.url || d.video || d.playurl || '';
      const src = absolute(raw);
      if (/^https?:/i.test(src)) { out.url = src; out.from = d.from || ''; return out; }
    } catch (e) { /* 不是 JSON，继续找别的 */ }
  }

  // ② 页面里任意 m3u8 / mp4 直链（含转义过的 \/ 和 &amp;）
  const cleaned = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const re = /(https?:\/\/[^"'\s<>\\]{6,400}?\.(?:m3u8|mp4|flv)(?:\?[^"'\s<>\\]{0,200})?)/i;
  const mm = cleaned.match(re);
  if (mm) {
    out.url = absolute(mm[1]);
    return out;
  }

  // ③ iframe 的 src（可能是解析页，App 直接播不了，但比没有强）
  const ifr = html.match(/<(?:iframe|frame)[^>]+src="([^"]+)"/i);
  if (ifr) {
    const src = absolute(ifr[1]);
    if (/^https?:/i.test(src)) { out.url = src; return out; }
  }

  // ④ data- 属性里塞的地址
  const dm = html.match(/data-(?:url|src|play|video)\s*=\s*["']([^"']{6,400})["']/i);
  if (dm) {
    const src = absolute(decodeEntities(dm[1]));
    if (/^https?:/i.test(src)) { out.url = src; return out; }
  }

  return out;
}

/** 截一段最有诊断价值的 HTML（选集/播放相关区域），用于截图回传定位 */
function diagExcerpt(html) {
  const keys = ['vodplay', 'play', '选集', 'fed-play', 'fed-part-play', 'player_', 'm3u8', 'nid=', 'sid='];
  let best = -1;
  for (const k of keys) {
    const i = html.indexOf(k);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) best = Math.floor(html.length / 2);
  const from = Math.max(0, best - 200);
  return html.slice(from, from + 900).replace(/\s+/g, ' ').slice(0, 700);
}
