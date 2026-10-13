# CinayWave backend

Express/Mongoose API. Requires Node.js 22+, MongoDB and network access to the catalog and configured identity/storage services.

Run `npm install` before starting: the latest Google auth dependency has been added to package.json, but the editing environment could not reach npm to update package-lock.json. Commit the refreshed lockfile before using `npm ci` in deployment.

Copy `.env.example` to `.env`, configure `MONGODB_URI` and a private `JWT_SECRET` of at least 32 characters, then run `npm start`. Never commit `.env`.

Configure SMTP for email verification, `GOOGLE_WEB_CLIENT_ID` for Google sign-in (the same Web OAuth client ID as Android), and Cloudinary for avatar uploads. Google tokens are verified using Google's official library. Deploy behind HTTPS; set `NODE_ENV=production` and set `TRUST_PROXY_HOPS` only to the known number of trusted proxy hops.

Proxy configuration defaults to 0 locally and 1 on Render (`RENDER=true`) when `TRUST_PROXY_HOPS` is unset or blank. An explicit value overrides this: if Render currently has `TRUST_PROXY_HOPS=0`, change it to `1` for the nearest proxy or remove the variable, then redeploy. Set the actual trusted hop count if additional proxies are present. Startup logs `server.proxy_config`; AI requests log `ai.result` with HTTP status, error code and a request ID, plus sanitized provider status/code for failed AI calls. These logs never include API keys, prompts, conversation history or personal data.

`GET /api/health` returns 200 when the database is ready, otherwise 503. Catalog remains accessible while MongoDB reconnects; account operations return 503.

Run the existing smoke check against an isolated database whose name contains `smoke`: set `SMOKE_MONGODB_URI=mongodb://127.0.0.1:27017/cinaywave_smoke`, then run `npm run smoke`. External providers are stubbed only in this check.

## CineWave AI

Get a Groq key at https://console.groq.com/keys. On Render, set `AI_PROVIDER=groq`, `AI_API_KEY` to that server-only key, `AI_MODEL=openai/gpt-oss-20b` and `AI_RATE_LIMIT_PER_MINUTE=8`, then deploy and try a chat question. Free Plan quota depends on your account/model; one question can consume two provider requests (`movie_intent` and `movie_answer`). Groq uses Chat Completions with strict JSON Schema and Zod validation; its endpoint does not support `store`, so that parameter is omitted. See https://console.groq.com/docs/structured-outputs and https://console.groq.com/docs/rate-limits.

To use OpenAI, set `AI_PROVIDER=openai`, an OpenAI `AI_API_KEY` and a compatible `AI_MODEL` such as `gpt-4.1-mini`. An unset/blank provider defaults to OpenAI for existing deployments. OpenAI keeps Responses with `store: false`; neither provider saves chats to MongoDB or automatically switches providers/retries on quota errors. The backend rate limit defaults to 8 requests/minute/IP and accepts integers from 1 to 120; invalid provider/rate-limit settings stop startup. Unsupported key/model/schema configuration returns `AI_NOT_CONFIGURED`; Groq models must support strict outputs (currently `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`). Provider 429 limits remain distinct from backend limits and credit/spend limits; a valid provider `Retry-After` is forwarded to the client.

`POST /api/ai/chat` accepts `{ message, history?: [{ role, content }], contextMovieSlug?, personalize?: false }`. Public requests work without MongoDB. Personalization requires a valid existing Bearer session and reads only that account's bounded favorites/recent movies. Limits: 1,500 characters/message, 12 history turns/8,000 total history characters, 24 candidates, 6 cards, 8 requests/minute/IP, 35-second deadline. Responses contain `{ reply, movies, suggestedQuestions }`; playback sources are fetched through the existing detail/player flow. Episode totals and minute limits are checked only when metadata establishes them; search covers a bounded candidate set.

Android: tap the sparkle button on Home, or “Hỏi AI về phim này” in details. Personalization starts off and clears the conversation when changed; logout/account changes also clear it. For a phone, build with `-PDEBUG_API_URL=http://<PC-LAN-IP>:3000/api/`, allow that IP in `app/src/debug/res/xml/debug_network.xml`, run `npm start`, and install `app/build/outputs/apk/debug/app-debug.apk`. Use the same Wi-Fi network. The default Android URL points to the hosted backend, which must receive these source changes separately; this task does not deploy it.

Verified locally: debug APK build, backend syntax/startup, real catalog/detail retrieval, request validation, `AI_NOT_CONFIGURED`, no results, candidate-ID enforcement, provider 429/500 handling and authenticated-subject authorization. AI/provider HTTP and database were stubbed for response/error/authorization checks; no real AI answer or device UI has been verified without credentials/a phone.
