// 酷播 kubb.tv (m.kubb.tv) → FongMi/TV (影视 5.8.7) QuickJS spider
// 版本: v1
//
// 关键机制（2026-11-08 实网复刻，见 recon/APIMAP.md）：
//  * 站点是 Angular SPA + ASP.NET Core 后端。所有 API 必须带签名，否则
//    返回 {"code":1,"msg":"用户签名错误"}（HTTP 仍 200）。
//  * 签名（前端 main.js 的 uriSignature()）：
//      vv = md5(PUB + "&" + lower(原始query串) + "&" + PRIV)
//      URL 末尾追加  &vv=<md5 32位小写hex> &pub=<PUB>
//    query 串 = ? 之后的参数按 key=value&key=value 拼接、value 先 URI 解码再把
//    '+' 换成空格，然后**整体转小写**；签名时不含 vv/pub 本身。
//    站点自己还会追加 `&v=1`（appendApiVersion），这个 v=1 参与签名。
//    → 参数顺序敏感：任何顺序变化都必须重算 md5。
//  * PUB/PRIV 是站点公开的静态常量（首页内联 JSON config[0].pConfig）。
//    QuickJS 顶层没有 md5X 导出（md5X 只在 js.eval 沙箱里），所以内嵌纯 JS MD5。
//
//  * 播放地址：v3/video/play?id={剧集key}&a=0
//      - a=0 用「剧集 mediaKey」；a=1 用「作品 videoKey」。传错 → code 1「视频不存在」。
//      - flvPathList[0] 是 20 秒 mp4 试看/广告位（link 指向 ppt.kubb.tv 广告），
//        flvPathList[1] 才是真正的 HLS m3u8。
//      - flvPathList 里 needSign=false，地址可直接播；实测带任意 UA 都能取到 #EXTM3U。
//      - clarity[] 里的 1080/720 标 isVIP=true，但用它的 key 调 play 仍返回同一条
//        576 流 —— 服务端未按清晰度加锁，源里照实列出即可。
//
//  * 剧集列表：v3/video/languagesplaylist?vid={作品key}&cid={videoClassID}&taxis=1
//      - **vid 必须同时带 cid**，只给 vid 返回空数组；给数字 id 会返回全库 2000 条。
//      - playList[] 每项 {id, key, name, isVip, isBought, isLive, updateDate}。
//
//  * 分类/搜索统一用 v2 的 list/Search：
//      list/Search?tags=&page=&size=&orderby=&desc=&cid=  → info[0]={recordcount,result[],maxpage}
//      这条带**真实总数**，用来算 pagecount；v2 的 list/index 不带 total。
//      注意 list/Search 在 offset>6000 时某些页号返回空数组（服务端分页怪癖），
//      见 categoryContent() 里的绕行逻辑。
//
//  依赖：只 import {Spider, page} from "catvod"，零外部依赖、可在 QuickJS-NG 直跑。

import {Spider, page} from "catvod";

const API = "https://m10.kubb.tv";
const RANK = "https://rankv21.kubb.tv";
const UPLOAD = "https://upload.kubb.tv";
const IMG = "https://static.kubb.tv";
const WEB = "https://www.kubb.tv/";
const UA_FALLBACK = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const TIMEOUT = 15000;

// 站点公开常量（首页 https://www.kubb.tv/ 的内联 JSON: config[0].pConfig）
const PUB = "CJSvD34sCpWvCIutCpHVH4LVCc4mCJeqPZWwCMCnDZetDsLZEZenNp4nCcHXDs8pDZbYEJGrC3XYC3OnP3StD3GoDc5ZDZOpNp8nCJHZD3SoOZ4nCJSrCJ9bPZHaD3avDpWpCpDXPMHY";
const PRIV = "SvD3JSvD34sCpWvCIutC";

