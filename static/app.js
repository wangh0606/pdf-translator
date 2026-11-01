import * as pdfjsLib from '/static/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';
const PDF_OPTS = {
  cMapUrl: '/static/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/static/vendor/pdfjs/standard_fonts/',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* =====================================================================
 * 偏好设置（保存在浏览器本地）
 * ===================================================================== */
const PREF_DEFAULTS = {
  batch_size: 20, concurrency: 3, hover_sync: true, scroll_sync: true,
  auto_translate: true, view: 'trans', scale: 1.25, chat_open: true,
};
const prefs = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('pdft_prefs') || '{}') };
const savePrefs = () => localStorage.setItem('pdft_prefs', JSON.stringify(prefs));

/* =====================================================================
 * 全局状态
 * ===================================================================== */
const S = {
  pdf: null, name: '', docId: 0,
  pages: [],          // {num, page, vp1, tc, items:[{start,end,x,y}], div, state, token}
  full: '',           // 全文（拼接后的文本）
  sents: [],          // {id, start, end, text, status, trans, para, loc:{page,x,y}}
  paras: [],          // {id, sids:[]}
  scale: prefs.scale,
  curPage: 1,
  hl: new Set(), hover: null,
  tEls: [], oEls: [],  // 右侧译文/原文 span
  pageMarks: [],       // 页码 -> 右侧锚点
  config: {},
  selection: null,     // {text, sids, side}
  progScrollUntil: 0,
};

/* =====================================================================
 * 工具函数
 * ===================================================================== */
async function api(path, body, opts = {}) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  });
  let j;
  try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
  if (!r.ok) {
    const msg = j.error || j.detail;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg) || `HTTP ${r.status}`);
  }
  return j;
}

