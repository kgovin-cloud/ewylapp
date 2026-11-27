import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updatePassword, signOut,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, deleteDoc, writeBatch, getDoc,
  query, where, getDocs, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import * as config from './firebase-config.js';

const { firebaseConfig } = config;
// Optional reCAPTCHA Enterprise site key for Firebase App Check, which protects the AI calls.
const appCheckSiteKey = config.appCheckSiteKey || '';
const SDK = 'https://www.gstatic.com/firebasejs/12.6.0/';
const AI_MODEL = 'gemini-4-hydrogen';

// Data layout in Firestore, one tree per family, stored under the uid of the parent who created it:
//   users/{uid}                       { rate, members: [parent emails], ownerEmail }
//   users/{uid}/kids/{id}             { name, emoji, birthYear, interests, goalId, username, loginUid, created }
//   users/{uid}/activities/{id}       { name, points, created }
//   users/{uid}/rewards/{id}          { name, points, icon, created }
//   users/{uid}/tx/{id}               { kidId, kind: 'earn'|'spend', points, label, note, date, created }
//   users/{uid}/themes/{id}           { text, created }   themes for AI reward ideas (parents only)
//   kidLogins/{kid's auth uid}        { ownerUid, kidId, username }   links a kid's login to their data
// Parents sign in with Google. Kids sign in with a username and password that a parent creates;
// Firebase needs an email, so the username becomes username@KID_DOMAIN behind the scenes.
const COLLS = ['kids', 'activities', 'rewards', 'tx', 'themes'];
const KID_DOMAIN = '@kids.ewylapp.web.app';
const DAY = 24 * 60 * 60 * 1000;
const PRESETS = [1, 2, 5, 10, 20, 50];

const app = document.getElementById('app');
const kidTabsEl = document.getElementById('kid-tabs');
const navEl = document.getElementById('nav');
const rateBadge = document.getElementById('rate-badge');
const syncPill = document.getElementById('sync-pill');
const toastEl = document.getElementById('toast');

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
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

