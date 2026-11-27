import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, deleteDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// Data layout in Firestore, one tree per signed-in user:
//   users/{uid}                       { rate }
//   users/{uid}/kids/{id}             { name, emoji, created }
//   users/{uid}/activities/{id}       { name, points, created }
//   users/{uid}/rewards/{id}          { name, points, created }
//   users/{uid}/tx/{id}               { kidId, kind: 'earn'|'spend', points, label, note, date, created }
const COLLS = ['kids', 'activities', 'rewards', 'tx'];
const DAY = 24 * 60 * 60 * 1000;

const app = document.getElementById('app');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const settingsLink = document.getElementById('settings-link');

// ---------- helpers

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const localIso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => localIso(new Date());
const pts = n => `${n} pt${Math.abs(n) === 1 ? '' : 's'}`;
const rupees = n => '₹' + (n * db.rate).toLocaleString('en-IN');

function fmtDate(iso) {
  const now = new Date();
  if (iso === localIso(now)) return 'Today';
  if (iso === localIso(new Date(now.getTime() - DAY))) return 'Yesterday';
  const d = new Date(iso + 'T00:00');
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// Builds DOM nodes. Text children are always inserted as text, never as HTML.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ---------- data cleaning (used for Firestore documents and backup files)

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const whole = v => Math.max(1, Math.round(Math.abs(Number(v)) || 1));

const clean = {
  kids: k => ({ id: str(k.id) || uid(), name: str(k.name) || '(no name)', emoji: str(k.emoji) || '🙂',
    created: Number(k.created) || 0 }),
  activities: a => ({ id: str(a.id) || uid(), name: str(a.name) || '(no name)', points: whole(a.points),
    created: Number(a.created) || 0 }),
  rewards: a => clean.activities(a),
  tx: t => ({
    id: str(t.id) || uid(),
    kidId: str(t.kidId),
    kind: t.kind === 'spend' ? 'spend' : 'earn',
    points: whole(t.points),
    label: str(t.label) || '(no description)',
    note: str(t.note),
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today(),
    created: Number(t.created) || Date.now(),
  }),
};

function parseBackup(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.kids) || !Array.isArray(d.tx)) {
    throw new Error('This is not an Ewyl Points backup file.');
  }
  const out = { rate: Number(d.rate) > 0 ? Number(d.rate) : 10 };
  for (const c of COLLS) out[c] = (Array.isArray(d[c]) ? d[c] : []).map(clean[c]);
  return out;
}

function defaultItems() {
  const now = Date.now();
  const mk = (name, points, i) => ({ id: uid(), name, points, created: now + i });
  return {
    activities: [
      mk('Homework done', 2, 0), mk('Read for 30 minutes', 2, 1), mk('Helped with chores', 1, 2),
      mk('Tidied room', 1, 3), mk('Good test result', 5, 4),
    ],
    rewards: [mk('Ice cream', 3, 0), mk('30 min extra screen time', 2, 1)],
  };
}

const emptyDb = () => ({ rate: 10, kids: [], activities: [], rewards: [], tx: [] });

// ---------- Firebase

const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('PASTE');
let auth;
let fs;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  // Keeps a copy on the phone: the app opens and works offline, and syncs changes later.
  fs = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
}

let db = emptyDb();
let user;             // undefined = still checking, null = signed out
let ready = false;    // first snapshot of everything has arrived
let unsubs = [];
let seeded = false;

const userDoc = () => doc(fs, 'users', user.uid);
const itemRef = (c, id) => doc(collection(userDoc(), c), id);
const withoutId = ({ id, ...rest }) => rest;

let errorShown = false;
function onSyncError(e) {
  console.error(e);
  if (errorShown) return;
  errorShown = true;
  alert('Could not sync with the cloud: ' + e.message);
}

// Writes go to the local cache instantly and to the server when online,
// so these are deliberately not awaited.
const put = (c, obj) => setDoc(itemRef(c, obj.id), withoutId(obj)).catch(onSyncError);
const del = (c, id) => deleteDoc(itemRef(c, id)).catch(onSyncError);
const setRate = rate => setDoc(userDoc(), { rate }, { merge: true }).catch(onSyncError);

// Firestore allows up to 500 writes per batch.
function runBatch(ops) {
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(fs);
    for (const op of ops.slice(i, i + 400)) op(b);
    jobs.push(b.commit());
  }
  return Promise.all(jobs).catch(onSyncError);
}

