'use strict';

/* =========================================================
   LIFT LOG — シンプルな筋トレ記録 PWA
   データはこの端末の localStorage にだけ保存される
   ========================================================= */

const STORE_KEY = 'liftlog.v1';
const UNDO_KEY = 'liftlog.undo';

const SEED_MEMO = `デッドリフト 90 3
シュラッグ 90
ラットプル 65 5
マシンロー 50
シーテッドバイセップカール 8

ベンチプレス 70 4
インクラインスミスベンチ
マシンショルダープレス 30
ケーブルプッシュダウン 22.5

スクワット 85 5
レッグエクステンション 40
レッグカール 45
カーフレイズ 85`;

const DEFAULT_TARGET = 6;   // この回数できたら重量アップ
const DEFAULT_INC = 5;      // 何kg上げるか
const DEFAULT_STEP = 2.5;   // ＋/− ボタンの刻み

/* ---------- utils ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);

function todayStr() {
  return todayStrOf(new Date());
}

function todayStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(s) {
  const [, m, d] = s.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 22.5 → "22.5", 70 → "70"
function fmtW(w) {
  if (w == null || Number.isNaN(w)) return '--';
  return String(Math.round(w * 100) / 100);
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------- memo parser ---------- */

const BIG3 = /^(デッ[ドト]リフト|ベンチプレス|スクワット)$/;

function isBig3(name) {
  return BIG3.test(name);
}

// 「種目名 重量 回数」形式のメモを日ごとのブロックに分解する
// 数字が1つだけなら重量、2つなら重量と回数
function parseMemo(text) {
  const blocks = [];
  let cur = null;
  const lines = text
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) { cur = null; continue; }
    if (/メモ$/.test(line)) continue;

    const m = line.match(/^(.+?)\s*(\d+(?:\.\d+)?)?\s*(?:kg)?(?:(?:\s*[x×*]\s*|\s+)(\d+)\s*(?:回|reps?)?)?$/i);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    if (!cur) { cur = []; blocks.push(cur); }
    cur.push({
      name,
      w: m[2] != null ? parseFloat(m[2]) : null,
      r: m[3] != null ? parseInt(m[3], 10) : null,
    });
  }

  return blocks.map((items, i) => {
    const names = items.map((e) => e.name).join(' ');
    let code = `DAY ${i + 1}`;
    let label = '';
    if (/デッ[ドト]リフト/.test(names)) { code = 'PULL'; label = '背中の日'; }
    else if (/ベンチ/.test(names)) { code = 'PUSH'; label = '胸の日'; }
    else if (/スクワット/.test(names)) { code = 'LEGS'; label = '脚の日'; }
    return {
      id: uid(),
      code,
      label,
      exercises: items.map((e) => newExercise(e.name, e.w, e.r)),
    };
  });
}

function newExercise(name, w = null, r = null) {
  return {
    id: uid(),
    name,
    base: { w, r },              // 最初に取り込んだ値（記録がまだない時の「前回」）
    prog: isBig3(name),          // 自動で重量アップするか
    target: DEFAULT_TARGET,
    inc: DEFAULT_INC,
    step: DEFAULT_STEP,
  };
}

/* ---------- state ---------- */

let state = load();
let ui = {
  dayId: null,
  editing: false,
};

function freshState() {
  return { v: 1, days: parseMemo(SEED_MEMO), logs: [] };
}

// 画面が描けない壊れたデータを弾く
function isValidState(s) {
  return !!s && Array.isArray(s.days) && Array.isArray(s.logs) &&
    s.days.every((d) => d && typeof d.id === 'string' && Array.isArray(d.exercises) &&
      d.exercises.every((e) => e && typeof e.id === 'string' && typeof e.name === 'string')) &&
    s.logs.every((l) => l && typeof l.exId === 'string' && typeof l.date === 'string');
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (_) { return freshState(); }
  if (!raw) return freshState();
  try {
    const s = JSON.parse(raw);
    if (isValidState(s)) return s;
  } catch (_) { /* fall through */ }
  // 読めないデータは消さずに退避してから初期状態で起動する
  try { localStorage.setItem(`liftlog.broken.${Date.now()}`, raw); } catch (_) { /* ignore */ }
  return freshState();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (_) {
    toast('保存できませんでした');
  }
}

// 取り込み・リセットなど大きな操作の直前の状態を1つだけ残す
function snapshot(label) {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ label, at: Date.now(), state }));
  } catch (_) { /* ignore */ }
}

function readUndo() {
  try {
    const u = JSON.parse(localStorage.getItem(UNDO_KEY));
    return u && isValidState(u.state) ? u : null;
  } catch (_) {
    return null;
  }
}

