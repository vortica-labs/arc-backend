import { Router, Request, Response } from "express";
import axios from "axios";
import { optionalAuth } from "./music.legacy-adapters";

const router = Router();
const JAMENDO_BASE = "https://api.jamendo.com/v3.0/tracks";

interface TrackResult {
  trackId: string;
  title: unknown;
  artist: unknown;
  url: unknown;
  coverUrl: unknown;
  duration: unknown;
  source: string;
}

// Curated fallback tracks returned when external APIs are unavailable
const FALLBACK_TRACKS: TrackResult[] = [
  { trackId: "fb-1",  title: "Victory Run",    artist: "Gaming Beats",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",  coverUrl: "", duration: 372, source: "demo" },
  { trackId: "fb-2",  title: "Arena",          artist: "Arc Studio",     url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",  coverUrl: "", duration: 221, source: "demo" },
  { trackId: "fb-3",  title: "Clutch Moment",  artist: "BGMI Vibes",     url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",  coverUrl: "", duration: 204, source: "demo" },
  { trackId: "fb-4",  title: "Drop Zone",      artist: "Gaming Beats",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",  coverUrl: "", duration: 407, source: "demo" },
  { trackId: "fb-5",  title: "Final Circle",   artist: "Arc Studio",     url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",  coverUrl: "", duration: 183, source: "demo" },
  { trackId: "fb-6",  title: "Sniper View",    artist: "War Zone",       url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",  coverUrl: "", duration: 291, source: "demo" },
  { trackId: "fb-7",  title: "Squad Wipe",     artist: "Gaming Beats",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",  coverUrl: "", duration: 375, source: "demo" },
  { trackId: "fb-8",  title: "Rank Push",      artist: "Arc Studio",     url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",  coverUrl: "", duration: 319, source: "demo" },
  { trackId: "fb-9",  title: "Neon Rush",      artist: "Electric Gamer", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",  coverUrl: "", duration: 204, source: "demo" },
  { trackId: "fb-10", title: "Boss Fight",     artist: "War Zone",       url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3", coverUrl: "", duration: 350, source: "demo" },
  { trackId: "fb-11", title: "Midnight Grind", artist: "Pixel Sounds",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3", coverUrl: "", duration: 283, source: "demo" },
  { trackId: "fb-12", title: "Headshot",       artist: "Gaming Beats",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3", coverUrl: "", duration: 410, source: "demo" },
  { trackId: "fb-13", title: "Chicken Dinner", artist: "Arc Studio",     url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3", coverUrl: "", duration: 188, source: "demo" },
  { trackId: "fb-14", title: "Tactical Push",  artist: "War Zone",       url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3", coverUrl: "", duration: 266, source: "demo" },
  { trackId: "fb-15", title: "Respawn",        artist: "Pixel Sounds",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3", coverUrl: "", duration: 335, source: "demo" },
];

const searchJamendo = async (q: string, tags: string, limit: number): Promise<TrackResult[]> => {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) return [];

  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(limit),
    order: "relevance_desc",
    audioformat: "mp32",
  });
  if (q) params.set("search", q);
  if (tags) params.set("tags", tags.replace(/\s+/g, "+"));

  const { data } = await axios.get(`${JAMENDO_BASE}/?${params.toString()}`, {
    timeout: 10000,
    headers: { Accept: "application/json" },
  });

  const results = (data as { results?: Array<Record<string, unknown>> }).results || [];
  return results.map((t) => ({
    trackId: `jm-${t.id}`,
    title: t.name || "Unknown",
    artist: t.artist_name || "Unknown",
    url: t.audio || "",
    coverUrl: t.album_image || t.image || "",
    duration: t.duration || 0,
    source: "jamendo",
  }));
};

const searchSoundCloud = async (q: string, limit: number): Promise<TrackResult[]> => {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret || !q) return [];

  try {
    // Exchange client credentials for an access token
    const tokenRes = await axios.post(
      "https://api.soundcloud.com/oauth2/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 }
    );
    const accessToken = (tokenRes.data as { access_token?: string })?.access_token;
    if (!accessToken) return [];

    type SCTrack = {
      id: number;
      title?: string;
      streamable?: boolean;
      stream_url?: string;
      duration?: number;
      artwork_url?: string;
      user?: { username?: string; avatar_url?: string };
    };

    const params = new URLSearchParams({ q, limit: String(limit), linked_partitioning: "1" });
    const { data } = await axios.get(`https://api.soundcloud.com/tracks?${params.toString()}`, {
      timeout: 8000,
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });

    const collection: SCTrack[] = Array.isArray(data)
      ? data
      : ((data as { collection?: SCTrack[] }).collection || []);

    return collection
      .filter((t) => t.streamable && t.stream_url)
      .map((t) => ({
        trackId: `sc-${t.id}`,
        title: t.title || "Unknown",
        artist: t.user?.username || "Unknown",
        url: `${t.stream_url}?oauth_token=${accessToken}`,
        coverUrl: (t.artwork_url || t.user?.avatar_url || "").replace("-large", "-t300x300"),
        duration: Math.floor((t.duration || 0) / 1000),
        source: "soundcloud",
      }));
  } catch (err) {
    console.warn("SoundCloud search skipped:", (err as { response?: { status?: number }; message?: string }).response?.status || (err as Error).message);
    return [];
  }
};

/**
 * GET /api/music/search?q=...&tags=...&limit=20
 * Queries Jamendo and SoundCloud in parallel and merges results.
 */
router.get("/search", optionalAuth, async (req: Request, res: Response) => {
  try {
    const jamendoConfigured = !!process.env.JAMENDO_CLIENT_ID;
    const soundcloudConfigured = !!process.env.SOUNDCLOUD_CLIENT_ID;

    if (!jamendoConfigured && !soundcloudConfigured) {
      return res.status(200).json({
        success: true,
        tracks: [],
        message: "Music search not configured. Add JAMENDO_CLIENT_ID or SOUNDCLOUD_CLIENT_ID to environment.",
      });
    }

    const q = (String(req.query.q || "")).trim();
    const tags = (String(req.query.tags || "")).trim();
    const limit = Math.min(parseInt(String(req.query.limit || "20"), 10) || 20, 50);

    if (!q && !tags) {
      return res.status(200).json({ success: true, tracks: FALLBACK_TRACKS.slice(0, limit) });
    }

    const bothActive = jamendoConfigured && soundcloudConfigured;
    const perSource = bothActive ? Math.ceil(limit / 2) : limit;

    const [jamendoResult, soundcloudResult] = await Promise.allSettled([
      jamendoConfigured ? searchJamendo(q, tags, perSource) : Promise.resolve([]),
      soundcloudConfigured && q ? searchSoundCloud(q, perSource) : Promise.resolve([]),
    ]);

    if (jamendoResult.status === "rejected") {
      console.error("Jamendo error:", (jamendoResult.reason as Error)?.message);
    }
    if (soundcloudResult.status === "rejected") {
      console.error("SoundCloud error:", (soundcloudResult.reason as Error)?.message);
    }

    const jamendoTracks = jamendoResult.status === "fulfilled" ? jamendoResult.value : [];
    const soundcloudTracks = soundcloudResult.status === "fulfilled" ? soundcloudResult.value : [];

    // Interleave: SC, Jamendo, SC, Jamendo... so both sources appear near the top
    const merged: TrackResult[] = [];
    const maxLen = Math.max(jamendoTracks.length, soundcloudTracks.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < soundcloudTracks.length) merged.push(soundcloudTracks[i]);
      if (i < jamendoTracks.length) merged.push(jamendoTracks[i]);
    }

    // If both APIs returned nothing, return curated fallback tracks
    const results = merged.length > 0 ? merged.slice(0, limit) : FALLBACK_TRACKS.slice(0, limit);
    return res.json({ success: true, tracks: results, fallback: merged.length === 0 });
  } catch (err) {
    const axiosError = err as { response?: { status?: number }; message?: string };
    if (axiosError.response?.status === 429) {
      return res.status(429).json({ success: false, message: "Too many requests. Try again in a minute." });
    }
    console.error("Music search error:", axiosError.message);
    return res.status(500).json({ success: false, message: "Music search failed. Try again." });
  }
});

export default router;