function seedDefaults() {
  if (seeded) return;
  seeded = true;
  const items = defaultItems();
  runBatch([
    b => b.set(userDoc(), { rate: 10 }, { merge: true }),
    ...['activities', 'rewards'].flatMap(c => items[c].map(it => b => b.set(itemRef(c, it.id), withoutId(it)))),
  ]);
}

function stopSync() {
  unsubs.forEach(u => u());
  unsubs = [];
  db = emptyDb();
  ready = false;
  seeded = false;
}

function startSync() {
  stopSync();
  const pending = new Set(['settings', ...COLLS]);
  const arrived = key => {
    pending.delete(key);
    if (!pending.size) ready = true;
    if (ready) render();
  };
  unsubs.push(onSnapshot(userDoc(), snap => {
    if (snap.exists()) {
      const r = Number(snap.data().rate);
      db.rate = r > 0 ? r : 10;
    } else if (!snap.metadata.fromCache) {
      seedDefaults(); // first sign-in ever for this account
    }
    arrived('settings');
  }, onSyncError));
  for (const c of COLLS) {
    unsubs.push(onSnapshot(collection(userDoc(), c), snap => {
      db[c] = snap.docs.map(d => clean[c]({ ...d.data(), id: d.id }));
      if (c !== 'tx') db[c].sort((a, b) => a.created - b.created);
      arrived(c);
    }, onSyncError));
  }
}

async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      alert('Sign-in failed: ' + e.message);
    }
  }
}

// ---------- derived data

const balance = kidId => db.tx.reduce(
  (sum, t) => (t.kidId === kidId ? sum + (t.kind === 'earn' ? t.points : -t.points) : sum), 0);
const byNewest = (a, b) => b.date.localeCompare(a.date) || b.created - a.created;
const kidTx = kidId => db.tx.filter(t => t.kidId === kidId).sort(byNewest);

// ---------- dialogs

function field(label, input) {
  return h('label', { class: 'field' }, h('span', null, label), input);
}

// onSubmit returns an error message to keep the dialog open, or nothing to close it.
function openDialog({ title, body, submit = 'Save', onSubmit, extraButtons = [] }) {
  const err = h('p', { class: 'error', hidden: true });
  const dlg = h('dialog');
  const form = h('form', { method: 'dialog' },
    h('h2', null, title),
    body,
    err,
    h('div', { class: 'dlg-actions' },
      extraButtons,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, submit)));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const msg = onSubmit();
    if (msg) {
      err.textContent = msg;
      err.hidden = false;
      return;
    }
    dlg.close();
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function deleteButton(question, onDelete, getDlg) {
  return h('button', {
    type: 'button',
    class: 'btn danger',
    onclick: () => {
      if (!confirm(question)) return;
      onDelete();
      getDlg().close();
    },
  }, 'Delete');
}

// Award (earn) or use (spend) points, or edit an existing entry.
function txDialog(kid, kind, existing) {
  const earn = kind === 'earn';
  const quickName = earn ? 'activities' : 'rewards';
  const quick = db[quickName];
  const name = h('input', { required: true, maxlength: 80, autocomplete: 'off',
    placeholder: earn ? 'e.g. Finished homework' : 'e.g. Ice cream' });
  const points = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, required: true });
  const rs = h('span', { class: 'muted' });
  const note = h('input', { maxlength: 200, placeholder: 'Optional' });
  const date = h('input', { type: 'date', required: true, max: today() });
  const remember = h('input', { type: 'checkbox' });

  name.value = existing ? existing.label : '';
  points.value = existing ? existing.points : '';
  note.value = existing ? existing.note : '';
  date.value = existing ? existing.date : today();

  const updateRs = () => {
    const p = parseInt(points.value, 10);
    rs.textContent = p > 0 ? `= ${rupees(p)}` : '';
  };
  points.addEventListener('input', updateRs);
  updateRs();

  const chips = quick.length && h('div', { class: 'chips' }, quick.map(q =>
    h('button', {
      type: 'button',
      class: 'chip',
      onclick: () => { name.value = q.name; points.value = q.points; updateRs(); },
    }, `${q.name} · ${q.points}`)));

  // Points available to spend; when editing a spend, its own points are given back first.
  const available = balance(kid.id) + (existing && !earn ? existing.points : 0);

  let dlg;
  dlg = openDialog({
    title: existing ? 'Edit entry' : earn ? `Award points to ${kid.name}` : `${kid.name} uses points`,
    body: [
      !earn && h('p', { class: 'muted' }, `Available: ${pts(available)} (${rupees(available)})`),
      !existing && chips,
      field(earn ? 'Activity' : 'Spent on', name),
      field('Points', h('div', { class: 'row' }, points, rs)),
      field('Note', note),
      field('Date', date),
      !existing && h('label', { class: 'check' }, remember,
        earn ? 'Add to quick activities' : 'Add to quick rewards'),
    ],
    submit: existing ? 'Save' : earn ? 'Award' : 'Deduct',
    extraButtons: existing ? [deleteButton('Delete this entry?', () => del('tx', existing.id), () => dlg)] : [],
    onSubmit: () => {
      const label = name.value.trim();
      const p = parseInt(points.value, 10);
      if (!label) return 'Enter a description.';
      if (!(p > 0)) return 'Points must be a whole number above 0.';
      if (!earn && p > available) return `Not enough points: ${kid.name} has ${pts(available)}.`;
      const fields = { label, points: p, note: note.value.trim(), date: date.value || today() };
      if (existing) {
        put('tx', { ...existing, ...fields });
      } else {
        put('tx', { id: uid(), kidId: kid.id, kind, ...fields, created: Date.now() });
        if (remember.checked && !quick.some(q => q.name.toLowerCase() === label.toLowerCase())) {
          put(quickName, { id: uid(), name: label, points: p, created: Date.now() });
        }
      }
    },
  });
}

