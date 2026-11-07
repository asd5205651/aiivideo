// E站弹幕网（m.ezdmw.org）—— AIIvideo spider
// 交付：本文件 + ezdmw-v1.json。文件名必须与 id 一致。
__spiderSite = {
  id: 'ezdmw-v1',
  name: 'E站弹幕网',
  version: 1,
  requires: '>=1',
  hosts: [
    'm.ezdmw.org',
    'www.ezdmw.org',
    'player.ezdmw.com',
    'player.danmuzf.vip',
    'ins.wdbed.vip',
    'image.ezdmw.com'
  ],
  home,
  category,
  search,
  detail,
  play
};

var BASE = 'https://m.ezdmw.org';
var UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// ── 小工具 ──────────────────────────────────────────────────────────

function encAscii(s) {
  // 站点 URL 里夹着原始中文（user=游客 / quarterly=2026年4月【全集完】），
  // okhttp 与 VLC 都不吃，逐字符转义。
  return String(s).replace(/[^\x00-\x7F]/g, function (c) {
    return encodeURIComponent(c);
  });
}

function unesc(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return unesc(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(html, list) {
  for (var i = 0; i < list.length; i++) {
    var m = html.match(list[i]);
    if (m && m[1] && stripTags(m[1])) return unesc(m[1]).trim();
  }
  return '';
}

function attr(tag, name) {
  var m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? unesc(m[1]).trim() : '';
}

function abs(u) {
  var s = unesc(String(u || '').trim());
  if (!s) return '';
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (s.indexOf('https://') === 0) return s;
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7);
  if (s.charAt(0) === '/') return BASE + s;
  return BASE + '/' + s;
}

async function get(ctx, url) {
  var r = await ctx.net({ url: encAscii(url), headers: { 'User-Agent': UA } });
  if (!r || !r.ok) throw new Error('请求失败：' + url + ' — ' + ((r && r.error) || '无响应'));
  return String(r.body || '');
}

// ── 卡片 ────────────────────────────────────────────────────────────

// 首页卡片：<a href="/Index/bangumi/102631.html"><img src="…" title="标题" class="img1" /></a>
// 搜索结果：<a href="/Index/bangumi/9212.html"><img src="…" class="img1" /><p>简介…</p></a><p …>标题</p>
function cards(html) {
  var out = [];
  var seen = {};
  var re = /<a\s+href="\/Index\/bangumi\/(\d+)\.html"\s*>\s*<img\s+([^>]*?)\/?>/gi;
  var m;
  while ((m = re.exec(html))) {
    var id = m[1];
    if (seen[id]) continue;
    var imgTag = m[2] || '';
    var cover = abs(attr(imgTag, 'src'));
    var title = attr(imgTag, 'title') || attr(imgTag, 'alt');
    if (!title) {
      // 搜索页形态：标题在 </a> 之后那个 <p> 里，前面还压着一段 HTML 注释
      var tail = html.slice(m.index, m.index + 1200);
      var close = tail.indexOf('</a>');
      var after = close > 0 ? tail.slice(close + 4) : tail;
      after = after.replace(/<!--[\s\S]*?-->/g, '');
      var pm = after.match(/<p[^>]*>\s*([^<]{1,120})/i);
      if (pm) title = stripTags(pm[1]);
    }
    title = unesc(title).replace(/\s+/g, ' ').trim();
    // 搜索结果会把「更至N话」粘在标题后面
    title = title.replace(/\s*更至\S*话\s*$/, '').replace(/\s*更至\S*$/, '').trim();
    if (!title) title = '番剧 ' + id;
    seen[id] = 1;
    out.push({ id: id, title: title, cover: cover });
  }
  return out;
}

// ── 列表能力 ────────────────────────────────────────────────────────

async function home(ctx) {
  var html = await get(ctx, BASE + '/');
  var items = cards(html);
  if (!items.length) throw new Error('首页没解析出卡片（' + html.length + ' 字节）');
  return { items: items, page: 1, hasMore: false };
}

function listUrl(slug, page) {
  // 该站翻页是 0/10/20 步进，不是 1/2/3
  var offset = (Math.max(1, Number(page) || 1) - 1) * 10;
  return BASE + '/Index/search_some.html?searchText=' + encodeURIComponent(slug) +
    '&page=' + offset + '&hot=true';
}

async function category(ctx, args) {
  var slug = String((args && args.slug) || '').trim();
  var page = Number((args && args.page) || 1) || 1;
  if (!slug) {
    var h = await home(ctx);
    h.page = page;
    return h;
  }
  var html = await get(ctx, listUrl(slug, page));
  var items = cards(html);
  var hasMore = /下一页/.test(html);
  return { items: items, page: page, hasMore: hasMore };
}

async function search(ctx, args) {
  var kw = String((args && args.keyword) || '').trim();
  var page = Number((args && args.page) || 1) || 1;
  if (!kw) return { items: [], page: page, hasMore: false };
  var html = await get(ctx, listUrl(kw, page));
  return { items: cards(html), page: page, hasMore: /下一页/.test(html) };
}

// ── 详情 ────────────────────────────────────────────────────────────

var LINE_CLASS = [
  { cls: 'circuit_switch1', line: 'main', name: '主线线路' },
  { cls: 'circuit_switch3', line: 'backup', name: '备用线路' },
  { cls: 'circuit_switch2', line: 'import', name: '导入观看' }
];

function scanEpisodes(html, cls) {
  var out = [];
  var re = new RegExp('<a\\s+class="' + cls + '"\\s+href="/Index/video/(\\d+)\\.html"[^>]*>\\s*<span[^>]*>([^<]*)<\\/span>', 'gi');
  var m;
  var seen = {};
  while ((m = re.exec(html))) {
    var vid = m[1];
    var no = Number(String(m[2]).replace(/[^\d]/g, ''));
    if (!no) continue;
    if (seen[no]) continue;
    seen[no] = 1;
    out.push({ no: no, ref: vid, title: '第' + (no < 10 ? '0' + no : no) + '集' });
  }
  out.sort(function (a, b) { return a.no - b.no; });
  return out;
}

async function detail(ctx, args) {
  var raw = String((args && args.ref) || '');
  var id = (raw.match(/\d{3,}/) || [])[0];
  if (!id) throw new Error('detail 的 ref 里没有 id：' + raw.slice(0, 40));
  var html = await get(ctx, BASE + '/Index/bangumi/' + id + '.html');

  var title = pick(html, [/<h4[^>]*class="top_title"[^>]*>([\s\S]{1,200}?)<\/h4>/i]) ||
    pick(html, [/<title>\s*([\s\S]{1,200}?)<\/title>/i]);
  title = stripTags(title)
    .replace(/第\d+集.*$/, '')
    .replace(/\s*-\s*\d+\s*$/, '')
    .replace(/[_-]\s*E站.*$/, '')
    .trim();

  var cover = pick(html, [
    /<img[^>]+src="([^"]+)"[^>]*class="fengmian"/i,
    /<img[^>]+class="fengmian"[^>]*src="([^"]+)"/i
  ]);
  if (!cover) {
    var og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (og) cover = og[1];
  }
  cover = abs(cover);

  var tags = [];
  var tagText = pick(html, [/【类型】：([^<]{1,160})/]);
  if (tagText) {
    tags = tagText.split(/[、,，\/]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  var desc = '';
  var meta = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (meta) desc = unesc(meta[1]).trim();
  if (!desc) {
    desc = stripTags(pick(html, [/简介：<\/h2>([\s\S]{1,1200}?)<\/p>/i]));
  }

  var lines = [];
  var episodes = [];
  for (var i = 0; i < LINE_CLASS.length; i++) {
    var eps = scanEpisodes(html, LINE_CLASS[i].cls);
    if (!eps.length) continue;
    lines.push({ line: LINE_CLASS[i].line, name: LINE_CLASS[i].name });
    if (!episodes.length) episodes = eps; // 只把第一条线路的集给 App（episodes 不带线路概念）
  }

  if (!episodes.length) {
    throw new Error('详情页没找到选集（' + html.length + ' 字节）：' + stripTags(html).slice(0, 160));
  }

  return {
    id: String(id),
    title: title || ('番剧 ' + id),
    cover: cover,
    description: desc,
    tags: tags,
    episodeCount: episodes.length,
    episodes: episodes,
    lines: lines
  };
}

// ── 播放 ────────────────────────────────────────────────────────────

// 播放页里 iframe 的 src 是运行时才设的，HTML 属性里只有 id="player_iframe"。
// 真正可用的地址在 var danmuPlayer1 = "…"。
function extractPlayerPage(html) {
  var m = html.match(/var\s+danmuPlayer1\s*=\s*"([^"]+)"/i);
  if (m) return unesc(m[1]);
  var m2 = html.match(/<iframe[^>]+id="player_iframe"[^>]+src="([^"]+)"/i);
  if (m2) return unesc(m2[1]);
  var m3 = html.match(/(https?:\/\/player\.[a-z0-9.]+\/danmuku\/\?[^"'\s<>]+)/i);
  if (m3) return unesc(m3[1]);
  return '';
}

function extractVideo(html) {
  var m = html.match(/<video\b[^>]*?\bsrc="([^"]+)"/i);
  if (!m) return '';
  var u = unesc(m[1]).trim();
  if (u.indexOf('//') === 0) u = 'https:' + u;
  return u;
}

async function play(ctx, args) {
  var raw = String((args && args.ref) || '');
  var ep = Number((args && args.ep) || 0) || 0;

  // ref 形态：'102608'（详情给的 vid）或 '98569:102608'（App 拼了 id 前缀）
  var segs = raw.split(':').map(function (s) { return s.trim(); }).filter(Boolean);
  var vid = '';
  for (var i = segs.length - 1; i >= 0; i--) {
    if (/^\d{3,}$/.test(segs[i])) { vid = segs[i]; break; }
  }
  if (!vid) throw new Error('play 的 ref 里没有选集 id：' + raw.slice(0, 40));

  var tried = [];

  // 第一跳：播放页 → 播放器页地址
  var vHtml = '';
  try {
    vHtml = await get(ctx, BASE + '/Index/video/' + vid + '.html');
  } catch (e) {
    throw new Error('play 失败 vid=' + vid + '：播放页取不到 — ' + String((e && e.message) || e).slice(0, 120));
  }
  var pUrl = extractPlayerPage(vHtml);
  if (!pUrl) {
    tried.push('播放页 ' + vHtml.length + 'B 里没有 danmuPlayer1');
    throw new Error('play 失败 vid=' + vid + '：' + tried.join('；') +
      '｜开头：' + stripTags(vHtml).slice(0, 100));
  }

  // 第二跳：播放器页 → <video src>
  var pHtml = '';
  try {
    pHtml = await get(ctx, pUrl);
  } catch (e) {
    throw new Error('play 失败 vid=' + vid + '：播放器页取不到 — ' +
      String((e && e.message) || e).slice(0, 140));
  }
  var src = extractVideo(pHtml);
  if (!src) {
    throw new Error('play 失败 vid=' + vid + '：播放器页 ' + pHtml.length +
      'B 里没有 <video src>｜开头：' + stripTags(pHtml).slice(0, 100));
  }

  var url = encAscii(src);
  var alt = encAscii(src.replace('player.ezdmw.com', 'player.danmuzf.vip'));
  var alts = [{ line: 'main', name: '主线线路', url: url }];
  if (alt && alt !== url) alts.push({ line: 'backup', name: '备用域名', url: alt });

  return {
    url: url,
    alts: alts,
    episodeNumber: ep || 1
  };
}
