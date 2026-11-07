// 欧乐影院 (olevod.com / api.olelive.com) → FongMi/TV (OK影视) QuickJS spider
// 版本: v2  —  修复直播：去掉逐频道 live/info、分组并发，避免宿主 30s TIMEOUT_LIVE
//
// 关键机制（2026-11-07 实网复刻，见 recon/PROTOCOL.md）：
//  * 站内 axios 拦截器会本地算 encryptVV(ts) 当 _vv，但服务端对**绝大多数**
//    端点不认这个值，一律 401「用户签名错误」。
//  * 真正可用的签名是 POST /pub/user/play/token（body {}）返回的 32 位 hex，
//    把它当作 _vv 参数加到任意 GET 即全绿。匿名可取，无需登录。
//  * 响应当前是明文 {code:0,data:...}（AES 已关）；/pub/tv/vod/url 与
//    /pub/user/play/token 两个端点响应拦截器直接放行，不走解密。
//  * 播放地址：/v1/pub/vod/detail/{id}/true 匿名直出 urls[].url（普通线）
//    与 urls[].vip_urls[].url（VIP 高清线）。VIP 判定纯前端
//    isVip = (userInfo.groupId == 3)，只是盖一层遮罩，服务端并未拦截。
//    本 spider 把 VIP 线路作为独立「线路」列出 —— 这就是绕过会员的方式。
//
// 依赖：只 import {Spider, page} from "catvod"，不加载 WASM、不内嵌 MD5
//（_vv 走服务端下发，纯 JS 无需 crypto），可在 QuickJS-NG 0.18 直接跑。

import {Spider, page} from "catvod";

const API = "https://api.olelive.com";
const IMG = "https://static.olelive.com";
const WEB = "https://www.olevod.com/";
const UA_FALLBACK = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const TIMEOUT = 15000;
const VV_TTL = 60000;          // play-token 缓存 60s，401 时自动重取

// navs.top 的 8 个入口；type=vod 的做点播分类，type=live 的不进点播列表
const FALLBACK_CLASSES = [
  {type_id: "0",  type_name: "全部"},
  {type_id: "1",  type_name: "电影"},
  {type_id: "2",  type_name: "连续剧"},
  {type_id: "3",  type_name: "综艺"},
  {type_id: "4",  type_name: "动漫"},
  {type_id: "14", type_name: "短剧"},
  {type_id: "6",  type_name: "VIP蓝光影院"},
];

// 纯 JS MD5（QuickJS 无顶层 md5X；Web Crypto 也不含 MD5，故内嵌）。
// 返回 32 位小写 hex。仅用于 signVV() 回退路径；正常请求走 play/token，不依赖它。
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

export default class Olevod extends Spider {
  // ---------- 基础设施 ----------
  init(extend = "") {
    let o = {};
    if (typeof extend === "string" && extend.trim()) {
      try { o = JSON.parse(extend); } catch (e) { o = {}; }
    } else if (extend && typeof extend === "object") o = extend;
    this.options = {
      api: String(o.api || API),
      img: String(o.img || IMG),
      web: String(o.web || WEB),
      include_vip: o.include_vip !== false,   // 默认把 VIP 线路列出来
      token: String(o.token || ""),           // 可选：自有会员 token 三段 a.b.c
      page_size: Math.max(1, Number(o.page_size) || 12),
    };
    // 兼容测试脚手架与旧版宿主
    this.md5 = md5hex;
    this._md5hex = md5hex;
  }

  headers() {
    return {
      "User-Agent": this.net.getUserAgent() || UA_FALLBACK,
      "Referer": this.options.web,
      "Origin": this.options.web.replace(/\/+$/, ""),
      "Accept": "application/json, text/plain, */*",
    };
  }

  // 供离线测试/诊断：本地 encryptVV 复刻（实际请求不用它，_vv 走 play/token）
  signVV(ts) {
    const n = String(ts), a = ["", "", "", ""];
    for (let i = 0; i < n.length; i++) {
      const b = n.charCodeAt(i).toString(2);
      a[0] += b.slice(2, 3); a[1] += b.slice(3, 4);
      a[2] += b.slice(4, 5); a[3] += b.slice(5);
    }
    const l = a.map((x) => {
      let E = parseInt(x, 2).toString(16);
      if (E.length === 2) E = "0" + E;
      else if (E.length === 1) E = "00" + E;
      else if (E.length === 0) E = "000";
      return E;
    });
    const u = md5hex(n);
    return u.slice(0, 3) + l[0] + u.slice(6, 11) + l[1] + u.slice(14, 19) + l[2] + u.slice(22, 27) + l[3] + u.slice(30);
  }