let toastTimer;
function toast(msg, err = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const isCJKLang = (l) => /中文|汉|漢|chinese|日本|japan|한국|korean/i.test(l || '');
const CJK = '⺀-鿿豈-﫿＀-￯　-〿';
const cjkSpaceRe = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');

function cleanText(t) {
  return t
    .replace(/([a-z])-\n([a-z])/g, '$1$2')   // 行尾连字符
    .replace(cjkSpaceRe, '$1')                // 中日韩文字之间的换行不加空格
    .replace(/\s+/g, ' ')
    .trim();
}

/* =====================================================================
 * 文本抽取与断句
 * ===================================================================== */
function buildFullText(pages) {
  let full = '';
  for (const pg of pages) {
    pg.items = [];
    let prev = null;
    for (const it of pg.tc.items) {
      if (it.str === undefined) continue;
      const str = it.str;
      const [, , c, d, x, y] = it.transform;
      const fh = Math.hypot(c, d) || it.height || 10;
      if (prev && str.length) {
        const dy = y - prev.y; // >0 向上
        const lh = Math.max(fh, prev.fh);
        let sep;
        if (Math.abs(dy) < lh * 0.6) {
          // 同一行
          const gap = x - (prev.x + prev.w);
          sep = gap > fh * 0.18 && !/\s$/.test(full) && !/^\s/.test(str) ? ' ' : '';
        } else {
          const sizeChange = Math.abs(fh - prev.fh) / lh > 0.18;
          // 向下的大间距或字号变化 => 新段落；向上跳（换栏/换页）或普通换行 => 句子继续
          sep = dy < -lh * 1.75 || sizeChange ? '\n\n' : '\n';
        }
        full += sep;
      }
      const start = full.length;
      full += str;
      pg.items.push({ start, end: full.length, x, y });
      if (str.trim().length) prev = { x, y, fh, w: it.width };
    }
    full += '\n';
  }
  return full;
}

const NEVER_BREAK = new Set([
  'e.g', 'i.e', 'al', 'vs', 'cf', 'viz', 'approx', 'resp', 'dr', 'mr', 'mrs', 'ms', 'prof',
  'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'ca', 'etc.al', 'w.r.t', 'a.k.a',
]);
const NUM_ABBR = new Set([
  'fig', 'figs', 'eq', 'eqs', 'eqn', 'no', 'nos', 'vol', 'vols', 'pp', 'p', 'ref', 'refs', 'sec',
  'secs', 'ch', 'chap', 'tab', 'thm', 'lem', 'def', 'prop', 'cor', 'alg', 'app', 'art', 'para',
]);
const CLOSERS = '"\'”’)]}»';
const CJK_END = '。！？';
const CJK_CLOSERS = '”’」』）)】》';

function segment(full) {
  const out = [];
  const n = full.length;
  let st = 0, newPara = true;
  const push = (end) => {
    let a = st, b = end;
    while (a < b && /\s/.test(full[a])) a++;
    while (b > a && /\s/.test(full[b - 1])) b--;
    if (b > a) { out.push({ start: a, end: b, paraStart: newPara }); newPara = false; }
    st = end;
  };
  for (let i = 0; i < n; i++) {
    const ch = full[i];
    if (ch === '\n' && full[i + 1] === '\n') {
      push(i); newPara = true; i++; continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < n && '.!?'.includes(full[j])) j++;
      while (j < n && CLOSERS.includes(full[j])) j++;
      if (j < n && !/\s/.test(full[j])) continue;          // 3.14 / U.S. / 网址
      let k = j;
      while (k < n && /[ \t\n]/.test(full[k]) && !(full[k] === '\n' && full[k + 1] === '\n')) k++;
      const nx = full[k] || '';
      if (/[a-z]/.test(nx)) continue;                      // 下一个词小写 => 不是句末
      if (ch === '.' && j === i + 1) {
        const m = /([A-Za-z][A-Za-z.]*)$/.exec(full.slice(Math.max(0, i - 12), i));
        const w = m ? m[1].toLowerCase() : '';
        if (NEVER_BREAK.has(w)) continue;
        if (NUM_ABBR.has(w) && /[0-9(\[]/.test(nx)) continue;
        if (m && m[1].length === 1 && /[A-Z]/.test(m[1])) continue;  // 人名缩写 J. Smith
        const sofar = full.slice(st, i).trim();
        if (/^\(?([0-9]{1,3}|[IVXivx]{1,4}|[A-Z])(\.[0-9]{1,3})*$/.test(sofar)) continue; // 章节编号 "1." "2.3."
      }
      push(j); i = j - 1; continue;
    }
    if (CJK_END.includes(ch) || (ch === '…' && full[i + 1] === '…')) {
      let j = i + 1;
      while (j < n && (CJK_END + '…').includes(full[j])) j++;
      while (j < n && CJK_CLOSERS.includes(full[j])) j++;
      push(j); i = j - 1; continue;
    }
  }
  push(n);

  // 过长的“句子”（表格、无标点文本）按行切开
  const res = [];
  for (const s of out) {
    if (s.end - s.start <= 1200) { res.push(s); continue; }
    let a = s.start, first = true;
    while (s.end - a > 1200) {
      let cut = full.indexOf('\n', a + 600);
      if (cut < 0 || cut >= s.end - 50) cut = full.indexOf(' ', a + 900);
      if (cut < 0 || cut >= s.end - 50) break;
      res.push({ start: a, end: cut, paraStart: first && s.paraStart });
      first = false;
      a = cut + 1;
    }
    res.push({ start: a, end: s.end, paraStart: first && s.paraStart });
  }
  return res;
}

function buildSentences() {
  const segs = segment(S.full);
  S.sents = [];
  S.paras = [];
  let para = null;
  segs.forEach((g, id) => {
    const text = cleanText(S.full.slice(g.start, g.end));
    if (g.paraStart || !para) { para = { id: S.paras.length, sids: [] }; S.paras.push(para); }
    const translatable = /\p{L}{2,}/u.test(text);
    S.sents.push({
      id, start: g.start, end: g.end, text,
      status: translatable ? 'pending' : 'skip', trans: '', para: para.id, loc: null,
    });
    para.sids.push(id);
  });
  // 每个句子在 PDF 中的位置（第一个文字片段）
  let k = 0;
  for (const pg of S.pages) {
    for (const it of pg.items) {
      if (it.end <= it.start) continue;
      while (k < S.sents.length && S.sents[k].end <= it.start) k++;
      for (let q = k; q < S.sents.length && S.sents[q].start < it.end; q++) {
        if (!S.sents[q].loc) S.sents[q].loc = { page: pg.num, x: it.x, y: it.y };
      }
    }
  }
  let last = { page: 1, x: 0, y: 0 };
  for (const s of S.sents) { if (s.loc) last = s.loc; else s.loc = last; }
}

// 第一个 end > pos 的句子下标
function sentIndexAt(pos) {
  let lo = 0, hi = S.sents.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (S.sents[mid].end <= pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* =====================================================================
 * 打开 PDF
 * ===================================================================== */
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('请选择 PDF 文件', true); return; }
  stopTranslation();
  const docId = ++S.docId;
  try { await S.pdf?.destroy(); } catch {}
  Object.assign(S, { pdf: null, pages: [], sents: [], paras: [], full: '', hl: new Set(), hover: null, selection: null });
  $('#pdfPages').innerHTML = '';
  $('#transContent').innerHTML = '';
  $('#dropHint').hidden = true;
  $('#docName').textContent = file.name;
  $('#docName').title = file.name;
  document.title = file.name + ' · PDF 逐句翻译';
  S.name = file.name.replace(/\.pdf$/i, '');
  setProgressText('正在读取 PDF…');

  let pdf;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data, ...PDF_OPTS }).promise;
  } catch (e) {
    toast('PDF 打开失败：' + e.message, true, 6000);
    setProgressText('打开失败');
    return;
  }
  if (docId !== S.docId) return;
  S.pdf = pdf;

  // 并行读取每页信息和文字
  const pages = new Array(pdf.numPages);
  let doneCnt = 0;
  const loadPage = async (i) => {
    const page = await pdf.getPage(i + 1);
    const tc = await page.getTextContent();
    pages[i] = { num: i + 1, page, vp1: page.getViewport({ scale: 1 }), tc, items: [], div: null, state: null };
    if (++doneCnt % 5 === 0) setProgressText(`解析文字 ${doneCnt}/${pdf.numPages}`);
  };
  const idxs = [...Array(pdf.numPages).keys()];
  const workers = Array.from({ length: Math.min(6, idxs.length) }, async () => {
    while (idxs.length) await loadPage(idxs.shift());
  });
  try { await Promise.all(workers); } catch (e) { toast('解析失败：' + e.message, true); return; }
  if (docId !== S.docId) return;
  S.pages = pages;

  S.full = buildFullText(pages);
  buildSentences();
  setupPages();
  const fit = (pdfScroll.clientWidth - 32) / pages[0].vp1.width;
  if (S.scale > fit * 1.05 || S.scale < fit * 0.6) setScale(fit);
  renderTrans();
  $('#exportBtn').disabled = false;
  $('#pauseBtn').disabled = false;

  const nTrans = S.sents.filter((s) => s.status === 'pending').length;
  if (!nTrans) {
    toast('这个 PDF 中没有可提取的文字（可能是扫描件/图片），需要先做 OCR 才能翻译。', true, 8000);
    setProgressText('没有可翻译的文字');
    return;
  }
  if (prefs.auto_translate) startTranslation();
  else { Q.paused = true; updateProgress(); }
}

/* =====================================================================
 * PDF 渲染（按需渲染可见页面）
 * ===================================================================== */
const pdfScroll = $('#pdfScroll');
const observer = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const pg = S.pages[+en.target.dataset.page - 1];
    if (!pg) continue;
    if (en.isIntersecting) renderPage(pg); else unrenderPage(pg);
  }
}, { root: pdfScroll, rootMargin: '1200px 0px' });