function undoLast() {
  const u = readUndo();
  if (!u) return;
  if (!confirm(`「${u.label}」の前の状態に戻しますか？`)) return;
  state = u.state;
  try { localStorage.removeItem(UNDO_KEY); } catch (_) { /* ignore */ }
  ui.dayId = null;
  ui.editing = false;
  save();
  closeSheet();
  render();
  toast('元に戻しました');
}

/* ---------- derived values ---------- */

function findExercise(exId) {
  for (const d of state.days) {
    const ex = d.exercises.find((e) => e.id === exId);
    if (ex) return { day: d, ex };
  }
  return null;
}

function logsFor(exId) {
  // 日付順（同日は追加順）
  return state.logs
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.exId === exId)
    .sort((a, b) => (a.l.date < b.l.date ? -1 : a.l.date > b.l.date ? 1 : a.i - b.i))
    .map(({ l }) => l);
}

function todayLog(exId) {
  const t = todayStr();
  return state.logs.find((l) => l.exId === exId && l.date === t) || null;
}

// 今日より前の最新記録（なければ取り込み時の値）
function prevRecord(ex) {
  const t = todayStr();
  const past = logsFor(ex.id).filter((l) => l.date < t);
  if (past.length) return past[past.length - 1];
  if (ex.base && (ex.base.w != null || ex.base.r != null)) return { ...ex.base, date: null };
  return null;
}

// 最新記録（今日を含む）
function lastRecord(ex) {
  return todayLog(ex.id) || prevRecord(ex);
}

function hitTarget(ex, rec) {
  return !!(ex.prog && rec && rec.r != null && rec.r >= ex.target);
}

// 記録 rec の次に挑戦する重量
function nextWeightAfter(ex, rec) {
  if (!rec || rec.w == null) return null;
  return hitTarget(ex, rec) ? rec.w + ex.inc : rec.w;
}

// 最後に記録された日の「次の日」をおすすめにする（今日記録中ならその日のまま）
function suggestedDayId() {
  if (!state.days.length) return null;
  let latest = null;
  state.logs.forEach((l, i) => {
    if (!latest || l.date > latest.l.date || (l.date === latest.l.date && i > latest.i)) latest = { l, i };
  });
  if (!latest) return state.days[0].id;
  const found = findExercise(latest.l.exId);
  if (!found) return state.days[0].id;
  if (latest.l.date === todayStr()) return found.day.id;
  const idx = state.days.findIndex((d) => d.id === found.day.id);
  return state.days[(idx + 1) % state.days.length].id;
}

function currentDay() {
  return state.days.find((d) => d.id === ui.dayId) || state.days[0] || null;
}

/* ---------- rendering ---------- */

function dotsHtml(n, target) {
  let s = '<span class="dots">';
  for (let i = 0; i < target; i++) s += `<i class="${n != null && i < n ? 'on' : ''}"></i>`;
  return s + '</span>';
}

function render() {
  if (!state.days.find((d) => d.id === ui.dayId)) ui.dayId = suggestedDayId();
  renderTabs();
  renderHero();
  renderList();
}

function renderTabs() {
  const next = suggestedDayId();
  $('#dayTabs').innerHTML = state.days
    .map((d) => `<button role="tab" data-day="${d.id}" aria-selected="${d.id === ui.dayId}">
        ${esc(d.code)}${d.id === next && d.id !== ui.dayId ? '<span class="next-dot"></span>' : ''}
      </button>`)
    .join('');
}

function renderHero() {
  const day = currentDay();
  if (!day) { $('#hero').innerHTML = ''; return; }
  const isNext = day.id === suggestedDayId();
  const doneCount = day.exercises.filter((e) => todayLog(e.id)).length;
  const lastDate = day.exercises
    .flatMap((e) => logsFor(e.id).map((l) => l.date))
    .sort()
    .pop();

  let meta;
  if (doneCount > 0) meta = `今日 ${doneCount} / ${day.exercises.length} 種目 完了`;
  else if (lastDate) meta = `前回 ${shortDate(lastDate)}`;
  else meta = `${day.exercises.length} 種目`;

  $('#hero').innerHTML = `
    <div>
      <div class="eyebrow">${isNext ? 'TODAY' : 'DAY'} · ${state.days.indexOf(day) + 1} / ${state.days.length}</div>
      <h1>${esc(day.code)}<small>${esc(day.label)}</small></h1>
      <div class="meta">${meta}</div>
      ${ui.editing ? '<button class="rename-day" data-act="rename-day">日の名前を変更</button>' : ''}
    </div>
    <button class="pill-btn ${ui.editing ? 'on' : ''}" data-act="toggle-edit">${ui.editing ? '完了' : '編集'}</button>`;
}

