// gqc2.top（共青春影院）— AIIvideo spider
// 列表页结构取自站点真实 HTML（fed-list-item 卡片），详情/播放按 vfed 模板族
// 的通用形态解析（播放地址走 MacCMS 标准 player_xxxx 全局变量）。
__spiderSite = {
  id: 'gqc2',
  name: '共青春影院',
  version: 1,
  requires: '>=1',
  hosts: ['gqc2.top', 'www.gqc2.top', '1.000163.xyz', '2.000163.xyz', '3.000163.xyz'],

  async home(ctx) {
    const html = await get(ctx, BASE() + '/');
    const items = parseCards(html);
    if (!items.length) throw new Error('首页没解析到卡片（' + html.length + ' 字节）');
    return { items: items, page: 1, hasMore: true };
  },

  async category(ctx, args) {
    // slug 可能为空（App 某些入口只给 key）：退回首页而不是报错，
    // 「分类缺少 slug」会让整页变成「源站返回了看不懂的数据」。
    let slug = String(args.slug || '').trim();
    if (!slug) {
      const items = parseCards(await get(ctx, BASE() + '/'));
      return { items: items, page: 1, hasMore: items.length > 0 };
    }
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

    const rawTitle = pick(html, [
      /<h1[^>]*>\s*([^<]{1,120})\s*<\/h1>/,
      /<title>\s*([^<]{1,200}?)\s*[-_|｜]\s*共青春影院/,
      /<title>\s*([^<]{1,200})\s*<\/title>/
    ]);
    if (!rawTitle) throw new Error('详情没解析到标题（' + html.length + ' 字节）');
    // 去掉「_韩剧_在线电影_在线播放」这类站点后缀
    const title = rawTitle.replace(/_[^_]{1,20}(?:_[^_]{1,20})*$/, '').trim() || rawTitle;

    const coverRaw = pick(html, [
      /class="fed-part-poster[^"]*"[\s\S]{0,400}?data-original="([^"]+)"/,
      /property="og:image"[^>]*content="([^"]+)"/,
      /data-original="([^"]+)"/,
      /data-background="([^"]+)"/
    ]);

    const description = pick(html, [
      /class="fed-part-esan[^"]*"[^>]*>([\s\S]{0,1500}?)<\/div>/,
      /class="fed-describe[^"]*"[^>]*>([\s\S]{0,1500}?)<\/div>/,
      /name="description"[^>]*content="([^"]{1,600})"/
    ]);

    // 真实结构：详情页的选集是 <a href="/bofang/<id>-<线路>-<集号>.html">第NN集</a>
    // 线路来自 /bofang/<id>-<line>-<no>，集号取链接最后一段（文本可能有「第01集」）
    const eps = scanEpisodes(html, id);
    if (!eps.length) {
      throw new Error('详情页没找到选集链接（' + html.length + ' 字节）'
        + ' — 片段：' + diagExcerpt(html));
    }

    eps.sort(function (a, b) {
      return a.line - b.line || a.no - b.no;
    });

    const lines = [];
    const lineSeen = new Set();
    for (const ep of eps) {
      if (lineSeen.has(ep.line)) continue;
      lineSeen.add(ep.line);
      lines.push({ line: ep.line, name: ep.lineName || ('线路 ' + ep.line) });
    }

    // 只返回第一条线路的集：协议里 episodes 不按线路分组，
    // 把所有线路的集都塞进去，App 会画成「1-8 重复十几遍」。
    const firstLine = lines[0].line;
    const inFirst = eps.filter(function (e) { return e.line === firstLine; });

    // 临时诊断：把播放页的真实检测结果写进简介（App 会显示简介，
    // 但不显示 play() 的 note，所以只能从这里把信息带出来）
    let diag = '';
    try {
      const first = inFirst[0];
      const pUrl = BASE() + '/bofang/' + id + '-' + first.line + '-' + first.no + '.html';
      const ph = await get(ctx, pUrl);
      const r = extractPlay(ph);
      if (r.url) {
        diag = '播放页 ' + ph.length + 'B ✓ 已取到地址';
      } else if (/Just a moment|challenge-platform/i.test(ph)) {
        diag = '播放页 ' + ph.length + 'B ✗ Cloudflare挑战页';
      } else if (ph.length < 2000) {
        diag = '播放页 ' + ph.length + 'B ✗ 页面过短';
      } else {
        diag = '播放页 ' + ph.length + 'B ✗ 无data-play/m3u8 | 片段: ' + stripTags(ph).slice(0, 180);
      }
    } catch (e) {
      diag = '播放页请求失败: ' + String(e && e.message || e).slice(0, 60);
    }

    return {
      id: id,
      title: title,
      cover: absolute(coverRaw),
      description: stripTags(description || '') + '\n\n【诊断】' + diag,
      tags: [],
      episodeCount: inFirst.length,
      episodes: inFirst.map(function (e) {
        return { no: e.no, ref: e.ref, title: e.title || ('第' + e.no + '集') };
      }),
      lines: lines
    };
  },

  async play(ctx, args) {
    // ref 可能是 "362248:1:1"（我给的）、"362248:ep1"、或就是 id。
    // 不猜格式：把候选 URL 全试一遍，第一个取到地址的即用。
    const raw = String(args.ref || '');
    const id = (raw.match(/\d{3,}/) || [])[0] || '';
    if (!id) return { reason: 'no-source', note: 'ref 里没有 id：' + raw.slice(0, 40) };

    // 从 ref 里尽力还原线路/集号
    // ref 里冒号分段：<id>:<线路>:<集号> → 最后一个数是集号，前一个是线路
    const segs = raw.split(':').filter(Boolean).slice(1);
    const allNums = [];
    for (const seg of segs) {
      const nums = String(seg).match(/\d+/g);
      if (nums) for (const n of nums) allNums.push(Number(n));
    }
    let no = 0;
    let line = String(args.line || '');
    if (allNums.length >= 2) {
      no = allNums[allNums.length - 1];
      line = line || String(allNums[allNums.length - 2]);
    } else if (allNums.length === 1) {
      no = allNums[0];
    }
    if (!no) no = Number(args.ep) || 1;
    if (!line) line = '1';

    const tried = [];

    // 候选顺序：先用 ref 解析出的，再试常见线路号
    const lineCands = [line, '1', '2', '3'].filter(function (v, i, a) { return a.indexOf(v) === i; });
    const urlCands = [];
    for (const l of lineCands) {
      urlCands.push(BASE() + '/bofang/' + id + '-' + l + '-' + no + '.html');
    }

    for (let ci = 0; ci < urlCands.length; ci++) {
      const u = urlCands[ci];
      const usedLine = lineCands[ci] || "1";
      let html = '';
      try {
        html = await get(ctx, u);
      } catch (e) {
        tried.push(u + ' → 请求失败');
        continue;
      }
      if (!html) { tried.push(u + ' → 空'); continue; }
      tried.push(u + ' → ' + html.length + 'B');

      const r = extractPlay(html);
      if (r.url) {
        return {
          url: r.url,
          alts: [{ line: String(usedLine), name: "线路 " + usedLine, url: r.url }],
          episodeNumber: Number(no),
        };
      }
    }

    // 全部失败：把每个 URL 的体量和页面性质写进 note（诊断用）
    return {
      reason: 'no-source',
      note: '候选都失败：' + tried.join(' | '),
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
/**
 * 解析选集。真实结构（2026-11 实测）：
 *   <a href="/bofang/<id>-<线路>-<集号>.html">第01集</a>
 * 详情页多集剧有 N 条，单集电影只有 1 条（「立即播放」按钮）。
 */
function scanEpisodes(html, id) {
  const eps = [];
  const seen = new Set();
  const re = /<a[^>]*href="([^"]*\/bofang\/(\d+)-(\d+)-(\d+)\.html)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[2] !== String(id)) continue;          // 只认当前视频的
    const line = String(m[3]);
    const no = Number(m[4]);
    if (!Number.isFinite(no) || no < 1) continue;
    const key = line + '-' + no;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = stripTags(m[5]).trim();
    const label = /立即播放|播放|HD|正片|抢先/i.test(text) && !/第\s*\d+/.test(text) ? '' : text;
    eps.push({
      line: line,
      no: no,
      ref: id + ':' + line + ':' + no,
      title: label || ('第' + no + '集'),
    });
  }
  return eps;
}