function editKid(kid) {
  const name = h('input', { required: true, maxlength: 40, autocomplete: 'off' });
  const emoji = h('input', { maxlength: 8, class: 'emoji-input' });
  name.value = kid ? kid.name : '';
  emoji.value = kid ? kid.emoji : '🙂';
  let dlg;
  dlg = openDialog({
    title: kid ? 'Edit kid' : 'Add a kid',
    body: [field('Name', name), field('Emoji', emoji)],
    extraButtons: kid ? [deleteButton(
      `Delete ${kid.name} and all of their ${kidTx(kid.id).length} entries? This cannot be undone.`,
      () => {
        runBatch([
          b => b.delete(itemRef('kids', kid.id)),
          ...kidTx(kid.id).map(t => b => b.delete(itemRef('tx', t.id))),
        ]);
        location.hash = '#/settings';
      },
      () => dlg)] : [],
    onSubmit: () => {
      const n = name.value.trim();
      if (!n) return 'Enter a name.';
      const e = emoji.value.trim() || '🙂';
      put('kids', kid ? { ...kid, name: n, emoji: e } : { id: uid(), name: n, emoji: e, created: Date.now() });
    },
  });
}

// Edit an item in the quick activities or quick rewards list.
function editQuick(listName, item) {
  const name = h('input', { required: true, maxlength: 80, autocomplete: 'off' });
  const points = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, required: true });
  name.value = item ? item.name : '';
  points.value = item ? item.points : '';
  const what = listName === 'activities' ? 'activity' : 'reward';
  let dlg;
  dlg = openDialog({
    title: item ? `Edit ${what}` : `Add ${what}`,
    body: [field('Name', name), field('Points', points)],
    extraButtons: item ? [deleteButton(`Delete "${item.name}"?`, () => del(listName, item.id), () => dlg)] : [],
    onSubmit: () => {
      const n = name.value.trim();
      const p = parseInt(points.value, 10);
      if (!n) return 'Enter a name.';
      if (!(p > 0)) return 'Points must be a whole number above 0.';
      put(listName, item ? { ...item, name: n, points: p } : { id: uid(), name: n, points: p, created: Date.now() });
    },
  });
}

// ---------- backup files (optional extra copy; the cloud is the main store)