function cardHtml(ex) {
  const done = todayLog(ex.id);
  const prev = prevRecord(ex);

  // 今日記録済みなら今日の値、未記録なら「今日やる重量」を表示
  let w, r, foot;
  const upFromPrev = hitTarget(ex, prev);
  if (done) {
    w = done.w; r = done.r;
  } else {
    w = nextWeightAfter(ex, prev);
    r = upFromPrev ? null : prev ? prev.r : null;
  }

  if (ex.prog) {
    const rec = done || prev;
    if (done && hitTarget(ex, done)) {
      foot = `${dotsHtml(done.r, ex.target)}<span class="up-text">🔥 次回 ${fmtW(done.w + ex.inc)}kg</span>`;
    } else if (!done && upFromPrev) {
      foot = `<span class="up-text">🔥 +${fmtW(ex.inc)}kg UP</span><span>前回 ${fmtW(prev.w)}kg × ${prev.r}</span>`;
    } else {
      const left = ex.target - ((rec && rec.r) || 0);
      foot = `${dotsHtml(rec ? rec.r : 0, ex.target)}<span>あと${left}回で +${fmtW(ex.inc)}kg</span>`;
    }
  } else if (done) {
    foot = '<span>今日 記録済み</span>';
  } else if (prev && prev.date) {
    foot = `<span>前回 ${shortDate(prev.date)}</span>`;
  } else {
    foot = prev ? '<span>タップして記録</span>' : '<span>まだ記録なし</span>';
  }

  const isUp = !done && upFromPrev;
  const nums = `
    <span class="n-big ${w == null ? 'n-empty' : ''}">${fmtW(w)}</span><span class="n-unit">kg</span>
    ${r != null ? `<span class="n-x">×</span><span class="n-reps">${r}</span>` : ''}
    ${isUp ? '<span class="badge">NEW</span>' : ''}`;

  return `
    <button class="card ${done ? 'done' : ''} ${isUp ? 'up' : ''}" data-ex="${ex.id}">
      <div class="card-head">
        ${ex.prog ? '<span class="star">★</span>' : ''}
        <span class="card-name">${esc(ex.name)}</span>
        ${done ? '<span class="check">✓</span>' : ''}
      </div>
      <div class="card-nums">${nums}</div>
      <div class="card-foot">${foot}</div>
    </button>`;
}

function editCardHtml(ex) {
  return `
    <div class="card editing" data-ex="${ex.id}">
      <span class="drag-handle" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>
      </span>
      <span class="card-name">${ex.prog ? '<span class="star">★</span> ' : ''}${esc(ex.name)}</span>
      <button class="mini-btn" data-act="edit-ex" data-ex="${ex.id}" aria-label="編集">✎</button>
    </div>`;
}

function renderList() {
  const day = currentDay();
  const list = $('#list');
  if (!day) { list.innerHTML = '<div class="empty">設定からメモを取り込んでください</div>'; return; }
  if (ui.editing) {
    list.innerHTML =
      (day.exercises.length > 1 ? '<div class="edit-hint">左の <b>⠿</b> を押さえたまま上下にドラッグで並べ替え</div>' : '') +
      day.exercises.map(editCardHtml).join('') +
      '<button class="add-card" data-act="add-ex">＋ 種目を追加</button>';
  } else {
    list.innerHTML = day.exercises.length
      ? day.exercises.map(cardHtml).join('')
      : '<div class="empty">「編集」から種目を追加しましょう</div>';
  }
}

/* ---------- sheet ---------- */

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  const sheet = $('#sheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('.sheet-panel').scrollTop = 0;
}

function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (document.activeElement) document.activeElement.blur();
}

/* ---------- log sheet ---------- */

let logCtx = null;

