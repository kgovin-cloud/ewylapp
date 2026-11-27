# EWYL - Earn While You Learn

Web app, installable on Android as a PWA, for tracking points parents award their kids for goals.
Kids spend points on rewards. 1 point = ₹10 by default, changeable in Settings.
Designed for phones first; on wider screens the layout expands (see Layout below).

## Version control

This repo uses **git**, not Perforce. The global CLAUDE.md rule about Perforce does not apply here.

- GitHub: https://github.com/kgovin-cloud/ewylapp (private), branch `main`.
- Local copy: `C:\Users\ksanthan\personal\github\ewylapp`. It was moved from `H:\personal\github\ewylapp`,
  a network share where git couldn't reliably update its own files. The old H: copy is obsolete.

## Decisions made

- **Plain HTML/CSS/JS, no build step, no npm dependencies.** The Firebase SDK v12.6.0 is loaded as ES modules
  from `https://www.gstatic.com/firebasejs/12.6.0/...`. No Tailwind or web fonts (works offline).
- **Data: Firebase Firestore** with its persistent local cache for offline use. **Hosting: Firebase Hosting**
  at https://ewylapp.web.app (not GitHub Pages: the repo must stay private).
- **Two kinds of users.** Parents sign in with Google. Kids sign in with a username and password that a parent
  creates; Firebase needs an email, so the username becomes `username@kids.ewylapp.web.app` (`KID_DOMAIN`).
  Parents create kid accounts with a throwaway second Firebase app (`withSideAuth`) so they stay signed in.
  Without Cloud Functions there is no password reset: a parent can change a password only by knowing the
  current one, otherwise remove the login and create a new username.
- **AI reward ideas use Gemini through Firebase AI Logic** (model `gemini-4-hydrogen`, Gemini Developer API,
  no billing), chosen by the user over Claude because it needs no server or secret key on the free Spark plan.
  Protected by App Check with reCAPTCHA Enterprise (`appCheckSiteKey` in `firebase-config.js`); AI Logic is
  enforced in App Check. The key's allowed domains are ewylapp.web.app, ewylapp.firebaseapp.com, localhost
  and the preview channel domain: add any new domain there first.
- Firebase project ID `ewylapp`. `firebase-config.js` values aren't secret; `firestore.rules` controls access.

## Files

- `index.html`: app shell (header, kid switcher, `main#app`, bottom nav, toast). `app.js`: all logic.
  `styles.css`: mobile-first styles, wide-screen layouts at the end.
- `firebase-config.js`: Firebase web config and App Check site key. `firestore.rules`: security rules.
- `firebase.json` and `.firebaserc`: Hosting config and rules path. `firebase.json` must explicitly ignore
  `.git/**`: on Windows `**/.*` did not exclude it, and the first deploy published `.git`.
- `sw.js`: service worker. App files network-first with offline fallback; SDK files cache-first.
  Bump `CACHE` when the list of cached files changes.
- `manifest.webmanifest` and `icons/` (180/192/512 PNG, gold star on indigo).

## Data model (Firestore)

```
users/{ownerUid}                  { rate, members: [parent emails], ownerEmail }
users/{ownerUid}/kids/{id}        { name, emoji, birthYear, interests, goalId, username, loginUid, created }
users/{ownerUid}/activities/{id}  { name, points, created }                 # quick picks for awarding
users/{ownerUid}/rewards/{id}     { name, points, icon, notFor: [kidIds], created }   # the reward store
users/{ownerUid}/tx/{id}          { kidId, kind: 'earn'|'spend', points, label, note, date: 'YYYY-MM-DD', created }
users/{ownerUid}/themes/{id}      { text, created }                         # themes for AI ideas
kidLogins/{kid auth uid}          { ownerUid, kidId, username }             # links a kid login to its data
```

- A balance is earn minus spend entries for a kid; never stored. First parent sign-in seeds default
  activities and rewards. Writes aren't awaited; `onSnapshot` listeners update `db` and re-render.
- `notFor` lists kids a reward is not suggested to; empty means all kids, including ones added later.
- **Family sharing:** the tree belongs to the parent who created it. Other parents are added by Gmail address
  (`members`). At sign-in `findFamily` queries `users` where `members` array-contains the email; the owner uid
  is cached per device in localStorage.
- **Rules summary:** parents (owner or verified-email member) read/write the whole tree; only the owner changes
  `members`. A kid can read the settings doc, their own kid doc, their own tx (query by `kidId`) and rewards,
  and can update only `goalId` on their kid doc. Themes and activities are parents only.

## Features

- Header: rate badge, sync pill (Synced/Saving/Offline). Kid switcher with balances (parents). Bottom nav:
  Home, Rewards, History, Settings ("Me" for kids).
- Home: wallet card (balance, ₹, this month, goal progress), inline Award form for parents (suggestions from
  quick activities and past entries, presets, note, date), "What you can get" card (affordable rewards for this
  kid plus "Next up"), recent activity.
- Rewards: store with icons, goal 🎯 (kids can set their own), Buy (parents), "Use points on something else",
  hidden-for-this-kid tag, and **✨ Get AI ideas**: themes + kid's age and interests + optional note → 6 ideas
  with ₹ prices; Add opens the reward form prefilled (suggested only to that kid) for the parent to approve.
- History: earned/used/balance totals, filters, search; parents tap an entry to edit or delete.
- Settings (parents): kids (name, emoji, birth year, interests), kid logins, parents/family, point value,
  quick activities, AI themes, account, backup/restore, erase all. Kids see only their account.

## Layout

Phone: single column with bottom nav. 600-899px: column up to 720px. 900px+: up to 1200px, nav becomes a left
sidebar, Home in two columns, rewards as a card grid, settings cards in two columns. `render()` sets
`main#app` class `page-{tab}` for these. With a mouse, chip rows wrap instead of scrolling sideways.

## Deploying

- Live: `npx firebase-tools deploy --only hosting,firestore:rules`.
- Preview without touching live: `npx firebase-tools hosting:channel:deploy <name> --expires 7d`
  (shares the live Firestore data and rules). Preview used for the redesign: `redesign`.
- Console setup already done: Google and Email/Password sign-in providers, AI Logic (Gemini Developer API),
  App Check with reCAPTCHA Enterprise.
- Nothing has an automated test; changes were checked by syntax check and by the user in the browser.
