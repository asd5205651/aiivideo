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

    // 播放链接形如 /play/<id>-<线路>-<集号>.html
    const eps = [];
    const seen = new Set();
    const lineRe = /\/play\/\d+-(\d+)-(\d+)\.html/g;
    let m;
    while ((m = lineRe.exec(html))) {
      const line = m[1];
      const no = Number(m[2]);
      const key = line + '-' + no;
      if (seen.has(key)) continue;
      seen.add(key);
      eps.push({ line: line, no: no, ref: id + ':' + line + ':' + no });
    }
    eps.sort(function (a, b) { return a.no - b.no; });

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
      description: stripTags(description || ''),
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

    const url = BASE() + '/play/' + id + '-' + line + '-' + no + '.html';
    const html = await get(ctx, url);

    // MacCMS 标准：player_aaaa = {"url":"…","from":"…","server":"…"}
    const pv = html.match(/player_[a-z0-9]+\s*=\s*(\{[\s\S]{0,4000}?\})\s*;?\s*<\/script>/i)
      || html.match(/player_[a-z0-9]+\s*=\s*(\{[\s\S]{0,4000}?\})/i);
    if (!pv) {
      const iframe = html.match(/<(?:iframe|frame)[^>]+src="([^"]+)"/i);
      if (iframe) {
        const src = absolute(iframe[1]);
        if (src && /^https?:/i.test(src)) {
          return {
            url: src,
            alts: [{ line: line, name: '线路 ' + line, url: src }],
            episodeNumber: no
          };
        }
      }
      return { reason: 'no-source', note: '播放页没找到 player 变量（' + html.length + ' 字节）' };
    }

    let data;
    try {
      data = JSON.parse(pv[1]);
    } catch (e) {
      return { reason: 'no-source', note: '播放信息解析失败：' + String(e.message).slice(0, 60) };
    }
    const raw = data && (data.url || data.video || '');
    const src = absolute(raw);
    if (!src) return { reason: 'no-source', note: '这一集源站没有给出地址' };
    if (!/^https?:/i.test(src)) {
      return { reason: 'encrypted', note: '这个地址不是直链，需要解析器（' + src.slice(0, 40) + '）' };
    }
    return {
      url: src,
      alts: [{ line: line, name: (data.from ? data.from + ' 线路 ' : '线路 ') + line, url: src }],
      episodeNumber: no
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