function openLog(exId) {
  const found = findExercise(exId);
  if (!found) return;
  const { ex } = found;
  const done = todayLog(ex.id);
  const prev = prevRecord(ex);
  const up = hitTarget(ex, prev);

  let w, r;
  if (done) { w = done.w; r = done.r; }
  else {
    w = nextWeightAfter(ex, prev);
    r = up ? null : prev ? prev.r : null;
  }
  logCtx = { exId: ex.id };

  const sub = done
    ? '今日の記録を修正'
    : prev
      ? `前回 ${fmtW(prev.w)}kg${prev.r != null ? ` × ${prev.r}回` : ''}${prev.date ? `（${shortDate(prev.date)}）` : ''}`
      : 'はじめての記録';

  const sameBtn = !done && prev && prev.w != null && !up
    ? `<button class="btn" data-act="log-same">前回と同じで記録（${fmtW(prev.w)}kg${prev.r != null ? ` × ${prev.r}` : ''}）</button>`
    : '';

  openSheet(`
    <div class="sh-title">
      ${ex.prog ? '<span class="star">★</span>' : ''}
      <h2>${esc(ex.name)}</h2>
      <button class="icon-btn" data-close aria-label="閉じる">✕</button>
    </div>
    <div class="sh-sub">${sub}</div>

    <div class="stepper-row">
      <div class="stepper">
        <label for="inW">WEIGHT</label>
        <input id="inW" inputmode="decimal" autocomplete="off" placeholder="--" value="${w == null ? '' : fmtW(w)}">
        <div class="unit">kg</div>
        <div class="step-btns">
          <button data-step="w" data-d="-1" aria-label="重量を減らす">−</button>
          <button data-step="w" data-d="1" aria-label="重量を増やす">＋</button>
        </div>
      </div>
      <div class="stepper">
        <label for="inR">REPS</label>
        <input id="inR" inputmode="numeric" autocomplete="off" placeholder="--" value="${r == null ? '' : r}">
        <div class="unit">回</div>
        <div class="step-btns">
          <button data-step="r" data-d="-1" aria-label="回数を減らす">−</button>
          <button data-step="r" data-d="1" aria-label="回数を増やす">＋</button>
        </div>
      </div>
    </div>

    <div id="progBox"></div>

    <div class="actions">
      <button class="btn primary" data-act="log-save">${done ? '更新する' : '記録する'}</button>
      ${sameBtn}
    </div>

    <div class="section-label">HISTORY</div>
    <div id="histArea"></div>
  `);
  updateProgBox();
  renderHistory();
}

function readInputs() {
  return { w: toNum($('#inW').value), r: (() => { const n = toNum($('#inR').value); return n == null ? null : Math.round(n); })() };
}

function updateProgBox() {
  if (!logCtx) return;
  const { ex } = findExercise(logCtx.exId) || {};
  const box = $('#progBox');
  if (!ex || !box) return;
  if (!ex.prog) { box.innerHTML = ''; return; }
  const { w, r } = readInputs();
  const hit = r != null && r >= ex.target;
  box.innerHTML = `
    <div class="prog-box ${hit ? 'hit' : ''}">
      ${dotsHtml(r, ex.target)}
      <span>${hit
        ? `🔥 ${ex.target}回達成！ 次回 ${w == null ? '' : `${fmtW(w + ex.inc)}kg`}`
        : `${ex.target}回できたら次回 +${fmtW(ex.inc)}kg`}</span>
    </div>`;
}

function stepInput(which, dir) {
  const { ex } = findExercise(logCtx.exId) || {};
  if (!ex) return;
  const input = which === 'w' ? $('#inW') : $('#inR');
  let v = toNum(input.value);
  if (which === 'w') {
    const step = ex.step || DEFAULT_STEP;
    v = v == null ? (dir > 0 ? step : 0) : Math.max(0, Math.round((v + dir * step) * 100) / 100);
    input.value = fmtW(v);
  } else {
    if (v == null) v = dir > 0 ? 1 : null;
    else { v = Math.round(v) + dir; if (v < 1) v = null; }
    input.value = v == null ? '' : v;
  }
  updateProgBox();
}

function saveLog(w, r) {
  const found = findExercise(logCtx.exId);
  if (!found) return;
  const { ex } = found;
  if (w == null && r == null) { toast('重量か回数を入れてください'); return; }

  const t = todayStr();
  const existing = todayLog(ex.id);
  if (existing) { existing.w = w; existing.r = r; }
  else state.logs.push({ id: uid(), exId: ex.id, date: t, w, r });
  save();
  closeSheet();
  render();

  const card = document.querySelector(`.card[data-ex="${ex.id}"]`);
  if (hitTarget(ex, { w, r })) {
    if (card) card.classList.add('flash');
    toast(`🔥 ${ex.target}回達成！ 次回は ${fmtW(w + ex.inc)}kg`, true);
  } else {
    toast(`✓ ${ex.name} ${fmtW(w)}kg${r != null ? ` × ${r}` : ''}`);
  }
}