let toastTimer;
function toast(msg, icon = '✨') {
  toastEl.textContent = `${icon} ${msg}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

// ---------- data cleaning (used for Firestore documents and backup files)

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const whole = v => Math.max(1, Math.round(Math.abs(Number(v)) || 1));

const clean = {
  kids: k => ({ id: str(k.id) || uid(), name: str(k.name) || '(no name)', emoji: str(k.emoji) || '🙂',
    birthYear: Number(k.birthYear) > 1900 ? Math.round(Number(k.birthYear)) : 0, interests: str(k.interests),
    goalId: str(k.goalId), username: str(k.username), loginUid: str(k.loginUid), created: Number(k.created) || 0 }),
  themes: t => ({ id: str(t.id) || uid(), text: str(t.text) || '(empty)', created: Number(t.created) || 0 }),
  activities: a => ({ id: str(a.id) || uid(), name: str(a.name) || '(no name)', points: whole(a.points),
    created: Number(a.created) || 0 }),
  // notFor: ids of kids this reward is not suggested to. Empty means every kid, including kids added later.
  rewards: a => ({ ...clean.activities(a), icon: str(a.icon) || '🎁',
    notFor: Array.isArray(a.notFor) ? a.notFor.map(str).filter(Boolean) : [] }),
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
    throw new Error('This is not an EWYL backup file.');
  }
  const out = { rate: Number(d.rate) > 0 ? Number(d.rate) : 10 };
  for (const c of COLLS) out[c] = (Array.isArray(d[c]) ? d[c] : []).map(clean[c]);
  return out;
}

function defaultItems() {
  const now = Date.now();
  const mk = (name, points, i, icon) => ({ id: uid(), name, points, created: now + i, ...(icon && { icon }) });
  return {
    activities: [
      mk('Homework done', 2, 0), mk('Read for 30 minutes', 2, 1), mk('Helped with chores', 1, 2),
      mk('Tidied room', 1, 3), mk('Good test result', 5, 4),
    ],
    rewards: [mk('Ice cream', 3, 0, '🍨'), mk('30 min extra screen time', 2, 1, '🎮')],
  };
}

const emptyDb = () => ({
  rate: 10, members: [], ownerEmail: '', kids: [], activities: [], rewards: [], tx: [], themes: [],
});

// ---------- Firebase

const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('PASTE');
let auth;
let fs;
let fbApp;
if (configured) {
  fbApp = initializeApp(firebaseConfig);
  if (appCheckSiteKey) {
    import(SDK + 'firebase-app-check.js').then(({ initializeAppCheck, ReCaptchaEnterpriseProvider }) => {
      initializeAppCheck(fbApp, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
    }).catch(e => console.warn('App Check not started', e));
  }
  auth = getAuth(fbApp);
  // Keeps a copy on the phone: the app opens and works offline, and syncs changes later.
  fs = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
}

let db = emptyDb();
let user;             // undefined = still checking, null = signed out
let role;             // 'parent' or 'kid'
let kidLink;          // for a kid: { ownerUid, kidId, username }
let ready = false;    // first snapshot of everything has arrived
let unsubs = [];
let seeded = false;
let ownerUid;         // whose data tree is shown
const pending = new Map(); // listener -> has local writes not yet on the server

const userDoc = () => doc(fs, 'users', ownerUid);
const isOwner = () => role === 'parent' && user && ownerUid === user.uid;
const isParent = () => role === 'parent';
const ownerKey = u => 'ewyl-owner-' + u.uid;
const linkKey = u => 'ewyl-kidlink-' + u.uid;
const itemRef = (c, id) => doc(collection(userDoc(), c), id);
const loginRef = loginUid => doc(fs, 'kidLogins', loginUid);
const withoutId = ({ id, ...rest }) => rest;
const isKidEmail = email => (email || '').toLowerCase().endsWith(KID_DOMAIN);

let errorShown = false;
function onSyncError(e) {
  console.error(e);
  if (e.code === 'permission-denied' && user && role === 'kid') {
    localStorage.removeItem(linkKey(user));
    alert('This login is no longer active. Ask a parent for a new one.');
    signOut(auth);
    return;
  }
  if (e.code === 'permission-denied' && user && ownerUid && role === 'parent' && !isOwner()) {
    // The family owner removed this account. Go back to this account's own data.
    localStorage.removeItem(ownerKey(user));
    alert('You no longer have access to the shared family data.');
    location.reload();
    return;
  }
  if (errorShown) return;
  errorShown = true;
  alert('Could not sync with the cloud: ' + e.message);
}

// Writes go to the local cache instantly and to the server when online,
// so these are deliberately not awaited.
const put = (c, obj) => setDoc(itemRef(c, obj.id), withoutId(obj)).catch(onSyncError);
const patch = (c, id, fields) => setDoc(itemRef(c, id), fields, { merge: true }).catch(onSyncError);
const del = (c, id) => deleteDoc(itemRef(c, id)).catch(onSyncError);
const setSettings = fields => setDoc(userDoc(), fields, { merge: true }).catch(onSyncError);

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
  pending.clear();
  db = emptyDb();
  ready = false;
  seeded = false;
}

// Parents get the whole family tree. A kid gets the settings, their own kid record, their own
// entries and the reward store, which is all the security rules let them read.
function startSync(owner, kidId) {
  stopSync();
  ownerUid = owner;
  const colls = kidId ? ['kids', 'rewards', 'tx'] : COLLS;
  const waiting = new Set(['settings', ...colls]);
  const arrived = key => {
    waiting.delete(key);
    if (!waiting.size) ready = true;
    if (ready) render();
  };
  const opts = { includeMetadataChanges: true };
  unsubs.push(onSnapshot(userDoc(), opts, snap => {
    pending.set('settings', snap.metadata.hasPendingWrites);
    if (snap.exists()) {
      const data = snap.data();
      const r = Number(data.rate);
      db.rate = r > 0 ? r : 10;
      db.members = Array.isArray(data.members) ? data.members.filter(m => typeof m === 'string') : [];
      db.ownerEmail = str(data.ownerEmail);
    } else if (!snap.metadata.fromCache && isOwner()) {
      seedDefaults(); // first sign-in ever for this account
    }
    arrived('settings');
  }, onSyncError));

  const listen = (c, ref) => unsubs.push(onSnapshot(ref, opts, snap => {
    pending.set(c, snap.metadata.hasPendingWrites);
    // Only the sync status changed: update the pill without redrawing the page.
    if (!waiting.has(c) && !snap.docChanges().length) return updateChrome();
    db[c] = snap.docs.map(d => clean[c]({ ...d.data(), id: d.id }));
    if (c !== 'tx') db[c].sort((a, b) => a.created - b.created);
    arrived(c);
  }, onSyncError));

  if (kidId) {
    unsubs.push(onSnapshot(itemRef('kids', kidId), opts, snap => {
      pending.set('kids', snap.metadata.hasPendingWrites);
      db.kids = snap.exists() ? [clean.kids({ ...snap.data(), id: snap.id })] : [];
      arrived('kids');
    }, onSyncError));
    listen('rewards', collection(userDoc(), 'rewards'));
    listen('tx', query(collection(userDoc(), 'tx'), where('kidId', '==', kidId)));
  } else {
    for (const c of COLLS) listen(c, collection(userDoc(), c));
  }
}

// Finds the family this parent was added to, if any. Returns the owner's uid, or the user's own uid.
async function findFamily(u) {
  if (!u.email) return u.uid;
  const snap = await getDocs(query(collection(fs, 'users'), where('members', 'array-contains', u.email)));
  const fam = snap.docs.find(d => d.id !== u.uid);
  if (fam) return fam.id;
  // Offline with nothing cached: keep whatever was used last time on this device.
  if (snap.metadata.fromCache) return localStorage.getItem(ownerKey(u)) || u.uid;
  return u.uid;
}

async function startKid(u, seq) {
  role = 'kid';
  const cached = localStorage.getItem(linkKey(u));
  if (cached) {
    try {
      kidLink = JSON.parse(cached);
      startSync(kidLink.ownerUid, kidLink.kidId);
    } catch { kidLink = null; }
  }
  if (!kidLink) render();
  let snap;
  try {
    snap = await getDoc(loginRef(u.uid));
  } catch (e) {
    console.warn('Could not look up kid login', e);
    if (!kidLink) { alert('Could not connect. Check the internet connection and try again.'); signOut(auth); }
    return;
  }
  if (seq !== authSeq) return;
  if (!snap.exists()) {
    localStorage.removeItem(linkKey(u));
    alert('This login is no longer active. Ask a parent for a new one.');
    signOut(auth);
    return;
  }
  const link = { ownerUid: str(snap.data().ownerUid), kidId: str(snap.data().kidId), username: str(snap.data().username) };
  localStorage.setItem(linkKey(u), JSON.stringify(link));
  if (!kidLink || link.ownerUid !== kidLink.ownerUid || link.kidId !== kidLink.kidId) {
    kidLink = link;
    startSync(link.ownerUid, link.kidId);
  }
  kidLink = link;
}

async function startParent(u, seq) {
  role = 'parent';
  // Start right away with the family used last time on this device, so the app opens fast and offline.
  const cached = localStorage.getItem(ownerKey(u));
  if (cached) startSync(cached);
  else render();
  let owner;
  try {
    owner = await findFamily(u);
  } catch (e) {
    console.warn('Could not look up family', e);
    owner = cached || u.uid;
  }
  if (seq !== authSeq) return;
  localStorage.setItem(ownerKey(u), owner);
  if (owner !== cached) startSync(owner);
}

let authSeq = 0;
function onUser(u) {
  const seq = ++authSeq;
  user = u;
  role = undefined;
  kidLink = null;
  if (!u) {
    stopSync();
    ownerUid = undefined;
    render();
    return;
  }
  if (isKidEmail(u.email)) startKid(u, seq);
  else startParent(u, seq);
}

async function signInParent() {
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

const cleanUsername = s => str(s).toLowerCase();
const validUsername = s => /^[a-z0-9][a-z0-9._-]{2,19}$/.test(s);

function authMessage(e) {
  switch (e.code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'Wrong username or password.';
    case 'auth/too-many-requests': return 'Too many tries. Wait a few minutes and try again.';
    case 'auth/network-request-failed': return 'No internet connection.';
    case 'auth/email-already-in-use': return 'That username is taken. Pick another one.';
    case 'auth/weak-password': return 'The password must be at least 6 characters.';
    case 'auth/operation-not-allowed':
      return 'Kid logins are not turned on yet. A parent needs to enable Email/Password sign-in in the Firebase console.';
    default: return e.message;
  }
}

async function signInKid(username, password) {
  await signInWithEmailAndPassword(auth, cleanUsername(username) + KID_DOMAIN, password);
}

// Runs `fn` with a separate, throwaway Firebase Auth instance, so a parent can create or change a
// kid's login without being signed out of their own account.
async function withSideAuth(fn) {
  const side = initializeApp(firebaseConfig, 'side-' + uid());
  const sideAuth = initializeAuth(side, { persistence: inMemoryPersistence });
  try {
    return await fn(sideAuth);
  } finally {
    await signOut(sideAuth).catch(() => {});
    await deleteApp(side).catch(() => {});
  }
}

async function createKidLogin(kid, username, password) {
  const loginUid = await withSideAuth(async sideAuth => {
    const cred = await createUserWithEmailAndPassword(sideAuth, username + KID_DOMAIN, password);
    return cred.user.uid;
  });
  await setDoc(loginRef(loginUid), { ownerUid, kidId: kid.id, username });
  await setDoc(itemRef('kids', kid.id), { username, loginUid }, { merge: true });
}

async function changeKidPassword(kid, oldPassword, newPassword) {
  await withSideAuth(async sideAuth => {
    const cred = await signInWithEmailAndPassword(sideAuth, kid.username + KID_DOMAIN, oldPassword);
    await updatePassword(cred.user, newPassword);
  });
}

function removeKidLogin(kid) {
  runBatch([
    b => b.delete(loginRef(kid.loginUid)),
    b => b.set(itemRef('kids', kid.id), { username: '', loginUid: '' }, { merge: true }),
  ]);
}

// ---------- derived data

const balance = kidId => db.tx.reduce(
  (sum, t) => (t.kidId === kidId ? sum + (t.kind === 'earn' ? t.points : -t.points) : sum), 0);
const byNewest = (a, b) => b.date.localeCompare(a.date) || b.created - a.created;
const kidTx = kidId => db.tx.filter(t => t.kidId === kidId).sort(byNewest);

function totals(kidId, monthOnly) {
  const month = today().slice(0, 7);
  let earned = 0;
  let spent = 0;
  for (const t of db.tx) {
    if (t.kidId !== kidId || (monthOnly && !t.date.startsWith(month))) continue;
    if (t.kind === 'earn') earned += t.points;
    else spent += t.points;
  }
  return { earned, spent };
}

// Quick activities first, then other activities used before, newest first.
function knownActivities() {
  const seen = new Map();
  for (const a of db.activities) seen.set(a.name.toLowerCase(), { name: a.name, points: a.points });
  for (const t of db.tx.slice().sort(byNewest)) {
    if (t.kind === 'earn' && !seen.has(t.label.toLowerCase())) {
      seen.set(t.label.toLowerCase(), { name: t.label, points: t.points });
    }
  }
  return [...seen.values()];
}

let selectedKidId = localStorage.getItem('ewyl-kid') || '';
function currentKid() {
  if (role === 'kid') return db.kids[0];
  return db.kids.find(k => k.id === selectedKidId) || db.kids[0];
}
function selectKid(id) {
  selectedKidId = id;
  localStorage.setItem('ewyl-kid', id);
  render();
}

// ---------- dialogs

function field(label, input) {
  return h('label', { class: 'field' }, h('span', null, label), input);
}

// onSubmit returns (or resolves to) an error message to keep the dialog open, or nothing to close it.
function openDialog({ title, body, submit = 'Save', onSubmit, extraButtons = [] }) {
  const err = h('p', { class: 'error', hidden: true });
  const dlg = h('dialog');
  const submitBtn = h('button', { type: 'submit', class: 'btn primary' }, submit);
  const form = h('form', { method: 'dialog' },
    h('h2', null, title),
    body,
    err,
    h('div', { class: 'dlg-actions' },
      extraButtons,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      submitBtn));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    let msg;
    try {
      msg = await onSubmit();
    } catch (ex) {
      msg = authMessage(ex);
    }
    submitBtn.disabled = false;
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

const passwordInput = (placeholder = 'At least 6 characters') => h('input', {
  type: 'password', minlength: 6, required: true, autocomplete: 'new-password', placeholder });

// Use (spend) points on something not in the reward list, or edit any existing entry.
function txDialog(kid, kind, existing) {
  const earn = kind === 'earn';
  const name = h('input', { required: true, maxlength: 80, autocomplete: 'off',
    placeholder: earn ? 'e.g. Finished homework' : 'e.g. Ice cream' });
  const points = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, required: true });
  const rs = h('span', { class: 'muted' });
  const note = h('input', { maxlength: 200, placeholder: 'Optional' });
  const date = h('input', { type: 'date', required: true, max: today() });

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

  // Points available to spend; when editing a spend, its own points are given back first.
  const available = balance(kid.id) + (existing && !earn ? existing.points : 0);

  let dlg;
  dlg = openDialog({
    title: existing ? 'Edit entry' : `${kid.name} uses points`,
    body: [
      !earn && h('p', { class: 'muted' }, `Available: ${pts(available)} (${rupees(available)})`),
      field(earn ? 'Activity' : 'Spent on', name),
      field('Points', h('div', { class: 'row' }, points, rs)),
      field('Note', note),
      field('Date', date),
    ],
    submit: existing ? 'Save' : 'Deduct',
    extraButtons: existing ? [deleteButton('Delete this entry?', () => {
      del('tx', existing.id);
      toast('Entry deleted', '🗑️');
    }, () => dlg)] : [],
    onSubmit: () => {
      const label = name.value.trim();
      const p = parseInt(points.value, 10);
      if (!label) return 'Enter a description.';
      if (!(p > 0)) return 'Points must be a whole number above 0.';
      if (!earn && p > available) return `Not enough points: ${kid.name} has ${pts(available)}.`;
      const fields = { label, points: p, note: note.value.trim(), date: date.value || today() };
      if (existing) put('tx', { ...existing, ...fields });
      else put('tx', { id: uid(), kidId: kid.id, kind, ...fields, created: Date.now() });
      toast(existing ? 'Entry saved' : `${pts(p)} used`, existing ? '✅' : '🎁');
    },
  });
}

function deleteKid(kid) {
  runBatch([
    b => b.delete(itemRef('kids', kid.id)),
    ...(kid.loginUid ? [b => b.delete(loginRef(kid.loginUid))] : []),
    ...kidTx(kid.id).map(t => b => b.delete(itemRef('tx', t.id))),
  ]);
}

function editKid(kid) {
  const name = h('input', { required: true, maxlength: 40, autocomplete: 'off' });
  const emoji = h('input', { maxlength: 8, class: 'emoji-input' });
  const thisYear = new Date().getFullYear();
  const born = h('input', { type: 'number', inputmode: 'numeric', min: thisYear - 25, max: thisYear, placeholder: 'e.g. 2016' });
  const interests = h('input', { maxlength: 200, autocomplete: 'off', placeholder: 'e.g. space, cricket, drawing, Lego' });
  name.value = kid ? kid.name : '';
  emoji.value = kid ? kid.emoji : '🙂';
  born.value = kid && kid.birthYear ? kid.birthYear : '';
  interests.value = kid ? kid.interests : '';
  let dlg;
  dlg = openDialog({
    title: kid ? 'Edit kid' : 'Add a kid',
    body: [
      field('Name', name),
      field('Emoji', emoji),
      field('Birth year (optional)', born),
      field('Interests (optional)', interests),
      h('p', { class: 'muted small' }, 'Birth year and interests help the AI suggest rewards that suit this kid.'),
    ],
    extraButtons: kid ? [deleteButton(
      `Delete ${kid.name} and all of their ${kidTx(kid.id).length} entries? This cannot be undone.`,
      () => deleteKid(kid), () => dlg)] : [],
    onSubmit: () => {
      const n = name.value.trim();
      if (!n) return 'Enter a name.';
      const e = emoji.value.trim() || '🙂';
      const y = parseInt(born.value, 10);
      if (born.value && !(y >= thisYear - 25 && y <= thisYear)) return 'Enter a birth year like 2016, or leave it empty.';
      const more = { birthYear: y || 0, interests: interests.value.trim() };
      if (kid) {
        patch('kids', kid.id, { name: n, emoji: e, ...more });
      } else {
        const id = uid();
        put('kids', { id, name: n, emoji: e, ...more, goalId: '', username: '', loginUid: '', created: Date.now() });
        selectedKidId = id;
        localStorage.setItem('ewyl-kid', id);
        toast(`${n} added. Create a login for them in Settings.`, '🎉');
      }
    },
  });
}

function kidLoginDialog(kid) {
  const username = h('input', { required: true, maxlength: 20, autocomplete: 'off', autocapitalize: 'none',
    spellcheck: 'false', placeholder: 'e.g. ' + (cleanUsername(kid.name).replace(/[^a-z0-9]/g, '') || 'aarav') });
  const password = passwordInput();
  openDialog({
    title: `Create a login for ${kid.name}`,
    body: [
      h('p', { class: 'muted' }, `${kid.name} logs in with this username and password, and sees only their own ` +
        'points, goal and history. Write the password down: it can only be changed if you know it.'),
      field('Username', username),
      field('Password', password),
    ],
    submit: 'Create login',
    onSubmit: async () => {
      const u = cleanUsername(username.value);
      if (!validUsername(u)) return 'Use 3 to 20 letters or numbers (dots, dashes and underscores are OK).';
      if (password.value.length < 6) return 'The password must be at least 6 characters.';
      if (!navigator.onLine) return 'You need to be online to create a login.';
      await createKidLogin(kid, u, password.value);
      toast(`${kid.name} can now log in as "${u}"`, '🔑');
    },
  });
}

function changePasswordDialog(kid) {
  const oldPw = passwordInput('Current password');
  const newPw = passwordInput();
  openDialog({
    title: `Change ${kid.name}'s password`,
    body: [
      h('p', { class: 'muted' }, `Username: ${kid.username}. If the current password is forgotten, remove this ` +
        'login and create a new one with a different username.'),
      field('Current password', oldPw),
      field('New password', newPw),
    ],
    submit: 'Change password',
    onSubmit: async () => {
      if (newPw.value.length < 6) return 'The new password must be at least 6 characters.';
      if (!navigator.onLine) return 'You need to be online to change a password.';
      await changeKidPassword(kid, oldPw.value, newPw.value);
      toast('Password changed', '🔑');
    },
  });
}

