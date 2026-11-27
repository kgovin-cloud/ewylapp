# Ewyl Points

Web app, installable on Android as a PWA, for tracking points a parent awards their kids for goals.
Kids spend points on things they want. 1 point = ₹10 by default, changeable in Settings.

## Version control

This repo uses **git**, not Perforce. The global CLAUDE.md rule about Perforce does not apply here.

- GitHub: https://github.com/kgovin-cloud/ewylapp (private), branch `main`.
- Local copy: `C:\Users\ksanthan\personal\github\ewylapp`. It was moved from `H:\personal\github\ewylapp`,
  a network share where git couldn't reliably update its own files. The old H: copy is obsolete.

## Decisions made

- **Plain HTML/CSS/JS, no build step, no npm dependencies.** The Firebase SDK v12.6.0 is loaded as ES modules
  from `https://www.gstatic.com/firebasejs/12.6.0/...`.
- **Data: Firebase Firestore**, chosen over local-only storage and over saving a JSON file to a GitHub repo.
  Google sign-in through Firebase Auth. Firestore's persistent local cache gives offline use and later sync.
- **Hosting: Firebase Hosting** at https://ewylapp.web.app. Not GitHub Pages, because Pages on a free account
  needs a public repo and the repo should stay private.
- Firebase project ID is `ewylapp`. The web config is in `firebase-config.js`. It isn't secret; the
  security rules in `firestore.rules` restrict each user to `users/{their uid}/**`.

## Files

- `index.html`: app shell. `app.js`: all logic (ES module). `styles.css`: mobile-first styles.
- `firebase-config.js`: Firebase web config. `firestore.rules`: security rules.
- `firebase.json` and `.firebaserc`: Hosting config (serves the repo root and ignores the config and docs files)
  and the rules path.
- `sw.js`: service worker. App files are network-first with an offline fallback; Firebase SDK files are
  cache-first. Bump `CACHE` when the list of cached files changes.
- `manifest.webmanifest` and `icons/` (180/192/512 PNG, gold star on indigo).

## Data model (Firestore)

```
users/{uid}                  { rate, members, ownerEmail }  # ₹ per point; members = emails sharing this family
users/{uid}/kids/{id}        { name, emoji, created }
users/{uid}/activities/{id}  { name, points, created }      # quick-pick list for awarding
users/{uid}/rewards/{id}     { name, points, created }      # quick-pick list for spending
users/{uid}/tx/{id}          { kidId, kind: 'earn'|'spend', points, label, note, date: 'YYYY-MM-DD', created }
```

A balance is the sum of a kid's earn entries minus their spend entries; it is never stored. The first sign-in
seeds default activities and rewards. Writes aren't awaited, because Firestore applies them locally first, and
`onSnapshot` listeners update the in-memory `db` and re-render.

**Family sharing:** the data tree belongs to the parent who created it. They add other parents by email in
Settings → Family (stored in `members`, lowercase). At sign-in, `findFamily` queries `users` where `members`
array-contains the user's email; if found, the app uses that owner's tree (`ownerUid`), cached per device in
localStorage. Rules let members read/write everything under the owner's tree except `members`/`ownerEmail`.

## Features

- Home: a card per kid with balance in points and ₹, plus a feed of recent entries.
- Kid page: balance, earned and used this month, **Award points** / **Use points** dialogs with quick picks,
  a date, a note, and an option to save the entry as a quick pick. Spending can't exceed the balance.
  History is grouped by day with All/Earned/Used tabs. Tap an entry to edit or delete it.
- Settings: point value, kids (name and emoji), quick activities and rewards, account and sign-out,
  JSON backup download and restore, and erase all.

## Status and next steps

- Deployed to https://ewylapp.web.app (deploy: `npx firebase-tools deploy --only hosting,firestore:rules`).
  Google sign-in had to be enabled in the Firebase console; it works on the laptop.
- `firebase.json` must explicitly ignore `.git/**`: on Windows `**/.*` did not exclude it, and the first deploy
  published `.git`.
- To test: phone sign-in (earlier it bounced back to the sign-in page, likely due to the then-missing Google
  provider), family sharing with a second account, offline use, install to home screen.
