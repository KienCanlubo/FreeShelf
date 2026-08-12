# Free Games Proxy — Backend

A tiny Express server that fetches free-game data from Steam and Epic
Games on the server side, so your frontend can call it without running
into CORS errors (browsers block direct calls to Steam/Epic's APIs from
a page running on a different origin).

## Setup

```bash
cd backend
npm install
npm start
```

The server runs at `http://localhost:3000` by default (set `PORT` to change it).

## Endpoints

- `GET /api/steam/free` — currently free-to-play games on Steam
- `GET /api/epic/free` — Epic Games Store's current + upcoming free promos
- `GET /health` — simple liveness check

Each returns:

```json
{
  "count": 10,
  "games": [
    {
      "name": "Team Fortress 2",
      "image": "https://...",
      "releaseDate": "21 Sep, 2023",
      "genre": "Action",
      "status": "free-to-play",
      "platform": "steam",
      "url": "https://store.steampowered.com/app/440"
    }
  ]
}
```

Responses are cached in memory for 30 minutes so you're not hitting
Steam/Epic on every page load — restart the server to clear the cache.

## How each platform is fetched

**Epic** — calls Epic's public (unofficial but widely used) free-promotions
endpoint directly. It returns clean JSON: title, images, and the promo
start/end dates. No API key needed.

**Steam** — Steam has no dedicated "free games" endpoint, so this uses
the store search page filtered to `maxprice=free`, pulls out the app IDs,
then calls `appdetails` for each one to get genre, header image, and
release date. To keep things fast and avoid rate limits, only the first
25 results get the detail lookup.

## Known limitations (worth knowing before you build on this)

1. **Epic doesn't expose genre tags.** Its API returns `genre: null`.
   If you want genre filtering to work for Epic games too, you'd need to
   cross-reference each title against a third-party catalog like
   [RAWG.io](https://rawg.io/apidocs) or IGDB — happy to wire that in if
   you want it.
2. **Both are unofficial/public endpoints, not documented APIs.** Steam
   and Epic could change response shapes without notice. If a route
   starts returning empty results, that's the most likely cause.
3. **Steam's `appdetails` has an informal rate limit** (roughly
   200 requests per 5 minutes per IP). The 25-item cap keeps normal usage
   safe; raise it if you need more, but watch for 429s.
4. This is a **local dev proxy**, not hardened for production — no
   request rate limiting, no auth. Fine for a personal project or
   internal tool; add protections before deploying it publicly.

## Deploying (Render)

1. Push this project to a GitHub repo (backend and frontend folders both included).
2. Go to [render.com](https://render.com), sign in with GitHub, click **New +** → **Web Service**, and point it at your repo's `backend` folder.
3. Render will detect `render.yaml` and pre-fill the build/start commands. Confirm and deploy.
4. Once live, copy the URL Render gives you (something like `https://free-games-proxy.onrender.com`).
5. In your deployed frontend's `index.html`, replace `YOUR_BACKEND_URL` with that Render URL.
6. Back in Render, set the `FRONTEND_ORIGIN` environment variable to your deployed frontend's exact URL (e.g. `https://your-app.vercel.app`) — this locks down CORS so only your site can call the API.

Render's free tier spins down after inactivity, so the first request after
a quiet period can take ~30–60 seconds to wake back up. That's normal.