function setupPages() {
  const root = $('#pdfPages');
  root.innerHTML = '';
  observer.disconnect();
  for (const pg of S.pages) {
    const div = el('div', 'page');
    div.dataset.page = pg.num;
    div.append(el('span', 'page-num', `${pg.num} / ${S.pages.length}`));
    pg.div = div;
    root.append(div);
  }
  layoutPages();
}

function layoutPages() {
  $('#zoomLabel').textContent = Math.round(S.scale * 100) + '%';
  for (const pg of S.pages) {
    unrenderPage(pg);
    const vp = pg.page.getViewport({ scale: S.scale });
    pg.div.style.width = Math.floor(vp.width) + 'px';
    pg.div.style.height = Math.floor(vp.height) + 'px';
    pg.div.style.setProperty('--scale-factor', S.scale);
  }
  observer.disconnect();
  for (const pg of S.pages) observer.observe(pg.div);
}

async function renderPage(pg) {
  if (pg.state) return;
  pg.state = 'rendering';
  const token = (pg.token = Symbol());
  const vp = pg.page.getViewport({ scale: S.scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const canvas = el('canvas');
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  pg.div.prepend(canvas);
  pg.canvas = canvas;

  const tl = el('div', 'textLayer');
  pg.div.append(tl);
  pg.tlDiv = tl;
  const textLayer = new pdfjsLib.TextLayer({ textContentSource: pg.tc, container: tl, viewport: vp });
  pg.textLayer = textLayer;

  pg.renderTask = pg.page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  try {
    await textLayer.render();
    if (pg.token !== token) return;
    decorateTextLayer(pg, textLayer.textDivs);
    tl.append(el('div', 'endOfContent'));
    await pg.renderTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException' && e?.name !== 'AbortException') console.warn(e);
    return;
  }
  if (pg.token === token) pg.state = 'done';
}

function unrenderPage(pg) {
  if (!pg.state) return;
  pg.token = null;
  try { pg.renderTask?.cancel(); } catch {}
  try { pg.textLayer?.cancel(); } catch {}
  pg.canvas?.remove();
  pg.tlDiv?.remove();
  pg.canvas = pg.tlDiv = pg.textLayer = pg.renderTask = null;
  pg.state = null;
}

// 把 pdf.js 文字层的每个 span 按句子边界切分成 <span class="seg" data-sid>
function decorateTextLayer(pg, divs) {
  const full = S.full;
  divs.forEach((div, i) => {
    const it = pg.items[i];
    if (!it || it.end <= it.start || !div.isConnected) return;
    let k = sentIndexAt(it.start);
    let pos = it.start;
    const frag = document.createDocumentFragment();
    while (pos < it.end) {
      const s = S.sents[k];
      if (!s || s.start >= it.end) { frag.append(full.slice(pos, it.end)); break; }
      if (s.start > pos) { frag.append(full.slice(pos, s.start)); pos = s.start; }
      const segEnd = Math.min(s.end, it.end);
      const span = el('span', 'seg', full.slice(pos, segEnd));
      span.dataset.sid = s.id;
      if (S.hl.has(s.id)) span.classList.add('hl');
      if (S.hover === s.id) span.classList.add('hover');
      frag.append(span);
      pos = segEnd;
      if (segEnd >= s.end) k++;
    }
    div.textContent = '';
    div.append(frag);
  });
}

function setScale(sc) {
  sc = Math.max(0.4, Math.min(4, sc));
  if (!S.pages.length) { S.scale = sc; $('#zoomLabel').textContent = Math.round(sc * 100) + '%'; return; }
  const ratio = pdfScroll.scrollTop / Math.max(1, pdfScroll.scrollHeight);
  S.scale = sc;
  prefs.scale = sc; savePrefs();
  layoutPages();
  pdfScroll.scrollTop = ratio * pdfScroll.scrollHeight;
}

/* =====================================================================
 * 右侧译文
 * ===================================================================== */
function transText(s) {
  return s.status === 'done' ? s.trans : s.text;
}

function renderTrans() {
  const root = $('#transContent');
  root.innerHTML = '';
  root.className = prefs.view === 'bi' ? 'view-bi' : 'view-trans';
  S.tEls = [];
  S.oEls = [];
  S.pageMarks = [];
  const joiner = isCJKLang(S.config.target_lang) ? '' : ' ';
  let lastPage = 0;
  const frag = document.createDocumentFragment();
  for (const p of S.paras) {
    const pgNum = S.sents[p.sids[0]].loc?.page || lastPage;
    if (pgNum > lastPage) {
      const mark = el('div', 'page-mark', `第 ${pgNum} 页`);
      frag.append(mark);
      for (let q = lastPage + 1; q <= pgNum; q++) S.pageMarks[q] = mark;
      lastPage = pgNum;
    }
    const pd = el('div', 'para');
    const od = el('div', 'orig');
    const td = el('div', 'trans');
    p.sids.forEach((sid, idx) => {
      const s = S.sents[sid];
      const o = el('span', 'oseg', s.text);
      o.dataset.sid = sid;
      const t = el('span', 'tseg ' + s.status, transText(s));
      t.dataset.sid = sid;
      if (idx) { od.append(' '); td.append(joiner); }
      od.append(o);
      td.append(t);
      S.oEls[sid] = o;
      S.tEls[sid] = t;
    });
    pd.append(od, td);
    frag.append(pd);
  }
  root.append(frag);
  for (const sid of S.hl) { S.tEls[sid]?.classList.add('hl'); S.oEls[sid]?.classList.add('hl'); }
}

function updateSentEl(s) {
  const t = S.tEls[s.id];
  if (!t) return;
  t.textContent = transText(s);
  for (const c of ['pending', 'loading', 'done', 'error', 'skip']) t.classList.toggle(c, s.status === c);
  t.title = s.status === 'error' ? '翻译失败：' + (s.error || '') : '';
}

/* =====================================================================
 * 翻译队列
 * ===================================================================== */
const Q = { batches: [], running: 0, paused: false, gen: 0, failStreak: 0 };

function buildBatches(statuses = ['pending']) {
  const B = Math.max(1, +prefs.batch_size || 20);
  const MAX_CHARS = 3500;
  const batches = [];
  let cur = [], chars = 0;
  const flush = () => {
    if (cur.length) batches.push({ sids: cur, page: S.sents[cur[0]].loc?.page || 1 });
    cur = []; chars = 0;
  };
  for (const s of S.sents) {
    if (!statuses.includes(s.status)) continue;
    if (cur.length && (cur.length >= B || chars + s.text.length > MAX_CHARS || s.id - cur[cur.length - 1] > 3)) flush();
    cur.push(s.id);
    chars += s.text.length;
  }
  flush();
  return batches;
}

function startTranslation(statuses = ['pending']) {
  Q.gen++;
  Q.running = 0;
  Q.failStreak = 0;
  Q.batches = buildBatches(statuses);
  Q.paused = false;
  $('#pauseBtn').textContent = '暂停';
  pump();
}

function stopTranslation() {
  Q.gen++;
  Q.batches = [];
  Q.running = 0;
}

function pump() {
  while (!Q.paused && Q.running < Math.max(1, +prefs.concurrency || 3) && Q.batches.length) {
    // 优先翻译当前阅读位置附近的内容
    const cur = S.curPage;
    let best = 0, bestScore = Infinity;
    Q.batches.forEach((b, i) => {
      const score = b.page >= cur ? b.page - cur : 1000 + (cur - b.page);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    runBatch(Q.batches.splice(best, 1)[0]);
  }
  updateProgress();
}

function contextBefore(sid, n = 3) {
  const parts = [];
  for (let i = sid - 1; i >= 0 && parts.length < n; i--) parts.unshift(S.sents[i].text);
  return parts.join(' ');
}

async function runBatch(b) {
  const gen = Q.gen;
  Q.running++;
  for (const sid of b.sids) { S.sents[sid].status = 'loading'; updateSentEl(S.sents[sid]); }
  try {
    const res = await api('/api/translate', {
      segments: b.sids.map((id) => ({ id, text: S.sents[id].text })),
      context: contextBefore(b.sids[0]),
    });
    if (gen !== Q.gen) return;
    Q.failStreak = 0;
    for (const sid of b.sids) {
      const s = S.sents[sid];
      const t = res.translations[sid];
      if (t) { s.trans = t; s.status = 'done'; } else { s.status = 'error'; s.error = '模型未返回该句译文'; }
      updateSentEl(s);
    }
  } catch (e) {
    if (gen !== Q.gen) return;
    for (const sid of b.sids) {
      const s = S.sents[sid];
      s.status = 'error'; s.error = e.message;
      updateSentEl(s);
    }
    Q.failStreak++;
    if (Q.failStreak >= 3 || /401|403|未配置|api key|API Key|Unauthorized|无法连接/i.test(e.message)) {
      Q.paused = true;
      $('#pauseBtn').textContent = '继续';
      toast('翻译出错，已暂停：' + e.message + '（请检查「设置」中的接口配置）', true, 9000);
    } else {
      toast('部分翻译失败：' + e.message, true);
    }
  } finally {
    if (gen === Q.gen) { Q.running--; pump(); }
  }
}

function updateProgress() {
  const all = S.sents.filter((s) => s.status !== 'skip');
  const done = all.filter((s) => s.status === 'done').length;
  const err = all.filter((s) => s.status === 'error').length;
  const total = all.length;
  $('#progressBar').style.width = total ? (100 * done / total).toFixed(1) + '%' : '0';
  let txt = total ? `已翻译 ${done}/${total}` : '未开始';
  if (err) txt += `，失败 ${err}`;
  if (Q.paused && done + err < total) txt += '（已暂停）';
  else if (done === total && total) txt = `翻译完成 ${done}/${total}`;
  setProgressText(txt);
  $('#retryBtn').hidden = !(err && !Q.running && !Q.batches.length);
}
function setProgressText(t) { $('#progressText').textContent = t; }

async function retranslate(sids, instruction) {
  sids = sids.filter((sid) => S.sents[sid].status !== 'skip');
  if (!sids.length) return;
  for (const sid of sids) { S.sents[sid].status = 'loading'; updateSentEl(S.sents[sid]); }
  try {
    for (let i = 0; i < sids.length; i += 20) {
      const part = sids.slice(i, i + 20);
      const res = await api('/api/translate', {
        segments: part.map((id) => ({ id, text: S.sents[id].text })),
        context: contextBefore(part[0]), force: true, instruction,
      });
      for (const sid of part) {
        const s = S.sents[sid];
        if (res.translations[sid]) { s.trans = res.translations[sid]; s.status = 'done'; }
        else { s.status = s.trans ? 'done' : 'error'; }
        updateSentEl(s);
      }
    }
    toast('已重新翻译');
  } catch (e) {
    for (const sid of sids) { const s = S.sents[sid]; s.status = s.trans ? 'done' : 'error'; s.error = e.message; updateSentEl(s); }
    toast('重新翻译失败：' + e.message, true);
  }
  updateProgress();
}

/* =====================================================================
 * 高亮联动
 * ===================================================================== */
function pdfSegs(sid) { return $$(`.seg[data-sid="${sid}"]`, $('#pdfPages')); }

function setHighlight(sids, { scrollPdf = false, scrollTrans = false } = {}) {
  for (const sid of S.hl) {
    pdfSegs(sid).forEach((e) => e.classList.remove('hl'));
    S.tEls[sid]?.classList.remove('hl');
    S.oEls[sid]?.classList.remove('hl');
  }
  S.hl = new Set(sids);
  for (const sid of sids) {
    pdfSegs(sid).forEach((e) => e.classList.add('hl'));
    S.tEls[sid]?.classList.add('hl');
    S.oEls[sid]?.classList.add('hl');
  }
  if (sids.length) {
    if (scrollPdf) scrollPdfTo(sids[0]);
    if (scrollTrans) scrollTransTo(sids[0]);
  }
}

function setHover(sid) {
  if (S.hover === sid) return;
  if (S.hover != null) {
    pdfSegs(S.hover).forEach((e) => e.classList.remove('hover'));
    S.tEls[S.hover]?.classList.remove('hover');
    S.oEls[S.hover]?.classList.remove('hover');
  }
  S.hover = sid;
  if (sid != null) {
    pdfSegs(sid).forEach((e) => e.classList.add('hover'));
    S.tEls[sid]?.classList.add('hover');
    S.oEls[sid]?.classList.add('hover');
  }
}

function markProgScroll() { S.progScrollUntil = Date.now() + 1200; }

function scrollPdfTo(sid) {
  const s = S.sents[sid];
  if (!s?.loc) return;
  const pg = S.pages[s.loc.page - 1];
  if (!pg) return;
  const vp = pg.page.getViewport({ scale: S.scale });
  const [x, y] = vp.convertToViewportPoint(s.loc.x, s.loc.y);
  const top = pg.div.offsetTop + y;
  const left = pg.div.offsetLeft + x;
  const view = pdfScroll;
  const visible = top > view.scrollTop + 60 && top < view.scrollTop + view.clientHeight - 40;
  markProgScroll();
  if (!visible) view.scrollTo({ top: top - view.clientHeight * 0.3, behavior: 'smooth' });
  if (left < view.scrollLeft || left > view.scrollLeft + view.clientWidth - 50) {
    view.scrollTo({ left: Math.max(0, left - 40), behavior: 'smooth' });
  }
}

function scrollTransTo(sid) {
  const e = (prefs.view === 'bi' ? S.oEls[sid] : null) || S.tEls[sid];
  if (!e) return;
  const box = $('#transScroll');
  const r = e.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (r.top < br.top + 30 || r.bottom > br.bottom - 30) {
    box.scrollTo({ top: box.scrollTop + r.top - br.top - box.clientHeight * 0.3, behavior: 'smooth' });
  }
}

// 计算选区覆盖到的句子
function sidsInRange(range, root, selector) {
  let anc = range.commonAncestorContainer;
  if (anc.nodeType !== 1) anc = anc.parentElement;
  const cands = new Set($$(selector, anc));
  const self = anc.closest(selector);
  if (self) cands.add(self);
  const sids = new Set();
  for (const e of cands) {
    if (!root.contains(e) || !range.intersectsNode(e)) continue;
    const tn = e.firstChild;
    if (tn && range.endContainer === tn && range.endOffset === 0) continue;
    if (tn && range.startContainer === tn && range.startOffset === tn.length) continue;
    sids.add(+e.dataset.sid);
  }
  return [...sids].sort((a, b) => a - b);
}

function handleMouseUp(side, ev) {
  if (ev.button !== 0) return;
  setTimeout(() => {
    $$('.textLayer.selecting').forEach((t) => t.classList.remove('selecting'));
    const sel = window.getSelection();
    const raw = sel && !sel.isCollapsed ? sel.toString() : '';
    const root = side === 'pdf' ? $('#pdfPages') : $('#transContent');
    const selector = side === 'pdf' ? '.seg' : '[data-sid]';
    if (!raw.trim()) {
      hideToolbar();
      const t = ev.target.closest?.(selector);  // 单击：选中所点的句子
      if (t && root.contains(t)) {
        const sid = +t.dataset.sid;
        setHighlight([sid], { scrollPdf: side === 'trans', scrollTrans: side === 'pdf' });
        S.selection = { text: S.sents[sid].text, sids: [sid], side, whole: true };
      }
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const sids = sidsInRange(range, root, selector);
    const text = side === 'pdf' ? cleanText(raw) : raw.replace(/[ \t]+/g, ' ').trim();
    S.selection = { text, sids, side };
    setHighlight(sids, { scrollPdf: side === 'trans', scrollTrans: side === 'pdf' });
    showToolbar(range.getBoundingClientRect());
  }, 0);
}

/* ---------- 浮动工具条 ---------- */
const toolbar = $('#selToolbar');
function showToolbar(rect) {
  toolbar.hidden = false;
  const w = toolbar.offsetWidth, h = toolbar.offsetHeight;
  let top = rect.top - h - 8;
  if (top < 50) top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
  toolbar.style.top = top + 'px';
  toolbar.style.left = left + 'px';
  $('[data-act="retranslate"]', toolbar).hidden = !S.selection?.sids.length;
}
function hideToolbar() { toolbar.hidden = true; }

toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // 不要让点击清除选区
toolbar.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act || !S.selection) return;
  const sel = { ...S.selection };
  hideToolbar();
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(sel.text); toast('已复制'); } catch { toast('复制失败', true); }
  } else if (act === 'retranslate') {
    openRetrans(sel.sids);
  } else if (act === 'ask') {
    openChat(true);
    setQuote(sel);
    $('#chatInput').focus();
  } else {
    openChat(true);
    sendChat(act, sel, '');
  }
});

