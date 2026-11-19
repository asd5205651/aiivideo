// 低端影视 ddys.io v1 — FongMi/TV QuickJS-NG type:3 spider
// 2026-11-18; host contract: FongMi/TV 5bf18d6ae8b0ccd9b753ef98f932838de2eb7254.
// Public API only; no login, private key, jar, Node API or external JS dependency.
// Keep this file beside ddys-v1.json. Online HLS/MP4 and cloud-share links are separate.
import {Spider} from "catvod";

const HOSTS = ["https://ddys.cloud", "https://ddys.fyi", "https://ddys.ceo", "https://ddys.io"];
const TYPES = [{code:"movie",name:"电影"},{code:"series",name:"剧集"},{code:"variety",name:"综艺"},{code:"anime",name:"动漫"}];
const UA = "Mozilla/5.0";
function integer(v, def, min, max) { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : def; }
function object(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) { try { const j = JSON.parse(v); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch (_) {} }
  return {};
}
function clean(v) {
  return String(v == null ? "" : v).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function label(v) { return clean(v).replace(/\$/g, "＄").replace(/#/g, "＃"); }
function episodeKey(v) {
  const s = clean(v).replace(/\s+/g, "").toLowerCase();
  const m = /^(?:第)?0*(\d+)(?:集|话|期)?/.exec(s);
  return m ? "episode:" + Number(m[1]) : "label:" + s;
}
function versionKey(v) {
  const s = clean(v);
  const tags = [];
  if (/国语|普通话/.test(s)) tags.push("国语");
  if (/粤语/.test(s)) tags.push("粤语");
  if (/英语|英文/.test(s)) tags.push("英语");
  if (/日语|日文/.test(s)) tags.push("日语");
  if (/韩语|韩文/.test(s)) tags.push("韩语");
  if (/中字|中文字幕/.test(s)) tags.push("中字");
  return tags.filter((v,i,a) => a.indexOf(v) === i).sort().join("+");
}
// RFC3986 HTTP resolution without relying on browser URL globals in QuickJS.
function resolve(base, ref) {
  ref = String(ref || "").trim();
  if (/^https?:\/\//i.test(ref)) return ref;
  const m = /^(https?):\/\/([^/]+)(\/[^?#]*)?/i.exec(String(base));
  if (!m) throw new Error("无法解析媒体地址");
  if (ref.indexOf("//") === 0) return m[1] + ":" + ref;
  const origin = m[1] + "://" + m[2], path = m[3] || "/";
  if (ref.charAt(0) === "?") return origin + path + ref;
  if (ref.charAt(0) === "#") return String(base).split("#")[0] + ref;
  const joined = ref.charAt(0) === "/" ? ref : path.slice(0, path.lastIndexOf("/") + 1) + ref;
  const cut = joined.search(/[?#]/), pathname = cut < 0 ? joined : joined.slice(0, cut), suffix = cut < 0 ? "" : joined.slice(cut);
  const parts = [];
  for (const p of pathname.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
  return origin + "/" + parts.join("/") + suffix;
}
function bytes(content) {
  if (Array.isArray(content)) return content;
  if (typeof ArrayBuffer !== "undefined" && content instanceof ArrayBuffer) return new Uint8Array(content);
  if (content && typeof content.length === "number" && typeof content !== "string") return content;
  return [];
}

export default class DDYS extends Spider {
  init(extend = "") {
    const o = object(extend);
    const hosts = Array.isArray(o.hosts) ? o.hosts : (o.host ? [o.host].concat(HOSTS) : HOSTS);
    this.hosts = hosts.map(h => String(h).trim().replace(/\/+$/, "")).filter((h, i, a) => /^https?:\/\/[^/]+$/i.test(h) && a.indexOf(h) === i);
    if (!this.hosts.length) throw new Error("DDYS hosts 配置为空");
    this.options = {
      page_size: integer(o.page_size, 24, 1, 50),
      timeout: integer(o.timeout, 4000, 1000, 6000),
      probe_timeout: integer(o.probe_timeout, 2200, 800, 4000),
      auto_fallback: o.auto_fallback !== false && o.auto_fallback !== 0,
      probe_segments: o.probe_segments !== false && o.probe_segments !== 0,
      media_referer: String(o.media_referer || "")
    };
    this.host = this.hosts[0];
    this.cache = new Map();
    this.probes = new Map();
    this.deadlineAt = 0;
  }
  requestBudget(max) {
    if (this.deadlineAt) {
      const remaining = this.deadlineAt - Date.now();
      if (remaining < 250) throw new Error("播放探测已达时间预算，请切换线路或稍后重试");
      return Math.min(max, remaining);
    }
    return max;
  }
  ready() { if (!this.options) this.init(); }
  ua() { try { return this.net.getUserAgent() || UA; } catch (_) { return UA; } }
  mediaHeaders() {
    const h = {"User-Agent":this.ua()};
    if (this.options.media_referer) h.Referer = this.options.media_referer;
    return h;
  }
  store(map, key, value, ttl, max = 64) {
    if (map.has(key)) map.delete(key);
    while (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, {value, until:Date.now() + ttl});
    return value;
  }
  async api(path, ttl = 60000) {
    this.ready();
    const hit = this.cache.get(path);
    if (hit && hit.until > Date.now()) return hit.value;
    const errors = [];
    const hosts = [this.host].concat(this.hosts.filter(h => h !== this.host));
    for (const host of hosts) {
      try {
        const requestTimeout = Math.min(this.options.timeout, this.requestBudget(2500));
        const r = await this.net.req(host + "/api/v1" + path, {method:"GET", buffer:0,
          headers:{"User-Agent":this.ua(),Accept:"application/json"}, timeout:requestTimeout,callTimeout:requestTimeout});
        const code = Number(r.code);
        let j;
        try { j = JSON.parse(String(r.content || "")); } catch (_) {}
        if (code === 429) { const e = new Error("DDYS 公开 API 限流，请稍后重试（不轮换域名规避限流）"); e.stop = true; throw e; }
        if (code === 404 || code === 422) { const e = new Error("DDYS HTTP " + code + "：" + clean(j && j.message || "资源不存在或参数无效")); e.stop = true; throw e; }
        if (r.error || code < 200 || code >= 300) throw new Error("HTTP " + code + (r.error ? " " + String(r.error) : ""));
        if (!j || j.success !== true || j.data == null) throw new Error(clean(j && j.message || "响应不是有效 DDYS JSON，可能是验证页"));
        this.host = host;
        return this.store(this.cache, path, j, ttl);
      } catch (e) {
        if (e.stop) throw e;
        errors.push(host + " " + String(e.message || e));
      }
    }
    throw new Error("DDYS 站点请求失败：" + errors.join("；"));
  }
  query(params) { return Object.keys(params).filter(k => params[k] !== "" && params[k] != null).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k]))).join("&"); }
  slug(v) {
    let s = String(v || "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?movie\//, "").split(/[?#]/)[0].replace(/\/+$/, "");
    try { s = decodeURIComponent(s); } catch (_) {}
    if (!s || /[\/\\\x00-\x1f]/.test(s)) throw new Error("DDYS 影片 ID 无效");
    return s;
  }
  card(row) {
    const rating = Number(row.rating);
    const remarks = [row.type || "", rating > 0 ? "评分 " + rating : ""];
    if (typeof row.is_completed === "boolean") remarks.push(row.is_completed ? "已完结" : "连载/待更新");
    return {vod_id:this.slug(row.slug || row.url),vod_name:clean(row.title),vod_pic:String(row.poster || ""),
      vod_remarks:remarks.filter(Boolean).join(" · "),vod_year:String(row.year || ""),vod_area:clean(row.region),
      type_name:clean(row.type),vod_score:rating > 0 ? String(rating) : "",vod_content:clean(row.intro || row.aka || "")};
  }
  paged(j, p) {
    if (!Array.isArray(j.data) || !j.meta || !Number.isFinite(Number(j.meta.total))) throw new Error("DDYS 分页响应缺少 data/meta");
    return {list:j.data.map(r => this.card(r)),page:Number(j.meta.page) || p,
      pagecount:Math.max(1, Number(j.meta.total_pages) || 0),limit:Number(j.meta.per_page) || this.options.page_size,total:Number(j.meta.total)};
  }
  async homeContent(filter) {
    const j = await this.api("/types", 3600000);
    const types = Array.isArray(j.data) && j.data.length ? j.data : TYPES;
    const classes = [{type_id:"all",type_name:"全部"}].concat(types.map(t => ({type_id:String(t.code),type_name:clean(t.name)})));
    const out = {class:classes};
    if (filter) {
      const dictionaries = await Promise.all([this.api("/genres",3600000),this.api("/regions",3600000)]);
      const years = [{n:"全部",v:""}], current = new Date().getFullYear();
      for (let year = current; year >= 1900; year--) years.push({n:String(year),v:String(year)});
      const choice = (key, name, data) => ({key,name,init:"",value:[{n:"全部",v:""}].concat((Array.isArray(data) ? data : []).map(r => ({n:clean(r.name),v:String(r.code)})))});
      const groups = [
        {key:"sort",name:"排序",init:"latest",value:[{n:"最新更新",v:"latest"},{n:"评分",v:"rating"},{n:"近30天热门",v:"popular"}]},
        choice("genre","题材",dictionaries[0].data),choice("region","地区",dictionaries[1].data),{key:"year",name:"年份",init:"",value:years}
      ];
      out.filters = {};
      for (const c of classes) out.filters[c.type_id] = groups;
    }
    return out;
  }
  async homeVideoContent() { const j = await this.api("/movies?" + this.query({sort:"latest",page:1,per_page:this.options ? this.options.page_size : 24})); return {list:j.data.map(r => this.card(r))}; }
  async categoryContent(tid, pg, filter, extend) {
    this.ready();
    const e = object(extend), p = integer(pg, 1, 1, 1000000);
    const q = {type:tid === "all" ? "" : String(tid || ""),genre:e.genre || "",region:e.region || "",year:e.year || "",
      sort:["latest","rating","popular"].indexOf(String(e.sort)) >= 0 ? String(e.sort) : "latest",page:p,per_page:this.options.page_size};
    return this.paged(await this.api("/movies?" + this.query(q)), p);
  }
  async searchContent(key, quick, pg = "1") {
    this.ready();
    const text = String(key || "").trim(), p = integer(pg,1,1,1000000);
    if (!text) return {list:[],page:p,pagecount:1,limit:this.options.page_size,total:0};
    // In /search, type=movie means the entire movie/series/variety/anime catalogue.
    return this.paged(await this.api("/search?" + this.query({q:Array.from(text).slice(0,100).join(""),type:"movie",page:p,per_page:this.options.page_size})),p);
  }
  parseSources(data) {
    const out = [];
    for (const [i, s] of (Array.isArray(data.online) ? data.online : []).entries()) {
      const raw = String(s.url || "").trim();
      const chunks = /^https?:\/\//i.test(raw) ? [raw] : raw.split("#");
      const episodes = [];
      const sourceVersion = versionKey((s.name || "") + " " + (s.quality || ""));
      for (const [index, chunk] of chunks.entries()) {
        const sep = chunk.indexOf("$"), singleUrl = /^https?:\/\//i.test(chunk);
        const url = (singleUrl ? chunk : sep >= 0 ? chunk.slice(sep + 1) : chunk).trim();
        if (!/^https?:\/\//i.test(url)) continue;
        const name = label(!singleUrl && sep >= 0 ? chunk.slice(0,sep) : chunks.length === 1 ? "正片" : "第" + (index + 1) + "集");
        const actualName = name || "第" + (index + 1) + "集";
        episodes.push({name:actualName,key:episodeKey(actualName),version:versionKey(actualName) || sourceVersion,url});
      }
      if (episodes.length) out.push({id:String(s.id == null ? i : s.id),name:label(s.name || "播放源 " + (i + 1)),quality:label(s.quality),format:String(s.format || "").toLowerCase(),episodes});
    }
    return out;
  }
  playId(slug, source, episode) { return "ddys:" + encodeURIComponent(JSON.stringify({v:1,slug,source,label:episode.name,key:episode.key,version:episode.version || ""})); }
  detailVod(row, data) {
    const item = this.card(row), slug = item.vod_id, groups = this.parseSources(data), lines = [], urls = [];
    item.vod_actor = Array.isArray(row.actors) ? row.actors.map(clean).join(" / ") : clean(row.actors);
    item.vod_director = Array.isArray(row.director) ? row.director.map(clean).join(" / ") : clean(row.director);
    item.type_name = [clean(row.type)].concat((row.genres || []).map(g => clean(g.genre_name || g.name))).filter(Boolean).join(" / ");
    const add = (name, source, episodes) => { lines.push(label(name)); urls.push(episodes.map(e => e.name + "$" + this.playId(slug,source,e)).join("#")); };
    if (this.options.auto_fallback && groups.length > 1) {
      const union = [], seen = new Set();
      for (const g of groups) for (const e of g.episodes) {
        const k = e.key + "|" + e.version;
        if (!seen.has(k)) { union.push(e); seen.add(k); }
      }
      add("自动择线（同集同版本匹配）","auto",union);
    }
    for (const g of groups) add(g.name + (g.quality ? " · " + g.quality : ""),g.id,g.episodes);
    item.vod_play_from = lines.join("$$$"); item.vod_play_url = urls.join("$$$");
    const notes = [];
    if (row.aka) notes.push("又名：" + clean(row.aka));
    if (row.warning_tags && row.warning_tags.length) notes.push("站点提示：" + row.warning_tags.map(clean).join(" / "));
    if (item.vod_content) notes.push(item.vod_content);
    if (!groups.length) { notes.push("本站此条目暂无可直接播放的在线源。"); item.vod_remarks = "暂无在线源"; }
    const shares = Array.isArray(data.download) ? data.download : [];
    if (shares.length) {
      notes.push("网盘下载（分享页链接，不是直播放源）：\n" + shares.map(s => [clean(s.name || s.download_type || "网盘"),clean(s.quality),clean(s.size),s.extract_code ? "提取码：" + clean(s.extract_code) : "",String(s.url || "")].filter(Boolean).join(" · ")).join("\n"));
    }
    notes.push("资源由站点聚合；站内 active 不保证链路有效，失效可手动换线。");
    item.vod_content = notes.join("\n\n");
    return item;
  }
  async detailContent(ids) {
    this.ready();
    const list = [];
    for (const id of (Array.isArray(ids) ? ids : [ids])) {
      const slug = this.slug(id), path = "/movies/" + encodeURIComponent(slug);
      const [d,s] = await Promise.all([this.api(path,300000),this.api(path + "/sources",60000)]);
      list.push(this.detailVod(d.data,s.data));
    }
    return {list};
  }
  async mediaRequest(url, binary, range, method = "GET") {
    const headers = this.mediaHeaders();
    if (range && method !== "HEAD") headers.Range = range;
    const perRequest = this.requestBudget(this.options.probe_timeout);
    const r = await this.net.req(url, {method,headers,buffer:binary ? 1 : 0,timeout:perRequest,callTimeout:perRequest});
    const status = Number(r.code);
    if (r.error || status < 200 || status >= 300) throw new Error("媒体 HTTP " + status + (r.error ? " " + String(r.error) : ""));
    return r;
  }
  async probe(url, format, depth = 0) {
    if (depth > 3) throw new Error("HLS 清单嵌套过深");
    if (!/\.m3u8(?:[?#]|$)/i.test(url) && !/m3u8|mpegurl/i.test(format)) return url;
    const r = await this.mediaRequest(url,false,"bytes=0-262143");
    const text = String(r.content || "").replace(/^\uFEFF/, "").trim();
    if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) throw new Error("响应不是 HLS 清单（可能是 HTML 验证/失效页）");
    const rows = text.split(/\r?\n/).map(s => s.trim()), variants = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
      const match = /(?:^|,)BANDWIDTH=(\d+)/.exec(rows[i].slice(rows[i].indexOf(":") + 1));
      let next = i + 1; while (next < rows.length && (!rows[next] || rows[next][0] === "#")) next++;
      if (rows[next]) variants.push({url:resolve(url,rows[next]),bandwidth:match ? Number(match[1]) : 0});
    }
    if (variants.length) {
      variants.sort((a,b) => b.bandwidth - a.bandwidth);
      const failures = [];
      for (const variant of variants) {
        try {
          // Validate at least one child; return the master to preserve its rendition groups.
          await this.probe(variant.url,"m3u8",depth + 1);
          return url;
        } catch (e) { failures.push(String(e.message || e)); }
      }
      throw new Error("主 HLS 清单的画质线路均不可用：" + failures.join("；"));
    }
    const segment = rows.find(s => s && s[0] !== "#");
    if (!segment || text.indexOf("#EXTINF:") < 0) throw new Error("HLS 清单没有可用分片");
    if (this.options.probe_segments) {
      const first = rows.indexOf(segment);
      const keyLine = rows.slice(0,first).filter(s => s.indexOf("#EXT-X-KEY:") === 0).pop() || "";
      if (/METHOD=AES-128(?:,|$)/.test(keyLine)) {
        const key = /URI="([^"]+)"/.exec(keyLine);
        if (!key) throw new Error("HLS AES-128 缺少密钥地址");
        const kr = await this.mediaRequest(resolve(url,key[1]),true,"bytes=0-31");
        if (bytes(kr.content).length !== 16) throw new Error("HLS AES-128 密钥不是16字节");
      }
      let range = "bytes=0-1023";
      const byterange = rows.slice(0,first).filter(s => s.indexOf("#EXT-X-BYTERANGE:") === 0).pop();
      if (byterange) { const m = /:(\d+)(?:@(\d+))?/.exec(byterange); if (m) { const start = Number(m[2] || 0); range = "bytes=" + start + "-" + (start + Math.min(Number(m[1]),1024) - 1); } }
      const sr = await this.mediaRequest(resolve(url,segment),true,range), b = bytes(sr.content);
      if (!b.length) throw new Error("HLS 首分片为空");
      const prefix = Array.from(b).slice(0,32).map(c => String.fromCharCode(c & 255)).join("").trim().toLowerCase();
      if (/^<!doctype|^<html|^<\?xml/.test(prefix)) throw new Error("HLS 首分片返回错误页面");
    }
    return url;
  }
  async checked(url, format) {
    const hit = this.probes.get(url);
    if (hit && hit.until > Date.now()) { if (hit.value.error) throw new Error(hit.value.error); return hit.value.url; }
    try { const value = await this.probe(url,format); this.store(this.probes,url,{url:value},30000,128); return value; }
    catch (e) { this.store(this.probes,url,{error:String(e.message || e)},10000,128); throw e; }
  }
  async playerContent(flag, id, vipFlags) {
    this.ready();
    const previousDeadline = this.deadlineAt;
    this.deadlineAt = Date.now() + 25000;
    try {
      if (String(id).indexOf("ddys:") !== 0) throw new Error("播放 ID 无效，请重新打开影片详情");
      const p = JSON.parse(decodeURIComponent(String(id).slice(5)));
      if (p.v !== 1 || !p.slug || !p.key) throw new Error("播放 ID 版本或集号无效");
      const s = await this.api("/movies/" + encodeURIComponent(this.slug(p.slug)) + "/sources",60000);
      const groups = this.parseSources(s.data), candidates = [];
      for (const g of groups) {
        if (p.source !== "auto" && g.id !== String(p.source)) continue;
        const e = g.episodes.find(item => item.key === p.key);
        if (e) candidates.push({group:g,episode:e});
      }
      if (!candidates.length) throw new Error("站点已无此集/版本，请刷新详情（不会用其他集替代）");
      const errors = [], seen = new Set();
      const requestedVersion = String(p.version || "");
      const matched = requestedVersion ? candidates.filter(c => c.episode.version === requestedVersion) : candidates.filter(c => !c.episode.version);
      for (const c of matched) {
        if (seen.has(c.episode.url)) continue;
        seen.add(c.episode.url);
        try {
          const url = await this.checked(c.episode.url,c.group.format);
          const out = {parse:0,jx:0,playUrl:"",url,header:this.mediaHeaders()};
          if (/\.m3u8(?:[?#]|$)/i.test(url) || /m3u8|mpegurl/i.test(c.group.format)) out.format = "application/x-mpegURL";
          else if (/\.mp4(?:[?#]|$)/i.test(url) || /mp4/i.test(c.group.format)) out.format = "video/mp4";
          return out;
        } catch (e) { errors.push(c.group.name + "：" + String(e.message || e)); }
      }
      throw new Error("此集线路不可用；" + errors.join("；") + "。可切换其他线路或稍后重试。");
    } catch (e) { return {parse:0,jx:0,url:"",msg:"低端影视：" + String(e.message || e)}; }
    finally { this.deadlineAt = previousDeadline; }
  }
  manualVideoCheck() { return false; }
  isVideoFormat(url) { return /\.(m3u8|mp4|mpd|mkv|flv|webm)(?:[?#]|$)/i.test(String(url || "")); }
  destroy() { if (this.cache) this.cache.clear(); if (this.probes) this.probes.clear(); }
}