  // _vv：主用服务端 play-token（POST /pub/user/play/token，匿名可取，最稳）；
  // 该端点万一挂了，回退到本地 encryptVV(ts)（站点原生算法，7 向量对拍通过）。
  // 带 60s 缓存；api() 遇 401 会 force 重取。
  async vv(force) {
    if (force) this.net.clearCache("olevod:vv");
    return await this.net.cached("olevod:vv", {ttl: VV_TTL, stale: false}, async () => {
      try {
        const r = await this.net.req(this.options.api + "/pub/user/play/token", {
          method: "POST",
          postType: "json",
          data: {},
          headers: {...this.headers(), "Content-Type": "application/json"},
          timeout: TIMEOUT, callTimeout: TIMEOUT,
        });
        const j = this.parseBody(r);
        if (j.code === 0 && j.data) return String(j.data);
      } catch (e) { /* 回退本地签名 */ }
      return this.signVV(Math.floor(Date.now() / 1000));
    });
  }

  parseBody(r) {
    if (r.error) throw new Error("HTTP 请求失败: " + r.error);
    if (r.code < 200 || r.code >= 300) throw new Error("HTTP " + r.code);
    const c = r.content;
    let text;
    if (typeof c === "string") text = c;
    else if (c instanceof ArrayBuffer) text = new TextDecoder("utf-8").decode(new Uint8Array(c));
    else if (Array.isArray(c)) text = String.fromCharCode(...c);
    else text = String(c || "");
    return JSON.parse(text);
  }

  // 统一 GET；401 自动重取 token 重试一次
  async api(path, params) {
    const build = (t) => {
      let url = this.options.api + path;
      url += (path.indexOf("?") >= 0 ? "&" : "?") + "_vv=" + encodeURIComponent(t);
      const tk = this.options.token.split(".");
      if (tk.length === 3) url += "&_he=" + encodeURIComponent(tk[0]) + "&_pl=" + encodeURIComponent(tk[1]) + "&_si=" + encodeURIComponent(tk[2]);
      if (params) url += "&" + params;
      return url;
    };
    const opts = {headers: this.headers(), timeout: TIMEOUT, callTimeout: TIMEOUT};
    let r = await this.net.req(build(await this.vv()), opts);
    if (r.code === 401) r = await this.net.req(build(await this.vv(true)), opts);
    const j = this.parseBody(r);
    // 站点业务码：0 正常；7 取不到数据；12/13/14 需要登录
    if (j.code !== 0) throw new Error("API " + j.code + ": " + (j.msg || ""));
    return j.data;
  }

  // ---------- 卡片 / 工具 ----------
  pic(row) {
    const p = String(row.pic || row.picThumb || row.icon || "").trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    return this.options.img.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
  }

  card(row) {
    const item = {
      vod_id: String(row.id),
      vod_name: String(row.name || row.title || ""),
      vod_pic: this.pic(row),
      vod_remarks: String(row.remarks || row.version || row.currentTitle || ""),
      vod_year: String(row.year || ""),
    };
    if (row.vip === true) item.vod_remarks = (item.vod_remarks ? item.vod_remarks + " · " : "") + "VIP";
    return item;
  }