// Edit an item in the quick activities list or the reward store.
// prefill: values for a new item, e.g. from an AI idea.
function editQuick(listName, item, prefill) {
  const reward = listName === 'rewards';
  const name = h('input', { required: true, maxlength: 80, autocomplete: 'off' });
  const points = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, required: true });
  const icon = h('input', { maxlength: 8, class: 'emoji-input' });
  const from = item || prefill;
  name.value = from ? from.name : '';
  points.value = from ? from.points : '';
  icon.value = from && from.icon ? from.icon : '🎁';
  const what = reward ? 'reward' : 'activity';
  const hidden = new Set(from && from.notFor ? from.notFor : []);
  const kidChecks = reward ? db.kids.map(k => {
    const box = h('input', { type: 'checkbox', value: k.id });
    box.checked = !hidden.has(k.id);
    return box;
  }) : [];
  let dlg;
  dlg = openDialog({
    title: item ? `Edit ${what}` : `Add ${what}`,
    body: [
      reward && field('Icon', icon),
      field('Name', name),
      field(reward ? 'Costs (points)' : 'Points', points),
      reward && db.kids.length > 0 && h('div', { class: 'field' },
        h('span', null, 'Suggest to'),
        h('div', { class: 'checks' }, db.kids.map((k, i) =>
          h('label', { class: 'check' }, kidChecks[i], `${k.emoji} ${k.name}`))),
        h('small', { class: 'muted' }, 'Kids see only the rewards suggested to them.')),
    ],
    extraButtons: item ? [deleteButton(`Delete "${item.name}"?`, () => del(listName, item.id), () => dlg)] : [],
    onSubmit: () => {
      const n = name.value.trim();
      const p = parseInt(points.value, 10);
      if (!n) return 'Enter a name.';
      if (!(p > 0)) return 'Points must be a whole number above 0.';
      const extra = reward ? {
        icon: icon.value.trim() || '🎁',
        // Keep ids of kids that may have been deleted out of the list: only the ones shown can change.
        notFor: [...[...hidden].filter(id => !db.kids.some(k => k.id === id)),
          ...kidChecks.filter(c => !c.checked).map(c => c.value)],
      } : {};
      put(listName, item ? { ...item, name: n, points: p, ...extra }
        : { id: uid(), name: n, points: p, ...extra, created: Date.now() });
    },
  });
}