function renderHistory() {
  const area = $('#histArea');
  if (!area || !logCtx) return;
  const { ex } = findExercise(logCtx.exId) || {};
  if (!ex) return;
  const logs = logsFor(ex.id);

  const pts = logs.filter((l) => l.w != null).slice(-20);
  let chart;
  if (pts.length < 2) {
    chart = '<div class="chart-wrap"><div class="chart-empty">記録が2回以上たまると、重量の推移グラフが出ます</div></div>';
  } else {
    const W = 320, H = 130, px = 16, top = 18, bottom = 22;
    const ws = pts.map((p) => p.w);
    let lo = Math.min(...ws), hi = Math.max(...ws);
    if (hi === lo) { hi += 5; lo -= 5; }
    const x = (i) => px + (i * (W - px * 2)) / (pts.length - 1);
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
    const area2 = `${x(0)},${H - bottom} ${line} ${x(pts.length - 1)},${H - bottom}`;
    const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3}" fill="${i === pts.length - 1 ? '#ffb347' : '#ff7a1a'}"/>`).join('');
    const maxW = Math.max(...ws);
    chart = `
      <div class="chart-wrap">
        <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="重量の推移">
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ff7a1a" stop-opacity="0.35"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/>
          </linearGradient></defs>
          <polygon points="${area2}" fill="url(#g)"/>
          <polyline points="${line}" fill="none" stroke="#ff7a1a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
          ${dots}
          <text x="${px}" y="12" fill="#8e8e93" font-size="10" font-weight="700">MAX ${fmtW(maxW)}kg</text>
          <text x="${px}" y="${H - 6}" fill="#8e8e93" font-size="10">${shortDate(pts[0].date)}</text>
          <text x="${W - px}" y="${H - 6}" fill="#8e8e93" font-size="10" text-anchor="end">${shortDate(pts[pts.length - 1].date)}</text>
        </svg>
      </div>`;
  }

  let best = -Infinity;
  const prFlags = logs.map((l) => { const pr = l.w != null && l.w > best; if (pr) best = l.w; return pr; });
  const rows = logs
    .map((l, i) => ({ l, pr: prFlags[i] && i > 0 }))
    .reverse()
    .slice(0, 15)
    .map(({ l, pr }) => `
      <li>
        <span class="d">${shortDate(l.date)}</span>
        <span class="v">${fmtW(l.w)}kg${l.r != null ? ` × ${l.r}` : ''}</span>
        ${hitTarget(ex, l) ? '<span class="pr">🔥</span>' : ''}${pr ? '<span class="pr">PR</span>' : ''}
        <button class="del" data-act="del-log" data-log="${l.id}" aria-label="削除">✕</button>
      </li>`)
    .join('');

  area.innerHTML = chart + (rows ? `<ul class="hist" style="margin-top:8px">${rows}</ul>` : '');
}

/* ---------- edit exercise sheet ---------- */

function openExerciseEditor(exId) {
  const found = exId ? findExercise(exId) : null;
  const ex = found ? found.ex : { name: '', prog: false, target: DEFAULT_TARGET, inc: DEFAULT_INC, step: DEFAULT_STEP, base: { w: null, r: null } };
  ui.editTarget = exId || null;
  const hasLogs = exId && logsFor(exId).length > 0;

  openSheet(`
    <div class="sh-title">
      <h2>${exId ? '種目を編集' : '種目を追加'}</h2>
      <button class="icon-btn" data-close aria-label="閉じる">✕</button>
    </div>
    <div class="sh-sub">${esc(currentDay().code)} ${esc(currentDay().label)}</div>

    <label class="field"><span>種目名</span>
      <input type="text" id="exName" value="${esc(ex.name)}" placeholder="例：ベンチプレス" autocomplete="off">
    </label>

    ${hasLogs ? '' : `
    <div class="grid-3" style="grid-template-columns:1fr 1fr">
      <label class="field"><span>今の重量 (kg)</span>
        <input type="number" inputmode="decimal" id="exBaseW" value="${ex.base && ex.base.w != null ? fmtW(ex.base.w) : ''}" placeholder="--">
      </label>
      <label class="field"><span>今の回数</span>
        <input type="number" inputmode="numeric" id="exBaseR" value="${ex.base && ex.base.r != null ? ex.base.r : ''}" placeholder="--">
      </label>
    </div>`}

    <label class="toggle">
      <div>★ 自動で重量アップ<small>目標回数に届いたら次回の重量を自動で上げる</small></div>
      <span class="switch"><input type="checkbox" id="exProg" ${ex.prog ? 'checked' : ''}><i></i></span>
    </label>

    <div class="grid-3">
      <label class="field"><span>目標回数</span>
        <input type="number" inputmode="numeric" id="exTarget" value="${ex.target}">
      </label>
      <label class="field"><span>上げ幅 kg</span>
        <input type="number" inputmode="decimal" id="exInc" value="${fmtW(ex.inc)}">
      </label>
      <label class="field"><span>±ボタン kg</span>
        <input type="number" inputmode="decimal" id="exStep" value="${fmtW(ex.step)}">
      </label>
    </div>

    <div class="actions">
      <button class="btn primary" data-act="ex-save">保存</button>
      ${exId ? '<button class="btn danger" data-act="ex-delete">この種目を削除</button>' : ''}
    </div>
  `);
  if (!exId) setTimeout(() => $('#exName').focus(), 350);
}