/* =====================================================================
 * AI 助手
 * ===================================================================== */
const chat = { history: [], quote: null, abort: null, busy: false };

function openChat(open) {
  $('#main').classList.toggle('no-chat', !open);
  $('#chatToggle').classList.toggle('active', open);
  prefs.chat_open = open; savePrefs();
}

function setQuote(q) {
  chat.quote = q;
  $('#quoteBox').hidden = !q;
  $('#quoteText').textContent = q ? q.text : '';
}

const MODE_LABEL = { ask: '💬 提问', explain: '📖 解释', polish: '✨ 润色', suggest: '📝 修改意见', summary: '🧾 总结' };
const MODE_PROMPT = {
  explain: '请解释选中内容：用通俗易懂的语言说明它在讲什么，解释其中的专业术语和背景知识，以及它在上下文中的作用。',
  polish: '请润色选中内容（保持其原有语言，不要翻译成其他语言）：使其更准确、流畅、地道，符合学术/专业写作规范，并尽量保留原意。先给出润色后的完整文本，再用列表简要说明主要修改及理由。',
  suggest: '请对选中内容提出具体的修改意见：从语法、用词、逻辑、清晰度、简洁性和学术规范等方面逐条指出问题、原因和建议改法，最后给出一个修改后的参考版本。',
  summaryQuote: '请总结选中内容的要点。',
  summaryDoc: '请总结这份文档的主要内容（例如：研究问题、方法、主要结论与贡献、局限性）。',
};