// ---------- AI reward ideas (parents only; Gemini through Firebase AI Logic)

const STARTER_THEMES = [
  'Age-appropriate books', 'Educational toys and science kits', 'Art and craft supplies',
  'Treats like pizza or ice cream', 'Outings and experiences', 'Sports and outdoor play',
];

let aiPromise;
// Loads the AI SDK only when a parent first asks for ideas, so kids' phones never download it.
function getAi() {
  if (!aiPromise) {
    aiPromise = import(SDK + 'firebase-ai.js').then(({ getAI, getGenerativeModel, GoogleAIBackend, Schema }) => {
      const ai = getAI(fbApp, { backend: new GoogleAIBackend() });
      const schema = Schema.object({
        properties: {
          ideas: Schema.array({
            items: Schema.object({
              properties: {
                name: Schema.string(),
                emoji: Schema.string(),
                priceInr: Schema.integer(),
                theme: Schema.string(),
                why: Schema.string(),
              },
            }),
          }),
        },
      });
      return getGenerativeModel(ai, {
        model: AI_MODEL,
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
      });
    });
    aiPromise.catch(() => { aiPromise = null; });
  }
  return aiPromise;
}

const ageOf = kid => (kid.birthYear ? new Date().getFullYear() - kid.birthYear : 0);

function ideasPrompt(kid, themes, interests, note) {
  const b = Math.max(0, balance(kid.id));
  const age = ageOf(kid);
  const existing = db.rewards.map(r => r.name);
  return [
    'You help parents in India choose rewards their child can buy with points earned for good habits and goals.',
    'Suggest 6 specific, wholesome, age-appropriate rewards a parent can easily buy or arrange in India.',
    age ? `The child is about ${age} years old.`
      : "The child's age is not known; suggest things that suit most children aged 6 to 12.",
    interests ? `The child is interested in: ${interests}. Prefer ideas that match these interests.` : '',
    `Themes the parent wants (spread the ideas across them): ${themes.join('; ')}.`,
    note ? `Parent's note: ${note}` : '',
    `Points: 1 point = ₹${db.rate}. The child has ${b} points (₹${b * db.rate}).`,
    'Include about half that the child can afford now and half to save up for, up to about four times their ' +
      'balance. If the balance is very small, suggest small treats and a few things to save for.',
    'priceInr is a typical current price in Indian rupees, as a whole number.',
    existing.length ? `Do not repeat these existing rewards: ${existing.join('; ')}.` : '',
    'name: short (under 40 characters) and specific, e.g. a book title or a kind of kit. emoji: exactly one ' +
      'emoji. theme: which of the themes it fits. why: one short sentence for the parent on why it suits this child.',
  ].filter(Boolean).join('\n');
}

function aiMessage(e) {
  const m = String((e && e.message) || e);
  if (!navigator.onLine) return 'No internet connection.';
  if (/app.?check/i.test(m)) return 'App Check blocked the request. See the setup notes for AI ideas.';
  if (/api.?not.?enabled|has not been used|disabled|PERMISSION_DENIED|403/i.test(m)) {
    return 'AI ideas are not turned on yet. In the Firebase console, open AI Logic and click Get started ' +
      '(choose the Gemini Developer API).';
  }
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(m)) return 'Too many requests right now. Try again in a minute.';
  return 'Could not get ideas: ' + m;
}