function saveExerciseEditor() {
  const name = $('#exName').value.trim();
  if (!name) { toast('種目名を入れてください'); return; }
  const day = currentDay();
  let ex;
  if (ui.editTarget) ex = findExercise(ui.editTarget).ex;
  else { ex = newExercise(name); day.exercises.push(ex); }

  ex.name = name;
  ex.prog = $('#exProg').checked;
  ex.target = Math.max(1, Math.round(toNum($('#exTarget').value) || DEFAULT_TARGET));
  ex.inc = toNum($('#exInc').value) || DEFAULT_INC;
  ex.step = toNum($('#exStep').value) || DEFAULT_STEP;
  if ($('#exBaseW')) {
    const r = toNum($('#exBaseR').value);
    ex.base = { w: toNum($('#exBaseW').value), r: r == null ? null : Math.round(r) };
  }
  save();
  closeSheet();
  render();
}

function deleteExercise() {
  const found = findExercise(ui.editTarget);
  if (!found) return;
  if (!confirm(`「${found.ex.name}」と、その記録を削除しますか？`)) return;
  snapshot(`${found.ex.name}の削除`);
  found.day.exercises = found.day.exercises.filter((e) => e.id !== found.ex.id);
  state.logs = state.logs.filter((l) => l.exId !== found.ex.id);
  save();
  closeSheet();
  render();
}

function moveExercise(exId, to) {
  const found = findExercise(exId);
  if (!found) return;
  const arr = found.day.exercises;
  const from = arr.indexOf(found.ex);
  if (from === to || to < 0 || to >= arr.length) return;
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  save();
}

/* ---------- drag to reorder (edit mode) ---------- */

let drag = null;

function dragShift() {
  const { cards, card, from, to, slot } = drag;
  cards.forEach((c, i) => {
    if (c === card) return;
    let shift = 0;
    if (from < to && i > from && i <= to) shift = -slot;
    else if (from > to && i >= to && i < from) shift = slot;
    c.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function dragMove(clientY) {
  const dy = clientY - drag.startY + (window.scrollY - drag.startScroll);
  drag.card.style.transform = `translateY(${dy}px) scale(1.03)`;
  const to = Math.max(0, Math.min(drag.cards.length - 1, Math.round(drag.from + dy / drag.slot)));
  if (to !== drag.to) {
    drag.to = to;
    dragShift();
  }
}

function dragEnd() {
  if (!drag) return;
  const { card, from, to, raf } = drag;
  cancelAnimationFrame(raf);
  drag = null;
  $('#list').classList.remove('sorting');
  if (to !== from) moveExercise(card.dataset.ex, to);
  renderList();
}

// 画面の端に指を持っていったら自動でスクロール
function dragAutoScroll() {
  if (!drag) return;
  const edge = 90;
  let v = 0;
  if (drag.y < edge) v = -Math.ceil((edge - drag.y) / 8);
  else if (drag.y > window.innerHeight - edge) v = Math.ceil((drag.y - (window.innerHeight - edge)) / 8);
  if (v) {
    window.scrollBy(0, v);
    dragMove(drag.y);
  }
  drag.raf = requestAnimationFrame(dragAutoScroll);
}

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle || drag) return;
  const card = handle.closest('.card');
  const cards = [...$('#list').querySelectorAll('.card.editing')];
  if (cards.length < 2) return;
  e.preventDefault();
  drag = {
    pointerId: e.pointerId,
    card,
    cards,
    from: cards.indexOf(card),
    to: cards.indexOf(card),
    slot: cards[1].offsetTop - cards[0].offsetTop,
    startY: e.clientY,
    startScroll: window.scrollY,
    y: e.clientY,
    raf: 0,
  };
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  card.classList.add('dragging');
  $('#list').classList.add('sorting');
  drag.raf = requestAnimationFrame(dragAutoScroll);
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  drag.y = e.clientY;
  dragMove(e.clientY);
}, { passive: false });

