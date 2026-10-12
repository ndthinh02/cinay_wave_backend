# CinayWave backend

Express/Mongoose API. Requires Node.js 22+, MongoDB and network access to the catalog and configured identity/storage services.

Run `npm install` before starting: the latest Google auth dependency has been added to package.json, but the editing environment could not reach npm to update package-lock.json. Commit the refreshed lockfile before using `npm ci` in deployment.

Copy `.env.example` to `.env`, configure `MONGODB_URI` and a private `JWT_SECRET` of at least 32 characters, then run `npm start`. Never commit `.env`.

Configure SMTP for email verification, `GOOGLE_WEB_CLIENT_ID` for Google sign-in (the same Web OAuth client ID as Android), and Cloudinary for avatar uploads. Google tokens are verified using Google's official library. Deploy behind HTTPS; set `NODE_ENV=production` and set `TRUST_PROXY_HOPS` only to the known number of trusted proxy hops.

`GET /api/health` returns 200 when the database is ready, otherwise 503. Catalog remains accessible while MongoDB reconnects; account operations return 503.

Run the existing smoke check against an isolated database whose name contains `smoke`: set `SMOKE_MONGODB_URI=mongodb://127.0.0.1:27017/cinaywave_smoke`, then run `npm run smoke`. External providers are stubbed only in this check.