function aiDialog(kid) {
  const themes = db.themes.length ? db.themes.map(t => t.text) : STARTER_THEMES;
  const boxes = themes.map(t => {
    const c = h('input', { type: 'checkbox', value: t });
    c.checked = true;
    return c;
  });
  const interests = h('input', { maxlength: 200, autocomplete: 'off', value: kid.interests,
    placeholder: 'e.g. dinosaurs, cricket, drawing' });
  const note = h('input', { maxlength: 200, autocomplete: 'off', placeholder: 'e.g. no sugary treats, for a birthday' });
  const results = h('div', { class: 'ideas' });
  const status = h('p', { class: 'muted small', hidden: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, '✨ Get ideas');
  const dlg = h('dialog');
  const age = ageOf(kid);

  const showIdeas = ideas => {
    results.replaceChildren(...ideas.map(idea => {
      const price = Math.max(1, Math.round(Number(idea.priceInr) || 0));
      const points = Math.max(1, Math.ceil(price / db.rate));
      const icon = Array.from(str(idea.emoji) || '🎁').slice(0, 2).join('');
      const name = str(idea.name).slice(0, 80) || 'Reward';
      const row = h('div', { class: 'idea' },
        h('span', { class: 'suggest-icon' }, icon),
        h('div', { class: 'idea-main' },
          h('b', null, name),
          h('small', null, `₹${price.toLocaleString('en-IN')} ≈ ${pts(points)}`, idea.theme && ` · ${str(idea.theme)}`),
          idea.why && h('small', { class: 'muted' }, str(idea.why))),
        h('button', {
          type: 'button',
          class: 'btn small primary',
          onclick: () => {
            // Approval: the normal reward form opens prefilled and suggested only to this kid.
            editQuick('rewards', null,
              { name, points, icon, notFor: db.kids.filter(k => k.id !== kid.id).map(k => k.id) });
            row.classList.add('added');
          },
        }, 'Add'));
      return row;
    }));
  };

  const form = h('form', {
    method: 'dialog',
    onsubmit: async e => {
      e.preventDefault();
      const chosen = boxes.filter(c => c.checked).map(c => c.value);
      if (!chosen.length) {
        status.textContent = 'Pick at least one theme.';
        status.hidden = false;
        return;
      }
      const likes = interests.value.trim();
      go.disabled = true;
      status.textContent = 'Thinking of ideas…';
      status.hidden = false;
      results.replaceChildren();
      try {
        const model = await getAi();
        const res = await model.generateContent(ideasPrompt(kid, chosen, likes, note.value.trim()));
        const data = JSON.parse(res.response.text());
        const ideas = Array.isArray(data.ideas) ? data.ideas.filter(i => i && i.name) : [];
        if (!ideas.length) throw new Error('No ideas came back. Try again.');
        showIdeas(ideas);
        status.textContent = 'Tap Add to review an idea and save it as a reward. Prices are estimates.';
        go.textContent = '✨ More ideas';
        // Remember interests typed here for next time.
        if (likes && likes !== kid.interests) patch('kids', kid.id, { interests: likes });
      } catch (ex) {
        console.error(ex);
        status.textContent = aiMessage(ex);
      }
      go.disabled = false;
    },
  },
  h('h2', null, `✨ Reward ideas for ${kid.name}`),
  h('p', { class: 'muted small' },
    age ? `Age ${age}. ` : 'Add a birth year for this kid in Settings to get age-appropriate ideas. ',
    'Nothing is added until you approve it.'),
  h('div', { class: 'field' }, h('span', null, 'Themes'),
    h('div', { class: 'checks' }, boxes.map((c, i) => h('label', { class: 'check' }, c, themes[i])))),
  field(`${kid.name}'s interests`, interests),
  field('Anything else? (optional)', note),
  status,
  results,
  h('div', { class: 'dlg-actions' },
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Close'),
    go));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}

function themesSection() {
  const input = h('input', { maxlength: 80, autocomplete: 'off', 'data-keep': 'theme',
    placeholder: 'e.g. Age-appropriate books' });
  const add = text => {
    const t = str(text);
    if (!t) return;
    if (db.themes.some(x => x.text.toLowerCase() === t.toLowerCase())) {
      toast('That theme is already there', 'ℹ️');
      return;
    }
    put('themes', { id: uid(), text: t, created: Date.now() });
    input.value = '';
  };
  const unused = STARTER_THEMES.filter(t => !db.themes.some(x => x.text.toLowerCase() === t.toLowerCase()));
  return h('section', { class: 'card' },
    h('h2', null, '✨ AI reward ideas'),
    h('p', { class: 'muted' }, 'On the Rewards page, "Get AI ideas" suggests gifts for a kid from these themes, ' +
      'their age and their interests (set those when you edit a kid). You approve each idea before it becomes a reward.'),
    db.themes.length ? h('div', { class: 'list' }, db.themes.map(t =>
      h('button', { class: 'list-row', onclick: () => { if (confirm(`Remove the theme "${t.text}"?`)) del('themes', t.id); } },
        t.text, h('span', { class: 'chev' }, '✕'))))
      : h('p', { class: 'muted' }, 'No themes yet, so the starter themes below are used.'),
    h('div', { class: 'add-row' }, input, h('button', { class: 'btn', onclick: () => add(input.value) }, 'Add')),
    unused.length > 0 && h('div', { class: 'chip-wrap' }, unused.map(t =>
      h('button', { type: 'button', class: 'chip', onclick: () => add(t) }, '+ ' + t))));
}

// ---------- actions

function award(kid, form) {
  const label = form.activity.value.trim();
  const p = parseInt(form.points.value, 10);
  if (!label) return toast('Enter or pick an activity', '⚠️');
  if (!(p > 0)) return toast('Points must be a whole number above 0', '⚠️');
  put('tx', {
    id: uid(), kidId: kid.id, kind: 'earn', label, points: p,
    note: form.note.value.trim(), date: form.date.value || today(), created: Date.now(),
  });
  form.activity.value = '';
  form.note.value = '';
  form.date.value = today();
  toast(`+${pts(p)} for ${kid.name} (${rupees(p)})`, '🎉');
}

function buy(kid, reward) {
  const b = balance(kid.id);
  if (b < reward.points) return toast(`${kid.name} needs ${reward.points - b} more points`, '🔒');
  if (!confirm(`${kid.name} uses ${pts(reward.points)} (${rupees(reward.points)}) on "${reward.name}"?`)) return;
  put('tx', {
    id: uid(), kidId: kid.id, kind: 'spend', label: reward.name, points: reward.points,
    note: '', date: today(), created: Date.now(),
  });
  toast(`${kid.name} got ${reward.icon} ${reward.name}!`, '🎁');
}

function setGoal(kid, reward) {
  const goalId = kid.goalId === reward.id ? '' : reward.id;
  patch('kids', kid.id, { goalId });
  toast(goalId ? `Goal set: ${reward.name}` : 'Goal cleared', '🎯');
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

// Deletes every document for this family and optionally writes new data in its place.
// Kid logins stay only for kids that are kept with the same login.
function replaceAll(data) {
  const ops = [];
  const current = new Map(db.kids.map(k => [k.id, k]));
  if (data) {
    data.kids = data.kids.map(k => {
      const cur = current.get(k.id);
      return cur && cur.loginUid && cur.loginUid === k.loginUid ? k : { ...k, username: '', loginUid: '' };
    });
  }
  const keptLogins = new Set(data ? data.kids.map(k => k.loginUid).filter(Boolean) : []);
  for (const k of db.kids) {
    if (k.loginUid && !keptLogins.has(k.loginUid)) ops.push(b => b.delete(loginRef(k.loginUid)));
  }
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

// ---------- header, kid switcher and bottom bar

function updateChrome(tab) {
  const signedIn = Boolean(user && ready);
  rateBadge.hidden = !signedIn;
  rateBadge.textContent = `1 pt = ₹${db.rate}`;

  syncPill.hidden = !signedIn;
  const offline = !navigator.onLine;
  const saving = [...pending.values()].some(Boolean);
  syncPill.className = 'pill ' + (offline ? 'off' : saving ? 'saving' : 'ok');
  syncPill.querySelector('.pill-text').textContent = offline ? 'Offline' : saving ? 'Saving' : 'Synced';
  syncPill.title = offline ? 'Changes are saved on this device and sync when you are back online.'
    : saving ? 'Sending changes to the cloud.' : 'Everything is saved to the cloud.';

  if (tab === undefined) return;
  navEl.hidden = !signedIn;
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  navEl.querySelector('[data-tab="settings"] span:last-child').textContent = role === 'kid' ? 'Me' : 'Settings';

  const showKids = signedIn && isParent() && tab !== 'settings' && db.kids.length > 0;
  kidTabsEl.hidden = !showKids;
  if (showKids) {
    const sel = currentKid();
    kidTabsEl.replaceChildren(...db.kids.map(k => {
      const b = balance(k.id);
      return h('button', { class: 'kid-tab' + (k === sel ? ' active' : ''), onclick: () => selectKid(k.id) },
        h('span', { class: 'kid-who' }, h('span', { class: 'kid-emoji' }, k.emoji), h('span', { class: 'kid-name' }, k.name)),
        h('span', { class: 'kid-bal' }, h('b', null, pts(b)), h('small', null, rupees(b))));
    }));
  }
}

window.addEventListener('online', () => updateChrome());
window.addEventListener('offline', () => updateChrome());

// ---------- pages

function renderMessage(...children) {
  app.append(h('div', { class: 'empty' }, children));
}

function renderSetup() {
  renderMessage(
    h('div', { class: 'empty-icon' }, '🔧'),
    h('p', null, 'Firebase is not set up yet.'),
    h('p', { class: 'muted' }, 'Paste your Firebase web app config into firebase-config.js. See README.md.'));
}

function renderSignIn() {
  const username = h('input', { name: 'username', 'data-keep': 'username', required: true, maxlength: 20,
    autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Username' });
  const password = h('input', { name: 'password', type: 'password', required: true,
    autocomplete: 'current-password', placeholder: 'Password' });
  const err = h('p', { class: 'error', hidden: true });
  const btn = h('button', { type: 'submit', class: 'btn primary wide' }, 'Log in');
  const form = h('form', {
    class: 'card login',
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      err.hidden = true;
      try {
        await signInKid(username.value, password.value);
      } catch (ex) {
        err.textContent = authMessage(ex);
        err.hidden = false;
        password.value = '';
      }
      btn.disabled = false;
    },
  }, h('h2', null, '🧒 Kids'), username, password, err, btn);

  app.append(
    h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, '⭐'),
      h('p', null, 'Earn points for your goals, and spend them on things you want.')),
    h('section', { class: 'card login' },
      h('h2', null, '👨‍👩‍👧 Parents'),
      h('button', { class: 'btn primary wide', onclick: signInParent }, 'Sign in with Google')),
    form);
}

function renderNoKids() {
  if (role === 'kid') {
    return renderMessage(h('div', { class: 'empty-icon' }, '🤔'),
      h('p', null, 'Your profile was not found. Ask a parent to check your login.'));
  }
  renderMessage(
    h('div', { class: 'empty-icon' }, '⭐'),
    h('p', null, 'Add your kids to start tracking their points.'),
    h('button', { class: 'btn primary', onclick: () => editKid() }, 'Add a kid'));
}

function txRow(t) {
  const earn = t.kind === 'earn';
  const kid = db.kids.find(k => k.id === t.kidId);
  const canEdit = kid && isParent();
  return h(canEdit ? 'button' : 'div', { class: 'tx', onclick: canEdit ? () => txDialog(kid, t.kind, t) : null },
    h('span', { class: 'tx-icon ' + t.kind }, earn ? '⭐' : '🎁'),
    h('span', { class: 'tx-main' },
      h('span', { class: 'tx-label' }, t.label),
      t.note && h('span', { class: 'tx-note' }, t.note)),
    h('span', { class: 'tx-amt' },
      h('span', { class: 'tx-pts ' + t.kind }, (earn ? '+' : '−') + pts(t.points)),
      h('small', null, rupees(t.points))));
}

function historyList(txs) {
  if (!txs.length) return h('p', { class: 'muted center pad' }, 'Nothing here yet.');
  const out = h('div', { class: 'history' });
  let lastDate;
  for (const t of txs) {
    if (t.date !== lastDate) {
      out.append(h('h3', { class: 'day' }, fmtDate(t.date)));
      lastDate = t.date;
    }
    out.append(txRow(t));
  }
  return out;
}

function awardCard(kid) {
  const activity = h('input', { name: 'activity', 'data-keep': 'activity', maxlength: 80, autocomplete: 'off',
    list: 'known-activities', placeholder: 'Type an activity or pick one below' });
  const points = h('input', { name: 'points', 'data-keep': 'points', type: 'number', inputmode: 'numeric',
    min: 1, step: 1, value: 5, class: 'points-input' });
  const rs = h('span', { class: 'rs-preview' });
  const updateRs = () => {
    const p = parseInt(points.value, 10);
    rs.textContent = p > 0 ? '= ' + rupees(p) : '';
  };
  points.addEventListener('input', updateRs);
  const known = knownActivities();
  const pick = a => { activity.value = a.name; points.value = a.points; updateRs(); };
  const form = h('form', { class: 'card award', onsubmit: e => { e.preventDefault(); award(kid, form); } },
    h('div', { class: 'card-head' }, h('h2', null, `⭐ Award points to ${kid.name}`)),
    field('Activity or goal achieved', activity),
    h('datalist', { id: 'known-activities' }, known.map(a => h('option', { value: a.name }))),
    known.length > 0 && h('div', { class: 'chip-scroll' }, known.slice(0, 10).map(a =>
      h('button', { type: 'button', class: 'chip', onclick: () => pick(a) }, a.name, h('b', null, ` +${a.points}`)))),
    h('div', { class: 'field' },
      h('span', { class: 'field-head' }, h('span', null, 'Points'), rs),
      h('div', { class: 'points-row' }, points,
        h('div', { class: 'chip-scroll' }, PRESETS.map(p =>
          h('button', { type: 'button', class: 'chip preset', onclick: () => { points.value = p; updateRs(); } }, `${p}`))))),
    h('div', { class: 'two' },
      h('input', { name: 'note', 'data-keep': 'note', maxlength: 200, placeholder: 'Note (optional)' }),
      h('input', { name: 'date', 'data-keep': 'date', type: 'date', max: today(), value: today() })),
    h('button', { type: 'submit', class: 'btn primary wide' }, 'Award points ⭐'));
  // Match the activity to a known one as it is typed, to fill in its usual points.
  activity.addEventListener('change', () => {
    const a = known.find(x => x.name.toLowerCase() === activity.value.trim().toLowerCase());
    if (a) pick(a);
  });
  setTimeout(updateRs, 0); // after kept values are restored
  return form;
}

const suggestedTo = (r, kid) => !r.notFor.includes(kid.id);

// What this kid can buy now with their points, and the next reward to save up for.
function suggestCard(kid, b) {
  const mine = role === 'kid';
  const list = db.rewards.filter(r => suggestedTo(r, kid));
  if (!list.length) {
    return mine ? null : h('section', { class: 'card suggest' },
      h('h2', null, `🛍️ What ${kid.name} can get`),
      h('p', { class: 'muted' }, `No rewards are suggested to ${kid.name} yet.`),
      h('a', { class: 'link', href: '#/rewards' }, 'Add rewards →'));
  }
  const affordable = list.filter(r => r.points <= b).sort((x, y) => y.points - x.points);
  const next = list.filter(r => r.points > b).sort((x, y) => x.points - y.points)[0];
  const shown = affordable.slice(0, 4);
  return h('section', { class: 'card suggest' },
    h('div', { class: 'card-head' },
      h('h2', null, mine ? '🛍️ What you can get' : `🛍️ What ${kid.name} can get`),
      h('a', { class: 'link', href: '#/rewards' }, 'All rewards →')),
    shown.length ? h('div', { class: 'suggest-list' }, shown.map(r =>
      h('div', { class: 'suggest-row' },
        h('span', { class: 'suggest-icon' }, r.icon),
        h('span', { class: 'suggest-main' },
          h('b', null, r.name),
          h('small', { class: 'muted' }, `${pts(r.points)} (${rupees(r.points)}) · ${pts(b - r.points)} left after`)),
        mine ? h('span', { class: 'small can' }, 'Ask a parent')
          : h('button', { class: 'btn small buy', onclick: () => buy(kid, r) }, 'Buy'))))
      : h('p', { class: 'muted' }, mine ? 'Not enough points for a reward yet. Keep going!'
        : `${kid.name} does not have enough points for a reward yet.`),
    affordable.length > shown.length && h('p', { class: 'muted small' },
      `…and ${affordable.length - shown.length} more.`),
    next && h('div', { class: 'next-up' },
      h('div', { class: 'goal-line' },
        h('span', null, `Next up: ${next.icon} ${next.name}`),
        h('b', null, `need ${next.points - Math.max(0, b)} more`)),
      h('div', { class: 'bar light' }, h('div', { class: 'bar-fill',
        style: `width:${Math.max(0, Math.min(100, Math.round((b / next.points) * 100)))}%` }))));
}

function renderHome() {
  const kid = currentKid();
  if (!kid) return renderNoKids();
  const b = balance(kid.id);
  const month = totals(kid.id, true);
  const goal = db.rewards.find(r => r.id === kid.goalId && (isParent() || suggestedTo(r, kid)));
  const pct = goal ? Math.max(0, Math.min(100, Math.round((b / goal.points) * 100))) : 0;
  const mine = role === 'kid';

  app.append(
    h('section', { class: 'wallet' + (b < 0 ? ' negative' : '') },
      h('div', { class: 'wallet-top' },
        h('div', null,
          h('span', { class: 'wallet-tag' }, mine ? `${kid.emoji} Hi ${kid.name}!` : `${kid.emoji} ${kid.name}'s wallet`),
          h('div', { class: 'wallet-bal' }, h('span', { class: 'big' }, b), h('span', null, b === 1 ? 'point' : 'points')),
          h('div', { class: 'wallet-rs' }, `Worth ${rupees(b)}`)),
        h('div', { class: 'wallet-month' },
          h('small', null, 'This month'),
          h('span', { class: 'up' }, `+${month.earned} earned`),
          h('span', { class: 'down' }, `−${month.spent} used`))),
      goal ? h('a', { class: 'goal', href: '#/rewards' },
        h('div', { class: 'goal-line' },
          h('span', { class: 'goal-name' }, `🎯 Goal: ${goal.icon} ${goal.name}`),
          h('b', null, `${Math.max(0, b)}/${goal.points} (${pct}%)`)),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${pct}%` })),
        b >= goal.points && h('div', { class: 'goal-done' }, mine
          ? 'You have enough for your goal! Ask a parent. 🎉' : 'Enough points for this goal! 🎉'))
        : h('a', { class: 'goal goal-empty', href: '#/rewards' }, '🎯 Pick a goal in Rewards →')),
    mine ? h('div', { class: 'notice' },
      h('span', null, 'Finished something? Ask a parent to add your points. ⭐'))
      : awardCard(kid),
    suggestCard(kid, b),
    h('section', { class: 'card recent' },
      h('div', { class: 'card-head' },
        h('h2', null, 'Recent activity'),
        h('a', { class: 'link', href: '#/history' }, 'View all →')),
      historyList(kidTx(kid.id).slice(0, 5))));
}

function renderRewards() {
  const kid = currentKid();
  if (!kid) return renderNoKids();
  const b = balance(kid.id);
  const parent = isParent();
  // Kids see only rewards suggested to them; parents see all, with the hidden ones marked.
  const list = parent ? db.rewards : db.rewards.filter(r => suggestedTo(r, kid));

  app.append(
    h('div', { class: 'page-head' },
      h('h2', null, 'Reward store'),
      h('p', { class: 'muted' }, parent ? `${kid.name} has ` : 'You have ',
        h('b', { class: 'accent' }, `${pts(b)} (${rupees(b)})`))),
    list.length ? h('div', { class: 'rewards' }, list.map(r => {
      const can = b >= r.points;
      const isGoal = kid.goalId === r.id;
      const hiddenHere = !suggestedTo(r, kid);
      return h('div', { class: 'reward' + (isGoal ? ' is-goal' : '') + (hiddenHere ? ' hidden-for' : '') },
        h(parent ? 'button' : 'span', { class: 'reward-icon', onclick: parent ? () => editQuick('rewards', r) : null,
          title: parent ? 'Edit reward' : null }, r.icon),
        h('div', { class: 'reward-main' },
          h('div', { class: 'reward-name' }, r.name, isGoal && h('span', { class: 'goal-tag' }, 'Goal'),
            hiddenHere && h('span', { class: 'hidden-tag' }, `Hidden for ${kid.name}`)),
          h('div', { class: 'reward-cost' }, pts(r.points), h('span', { class: 'muted' }, ` (${rupees(r.points)})`)),
          can ? (!parent && h('div', { class: 'small can' }, 'You have enough! Ask a parent.'))
            : h('div', { class: 'muted small' }, `Need ${r.points - b} more`)),
        h('div', { class: 'reward-actions' },
          h('button', { class: 'icon-chip' + (isGoal ? ' on' : ''), title: isGoal ? 'Clear goal' : 'Make this the goal',
            onclick: () => setGoal(kid, r) }, '🎯'),
          parent && h('button', { class: 'btn small ' + (can ? 'buy' : 'locked'), disabled: !can,
            onclick: () => buy(kid, r) }, can ? 'Buy' : 'Locked')));
    })) : h('p', { class: 'muted center pad' }, 'No rewards yet.'),
    parent ? h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => editQuick('rewards') }, '+ Add reward'),
      h('button', { class: 'btn ai', onclick: () => aiDialog(kid) }, '✨ Get AI ideas'),
      h('button', { class: 'btn', onclick: () => txDialog(kid, 'spend') }, 'Use points on something else'))
      : h('p', { class: 'muted small center' }, 'Tap 🎯 to choose your goal.'),
    parent && h('p', { class: 'muted small center' },
      'Tap a reward\'s icon to edit it and choose which kids it is suggested to.'));
}

let historyFilter = 'all';
let historySearch = '';

function renderHistory() {
  const kid = currentKid();
  if (!kid) return renderNoKids();
  const all = totals(kid.id, false);
  const q = historySearch.trim().toLowerCase();
  const txs = kidTx(kid.id)
    .filter(t => historyFilter === 'all' || t.kind === historyFilter)
    .filter(t => !q || t.label.toLowerCase().includes(q) || t.note.toLowerCase().includes(q));
  const tab = (key, label) => h('button', {
    class: 'seg' + (historyFilter === key ? ' active' : ''),
    onclick: () => { historyFilter = key; render(); },
  }, label);
  const sum = (cls, label, n) => h('div', { class: 'sum ' + cls },
    h('small', null, label), h('b', null, (n > 0 && cls === 'earn' ? '+' : '') + n), h('span', null, rupees(Math.abs(n))));

  app.append(
    h('div', { class: 'page-head' },
      h('h2', null, role === 'kid' ? `${kid.emoji} My history` : `${kid.emoji} ${kid.name}'s history`),
      h('p', { class: 'muted' }, isParent() ? 'Tap an entry to change or delete it.' : 'Everything earned and used.')),
    h('div', { class: 'sums' },
      sum('earn', 'Earned', all.earned), sum('spend', 'Used', -all.spent), sum('net', 'Balance', all.earned - all.spent)),
    h('div', { class: 'filters' },
      h('div', { class: 'segs' }, tab('all', 'All'), tab('earn', 'Earned'), tab('spend', 'Used')),
      h('input', { type: 'search', 'data-keep': 'search', placeholder: 'Search…', value: historySearch,
        oninput: e => { historySearch = e.target.value; render(); } })),
    h('section', { class: 'card' }, historyList(txs)));
}

function familySection() {
  if (!isOwner()) {
    return h('section', { class: 'card' },
      h('h2', null, '👨‍👩‍👧 Family'),
      h('p', { class: 'muted' }, `You are sharing the family data of ${db.ownerEmail || 'another parent'}. ` +
        'Changes you make are seen by everyone in the family.'));
  }
  const email = h('input', { type: 'email', placeholder: 'name@gmail.com', autocomplete: 'off', 'data-keep': 'email' });
  const add = () => {
    const e = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return alert('Enter a valid email address.');
    if (e === (user.email || '').toLowerCase()) return alert('That is your own account.');
    if (isKidEmail(e)) return alert('That is a kid login. Kids get their logins under "Kid logins".');
    setSettings({ members: arrayUnion(e), ownerEmail: user.email || '' });
    email.value = '';
    toast(`${e} can now sign in as a parent`, '👨‍👩‍👧');
  };
  const remove = m => {
    if (!confirm(`Stop sharing with ${m}?`)) return;
    setSettings({ members: arrayRemove(m) });
  };
  return h('section', { class: 'card' },
    h('h2', null, '👨‍👩‍👧 Parents'),
    h('p', { class: 'muted' }, 'Add your partner or other family members by their Gmail address. When they sign ' +
      'in with Google, they see all the kids and can award and spend points.'),
    db.members.length ? h('div', { class: 'list' }, db.members.map(m =>
      h('button', { class: 'list-row', onclick: () => remove(m) }, m, h('span', { class: 'chev' }, '✕'))))
      : h('p', { class: 'muted' }, 'Only you so far.'),
    h('div', { class: 'add-row' }, email, h('button', { class: 'btn', onclick: add }, 'Add')));
}

function kidLoginsSection() {
  return h('section', { class: 'card' },
    h('h2', null, '🔑 Kid logins'),
    h('p', { class: 'muted' }, 'Each kid can log in on their own phone or tablet with a username and password, ' +
      'and see only their own points, goal and history.'),
    db.kids.length ? h('div', { class: 'logins' }, db.kids.map(k => h('div', { class: 'login-row' },
      h('div', { class: 'login-who' },
        h('b', null, `${k.emoji} ${k.name}`),
        h('span', { class: 'muted small' }, k.username ? `Username: ${k.username}` : 'No login yet')),
      k.username ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => changePasswordDialog(k) }, 'Password'),
        h('button', {
          class: 'btn small danger',
          onclick: () => {
            if (!confirm(`Remove ${k.name}'s login "${k.username}"? They will be signed out.`)) return;
            removeKidLogin(k);
            toast('Login removed', '🗑️');
          },
        }, 'Remove'))
        : h('button', { class: 'btn small primary', onclick: () => kidLoginDialog(k) }, 'Create login'))))
      : h('p', { class: 'muted' }, 'Add a kid first.'));
}