document.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) dragEnd(); });
document.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) dragEnd(); });

function renameDay() {
  const day = currentDay();
  const code = prompt('タブの名前（例：PUSH）', day.code);
  if (code == null) return;
  const label = prompt('サブタイトル（例：胸の日）', day.label);
  if (label == null) return;
  day.code = code.trim() || day.code;
  day.label = label.trim();
  save();
  render();
}

/* ---------- settings ---------- */

function exportMemo() {
  return '筋トレメモ\n' + state.days
    .map((d) => d.exercises
      .map((ex) => {
        const rec = lastRecord(ex);
        if (!rec) return ex.name;
        return [ex.name, rec.w != null ? fmtW(rec.w) : null, rec.r != null ? rec.r : null]
          .filter((v) => v != null).join(' ');
      })
      .join('\n'))
    .join('\n\n');
}

function openSettings() {
  const u = readUndo();
  const undoBtn = u
    ? `<button data-act="undo"><span class="ic">↩️</span><div>直前の操作を取り消す<small>「${esc(u.label)}」の前に戻す（${shortDate(todayStrOf(new Date(u.at)))}）</small></div></button>`
    : '';
  openSheet(`
    <div class="sh-title">
      <h2>設定</h2>
      <button class="icon-btn" data-close aria-label="閉じる">✕</button>
    </div>
    <div class="sh-sub">データはこのiPhoneの中だけに保存されます</div>

    <div class="menu">
      <button data-act="export-memo"><span class="ic">📋</span><div>メモ形式でコピー<small>今の重量と回数を、いつものメモの形でコピー</small></div></button>
      <button data-act="import-memo"><span class="ic">📝</span><div>メモから取り込み<small>メモを貼り付けて、種目と重量を作り直す</small></div></button>
      <button data-act="add-day"><span class="ic">➕</span><div>日（タブ）を追加</div></button>
      <button data-act="delete-day"><span class="ic">🗂️</span><div>今の日（${esc(currentDay() ? currentDay().code : '')}）を削除</div></button>
    </div>

    <div class="section-label">BACKUP</div>
    <div class="menu">
      <button data-act="backup"><span class="ic">💾</span><div>バックアップをコピー<small>全記録をテキストでコピー（メモアプリ等に保存）</small></div></button>
      <button data-act="restore"><span class="ic">♻️</span><div>バックアップから復元</div></button>
      ${undoBtn}
      <button class="danger" data-act="reset"><span class="ic">⚠️</span><div>すべてリセット</div></button>
    </div>
    <p class="note">ホーム画面に追加したアプリと Safari とでは保存場所が別になります。機種変更の前などは「バックアップをコピー」で保存しておくと安心です。</p>
  `);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch (_) {
    openTextSheet('コピー用テキスト', text, null);
  }
}

function openTextSheet(title, value, action, hint = '') {
  openSheet(`
    <div class="sh-title">
      <h2>${esc(title)}</h2>
      <button class="icon-btn" data-close aria-label="閉じる">✕</button>
    </div>
    ${hint ? `<div class="sh-sub">${hint}</div>` : '<div class="sh-sub"></div>'}
    <label class="field"><textarea id="bigText" spellcheck="false">${esc(value)}</textarea></label>
    ${action ? `<button class="btn primary" data-act="${action}">実行する</button>` : ''}
  `);
}

function doImportMemo() {
  const days = parseMemo($('#bigText').value);
  if (!days.length || !days.some((d) => d.exercises.length)) { toast('種目が読み取れませんでした'); return; }
  const n = days.reduce((a, d) => a + d.exercises.length, 0);

  // 同じ名前の種目は、今の設定と記録をそのまま引き継ぐ
  const oldByName = new Map();
  state.days.forEach((d) => d.exercises.forEach((e) => { if (!oldByName.has(e.name)) oldByName.set(e.name, e); }));
  let kept = 0;
  days.forEach((d) => {
    d.exercises = d.exercises.map((e) => {
      const old = oldByName.get(e.name);
      if (!old) return e;
      oldByName.delete(e.name);
      kept++;
      return { ...e, id: old.id, prog: old.prog, target: old.target, inc: old.inc, step: old.step };
    });
  });
  const ids = new Set(days.flatMap((d) => d.exercises.map((e) => e.id)));
  const logs = state.logs.filter((l) => ids.has(l.exId));

  if (!confirm(`${days.length}日・${n}種目を取り込みます。\n同じ名前の${kept}種目は記録を引き継ぎます。\n（あとで「直前の操作を取り消す」で戻せます）`)) return;
  snapshot('メモから取り込み');
  state = { v: 1, days, logs };
  ui.dayId = null;
  save();
  closeSheet();
  render();
  toast('取り込みました');
}