function exportData() {
  const data = { version: 1, exported: new Date().toISOString(), rate: db.rate };
  for (const c of COLLS) data[c] = db[c];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `ewyl-points-backup-${today()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Deletes every document for this user and optionally writes new data in its place.
function replaceAll(data) {
  const ops = [];
  for (const c of COLLS) {
    const keep = new Set(data ? data[c].map(x => x.id) : []);
    for (const x of db[c]) if (!keep.has(x.id)) ops.push(b => b.delete(itemRef(c, x.id)));
    if (data) for (const x of data[c]) ops.push(b => b.set(itemRef(c, x.id), withoutId(x)));
  }
  ops.push(b => b.set(userDoc(), { rate: data ? data.rate : 10 }, { merge: true }));
  return runBatch(ops);
}

async function importData(file) {
  try {
    const data = parseBackup(JSON.parse(await file.text()));
    const msg = `Replace everything with this backup (${data.kids.length} kids, ` +
      `${data.tx.length} entries)? Current data will be lost.`;
    if (!confirm(msg)) return;
    replaceAll(data);
    location.hash = '#/';
  } catch (e) {
    alert('Could not read that file. ' + e.message);
  }
}

// ---------- pages

function setHeader(title, showBack) {
  titleEl.textContent = title;
  document.title = title === 'Ewyl Points' ? title : `${title} · Ewyl Points`;
  backBtn.hidden = !showBack;
  settingsLink.hidden = showBack || !user;
}

function renderMessage(...children) {
  setHeader('Ewyl Points', false);
  app.append(h('div', { class: 'empty' }, children));
}

function renderSetup() {
  renderMessage(
    h('div', { class: 'empty-icon' }, '🔧'),
    h('p', null, 'Firebase is not set up yet.'),
    h('p', { class: 'muted' }, 'Paste your Firebase web app config into firebase-config.js. See README.md.'));
}

function renderSignIn() {
  renderMessage(
    h('div', { class: 'empty-icon' }, '⭐'),
    h('p', null, "Track the points your kids earn, and what they spend them on."),
    h('button', { class: 'btn primary', onclick: signIn }, 'Sign in with Google'));
}

function txRow(t, showKid) {
  const kid = db.kids.find(k => k.id === t.kidId);
  return h('button', { class: 'tx', onclick: () => { if (kid) txDialog(kid, t.kind, t); } },
    h('span', { class: 'tx-main' },
      h('span', { class: 'tx-label' }, showKid && kid ? `${kid.emoji} ${kid.name}: ${t.label}` : t.label),
      t.note && h('span', { class: 'tx-note' }, t.note)),
    h('span', { class: `tx-pts ${t.kind}` }, (t.kind === 'earn' ? '+' : '−') + t.points));
}

function historyList(txs, showKid) {
  if (!txs.length) return h('p', { class: 'muted center' }, 'Nothing here yet.');
  const out = h('div', { class: 'history' });
  let lastDate;
  for (const t of txs) {
    if (t.date !== lastDate) {
      out.append(h('h3', { class: 'day' }, fmtDate(t.date)));
      lastDate = t.date;
    }
    out.append(txRow(t, showKid));
  }
  return out;
}

function renderHome() {
  setHeader('Ewyl Points', false);
  if (!db.kids.length) {
    renderMessage(
      h('div', { class: 'empty-icon' }, '⭐'),
      h('p', null, 'Add your kids to start tracking their points.'),
      h('button', { class: 'btn primary', onclick: () => editKid() }, 'Add a kid'));
    return;
  }

  app.append(h('div', { class: 'kids' }, db.kids.map(k => {
    const b = balance(k.id);
    return h('a', { class: 'kid-card', href: `#/kid/${encodeURIComponent(k.id)}` },
      h('span', { class: 'emoji' }, k.emoji),
      h('span', { class: 'name' }, k.name),
      h('span', { class: 'bal' }, pts(b)),
      h('span', { class: 'rs' }, rupees(b)));
  })));

  app.append(h('h2', { class: 'section' }, 'Recent'),
    historyList(db.tx.slice().sort(byNewest).slice(0, 15), true));
}

let kidFilter = 'all';

function renderKid(kid) {
  setHeader(`${kid.emoji} ${kid.name}`, true);
  const b = balance(kid.id);
  const txs = kidTx(kid.id);
  const month = today().slice(0, 7);
  let earnedMonth = 0;
  let spentMonth = 0;
  for (const t of txs) {
    if (!t.date.startsWith(month)) continue;
    if (t.kind === 'earn') earnedMonth += t.points;
    else spentMonth += t.points;
  }
  const stat = (label, value) => h('div', { class: 'stat' },
    h('span', { class: 'stat-val' }, value), h('span', { class: 'stat-label' }, label));
  const tab = (key, label) => h('button', {
    class: 'tab' + (kidFilter === key ? ' active' : ''),
    onclick: () => { kidFilter = key; render(); },
  }, label);

  app.append(
    h('section', { class: 'balance' + (b < 0 ? ' negative' : '') },
      h('div', { class: 'big' }, b),
      h('div', { class: 'unit' }, `points · worth ${rupees(b)}`)),
    h('div', { class: 'stats' },
      stat('earned this month', '+' + earnedMonth),
      stat('used this month', '−' + spentMonth)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn earn', onclick: () => txDialog(kid, 'earn') }, '+ Award points'),
      h('button', { class: 'btn spend', onclick: () => txDialog(kid, 'spend') }, '− Use points')),
    h('div', { class: 'tabs' }, tab('all', 'All'), tab('earn', 'Earned'), tab('spend', 'Used')),
    historyList(kidFilter === 'all' ? txs : txs.filter(t => t.kind === kidFilter), false));
}