function accountSection() {
  const who = role === 'kid' ? `Logged in as ${kidLink ? kidLink.username : user.email.replace(KID_DOMAIN, '')}.`
    : `Signed in as ${user.email || user.displayName || 'unknown'}. Your data syncs to every phone where the ` +
      'family signs in.';
  return h('section', { class: 'card' },
    h('h2', null, '👤 Account'),
    h('p', { class: 'muted' }, who),
    h('button', { class: 'btn', onclick: () => { if (confirm('Sign out?')) signOut(auth); } }, 'Sign out'));
}

function renderSettings() {
  if (role === 'kid') {
    const kid = currentKid();
    app.append(
      h('div', { class: 'page-head' }, h('h2', null, kid ? `${kid.emoji} ${kid.name}` : 'Me')),
      accountSection());
    return;
  }

  const listSection = (title, items, label, onEdit, onAdd, addLabel) => h('section', { class: 'card' },
    h('h2', null, title),
    items.length ? h('div', { class: 'list' }, items.map(it =>
      h('button', { class: 'list-row', onclick: () => onEdit(it) }, label(it), h('span', { class: 'chev' }, '›'))))
      : h('p', { class: 'muted' }, 'None yet.'),
    h('button', { class: 'btn', onclick: onAdd }, addLabel));

  const rate = h('input', { type: 'number', inputmode: 'decimal', min: 0.01, step: 'any', class: 'rate-input',
    value: db.rate });
  rate.addEventListener('change', () => {
    const r = Number(rate.value);
    if (r > 0) { setSettings({ rate: r }); toast(`1 point = ₹${r}`, '✅'); } else rate.value = db.rate;
  });

  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) importData(f); },
  });

  app.append(
    h('div', { class: 'page-head' }, h('h2', null, 'Settings')),
    listSection('👦👧 Kids', db.kids, k => `${k.emoji} ${k.name}`, k => editKid(k), () => editKid(), '+ Add a kid'),
    kidLoginsSection(),
    themesSection(),
    familySection(),
    h('section', { class: 'card' },
      h('h2', null, '💰 Value of a point'),
      h('label', { class: 'row' }, '1 point = ₹', rate)),
    listSection('⭐ Quick activities', db.activities, a => `${a.name} · ${pts(a.points)}`,
      a => editQuick('activities', a), () => editQuick('activities'), '+ Add activity'),
    accountSection(),
    h('section', { class: 'card' },
      h('h2', null, '💾 Backup file'),
      h('p', { class: 'muted' }, 'Optional: download a copy of everything, or restore from one.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportData }, 'Download backup'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Restore from file')),
      fileInput),
    h('section', { class: 'card' },
      h('h2', null, '⚠️ Erase everything'),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          if (!confirm('Erase all kids, points, history and kid logins? This cannot be undone.')) return;
          replaceAll({ rate: 10, kids: [], tx: [], themes: [], ...defaultItems() });
          location.hash = '#/';
        },
      }, 'Erase all data')));
}