function doRestore() {
  try {
    const s = JSON.parse($('#bigText').value);
    if (!isValidState(s)) throw new Error('bad');
    if (!confirm('バックアップの内容で上書きします。よろしいですか？')) return;
    snapshot('バックアップから復元');
    state = s;
    ui.dayId = null;
    save();
    closeSheet();
    render();
    toast('復元しました');
  } catch (_) {
    toast('バックアップの形式が正しくありません');
  }
}

/* ---------- toast ---------- */

let toastTimer = null;
function toast(msg, fire = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('fire', fire);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), fire ? 2800 : 1800);
}

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t) return;

  if (t.hasAttribute('data-close')) { closeSheet(); return; }

  if (t.dataset.day) {
    ui.dayId = t.dataset.day;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (t.dataset.step) { stepInput(t.dataset.step, Number(t.dataset.d)); return; }

  const act = t.dataset.act;
  if (!act && t.classList.contains('card') && t.dataset.ex) { openLog(t.dataset.ex); return; }

  switch (act) {
    case 'toggle-edit': ui.editing = !ui.editing; render(); break;
    case 'rename-day': renameDay(); break;
    case 'edit-ex': openExerciseEditor(t.dataset.ex); break;
    case 'add-ex': openExerciseEditor(null); break;
    case 'ex-save': saveExerciseEditor(); break;
    case 'ex-delete': deleteExercise(); break;

    case 'log-save': { const { w, r } = readInputs(); saveLog(w, r); break; }
    case 'log-same': {
      const prev = prevRecord(findExercise(logCtx.exId).ex);
      if (prev) saveLog(prev.w, prev.r);
      break;
    }
    case 'del-log': {
      if (!confirm('この記録を削除しますか？')) break;
      state.logs = state.logs.filter((l) => l.id !== t.dataset.log);
      save();
      renderHistory();
      render();
      break;
    }

    case 'export-memo': copyText(exportMemo(), '📋 メモ形式でコピーしました'); break;
    case 'import-memo':
      openTextSheet('メモから取り込み', '', 'do-import',
        '「種目名 重量 回数」を1行ずつ。空行で日を区切ります。<br>例：ベンチプレス 70 4 ／ レッグカール 45');
      break;
    case 'do-import': doImportMemo(); break;
    case 'add-day': {
      const code = prompt('新しい日の名前（例：ARMS）', `DAY ${state.days.length + 1}`);
      if (!code) break;
      const d = { id: uid(), code: code.trim(), label: '', exercises: [] };
      state.days.push(d);
      ui.dayId = d.id;
      ui.editing = true;
      save();
      closeSheet();
      render();
      break;
    }
    case 'delete-day': {
      const day = currentDay();
      if (!day || !confirm(`「${day.code}」とその種目・記録を削除しますか？`)) break;
      snapshot(`${day.code}の削除`);
      const ids = new Set(day.exercises.map((x) => x.id));
      state.days = state.days.filter((d) => d.id !== day.id);
      state.logs = state.logs.filter((l) => !ids.has(l.exId));
      ui.dayId = null;
      save();
      closeSheet();
      render();
      break;
    }
    case 'backup': copyText(JSON.stringify(state), '💾 バックアップをコピーしました'); break;
    case 'restore': openTextSheet('バックアップから復元', '', 'do-restore', 'コピーしておいたバックアップを貼り付けてください'); break;
    case 'do-restore': doRestore(); break;
    case 'undo': undoLast(); break;
    case 'reset':
      if (!confirm('すべての種目と記録を消して、最初の状態に戻しますか？')) break;
      snapshot('すべてリセット');
      state = freshState();
      ui.dayId = null;
      save();
      closeSheet();
      render();
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'inW' || e.target.id === 'inR') updateProgBox();
});

// 入力欄をタップしたら全選択して打ち直しやすく
document.addEventListener('focusin', (e) => {
  if (e.target.id === 'inW' || e.target.id === 'inR') setTimeout(() => e.target.select(), 0);
});

$('#settingsBtn').addEventListener('click', openSettings);

// アプリに戻ってきたら表示を更新。選んでいるタブは、日付が変わった時だけおすすめに戻す
let shownDate = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('#sheet').classList.contains('open')) return;
  if (todayStr() !== shownDate) {
    shownDate = todayStr();
    ui.dayId = null;
  }
  render();
});

/* ---------- boot ---------- */

ui.dayId = suggestedDayId();
render();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
