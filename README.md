# Ewyl Points

A small web app (installable on Android as a PWA) to track points kids earn for goals and spend on rewards.

- Award points for activities, with one-tap quick activities.
- Deduct points when they're used, with quick rewards and a rupee value (1 point = ₹10 by default, changeable).
- Balance, monthly earned and used totals, and full history per kid. Tap an entry to edit or delete it.
- Data is stored in Firebase Firestore under your Google account, syncs across devices, and works offline.

No build step: plain HTML, CSS and JavaScript, with the Firebase SDK loaded from Google's CDN.

## Firebase setup (one time)

1. Go to <https://console.firebase.google.com>, then **Create a project** (Google Analytics is not needed).
2. **Build > Authentication > Get started > Sign-in method > Google > Enable**, then Save.
3. **Authentication > Settings > Authorized domains > Add domain**, and add `kgovin-cloud.github.io`.
4. **Build > Firestore Database > Create database**. Pick a location near you (for example `asia-south1`, Mumbai)
   and start in **production mode**.
5. **Firestore > Rules**: replace the rules with the contents of [`firestore.rules`](firestore.rules), then **Publish**.
6. **Project settings (gear) > General > Your apps > Web (`</>`)**: register an app (no Firebase Hosting needed),
   then copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js).

The config values are not secrets. Anyone can see them in a web app. The Firestore rules are what keep each
account's data private.

## Hosting on GitHub Pages

Repo **Settings > Pages > Build and deployment**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**.
The app is then at <https://kgovin-cloud.github.io/ewylapp/>.

## Installing on Android

Open the URL in Chrome, sign in, then **⋮ > Add to Home screen** (or **Install app**).

## Running locally

Serve the folder over HTTP (service workers and ES modules don't work from `file://`), for example
`npx serve .`, and add `localhost` to the Firebase authorized domains (it's usually there by default).