function renderSettings() {
  setHeader('Settings', true);

  const rate = h('input', { type: 'number', inputmode: 'decimal', min: 0.01, step: 'any', class: 'rate-input' });
  rate.value = db.rate;
  rate.addEventListener('change', () => {
    const r = Number(rate.value);
    if (r > 0) setRate(r);
    else rate.value = db.rate;
  });

  const listSection = (title, items, label, onEdit, onAdd, addLabel) => h('section', { class: 'card' },
    h('h2', null, title),
    items.length ? h('div', { class: 'list' }, items.map(it =>
      h('button', { class: 'list-row', onclick: () => onEdit(it) }, label(it), h('span', { class: 'chev' }, '›'))))
      : h('p', { class: 'muted' }, 'None yet.'),
    h('button', { class: 'btn', onclick: onAdd }, addLabel));

  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) importData(f); },
  });

  app.append(
    h('section', { class: 'card' },
      h('h2', null, 'Value of a point'),
      h('label', { class: 'row' }, '1 point = ₹', rate)),
    listSection('Kids', db.kids, k => `${k.emoji} ${k.name}`, k => editKid(k), () => editKid(), 'Add a kid'),
    listSection('Quick activities', db.activities, a => `${a.name} · ${pts(a.points)}`,
      a => editQuick('activities', a), () => editQuick('activities'), 'Add activity'),
    listSection('Quick rewards', db.rewards, r => `${r.name} · ${pts(r.points)}`,
      r => editQuick('rewards', r), () => editQuick('rewards'), 'Add reward'),
    h('section', { class: 'card' },
      h('h2', null, 'Account'),
      h('p', { class: 'muted' }, `Signed in as ${user.email || user.displayName || 'unknown'}. ` +
        'Your data is saved to the cloud and syncs to any phone where you sign in with this account.'),
      h('button', { class: 'btn', onclick: () => { if (confirm('Sign out?')) signOut(auth); } }, 'Sign out')),
    h('section', { class: 'card' },
      h('h2', null, 'Backup file'),
      h('p', { class: 'muted' }, 'Optional: download a copy of everything, or restore from one.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportData }, 'Download backup'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Restore from file')),
      fileInput),
    h('section', { class: 'card' },
      h('h2', null, 'Erase everything'),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          if (!confirm('Erase all kids, points and history from the cloud? This cannot be undone.')) return;
          replaceAll({ rate: 10, kids: [], tx: [], ...defaultItems() });
          location.hash = '#/';
        },
      }, 'Erase all data')));
}

// ---------- routing

let lastRoute = null;
function render() {
  const route = location.hash.slice(1) || '/';
  const [, page, id] = route.split('/');
  if (route !== lastRoute) {
    window.scrollTo(0, 0);
    if (page !== 'kid' || lastRoute === null || !lastRoute.startsWith('/kid/')) kidFilter = 'all';
    lastRoute = route;
  }
  app.replaceChildren();
  if (!configured) return renderSetup();
  if (user === undefined || (user && !ready)) return renderMessage(h('p', { class: 'muted' }, 'Loading…'));
  if (!user) return renderSignIn();
  if (page === 'kid') {
    const kid = db.kids.find(k => k.id === decodeURIComponent(id || ''));
    if (kid) return renderKid(kid);
    location.hash = '#/';
    return;
  }
  if (page === 'settings') return renderSettings();
  renderHome();
}

backBtn.addEventListener('click', () => { location.hash = '#/'; });
window.addEventListener('hashchange', render);

if (configured) {
  onAuthStateChanged(auth, u => {
    user = u;
    if (u) startSync();
    else stopSync();
    render();
  });
}
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
}