function sidsTexts(sids, kind) {
  return sids.map((sid) => {
    const s = S.sents[sid];
    return kind === 'orig' ? s.text : (s.status === 'done' ? s.trans : '');
  }).filter(Boolean).join(kind === 'orig' || !isCJKLang(S.config.target_lang) ? ' ' : '');
}

function buildUserContent(mode, quote, question) {
  const parts = [];
  if (quote) {
    const from = quote.side === 'pdf' ? '原文' : '译文';
    parts.push(`【选中内容（来自${from}）】\n"""\n${quote.text}\n"""`);
    if (quote.sids?.length) {
      if (quote.side === 'pdf') {
        const tr = sidsTexts(quote.sids, 'trans');
        if (tr) parts.push(`【对应的译文】\n"""\n${tr}\n"""`);
      } else {
        const or = sidsTexts(quote.sids, 'orig');
        if (or) parts.push(`【对应的原文】\n"""\n${or}\n"""`);
      }
    }
  }
  if (mode === 'ask') parts.push(`【我的问题】\n${question}`);
  else if (mode === 'summary') parts.push(`【要求】${quote ? MODE_PROMPT.summaryQuote : MODE_PROMPT.summaryDoc}`);
  else parts.push(`【要求】${MODE_PROMPT[mode]}${question ? '\n补充说明：' + question : ''}`);
  return parts.join('\n\n');
}

