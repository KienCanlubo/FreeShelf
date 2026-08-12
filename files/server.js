import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();

// In development (no FRONTEND_ORIGIN set) this allows any origin, which is
// fine for localhost testing. In production, set FRONTEND_ORIGIN to your
// deployed frontend's exact URL (e.g. https://your-app.vercel.app) so only
// your site can call this API.
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

const PORT = process.env.PORT || 3000;

// Very small in-memory cache so a page refresh doesn't hammer Steam/Epic.
// Key -> { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// EPIC GAMES — uses Epic's public (unofficial) free-promotions endpoint.
// This is the same endpoint most Epic free-games trackers use. No API key.
// Note: Epic does not return clean genre tags, so `genre` comes back null —
// see README for options to enrich this from a third-party source.
// ---------------------------------------------------------------------------
app.get("/api/epic/free", async (req, res) => {
  const cached = getCached("epic");
  if (cached) return res.json(cached);

  try {
    const url =
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US";
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Epic API responded ${r.status}`);
    const data = await r.json();

    const elements = data?.data?.Catalog?.searchStore?.elements || [];

    const games = elements
      .filter((g) => {
        const promos = g.promotions;
        return (
          promos &&
          ((promos.promotionalOffers && promos.promotionalOffers.length) ||
            (promos.upcomingPromotionalOffers && promos.upcomingPromotionalOffers.length))
        );
      })
      .map((g) => {
        const image =
          (g.keyImages.find((i) => i.type === "OfferImageWide") ||
            g.keyImages.find((i) => i.type === "Thumbnail") ||
            g.keyImages[0] ||
            {}
          ).url || null;

        const currentOffer = g.promotions.promotionalOffers?.[0]?.promotionalOffers?.[0];
        const upcomingOffer = g.promotions.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];
        const offer = currentOffer || upcomingOffer;
        const isFreeNow = !!currentOffer;

        const slug =
          g.productSlug ||
          g.offerMappings?.[0]?.pageSlug ||
          g.catalogNs?.mappings?.[0]?.pageSlug ||
          "";

        return {
          name: g.title,
          image,
          releaseDate: g.effectiveDate || null,
          freeFrom: offer?.startDate || null,
          freeUntil: offer?.endDate || null,
          status: isFreeNow ? "free-now" : "upcoming",
          platform: "epic",
          url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : "https://store.epicgames.com/en-US/free-games",
          genre: null
        };
      });

    const payload = { count: games.length, games };
    setCached("epic", payload);
    res.json(payload);
  } catch (err) {
    console.error("Epic fetch failed:", err.message);
    res.status(502).json({ error: "Failed to fetch Epic free games", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// STEAM — Steam has no dedicated "free games" API, so we use the store
// search endpoint filtered to maxprice=free, then call appdetails for each
// result to get genre + header image + release date.
// ---------------------------------------------------------------------------
app.get("/api/steam/free", async (req, res) => {
  const cached = getCached("steam");
  if (cached) return res.json(cached);

  try {
    // Steam's search endpoint pages results 50 at a time. Walk through pages
    // until Steam stops returning new results (or we hit a sane upper bound)
    // so we're not stuck with just the first page's 50 games.
    const appIds = [];
    const PAGE_SIZE = 50;
    const MAX_PAGES = 6; // 6 * 50 = up to 300 candidate app IDs
    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE;
      const searchUrl = `https://store.steampowered.com/search/results/?query&start=${start}&count=${PAGE_SIZE}&maxprice=free&category1=998&infinite=1`;
      const sr = await fetch(searchUrl);
      if (!sr.ok) throw new Error(`Steam search responded ${sr.status}`);
      const searchJson = await sr.json();

      const $ = cheerio.load(searchJson.results_html || "");
      const pageIds = [];
      $("a.search_result_row").each((_, el) => {
        const id = $(el).attr("data-ds-appid");
        if (id) pageIds.push(id);
      });

      if (pageIds.length === 0) break; // no more pages
      appIds.push(...pageIds);
      if (pageIds.length < PAGE_SIZE) break; // last page was partial, so we're done
    }

    // Cap how many detail calls we make per request to stay under Steam's
    // informal appdetails rate limit (~200 req / 5 min per IP) while still
    // covering the vast majority of the free-to-play catalog. Raise this
    // further if you're not seeing 429s in the logs.
    const limited = [...new Set(appIds)].slice(0, 150);

    async function fetchDetail(id) {
      try {
        const dr = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=en`
        );
        const dj = await dr.json();
        const info = dj?.[id]?.data;
        if (!info) return null;

        return {
          name: info.name,
          image: info.header_image || null,
          releaseDate: info.release_date?.date || null,
          genre: info.genres?.[0]?.description || "Unknown",
          genres: (info.genres || []).map((g) => g.description),
          status: "free-to-play",
          platform: "steam",
          url: `https://store.steampowered.com/app/${id}`
        };
      } catch {
        return null;
      }
    }

    // Fetch in small concurrent batches (instead of all at once) to stay
    // friendlier to Steam's informal rate limit on appdetails.
    const BATCH_SIZE = 10;
    const details = [];
    for (let i = 0; i < limited.length; i += BATCH_SIZE) {
      const batch = limited.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(fetchDetail));
      details.push(...results);
    }

    const games = details.filter(Boolean);
    const payload = { count: games.length, games };
    setCached("steam", payload);
    res.json(payload);
  } catch (err) {
    console.error("Steam fetch failed:", err.message);
    res.status(502).json({ error: "Failed to fetch Steam free games", detail: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Free-games proxy running at http://localhost:${PORT}`);
  console.log(`  GET /api/steam/free`);
  console.log(`  GET /api/epic/free`);
});
