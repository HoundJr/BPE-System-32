# Job Shop Dashboard

A simple RFQ-to-shipment dashboard for a one-person machine shop: customer/job
tracking, a single-queue status board, and a per-job traveler with operations,
material info, and a time log. Static site (no build step), hosted on GitHub
Pages, backed by Firebase (Firestore + Auth).

See `C:\Users\User\.claude\plans\my-job-shop-machining-structured-moon.md` for
the full design decisions and future-phase notes (Reference Class Forecasting
quoting, invoice generation, etc).

## One-time setup

1. **Create a Firebase project** at https://console.firebase.google.com.
2. **Add a web app** to the project (the `</>` icon on the project overview
   page). Copy the `firebaseConfig` object it gives you into
   [js/firebase-config.js](js/firebase-config.js), replacing the placeholder
   values. This config is not a secret — it's fine to commit it publicly.
3. **Enable Authentication**: in the Firebase console, go to
   Authentication > Sign-in method, enable "Email/Password", then go to the
   Users tab and add yourself as a user (your email + a password).
4. **Create Firestore Database**: Firestore Database > Create database,
   start in production mode, pick a region.
5. **Set security rules**: in Firestore > Rules, paste in the contents of
   [firestore.rules](firestore.rules) and publish. This restricts all
   reads/writes to logged-in users only.
6. **Add your first customer** so job numbers have something to attach to —
   this is done from within the app itself once it's running (Customers tab).

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to Settings > Pages, set "Source" to your default branch,
   root folder.
3. Visit the URL GitHub gives you, log in with the account you created in
   step 3 above.

## Local preview

Because the app uses ES modules (`type="module"`), open it through a local
server rather than a `file://` URL — e.g. from this folder:

```
npx serve .
```

or any other static file server, then visit the printed localhost URL.

## Notes

- The job detail/traveler view prints cleanly (nav and buttons are hidden via
  a print stylesheet) if you want a paper copy for the shop floor.
- Job numbers are `<customer number>-<sequence>`, e.g. `123-004` for the 4th
  job from customer `123`. Assign customer numbers however makes sense to you
  when adding a customer.
- "Lost" quotes are hidden from the board by default (checkbox to show them)
  so they don't clutter the working queue.