function buildDocContext(quote, mode) {
  if (!S.sents.length) return '';
  if (mode === 'summary' && !quote) return S.full.replace(/\s+/g, ' ').slice(0, 12000);
  const head = S.sents.slice(0, 40).map((s) => s.text).join(' ').slice(0, 2500);
  let near = '';
  if (quote?.sids?.length) {
    const a = Math.max(0, quote.sids[0] - 6);
    const b = Math.min(S.sents.length, quote.sids[quote.sids.length - 1] + 7);
    near = S.sents.slice(a, b).map((s) => s.text).join(' ');
  }
  return `【文档开头】\n${head}` + (near ? `\n\n【选中内容附近的原文】\n${near}` : '');
}

function addMsg(role, cls = '') {
  const m = el('div', `msg ${role} ${cls}`);
  $('#chatMsgs').append(m);
  $('.chat-tip')?.remove();
  m.scrollIntoView({ block: 'end' });
  return m;
}

async function sendChat(mode, quote, question) {
  if (chat.busy) { toast('请等待当前回答完成，或点击「停止」'); return; }
  if (mode === 'ask' && !question.trim()) { $('#chatInput').focus(); return; }
  if (['explain', 'polish', 'suggest'].includes(mode) && !quote) {
    toast('请先在左侧 PDF 或右侧译文中划选要处理的文字');
    return;
  }
  const content = buildUserContent(mode, quote, question);
  const docContext = buildDocContext(quote, mode);

  // 显示用户消息
  const um = addMsg('user');
  um.append(el('div', '', mode === 'ask' ? question : MODE_LABEL[mode] + (question ? '：' + question : '')));
  if (quote) um.append(el('div', 'q', quote.text.length > 400 ? quote.text.slice(0, 400) + '…' : quote.text));

  const messages = [...chat.history, { role: 'user', content }];
  const am = addMsg('assistant');
  const reasonBox = el('details', 'reasoning');
  reasonBox.append(el('summary', '', '思考过程'), el('div'));
  const body = el('div', 'md cursor');
  am.append(body);

  chat.busy = true;
  chat.abort = new AbortController();
  $('#chatStop').hidden = false;
  $('#chatSend').disabled = true;
  let answer = '', reasoning = '', failed = false;
  let raf = 0;
  const paint = () => {
    raf = 0;
    body.innerHTML = renderMarkdown(answer);
    const box = $('#chatMsgs');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  };
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, doc_context: docContext }),
      signal: chat.abort.signal,
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.t === 'delta') { answer += evt.c; if (!raf) raf = requestAnimationFrame(paint); }
        else if (evt.t === 'reasoning') {
          reasoning += evt.c;
          if (!reasonBox.isConnected) am.prepend(reasonBox);
          reasonBox.lastChild.textContent = reasoning;
        } else if (evt.t === 'error') { throw new Error(evt.m); }
      }
    }
  } catch (e) {
    failed = true;
    if (e.name === 'AbortError') answer += answer ? '\n\n*（已停止）*' : '*（已停止）*';
    else { am.classList.add('error'); answer += (answer ? '\n\n' : '') + '**出错了：** ' + e.message; }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    paint();
    body.classList.remove('cursor');
    chat.busy = false;
    $('#chatStop').hidden = true;
    $('#chatSend').disabled = false;
  }
  if (!failed || (answer && !am.classList.contains('error'))) {
    chat.history.push({ role: 'user', content }, { role: 'assistant', content: answer });
    if (chat.history.length > 16) chat.history = chat.history.slice(-16);
  }
  const tools = el('div', 'tools');
  const copyBtn = el('button', '', '复制');
  copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(answer); toast('已复制'); } catch { toast('复制失败', true); } };
  tools.append(copyBtn);
  am.append(tools);
}

function submitChatInput(mode = 'ask') {
  const q = $('#chatInput').value.trim();
  if (mode === 'ask' && !q) return;
  sendChat(mode, chat.quote, q);
  $('#chatInput').value = '';
  setQuote(null);
}

