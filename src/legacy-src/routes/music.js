const express = require('express');
const axios = require('axios');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();
const JAMENDO_BASE = 'https://api.jamendo.com/v3.0/tracks';

const FALLBACK_TRACKS = [
  { trackId: 'fb-1',  title: 'Victory Run',    artist: 'Gaming Beats',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',  coverUrl: '', duration: 372, source: 'demo' },
  { trackId: 'fb-2',  title: 'Arena',          artist: 'Arc Studio',     url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',  coverUrl: '', duration: 221, source: 'demo' },
  { trackId: 'fb-3',  title: 'Clutch Moment',  artist: 'BGMI Vibes',     url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',  coverUrl: '', duration: 204, source: 'demo' },
  { trackId: 'fb-4',  title: 'Drop Zone',      artist: 'Gaming Beats',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',  coverUrl: '', duration: 407, source: 'demo' },
  { trackId: 'fb-5',  title: 'Final Circle',   artist: 'Arc Studio',     url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',  coverUrl: '', duration: 183, source: 'demo' },
  { trackId: 'fb-6',  title: 'Sniper View',    artist: 'War Zone',       url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',  coverUrl: '', duration: 291, source: 'demo' },
  { trackId: 'fb-7',  title: 'Squad Wipe',     artist: 'Gaming Beats',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',  coverUrl: '', duration: 375, source: 'demo' },
  { trackId: 'fb-8',  title: 'Rank Push',      artist: 'Arc Studio',     url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',  coverUrl: '', duration: 319, source: 'demo' },
  { trackId: 'fb-9',  title: 'Neon Rush',      artist: 'Electric Gamer', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',  coverUrl: '', duration: 204, source: 'demo' },
  { trackId: 'fb-10', title: 'Boss Fight',     artist: 'War Zone',       url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3', coverUrl: '', duration: 350, source: 'demo' },
  { trackId: 'fb-11', title: 'Midnight Grind', artist: 'Pixel Sounds',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3', coverUrl: '', duration: 283, source: 'demo' },
  { trackId: 'fb-12', title: 'Headshot',       artist: 'Gaming Beats',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3', coverUrl: '', duration: 410, source: 'demo' },
  { trackId: 'fb-13', title: 'Chicken Dinner', artist: 'Arc Studio',     url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3', coverUrl: '', duration: 188, source: 'demo' },
  { trackId: 'fb-14', title: 'Tactical Push',  artist: 'War Zone',       url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3', coverUrl: '', duration: 266, source: 'demo' },
  { trackId: 'fb-15', title: 'Respawn',        artist: 'Pixel Sounds',   url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3', coverUrl: '', duration: 335, source: 'demo' },
];

const searchJamendo = async (q, tags, limit) => {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) return [];

  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: String(limit),
    order: 'relevance_desc',
    audioformat: 'mp32',
  });
  if (q) params.set('search', q);
  if (tags) params.set('tags', tags.replace(/\s+/g, '+'));

  const { data } = await axios.get(`${JAMENDO_BASE}/?${params.toString()}`, {
    timeout: 10000,
    headers: { Accept: 'application/json' },
  });

  return (data.results || []).map((t) => ({
    trackId: `jm-${t.id}`,
    title: t.name || 'Unknown',
    artist: t.artist_name || 'Unknown',
    url: t.audio || '',
    coverUrl: t.album_image || t.image || '',
    duration: t.duration || 0,
    source: 'jamendo',
  }));
};

const searchSoundCloud = async (q, limit) => {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret || !q) return [];

  try {
    // Exchange client credentials for an access token
    const tokenRes = await axios.post(
      'https://api.soundcloud.com/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      }
    );
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) return [];

    const params = new URLSearchParams({ q, limit: String(limit), linked_partitioning: '1' });
    const { data } = await axios.get(
      `https://api.soundcloud.com/tracks?${params.toString()}`,
      {
        timeout: 8000,
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      }
    );

    const collection = Array.isArray(data) ? data : (data.collection || []);
    return collection
      .filter((t) => t.streamable && t.stream_url)
      .map((t) => ({
        trackId: `sc-${t.id}`,
        title: t.title || 'Unknown',
        artist: t.user?.username || 'Unknown',
        url: `${t.stream_url}?oauth_token=${accessToken}`,
        coverUrl: (t.artwork_url || t.user?.avatar_url || '').replace('-large', '-t300x300'),
        duration: Math.floor((t.duration || 0) / 1000),
        source: 'soundcloud',
      }));
  } catch (err) {
    console.warn('SoundCloud search skipped:', err.response?.status || err.message);
    return [];
  }
};

/**
 * GET /api/music/search?q=...&tags=...&limit=20
 * Queries Jamendo and SoundCloud in parallel and merges results.
 */
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const jamendoConfigured = !!process.env.JAMENDO_CLIENT_ID;
    const soundcloudConfigured = !!process.env.SOUNDCLOUD_CLIENT_ID;

    if (!jamendoConfigured && !soundcloudConfigured) {
      return res.status(200).json({
        success: true,
        tracks: [],
        message: 'Music search not configured. Add JAMENDO_CLIENT_ID or SOUNDCLOUD_CLIENT_ID to .env',
      });
    }

    const q = (req.query.q || '').trim();
    const tags = (req.query.tags || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    if (!q && !tags) {
      return res.status(200).json({ success: true, tracks: FALLBACK_TRACKS.slice(0, limit) });
    }

    const bothActive = jamendoConfigured && soundcloudConfigured;
    const perSource = bothActive ? Math.ceil(limit / 2) : limit;

    const [jamendoResult, soundcloudResult] = await Promise.allSettled([
      jamendoConfigured ? searchJamendo(q, tags, perSource) : Promise.resolve([]),
      soundcloudConfigured && q ? searchSoundCloud(q, perSource) : Promise.resolve([]),
    ]);

    if (jamendoResult.status === 'rejected') {
      console.error('Jamendo error:', jamendoResult.reason?.message);
    }
    if (soundcloudResult.status === 'rejected') {
      console.error('SoundCloud error:', soundcloudResult.reason?.message);
    }

    const jamendoTracks = jamendoResult.status === 'fulfilled' ? jamendoResult.value : [];
    const soundcloudTracks = soundcloudResult.status === 'fulfilled' ? soundcloudResult.value : [];

    // Interleave: sc, jm, sc, jm... so both sources appear near the top
    const merged = [];
    const maxLen = Math.max(jamendoTracks.length, soundcloudTracks.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < soundcloudTracks.length) merged.push(soundcloudTracks[i]);
      if (i < jamendoTracks.length) merged.push(jamendoTracks[i]);
    }

    const results = merged.length > 0 ? merged.slice(0, limit) : FALLBACK_TRACKS.slice(0, limit);
    return res.json({ success: true, tracks: results, fallback: merged.length === 0 });
  } catch (err) {
    if (err.response && err.response.status === 429) {
      return res.status(429).json({ success: false, message: 'Too many requests. Try again in a minute.' });
    }
    console.error('Music search error:', err.message);
    return res.status(500).json({ success: false, message: 'Music search failed. Try again.' });
  }
});

module.exports = router;
