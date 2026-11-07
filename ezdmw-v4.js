// E站弹幕网（m.ezdmw.org）—— AIIvideo spider
// 交付：本文件 + ezdmw-v4.json。文件名必须与 id 一致。
//
// v4 相对 v3 只改 play 的线路取舍（列表/详情/取播放器页未动）：
//   站点每集实际只有三类产物 ——
//     ① 微软 personal content 直链：206 video/mp4 + ftyp 头，实测稳定可播；
//     ② tiktok ibyteimg 直链：老番多数已 403/404，需探一次才敢用；
//     ③ .webp 伪装 HLS：200 image/webp 的 m3u8、分片前压 PNG 头。
//   ③ 在 App 上必挂：网页内核不解 HLS → 退内置 VLC → 中继把 PNG 头分片当
//   octet-stream 透传 → demux 失败。把它列进 alts 只会白耗换线轮次，还会让
//   用户误以为「回上一页重取」有用。所以 v4 只把 ①②交给播放器；一条可播的
//   都没有就直接 throw Error —— feed-player.js 的 boot(error.message) 会把
//   原文贴到黑屏上，用户一眼就知道是源站片源失效，不用回来问。
//   实测（2026-11-07）：一拳超人 S3 全季有 ①；S1 只剩 ② 的死链；
//   S2 三条线路全是 ③。这是站点自己的片源状况，脚本修不了。
__spiderSite = {
  id: 'ezdmw-v4',
  name: 'E站弹幕网',
  version: 4,
  requires: '>=1',
  hosts: [
    'm.ezdmw.org',
    'www.ezdmw.org',
    'player.ezdmw.com',
    'player.danmuzf.vip',
    'ins.wdbed.vip',
    'image.ezdmw.com',
    'my.microsoftpersonalcontent.com',
    'p16-va-tiktok.ibyteimg.com'
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
  // 还有空格（title=FX 战士久留美）。okhttp 的 HttpUrl 见到空格直接抛
  // IllegalArgumentException，连请求都发不出去 —— 所以空格也要转。
  return String(s)
    .replace(/ /g, '%20')
    .replace(/"/g, '%22')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/[^\x00-\x7F]/g, function (c) {
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

// ascrs=true 要拼在播放器页地址后面；地址本身已经带了 query，所以是追加。
function withAscrs(u) {
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'ascrs=true';
}

// 取播放器页并抠出 <video src>。两个播放器域互为镜像，第一个拿不到就换第二个。
// sign 是播放器页当场生成的、且有寿命（页面里那句「请求过期了，请刷新」是 JS 兜底
// 文案，页面上永远在，不能拿它判断过期）——所以每次都重新取，不复用旧地址。
async function fetchPlayerPage(ctx, pUrl, ascrs) {
  var first = ascrs ? withAscrs(pUrl) : pUrl;
  var second = pUrl.replace('player.ezdmw.com', 'player.danmuzf.vip');
  second = ascrs ? withAscrs(second) : second;
  var urls = second === first ? [first] : [first, second];
  var tried = [];
  for (var i = 0; i < urls.length; i++) {
    try {
      var html = await get(ctx, urls[i]);
      var src = extractVideo(html);
      if (src) return { src: src, tried: tried };
      tried.push('播放器页 ' + html.length + 'B 里没有 <video src>');
    } catch (e) {
      tried.push('播放器页取不到(' + (i === 0 ? 'ezdmw' : 'danmuzf') + ') ' +
        String((e && e.message) || e).slice(0, 60));
    }
  }
  return { src: '', tried: tried };
}

// 只认 MP4 直链。伪装 HLS（listres/*.webp）一律不收：它在 App 上必解不了，
// 列进 alts 只是白耗换线，还会误导用户去重取。
function mp4Kind(u) {
  if (/microsoftpersonalcontent\.com/i.test(u)) return 'microsoft';
  if (/ibyteimg\.com/i.test(u) || /\/obj\//i.test(u) || /\.mp4(\?|$)/i.test(u)) return 'other-mp4';
  return '';
}

// 给用户看的诊断名：全不可播时把「站点到底给了什么」写进报错。
function shapeName(u) {
  if (!u) return '没解析出地址';
  if (/\/listres\//i.test(u) || /\.webp(\?|$)/i.test(u)) return '伪装 HLS（image/webp + PNG 头分片）';
  if (/ibyteimg\.com/i.test(u)) return 'tiktok CDN 直链';
  return '未知格式 ' + u.slice(0, 50);
}

// 非微软域的直链先 Range 探 1KB：ctx.net 非 2xx 直接抛错，抛了就是死链。
// 微软域实测稳定，跳过探测省一次请求。
async function aliveMp4(ctx, url) {
  try {
    var r = await ctx.net({ url: encAscii(url), headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } });
    var body = String((r && r.body) || '');
    // 有些 CDN 用 200 + JSON 错误页糊弄，别把它当视频。
    if (/^\s*\{/.test(body)) return false;
    return true;
  } catch (e) {
    return false;
  }
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

  // 第一跳：播放页 → 播放器页地址
  var vHtml = '';
  try {
    vHtml = await get(ctx, BASE + '/Index/video/' + vid + '.html');
  } catch (e) {
    throw new Error('play 失败 vid=' + vid + '：播放页取不到 — ' + String((e && e.message) || e).slice(0, 120));
  }
  var pUrl = extractPlayerPage(vHtml);
  if (!pUrl) {
    throw new Error('play 失败 vid=' + vid + '：播放页 ' + vHtml.length +
      'B 里没有 danmuPlayer1｜开头：' + stripTags(vHtml).slice(0, 100));
  }

  // 第二跳之一：主线二（&ascrs=true）→ 通常就是真 MP4
  var mp4 = await fetchPlayerPage(ctx, pUrl, true);
  var found = [];
  function push(u) {
    if (!u) return;
    var kind = mp4Kind(u);
    if (!kind) return;                       // 伪装 HLS 直接丢弃
    var eu = encAscii(u);
    for (var j = 0; j < found.length; j++) if (found[j].url === eu) return;
    found.push({
      url: eu,
      kind: kind,
      name: kind === 'microsoft' ? '主线二 · MP4 直链' : 'MP4 直链'
    });
  }
  push(mp4.src);

  // 主线二没拿到可播 MP4（老番常见）时，再看主线一有没有别的直链。
  var hls = { src: '', tried: [] };
  if (!found.some(function (f) { return f.kind === 'microsoft'; })) {
    hls = await fetchPlayerPage(ctx, pUrl, false);
    push(hls.src);
  }

  if (!found.length) {
    throw new Error('第 ' + (ep || 1) + ' 集：源站没有可播放的资源 —— 主线二给的是 ' +
      shapeName(mp4.src) + '、主线一给的是 ' + shapeName(hls.src) +
      '，App 都解不了。换一集或换个源试试（重取多少次都一样）。');
  }

  var usable = [];
  for (var k = 0; k < found.length; k++) {
    if (found[k].kind === 'microsoft' || await aliveMp4(ctx, found[k].url)) usable.push(found[k]);
  }
  if (!usable.length) {
    throw new Error('第 ' + (ep || 1) + ' 集：源站的 MP4 直链已失效（上游 403/404）' +
      '，换一集或换个源试试。');
  }

  // url 必须先出现在 alts 里（规则 1），否则用户切一次线路再切回来就换了源。
  var alts = usable.map(function (f, i) {
    return { line: i === 0 ? f.kind : f.kind + '-' + i, name: f.name, url: f.url };
  });
  return {
    url: alts[0].url,
    alts: alts,
    episodeNumber: ep || 1
  };
}