/* ---------- 简易 Markdown 渲染 ---------- */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderInline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
function renderMarkdown(src) {
  const blocks = [];
  src = src.replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  let html = '', para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.map(renderInline).join('<br>')}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.tag}>`; list = null; } };
  const flushQuote = () => { if (quote.length) { html += `<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`; quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (const line of src.split('\n')) {
    let m;
    if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim()))) { flushAll(); html += blocks[+m[1]]; }
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushAll(); const l = Math.min(4, m[1].length); html += `<h${l}>${renderInline(m[2])}</h${l}>`; }
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
    else if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); }
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushAll(); html += '<hr>'; }
    else if (!line.trim()) flushAll();
    else if (list && /^\s{2,}/.test(line)) list.items[list.items.length - 1] += ' ' + line.trim();
    else { flushList(); flushQuote(); para.push(line); }
  }
  flushAll();
  return html;
}

/* =====================================================================
 * 设置
 * ===================================================================== */
async function loadConfig() {
  try {
    S.config = await api('/api/config');
    $('#chatModel').textContent = S.config.model ? '模型：' + S.config.model : '';
    if (!S.config.has_key && /openai\.com/.test(S.config.base_url)) {
      toast('请先点击右上角「⚙ 设置」配置大模型 API', false, 6000);
    }
  } catch (e) { toast('无法连接后端：' + e.message, true); }
}

function openSettings() {
  const f = $('#settingsForm');
  const c = S.config;
  for (const k of ['base_url', 'model', 'translate_model', 'target_lang', 'temperature', 'translate_instructions']) {
    f.elements[k].value = c[k] ?? '';
  }
  f.elements.api_key.value = '';
  f.elements.api_key.placeholder = c.has_key ? `已设置：${c.api_key}（留空表示不修改）` : 'sk-...';
  for (const k of ['batch_size', 'concurrency']) f.elements[k].value = prefs[k];
  for (const k of ['hover_sync', 'scroll_sync', 'auto_translate']) f.elements[k].checked = !!prefs[k];
  $('#testResult').textContent = '';
  $('#settingsDlg').showModal();
}

async function saveSettings() {
  const f = $('#settingsForm');
  const body = {};
  for (const k of ['base_url', 'model', 'translate_model', 'target_lang', 'translate_instructions']) body[k] = f.elements[k].value;
  body.temperature = parseFloat(f.elements.temperature.value) || 0;
  if (f.elements.api_key.value.trim()) body.api_key = f.elements.api_key.value.trim();
  for (const k of ['batch_size', 'concurrency']) prefs[k] = Math.max(1, parseInt(f.elements[k].value) || PREF_DEFAULTS[k]);
  for (const k of ['hover_sync', 'scroll_sync', 'auto_translate']) prefs[k] = f.elements[k].checked;
  savePrefs();
  const oldLang = S.config.target_lang;
  S.config = await api('/api/config', body);
  f.elements.api_key.value = '';
  $('#chatModel').textContent = S.config.model ? '模型：' + S.config.model : '';
  if (S.config.target_lang !== oldLang && S.sents.length) renderTrans();
}

$('#settingsBtn').onclick = openSettings;
$('#settingsDlg').addEventListener('close', async () => {
  if ($('#settingsDlg').returnValue !== 'save') return;
  try {
    await saveSettings();
    toast('设置已保存');
    if (Q.paused && S.sents.some((s) => s.status === 'error')) {
      for (const s of S.sents) if (s.status === 'error') { s.status = 'pending'; updateSentEl(s); }
      startTranslation(['pending']);
    }
  } catch (e) { toast('保存失败：' + e.message, true); }
});
$('#testConn').onclick = async () => {
  const out = $('#testResult');
  out.className = 'small'; out.textContent = '正在测试…';
  try {
    await saveSettings();
    const r = await api('/api/test', {});
    out.className = 'small ok'; out.textContent = '✓ 连接成功：' + r.reply;
  } catch (e) { out.className = 'small err'; out.textContent = '✗ ' + e.message; }
};
$('#loadModels').onclick = async () => {
  const out = $('#testResult');
  out.className = 'small'; out.textContent = '正在获取…';
  try {
    await saveSettings();
    const r = await api('/api/models');
    const dl = $('#modelList');
    dl.innerHTML = '';
    for (const m of r.models) { const o = el('option'); o.value = m; dl.append(o); }
    if (r.models.length) { out.className = 'small ok'; out.textContent = `共 ${r.models.length} 个模型，点输入框可选择`; }
    else { out.className = 'small err'; out.textContent = '没有获取到模型列表' + (r.error ? '：' + r.error : '（可直接手动填写模型名）'); }
  } catch (e) { out.className = 'small err'; out.textContent = '✗ ' + e.message; }
};
$('#clearCache').onclick = async () => {
  if (!confirm('确定清空所有已缓存的译文吗？')) return;
  try { await api('/api/cache/clear', {}); toast('缓存已清空'); } catch (e) { toast(e.message, true); }
};

/* ---------- 重新翻译对话框 ---------- */
let retransSids = [];
function openRetrans(sids) {
  retransSids = sids;
  $('#retransInstr').value = '';
  $('#retransDlg').showModal();
}
$('#retransDlg').addEventListener('close', () => {
  if ($('#retransDlg').returnValue === 'ok') retranslate(retransSids, $('#retransInstr').value.trim());
});

/* =====================================================================
 * 导出
 * ===================================================================== */
$('#exportBtn').onclick = () => {
  if (!S.paras.length) return;
  const joiner = isCJKLang(S.config.target_lang) ? '' : ' ';
  const lines = [`# ${S.name}`, ''];
  let lastPage = 0;
  for (const p of S.paras) {
    const pg = S.sents[p.sids[0]].loc?.page || lastPage;
    if (pg > lastPage) { lines.push(`<!-- 第 ${pg} 页 -->`, ''); lastPage = pg; }
    lines.push(p.sids.map((i) => S.sents[i].text).join(' '), '');
    lines.push('> ' + p.sids.map((i) => transText(S.sents[i])).join(joiner), '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.name}.双语.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* =====================================================================
 * 事件绑定
 * ===================================================================== */
$('#fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const f = [...(e.dataTransfer?.files || [])].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (f) openFile(f); else toast('请拖入 PDF 文件', true);
});

$('#zoomIn').onclick = () => setScale(Math.round((S.scale + 0.15) * 100) / 100);
$('#zoomOut').onclick = () => setScale(Math.round((S.scale - 0.15) * 100) / 100);
$('#zoomFit').onclick = () => {
  if (!S.pages.length) return;
  setScale((pdfScroll.clientWidth - 32) / S.pages[0].vp1.width);
};
pdfScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !S.pages.length) return;
  e.preventDefault();
  setScale(S.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

$('#pauseBtn').onclick = () => {
  Q.paused = !Q.paused;
  $('#pauseBtn').textContent = Q.paused ? '继续' : '暂停';
  if (!Q.paused) {
    for (const s of S.sents) if (s.status === 'error') { s.status = 'pending'; updateSentEl(s); }
    if (Q.running) { Q.batches = buildBatches(['pending']); pump(); }
    else startTranslation(['pending']);
  }
  updateProgress();
};
$('#retryBtn').onclick = () => {
  for (const s of S.sents) if (s.status === 'error') { s.status = 'pending'; updateSentEl(s); }
  startTranslation(['pending']);
};

$('#viewMode').value = prefs.view;
$('#viewMode').onchange = (e) => {
  prefs.view = e.target.value; savePrefs();
  $('#transContent').className = prefs.view === 'bi' ? 'view-bi' : 'view-trans';
};

// 当前页 & 滚动跟随
let scrollRaf = 0;
pdfScroll.addEventListener('scroll', () => {
  hideToolbar();
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!S.pages.length) return;
    const mid = pdfScroll.scrollTop + pdfScroll.clientHeight * 0.35;
    let lo = 0, hi = S.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (S.pages[m].div.offsetTop <= mid) lo = m; else hi = m - 1;
    }
    const p = lo + 1;
    if (p !== S.curPage) {
      S.curPage = p;
      $('#pageLabel').textContent = `第 ${p} / ${S.pages.length} 页`;
      if (prefs.scroll_sync && Date.now() > S.progScrollUntil && S.pageMarks[p]) {
        const box = $('#transScroll');
        box.scrollTo({ top: S.pageMarks[p].offsetTop - 10, behavior: 'smooth' });
      }
    }
  });
});
$('#transScroll').addEventListener('scroll', hideToolbar);