  parseId(v) {
    return String(v).replace(/^vod\//, "").split("/")[0];
  }

  enc(url) { return encodeURIComponent(String(url)); }
  dec(v) { try { return decodeURIComponent(String(v)); } catch (e) { return String(v); } }

  cleanLabel(s) {
    return String(s == null ? "" : s).replace(/\$/g, "＄").replace(/#/g, "＃").trim();
  }

  // ---------- 首页 / 分类 ----------
  async homeContent(filter) {
    let classes = FALLBACK_CLASSES;
    try {
      const d = await this.api("/v1/pub/vod/list/type");
      if (Array.isArray(d) && d.length) {
        classes = [{type_id: "0", type_name: "全部"}].concat(
          d.filter((x) => String(x.typeEn || "") !== "chengren").map((x) => ({
            type_id: String(x.typeId1 != null ? x.typeId1 : x.typeId),
            type_name: String(x.typeName || ""),
          }))
        );
        // 去重（多个子分类共享 typeId1）
        const seen = {};
        classes = classes.filter((c) => (seen[c.type_id] ? false : (seen[c.type_id] = 1)));
      }
    } catch (e) { /* 用兜底分类 */ }
    const result = {class: classes};
    if (filter) {
      const f = {sort: {key: "sort", name: "排序", init: "time", value: [
        {n: "最新", v: "time"}, {n: "最热", v: "hits"}, {n: "评分", v: "score"},
      ]}};
      result.filters = {};
      for (const c of classes) result.filters[c.type_id] = [f.sort];
    }
    return result;
  }

  async homeVideoContent() {
    try {
      const d = await this.api("/v1/pub/vod/newest/1/20");
      const list = Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : []);
      return {list: list.map((r) => this.card(r))};
    } catch (e) { return {list: []}; }
  }

  // 分类用 /v1/pub/index/vod/data/list/{typeId1}/{limit}（返回干净数组）
  async categoryContent(tid, pg, filter, extend) {
    const p = Math.max(1, Number(pg) || 1);
    const size = this.options.page_size;
    try {
      const d = await this.api("/v1/pub/index/vod/data/list/" + encodeURIComponent(String(tid)) + "/" + (p * size));
      const rows = Array.isArray(d) ? d : [];
      return page(rows.map((r) => this.card(r)), p, size);
    } catch (e) { return {list: [], page: p, pagecount: 1, limit: size}; }
  }

  // ---------- 搜索 ----------
  // 实测: /v1/pub/index/search/{kw}/{a}/{b}/{page}/{limit}，结果在
  // data.data[] 里 type=vod 那组的 list[]
  async searchContent(key, quick, pg = "1") {
    const kw = String(key || "").trim();
    const p = Math.max(1, Number(pg) || 1);
    const size = this.options.page_size;
    if (!kw) return {list: [], page: p, pagecount: 1, limit: size};
    try {
      const d = await this.api("/v1/pub/index/search/" + encodeURIComponent(kw) + "/1/0/" + p + "/" + size);
      const groups = d && Array.isArray(d.data) ? d.data : [];
      const vod = groups.find((g) => g && g.type === "vod");
      const rows = vod && Array.isArray(vod.list) ? vod.list : [];
      const total = Number(d && d.total) || rows.length;
      return {list: rows.map((r) => this.card(r)), page: p,
        pagecount: Math.max(1, Math.ceil(total / size)), limit: size, total};
    } catch (e) { return {list: [], page: p, pagecount: 1, limit: size}; }
  }

  // ---------- 详情（含 VIP 线路） ----------
  // detail:/true 匿名直出 urls[].url + urls[].vip_urls[].url
  // /false 会把 url 置空 —— 第二个参数是「是否返回播放地址」开关，不是 VIP 开关
  async fetchDetail(id) {
    return await this.api("/v1/pub/vod/detail/" + encodeURIComponent(this.parseId(id)) + "/true");
  }

  lines(detail) {
    const urls = Array.isArray(detail.urls) ? detail.urls : [];
    const normal = [], vip = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i] || {};
      const label = this.cleanLabel(u.title || ("第" + (u.index || i + 1) + "集"));
      if (u.url) normal.push(label + "$" + this.enc(u.url));
      const vs = Array.isArray(u.vip_urls) ? u.vip_urls : [];
      if (this.options.include_vip) {
        for (let k = 0; k < vs.length; k++) {
          const v = vs[k] || {};
          if (v.url) {
            const vl = this.cleanLabel(v.title || label) + (vs.length > 1 ? "(" + (k + 1) + ")" : "");
            vip.push(vl + "$" + this.enc(v.url));
          }
        }
      }
    }
    return {normal, vip};
  }

  detailVod(detail) {
    const item = this.card(detail);
    const L = this.lines(detail);
    const flags = [], lines = [];
    if (L.normal.length) { flags.push("欧乐线路"); lines.push(L.normal.join("#")); }
    if (L.vip.length) { flags.push("VIP高清"); lines.push(L.vip.join("#")); }
    Object.assign(item, {
      type_name: String(detail.typeId1Name || detail.typeIdName || ""),
      vod_year: String(detail.year || ""),
      vod_area: String(detail.area || ""),
      vod_director: String(detail.director || ""),
      vod_actor: String(detail.actor || ""),
      vod_content: String(detail.content || detail.blurb || ""),
      vod_remarks: String(detail.remarks || detail.version || "") + (detail.vip ? " · VIP" : ""),
      vod_play_from: flags.join("$$$"),
      vod_play_url: lines.join("$$$"),
    });
    return item;
  }

  async detailContent(ids) {
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : [ids])) {
      try { out.push(this.detailVod(await this.fetchDetail(id))); }
      catch (e) { /* 单片失败不拖垮整批 */ }
    }
    return {list: out};
  }

  // ---------- 播放 ----------
  // 播放值就是 encodeURIComponent 后的直链，零额外请求
  async playerContent(flag, id, vipFlags) {
    const url = this.dec(id);
    if (!/^https?:\/\//i.test(url)) return {parse: 0, msg: "无效的播放地址: " + String(id).slice(0, 80)};
    return {
      parse: 0, jx: 0, url,
      header: {"User-Agent": this.net.getUserAgent() || UA_FALLBACK, "Referer": this.options.web},
      format: /\.mp4(\?|$)/i.test(url) ? "video/mp4" : undefined,
    };
  }

  manualVideoCheck() { return true; }
  isVideoFormat(url) { return /\.(m3u8|mp4|mpd|flv|mkv)(\?|$)/i.test(String(url || "")); }

  // ---------- 直播 ----------
  // 5.8.7 宿主 TIMEOUT_LIVE = 30s：直播解析只给 30 秒。
  // 站点直播 hls 是固定形态（streamId 从 live/list 即得），无需逐频道 live/info。
  // 本版：types 1 次 + 各分组 list 并发（Promise.all），零每频道请求，
  // 总请求数 ~5，远低于超时；多线路直接拼固定 hls（超清/标清）。
  buildLive(groups) {
    const out = [];
    for (const g of (groups || [])) {
      const chans = Array.isArray(g.channels) ? g.channels : [];
      if (!chans.length) continue;
      out.push({name: String(g.name || "直播"), channel: chans.map((c) => ({
        name: String(c.name || ""),
        urls: (c.urls || []).map((u) => String(u)),
      }))});
    }
    return out;
  }

  liveHeaders(path, t) {
    let u = this.options.api + path;
    u += (path.indexOf("?") >= 0 ? "&" : "?") + "_vv=" + encodeURIComponent(t);
    const tk = this.options.token.split(".");
    if (tk.length === 3) u += "&_he=" + encodeURIComponent(tk[0]) + "&_pl=" + encodeURIComponent(tk[1]) + "&_si=" + encodeURIComponent(tk[2]);
    return u;
  }

  async liveGet(path, t) {
    const r = await this.net.req(this.liveHeaders(path, t), {
      headers: this.headers(), timeout: 8000, callTimeout: 8000,
    });
    const j = this.parseBody(r);
    return j.code === 0 ? j.data : null;
  }

  async liveContent(url) {
    // 若直接给了 TXT/M3U 地址，原样交回给 App 解析
    if (url && /^https?:\/\//i.test(url)) return url;
    let t;
    try { t = await this.vv(); } catch (e) { return []; }

    const types = await this.liveGet("/v1/pub/live/types", t).catch(() => null);
    const tlist = Array.isArray(types) ? types : [];
    // 只保留 tv 分组（央视/地方），overseas 体育分组的 groupId 语义不同，先不列
    const picked = tlist.filter((x) => String(x.type || "tv") === "tv");
    const list = picked.length ? picked : tlist.slice(0, 2);

    const groups = await Promise.all(list.map(async (tp) => {
      const type = String(tp.type || "tv");
      const gid = String(tp.id || "1");
      const d = await this.liveGet(
        "/v1/pub/live/list/" + encodeURIComponent(type) + "/1/0/60/0/0/" + encodeURIComponent(gid), t
      ).catch(() => null);
      const rows = (d && Array.isArray(d.list)) ? d.list : [];
      const channels = rows.filter((c) => c && c.streamId).map((c) => {
        const sid = String(c.streamId);
        const base = this.options.api.replace(/\/+$/, "") + "/dis/live/" + encodeURIComponent(sid);
        return {
          name: String(c.title || sid),
          urls: [
            base + "/hls.m3u8$超清",
            base + "_360/hls.m3u8$标清",
          ],
        };
      });
      return {name: String(tp.title || "直播"), channels};
    }));
    return this.buildLive(groups);
  }

  // ---------- 诊断 ----------
  async action(value) {
    if (value === "ping" || value === "token") {
      try {
        const t = await this.vv(true);
        const d = await this.api("/v1/pub/index/navs");
        return {msg: "OK vv=" + t + " navs=" + (d && d.top ? d.top.length + "类" : "?")};
      } catch (e) { return {msg: "FAIL " + String(e && e.message || e)}; }
    }
    return {msg: "可用操作: ping"};
  }

  destroy() {}
}