// ---------- routing

let lastRoute = null;
function render() {
  const route = location.hash.slice(1) || '/';
  const [, page, id] = route.split('/');
  if (page === 'kid') { // old links: #/kid/{id}
    if (id) selectedKidId = decodeURIComponent(id);
    location.replace('#/');
    return;
  }
  const tab = ['rewards', 'history', 'settings'].includes(page) ? page : 'home';

  // Redraws replace the page, so keep what is being typed and where the cursor is.
  const sameRoute = route === lastRoute;
  const kept = {};
  let focus = null;
  if (sameRoute) {
    for (const el of app.querySelectorAll('[data-keep]')) kept[el.dataset.keep] = el.value;
    const a = document.activeElement;
    if (a && a.dataset && a.dataset.keep && app.contains(a)) {
      focus = { key: a.dataset.keep, start: a.selectionStart, end: a.selectionEnd };
    }
  } else {
    window.scrollTo(0, 0);
    lastRoute = route;
  }

  app.replaceChildren();
  updateChrome(tab);
  const loading = user === undefined || (user && !ready);
  // Tells the stylesheet which page this is, for the wide-screen layouts.
  app.className = !configured || loading ? 'page-message' : !user ? 'page-signin' : 'page-' + tab;
  if (!configured) return renderSetup();
  if (loading) return renderMessage(h('p', { class: 'muted' }, 'Loading…'));
  if (!user) return renderSignIn();
  if (tab === 'rewards') renderRewards();
  else if (tab === 'history') renderHistory();
  else if (tab === 'settings') renderSettings();
  else renderHome();

  for (const el of app.querySelectorAll('[data-keep]')) {
    if (el.dataset.keep in kept) el.value = kept[el.dataset.keep];
  }
  if (focus) {
    const el = app.querySelector(`[data-keep="${focus.key}"]`);
    if (el) {
      el.focus();
      try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
    }
  }
}

window.addEventListener('hashchange', render);

if (configured) onAuthStateChanged(auth, onUser);
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
}