/**
 * 从播放页提取可播地址。真实结构（2026-11 实测）：
 *   <iframe ... data-play="https://v.xxx/index.m3u8" data-pars="https://play.xxx/player/ec.php?...">
 * 优先 data-play（直链），其次页面里的 m3u8，最后 data-pars / iframe src。
 */
function extractPlay(html) {
  const out = { url: '', from: '', host: '' };
  const clean = html.replace(/&amp;/g, '&').replace(/\\\//g, '/');

  // ① 播放器 iframe 的 src 里带 url=<m3u8>：实测这站最常见，最先取
  const ifrUrl = clean.match(/<(?:iframe|frame)[^>]+src="[^"]*[?&]url=(https?[^"&]+)/i);
  if (ifrUrl) {
    const src = absolute(decodeURIComponent(ifrUrl[1]));
    if (/^https?:/i.test(src) && /\.(?:m3u8|mp4|flv)/i.test(src)) {
      out.url = src; out.host = hostOf(src); return out;
    }
  }

  // ② iframe 上的 data-play：直链 m3u8/mp4
  const dp = html.match(/data-play\s*=\s*"([^"]{6,500})"/i);
  if (dp) {
    const src = absolute(decodeEntities(dp[1]));
    if (/^https?:/i.test(src)) { out.url = src; out.host = hostOf(src); return out; }
  }

  // ② 页面里任意 m3u8 / mp4（含转义 \/ 和 &amp;）
  const cleaned = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const mm = cleaned.match(/(https?:\/\/[^"'\s<>\\]{6,400}?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]{0,200})?)/i);
  if (mm) { out.url = absolute(mm[1]); out.host = hostOf(out.url); return out; }

  // ③ MacCMS player_xxxx = {...}
  const pv = cleaned.match(/player_[a-z0-9_]+\s*=\s*(\{[\s\S]{0,6000}?\})\s*;?/i);
  if (pv) {
    try {
      const d = JSON.parse(pv[1]);
      const src = absolute(d.url || d.video || d.playurl || '');
      if (/^https?:/i.test(src)) { out.url = src; out.from = d.from || ''; return out; }
    } catch (e) { /* 继续 */ }
  }

  // ④ data-pars / iframe src：是解析页，App 播不了直链，但给出来比没有强
  const pars = html.match(/data-pars\s*=\s*"([^"]{6,500})"/i);
  if (pars) {
    const src = absolute(decodeEntities(pars[1]));
    if (/^https?:/i.test(src)) { out.url = src; out.from = 'pars'; return out; }
  }
  const ifr = html.match(/<iframe[^>]+src="([^"]{6,500})"/i);
  if (ifr) {
    const src = absolute(decodeEntities(ifr[1]));
    if (/^https?:/i.test(src)) { out.url = src; out.from = 'iframe'; return out; }
  }

  return out;
}

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

/** 取 URL 的主机名，用于诊断/日志 */
function hostOf(u) {
  const m = String(u || '').match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}