// 悬停联动
$('#pdfPages').addEventListener('mouseover', (e) => {
  if (!prefs.hover_sync || e.buttons) return;
  const t = e.target.closest('.seg');
  setHover(t ? +t.dataset.sid : null);
});
$('#pdfPages').addEventListener('mouseleave', () => setHover(null));
$('#transContent').addEventListener('mouseover', (e) => {
  if (!prefs.hover_sync || e.buttons) return;
  const t = e.target.closest('[data-sid]');
  setHover(t ? +t.dataset.sid : null);
});
$('#transContent').addEventListener('mouseleave', () => setHover(null));

// 选择 / 点击
// 记录从哪一侧开始拖选，鼠标在任意位置松开都能正确处理
let downSide = null;
$('#pdfPages').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  downSide = 'pdf';
  e.target.closest('.textLayer')?.classList.add('selecting');
});
$('#transContent').addEventListener('mousedown', (e) => { if (e.button === 0) downSide = 'trans'; });
document.addEventListener('mouseup', (e) => {
  const side = downSide;
  downSide = null;
  if (side) handleMouseUp(side, e);
  else setTimeout(() => $$('.textLayer.selecting').forEach((t) => t.classList.remove('selecting')), 0);
});
document.addEventListener('mousedown', (e) => {
  if (!toolbar.contains(e.target)) hideToolbar();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    hideToolbar();
    setHighlight([]);
    window.getSelection()?.removeAllRanges();
  }
});

// 分隔条拖动
for (const sp of $$('.splitter')) {
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const L = $('#' + sp.dataset.left), R = $('#' + sp.dataset.right);
    const lw = L.getBoundingClientRect().width, rw = R.getBoundingClientRect().width;
    const x0 = e.clientX;
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const nl = Math.max(200, lw + dx), nr = Math.max(200, rw - dx);
      if (nl + nr > lw + rw + 1) return;
      L.style.flex = `0 0 ${nl}px`;
      R.style.flex = `0 0 ${nr}px`;
    };
    const up = () => {
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// 聊天面板
$('#chatToggle').onclick = () => openChat($('#main').classList.contains('no-chat'));
$('#chatClose').onclick = () => openChat(false);
$('#chatClear').onclick = () => {
  chat.abort?.abort();
  chat.history = [];
  $('#chatMsgs').innerHTML = '';
  setQuote(null);
};
$('#chatStop').onclick = () => chat.abort?.abort();
$('#quoteClear').onclick = () => setQuote(null);
$('#chatSend').onclick = () => submitChatInput('ask');
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitChatInput('ask'); }
});
for (const c of $$('.quick .chip')) {
  c.onclick = () => {
    const mode = c.dataset.mode;
    const quote = chat.quote || (S.selection && !S.selection.whole ? S.selection : null) || (S.selection?.whole ? S.selection : null);
    const q = $('#chatInput').value.trim();
    sendChat(mode, quote, q);
    $('#chatInput').value = '';
    setQuote(null);
  };
}

openChat(prefs.chat_open);
$('#zoomLabel').textContent = Math.round(S.scale * 100) + '%';
loadConfig();

// 方便调试
window.__pdft = { S, Q, segment, renderMarkdown };