// 站点一级分类 -> v2 list/*Type 端点。cid 用 pid（父级路径）。
const TYPE_ENDS = [
  ["电影", "0,1,3", "list/FilmType"],
  ["电视剧", "0,1,4", "list/TvType"],
  ["综艺", "0,1,5", "list/VarietyType"],
  ["动漫", "0,1,6", "list/AnimeType"],
  ["纪录片", "0,1,7", "list/DocumentaryType"],
  ["短剧", "0,1,8", "list/CircleType"],
  ["体育", "0,1,95", "list/SportType"],
  ["游戏", "0,1,100", "list/GameType"],
];

// 兜底可播地址用的 banner 分类（每个分类各返回一批带 rtmp 的条目）
const BANNER_CIDS = ["0,1", "0,1,3", "0,1,4", "0,1,5", "0,1,6", "0,1,7"];

// 纯 JS MD5（QuickJS 顶层没有 md5X）。返回 32 位小写 hex。
function md5hex(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else { c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff)); bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  const blen = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLen = blen * 8;
  for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xff);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M.push((bytes[off + i*4] | (bytes[off + i*4+1] << 8) | (bytes[off + i*4+2] << 16) | (bytes[off + i*4+3] << 24)) >>> 0);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7*i) % 16; }
      const tmp = D;
      D = C; C = B;
      B = (B + rotl((A + F + K[i] + M[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hx = (n) => { let s = ""; for (let i = 0; i < 4; i++) s += ((n >>> (8*i)) & 0xff).toString(16).padStart(2, "0"); return s; };
  return hx(a0) + hx(b0) + hx(c0) + hx(d0);
}

export default class Kubb extends Spider {
  // ---------- 基础设施 ----------
  init(extend = "") {
    let o = {};
    if (typeof extend === "string" && extend.trim()) {
      try { o = JSON.parse(extend); } catch (e) { o = {}; }
    } else if (extend && typeof extend === "object") o = extend;
    this.options = {
      api: String(o.api || API),
      rank: String(o.rank || RANK),
      upload: String(o.upload || UPLOAD),
      img: String(o.img || IMG),
      web: String(o.web || WEB),
      page_size: Math.max(1, Number(o.page_size) || 20),
      include_ad: o.include_ad === true,   // 是否把 20s 试看 mp4 也列成线路
    };
    this.md5 = md5hex;
    this._md5hex = md5hex;
  }

  headers() {
    return {
      "User-Agent": this.net.getUserAgent() || UA_FALLBACK,
      "Referer": this.options.web,
      "Origin": "https://www.kubb.tv",
      "Accept": "application/json, text/plain, */*",
    };
  }

  // 复刻前端 get_query()：? 之后的原始 query，value 先 URI 解码再 '+'→空格
  rawQuery(path) {
    const i = path.indexOf("?");
    if (i < 0) return "";
    let q = path.slice(i + 1);
    const h = q.indexOf("#");
    if (h >= 0) q = q.slice(0, h);
    const out = [];
    for (const part of q.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = eq < 0 ? part : part.slice(0, eq);
      let v = eq < 0 ? "" : part.slice(eq + 1);
      try { v = decodeURIComponent(v); } catch (e) { /* 原样 */ }
      v = v.replace(/\+/g, " ");
      out.push(k + "=" + v);
    }
    return out.join("&");
  }

  // 生成签名 URL
  sign(path) {
    const q = this.rawQuery(path).toLowerCase();
    const vv = md5hex(PUB + "&" + q + "&" + PRIV);
    return this.options.api + path + (path.indexOf("?") >= 0 ? "&" : "?") + "vv=" + vv + "&pub=" + PUB;
  }

  parseBody(r) {
    if (r.error) throw new Error("HTTP 请求失败: " + r.error);
    if (r.code < 200 || r.code >= 300) throw new Error("HTTP " + r.code);
    let text;
    const c = r.content;
    if (typeof c === "string") text = c;
    else if (c instanceof ArrayBuffer) text = new TextDecoder("utf-8").decode(new Uint8Array(c));
    else if (Array.isArray(c)) text = String.fromCharCode.apply(null, c);
    else text = String(c || "");
    return JSON.parse(text);
  }

  // 统一 GET（走签名）。host 可选换主机（搜索走 rankv21）。
  async api(path, host) {
    const opts = {headers: this.headers(), timeout: TIMEOUT, callTimeout: TIMEOUT};
    let url;
    if (host === "rank") {
      const q = this.rawQuery(path).toLowerCase();
      const vv = md5hex(PUB + "&" + q + "&" + PRIV);
      url = this.options.rank + path + (path.indexOf("?") >= 0 ? "&" : "?") + "vv=" + vv + "&pub=" + PUB;
    } else {
      url = this.sign(path);
    }
    const r = await this.net.req(url, opts);
    const j = this.parseBody(r);
    if (j.data && j.data.code !== 0) {
      const msg = j.data.msg || ("code " + j.data.code);
      const e = new Error("API: " + msg);
      e.code = j.data.code;
      e.msg = msg;
      throw e;
    }
    const info = j.data ? j.data.info : j.info;
    return {info: info, data: j.data};
  }

  // v2 list/*Type / list/index / list/Search 都在 /api 下；v3 端点在 /v3 下
  async apiV2(path) { return await this.api(path); }
  async apiV3(path) { return await this.api(path); }

  // ---------- 卡片 ----------
  pic(row) {
    const p = String(row.image || row.imgPath || row.imgpath_list || "").trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    return this.options.img.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
  }

  card(row) {
    const remarks = [];
    if (row.lastName) remarks.push(String(row.lastName));
    if (row.vipResource) remarks.push(String(row.vipResource));
    const item = {
      vod_id: String(row.key || row.id || ""),
      vod_name: String(row.title || row.name || ""),
      vod_pic: this.pic(row),
      vod_remarks: remarks.join(" · "),
      vod_year: String(row.year || row.post_Year || ""),
      vod_area: String(row.regional || ""),
      vod_actor: String(row.starring || ""),
      vod_director: String(row.directed || ""),
      vod_content: String(row.contxt || row.shortDes || ""),
      type_name: String(row.atypeName || ""),
    };
    return item;
  }

  // ---------- 首页 / 分类 ----------
  async homeContent(filter) {
    // 分类权威来源：v3/list/mainMenuv2?cid=0,1 → 8 个一级（category 字段即 cid）。
    // 兜底：v2 list/AllVideoType?cid=0,1 → 6 个（不含短剧/游戏），再补静态表。
    let classes = [{type_id: "0", type_name: "全部"}];
    try {
      const {info} = await this.apiV3("/v3/list/mainMenuv2?cid=0,1&v=1");
      const rows = Array.isArray(info) ? info : [];
      if (rows.length) {
        classes = [{type_id: "0", type_name: "全部"}];
        const seen = {};
        for (const r of rows) {
          // 只接受真正的 videoClassID（形如 0,1,X）；mainMenuv2 里混了
          // chinese/discovery/news/... 这类非分类 slug，以及 category 为空的入口项。
          const cid = String(r.category || "");
          if (!/^0,1(,\d+)?$/.test(cid)) continue;
          if (seen[cid]) continue;
          seen[cid] = 1;
          classes.push({type_id: cid, type_name: String(r.label || "")});
        }
      }
    } catch (e) { /* 走兜底 */ }
    if (classes.length <= 1) {
      classes = [{type_id: "0", type_name: "全部"}];
      for (const [name, cid] of TYPE_ENDS) classes.push({type_id: cid, type_name: name});
    }
    // 直播分类（cid 0,1,111）：站内只有 4 条录播式直播条目，
    // 但它们在 API 里就是普通视频条目 → 同时作为普通分类暴露，比只走 liveContent 稳。
    classes.push({type_id: "0,1,111", type_name: "直播"});
    const result = {class: classes};
    if (filter) {
      const sort = {key: "orderby", name: "排序", init: "4", value: [
        {n: "最新", v: "4"},
        {n: "最热", v: "1"},
        {n: "评分", v: "0"},
      ]};
      result.filters = {};
      for (const c of classes) result.filters[c.type_id] = [sort];
      // 子类筛选：v2 list/AllVideoType 是「按父路径取子节点」的树查询，
      //   cid=0,1 → 6 个一级；cid=0,1,3 → 18 个电影子类 …… 逐层下钻。
      // 逐个一级分类取它的子类，作为 filter 的第二组。
      for (const c of classes) {
        if (c.type_id === "0" || c.type_id === "0,1,111") continue;
        try {
          const {info} = await this.apiV2("/api/list/AllVideoType?cid=" + encodeURIComponent(c.type_id) + "&v=1");
          const rows = Array.isArray(info) ? info : [];
          const values = [];
          for (const r of rows) {
            if (!r || !r.path || !r.className) continue;
            // 跳过成人版块
            if (String(r.path).indexOf("0,2") === 0) continue;
            values.push({n: String(r.className), v: String(r.path)});
          }
          if (values.length) {
            result.filters[c.type_id] = [sort, {key: "category", name: "子分类", init: "", value: values}];
          }
        } catch (e) { /* 子类取不到就只保留排序 */ }
      }
    }
    return result;
  }

  async homeVideoContent() {
    try {
      const {info} = await this.apiV3("/v3/home/getAllVideo?set=1&size=13");
      const d = Array.isArray(info) ? (info[0] || {}) : {};
      const out = [];
      const push = (arr) => { for (const r of (arr || [])) out.push(this.card(r)); };
      push(d.filmList);
      push(d.tvList);
      push(d.varietyList);
      push(d.animeList);
      push(d.documentaryList);
      push(d.sportList);
      push(d.shortList);
      return {list: out};
    } catch (e) {
      return {list: []};
    }
  }

  // 分类列表：v2 list/Search（带 recordcount，能算真 pagecount）
  // 子类筛选直接换 cid 传给服务端（子类 path 形如 0,1,3,19），
  // 这样 recordcount / 分页都是该子类的真实值（实测 cid=0,1,3,19 → 2381 条）。
  async categoryContent(tid, pg, filter, extend) {
    const p = Math.max(1, Number(pg) || 1);
    const size = this.options.page_size;
    const ext = extend || {};
    const orderby = String(ext.orderby || "4");
    const sub = String(ext.category || "");
    const cid = sub || String(tid || "0");
    const q = this.searchQuery("", p, size, orderby, cid, ext);
    try {
      const {info} = await this.apiV2(q);
      const rec = Array.isArray(info) ? (info[0] || {}) : {};
      const rows = Array.isArray(rec.result) ? rec.result : [];
      const total = Number(rec.recordcount) || 0;
      // 服务端分页怪癖：某些 (page,size) 组合返回空数组（offset>6000 附近）。
      // 命中空页时改用 v2 list/index（同 cid/orderby 语义）兜底。
      if (!rows.length && p > 1) {
        const alt = await this.indexQuery(p, size, cid, orderby);
        if (alt.length) return this.paged(alt, p, size, total);
      }
      return this.paged(rows, p, size, total);
    } catch (e) {
      try {
        const alt = await this.indexQuery(p, size, cid, orderby);
        return this.paged(alt, p, size, 0);
      } catch (e2) {
        return {list: [], page: p, pagecount: 1, limit: size};
      }
    }
  }

  paged(rows, p, size, total) {
    const list = rows.map((r) => this.card(r));
    const totalN = total || list.length;
    const pagecount = totalN > 0 ? Math.max(1, Math.ceil(totalN / size)) : (list.length >= size ? p + 1 : p);
    return {list, page: p, pagecount, limit: size, total: totalN};
  }

  searchQuery(kw, p, size, orderby, cid, ext) {
    const e = ext || {};
    const parts = [
      "tags=" + encodeURIComponent(String(kw || "")),
      "star=",
      "director=",
      "orderby=" + encodeURIComponent(String(orderby || "4")),
      "desc=0",
      "page=" + p,
      "size=" + size,
      "cid=" + encodeURIComponent(String(cid || "")),
      "year=" + encodeURIComponent(String(e.year || "")),
      "language=" + encodeURIComponent(String(e.language || "")),
      "region=" + encodeURIComponent(String(e.region || "")),
      "vipResource=" + encodeURIComponent(String(e.vipResource || "")),
      "isSerial=" + encodeURIComponent(String(e.isSerial != null && e.isSerial !== "" ? e.isSerial : "-1")),
      "istitle=0",
      "v=1",
    ];
    return "/api/list/Search?" + parts.join("&");
  }

  // v2 list/index：与 list/Search 同数据源，但不受分页怪癖影响；无 total。
  indexQuery(p, size, cid, orderby) {
    const isn = String(orderby === "1" ? 4 : (orderby === "0" ? 4 : (orderby === "4" ? 0 : 0)));
    return "/api/list/index?page=" + p + "&cid=" + encodeURIComponent(String(cid || "0"))
      + "&size=" + size + "&isn=" + isn + "&isfree=-1&v=1";
  }

  // ---------- 搜索 ----------
  // 两条搜索端点语料不同（实测）：
  //   list/Search      —— 匹配标题/标签，rc 较小（"电影" 92、"战神" 22）
  //   rankv21 briefsearch —— 全文检索，rc 更大（"电影" 123、"战神" 26、"动漫" 43970）
  // 两条都跑一遍并合并去重，召回更全；总数取两者较大值算 pagecount。
  async searchContent(key, quick, pg = "1") {
    const kw = String(key || "").trim();
    const p = Math.max(1, Number(pg) || 1);
    const size = this.options.page_size;
    if (!kw) return {list: [], page: p, pagecount: 1, limit: size};
    const seen = {};
    const rows = [];
    let total = 0;
    const collect = (arr) => {
      for (const r of (arr || [])) {
        const k = String(r.key || "");
        if (!k || seen[k]) continue;
        seen[k] = 1;
        rows.push(r);
      }
    };
    // v2 list/Search
    try {
      const {info} = await this.apiV2(this.searchQuery(kw, p, size, "4", "", {}));
      const rec = Array.isArray(info) ? (info[0] || {}) : {};
      collect(rec.result);
      total = Math.max(total, Number(rec.recordcount) || 0);
    } catch (e) { /* 换另一条 */ }
    // v3 rankv21 briefsearch（全文索引，召回更高）
    try {
      const q = this.searchQuery(kw, p, size, "4", "", {});
      const v3 = q.replace("/api/list/Search?", "/v3/list/briefsearch?")
        .replace("&isSerial=", "&isserial=").replace("&istitle=0", "&istitle=0");
      const {info} = await this.api(v3, "rank");
      const rec = Array.isArray(info) ? (info[0] || {}) : {};
      collect(rec.result);
      total = Math.max(total, Number(rec.recordcount) || 0);
    } catch (e) { /* 忽略 */ }
    return {list: rows.map((r) => this.card(r)), page: p,
      pagecount: Math.max(1, Math.ceil(total / size)), limit: size, total};
  }

  // ---------- 详情 ----------
  async fetchDetail(key) {
    const {info} = await this.apiV3("/v3/video/detail?ispath=false&cinema=1&device=1&player=CkPlayer"
      + "&tech=HLS&country=HU&lang=cns&v=1&id=" + encodeURIComponent(String(key)) + "&region=GL.");
    const d = Array.isArray(info) ? (info[0] || null) : (info || null);
    if (!d) throw new Error("detail 为空: " + key);
    return d;
  }

  async fetchEpisodes(key, cid) {
    const q = "/v3/video/languagesplaylist?vid=" + encodeURIComponent(String(key))
      + "&cid=" + encodeURIComponent(String(cid || "")) + "&taxis=1&v=1";
    const {info} = await this.apiV3(q);
    const d = Array.isArray(info) ? (info[0] || null) : null;
    return (d && Array.isArray(d.playList)) ? d.playList : [];
  }

  detailVod(d, eps) {
    const item = this.card({
      key: d.key, title: d.title, image: d.imgPath, year: d.post_Year, regional: d.regional,
      starring: Array.isArray(d.stars) ? d.stars.join(",") : "",
      directed: Array.isArray(d.directors) ? d.directors.join(",") : "",
      contxt: d.contxt, atypeName: d.channel, lastName: d.lastName, vipResource: d.vipResource,
    });
    // TV 宿主的 Flag.setEpisodes() 按 "$" 切：<剧集名>$<播放id>，多个剧集用 "#" 分隔。
    // 必须是「名字$url」成对出现 —— 只给名字不给 url，宿主会把名字当播放 id 传给
    // playerContent（表现为「API: 视频不存在」）。
    const eps2 = [];
    for (let i = 0; i < eps.length; i++) {
      const e = eps[i];
      // 站点的单片电影把「清晰度」当剧集名（"576P"/"1080P"），不是集号。
      // 宿主按序号显示（01/02…），这里统一成序号，只有真正的多集剧才用站点名。
      const raw = String(e.name || "");
      const isQuality = /^\d{3,4}P$/i.test(raw);
      const label = isQuality ? String(i + 1).padStart(2, "0") : raw;
      const flag = e.isVip ? "[VIP]" : "";
      eps2.push((label || String(i + 1).padStart(2, "0")) + flag + "$" + this.enc(d.key + "|" + e.key));
    }
    item.vod_play_from = "酷播";
    item.vod_play_url = eps2.join("#");
    return item;
  }

  async detailContent(ids) {
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : [ids])) {
      try {
        const d = await this.fetchDetail(id);
        let eps = [];
        try { eps = await this.fetchEpisodes(d.key, d.cid); } catch (e) { eps = []; }
        out.push(this.detailVod(d, eps));
      } catch (e) { /* 单片失败不拖垮整批 */ }
    }
    return {list: out};
  }

  // ---------- 播放 ----------
  enc(v) { return encodeURIComponent(String(v)); }
  dec(v) { try { return decodeURIComponent(String(v)); } catch (e) { return String(v); } }

  // video/play 端点有严格限流（实测 code 5「访问过量」，其它端点正常）。
  // 所以：① 按需取（只在 playerContent 时请求）② 同一 mediaKey 做 TTL 缓存
  // ③ 命中限流时给上一次缓存兜底，避免直接失败。
  playCache() {
    if (!this._playCache) this._playCache = new Map();
    return this._playCache;
  }

  async fetchPlay(id, a) {
    const key = a + "|" + id;
    const cache = this.playCache();
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && hit.until > now) return hit.value;
    // cinema=1 必须带（前端注册表默认值），少了会报「参数错误」。
    const path = "/v3/video/play?cinema=1&id=" + encodeURIComponent(String(id))
      + "&a=" + a + "&lang=cns&usersign=1&region=GL.&device=1&v=1";
    const {info} = await this.apiV3(path);
    const d = Array.isArray(info) ? (info[0] || null) : null;
    if (!d) throw new Error("play 无数据");
    cache.set(key, {value: d, until: now + 30000});
    return d;
  }

  // 兜底可播地址：home/getflashbanner 的 rtmp 字段是逐条目真实分配的可播 m3u8，
  // 完全不过 video/play（因此不受其限流影响）。
  // 实测：每个一级分类各返回 ~10 条，各自带一个互不相同的 rtmp；
  // 累计 40 个可播条目（cid=0,1 → 9 条、0,1,3 → +6、0,1,4 → +6、0,1,5 → +9、0,1,6 → +10 …）。
  // curl 裸 UA 取回 #EXTM3U + 3 个分片，分片可下到 2.6MB 有效字节。
  // **只做精确匹配**：banner 的 rtmp 就是该条目自己的流，配错会播成别的内容。
  async bannerUrl(videoKey) {
    if (!videoKey) return "";
    if (!this._bannerMap) this._bannerMap = new Map();
    const map = this._bannerMap;
    if (map.has(videoKey)) return map.get(videoKey);
    try {
      for (const cid of BANNER_CIDS) {
        const {info} = await this.apiV3("/v3/home/getflashbanner?cid=" + encodeURIComponent(cid) + "&size=100&v=1");
        for (const r of (Array.isArray(info) ? info : [])) {
          if (!r || !r.listPath || !r.rtmp) continue;
          if (!map.has(String(r.listPath))) map.set(String(r.listPath), String(r.rtmp));
        }
      }
    } catch (e) { /* ignore */ }
    return map.has(videoKey) ? map.get(videoKey) : "";
  }

  // 去掉播放地址里的 us=1 参数。
  //
  // 关键坑（2026-11-08 实网复刻）：站点下发的 HLS 地址带 `us=1`，**带 us 的分片
  // 会被 CDN 边缘直接 TCP reset**（curl: (56) Recv failure，0 字节，25ms 内断开），
  // 表现为「一开始几百 KB/s → 两位数 → 个位数 → 连接超时」。
  // 去掉 us 后同一路径直接 200，分片 0.7–1.8 MB，8–23 MB/s，TS 同步字节 0x47 正常。
  //   原样: https://hss111.pipecdn.vip/ppotb62-<asset>/media_0.ts?...&us=1  → reset
  //   去us: https://hss111.pipecdn.vip/ppotb62-<asset>/media_0.ts?...        → 200
  // 而且 master 本身带 us 时，它列出的分片也带 us → 必须连 master 一起去掉，
  // 这样 master 列出的分片 URL 天然就不含 us，播放器照读即可。
  //
  // 与 Referer / Origin / Range / UA / HTTP 版本 / IPv4-IPv6 都无关；换其它 hssN 主机
  // 同样 reset（该 asset 只存在于 hss111，换主机是 404 而非 reset）。
  stripUs(url) {
    const s = String(url || "");
    if (!s || s.indexOf("?") < 0) return s;
    const i = s.indexOf("?");
    const base = s.slice(0, i);
    const q = s.slice(i + 1);
    const parts = [];
    for (const kv of q.split("&")) {
      if (!kv) continue;
      const eq = kv.indexOf("=");
      const k = eq < 0 ? kv : kv.slice(0, eq);
      if (k === "us") continue;
      parts.push(kv);
    }
    return base + "?" + parts.join("&");
  }

  async playerContent(flag, id, vipFlags) {
    const raw = this.dec(id);
    const parts = String(raw).split("|");
    const epKey = parts.length > 1 ? parts[1] : parts[0];
    const videoKey = parts.length > 1 ? parts[0] : "";
    const header = {"User-Agent": this.net.getUserAgent() || UA_FALLBACK, "Referer": this.options.web};
    const errors = [];
    // a=0 用剧集 mediaKey；万一站点把它当作品 key 收（code 1「视频不存在」），再试 a=1。
    for (const attempt of [[epKey, 0], [epKey, 1], [videoKey, 1], [videoKey, 0]]) {
      const [k, a] = attempt;
      if (!k) continue;
      try {
        const d = await this.fetchPlay(k, a);
        const flvs = Array.isArray(d.flvPathList) ? d.flvPathList : [];
        const hls = flvs.filter((x) => x && x.isHls && x.result);
        const mp4 = flvs.filter((x) => x && !x.isHls && x.result && x.duration > 0);
        let url = "";
        if (hls.length) url = this.stripUs(hls[0].result);
        else if (mp4.length) url = this.stripUs(mp4[0].result);
        if (url) {
          return {
            parse: 0, jx: 0, url,
            header,
            format: /\.m3u8(\?|$)/i.test(url) ? "application/x-mpegURL" : "video/mp4",
          };
        }
        errors.push("无可用播放地址");
      } catch (e) {
        errors.push(String(e && e.message || e));
      }
    }
    // 限流兜底 1：用缓存里过期的地址（30s TTL 已过但内容仍可能有效）
    const cache = this.playCache();
    for (const ck of ["0|" + epKey, "1|" + epKey, "1|" + videoKey]) {
      const hit = cache.get(ck);
      if (hit && hit.value) {
        const flvs = Array.isArray(hit.value.flvPathList) ? hit.value.flvPathList : [];
        const hls = flvs.filter((x) => x && x.isHls && x.result);
        if (hls.length) {
          return {parse: 0, jx: 0, url: this.stripUs(hls[0].result), header, format: "application/x-mpegURL"};
        }
      }
    }
    // 限流兜底 2：走 banner 的 rtmp（不经过 video/play，不受限流影响）
    try {
      const alt = await this.bannerUrl(videoKey || epKey);
      if (alt) return {parse: 0, jx: 0, url: this.stripUs(alt), header, format: "application/x-mpegURL"};
    } catch (e2) { /* ignore */ }
    return {parse: 0, jx: 0, url: "", msg: errors[0] || "无法解析播放地址"};
  }

  manualVideoCheck() { return true; }
  isVideoFormat(url) { return /\.(m3u8|mp4|mpd|flv|mkv)(\?|$)/i.test(String(url || "")); }

  // ---------- 直播 ----------
  // kubb.tv 的「直播」是站内 cid 0,1,111 的**录播式直播条目**（实测只有 4 条：
  // 央视春晚 / CCTV 九三军演 / 24小时直播 / 2025蛇年春晚直播），**没有 IPTV 频道表**。
  // 后端为 IPTV 准备的 Home/GetTVLiveList 恒返回空数组（死路）。
  // 每条只有 1 个剧集 / 1 条线路，拆不成多频道。
  // 播放地址 vhash/vendtime 是服务端签名会过期 → liveContent 里实时解析一次；
  // 但 video/play 有独立限流，解析失败时退化为空 urls（不抛错，让 App 仍能显示频道）。
  async liveContent(url) {
    if (url && /^https?:\/\//i.test(url)) return url;
    const groups = {};
    try {
      const {info} = await this.apiV3("/v3/Home/GetLiveList?pageindex=1&pagesize=24&v=1");
      const rows = Array.isArray(info) ? info : [];
      for (const r of rows) {
        const key = String(r.key || "");
        const title = String(r.title || "直播");
        if (!key) continue;
        // 直播判定看 cid 字段（GetLiveList 的 videoClassID 全是 null）
        const cid = String(r.cid || "");
        const gname = cid.indexOf("0,1,111") === 0 ? "电视直播" : "直播";
        if (!groups[gname]) groups[gname] = {name: gname, channel: []};
        const chans = [];
        try {
          const eps = await this.fetchEpisodes(key, cid);
          for (const e of eps) {
            let u = "";
            try { u = await this.liveUrl(e.key); } catch (err) { u = ""; }
            chans.push({name: String(e.name || title), urls: u ? [u] : []});
          }
        } catch (e) { /* 单条失败不拖垮整组 */ }
        if (!chans.length) chans.push({name: title, urls: []});
        groups[gname].channel.push(...chans);
      }
    } catch (e) {
      return [];
    }
    return Object.keys(groups).map((k) => groups[k]);
  }

  // 直播条目：作品 key 用 a=1（实测 a=0 对直播条目返回「参数错误」）
  async liveUrl(videoKey) {
    try {
      const d = await this.fetchPlay(videoKey, 1);
      const flvs = Array.isArray(d.flvPathList) ? d.flvPathList : [];
      const hls = flvs.filter((x) => x && x.isHls && x.result);
      if (hls.length) return hls[0].result;
      const mp4 = flvs.filter((x) => x && !x.isHls && x.result);
      return mp4.length ? mp4[0].result : "";
    } catch (e) {
      return "";
    }
  }
}
