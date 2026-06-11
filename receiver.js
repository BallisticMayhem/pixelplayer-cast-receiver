/*
 * PixelPlayer custom Cast receiver logic.
 *
 * Responsibilities:
 *   - Boot the CAF receiver and keep the hidden <cast-media-player> as the playback engine.
 *   - Mirror the now-playing metadata (title / artist / artwork) into our custom DOM.
 *   - Extract the album-art colours and theme the whole screen per song (blob bg + accents),
 *     matching the PixelPlayer phone aesthetic. Falls back to a neutral theme if the art can't
 *     be read (e.g. the art server didn't send CORS headers).
 *   - Drive the M3-Expressive "squiggle" (wavy) progress bar from the live playback clock.
 *   - Listen on a PixelPlayer custom message channel so the phone can push UI state to the TV
 *     (e.g. open fullscreen lyrics). Sender-side wiring is a follow-up; the handler is ready.
 */

(function () {
  'use strict';

  // ---- TEMP on-screen logging (paired with the #debug overlay in index.html). Remove once working.
  const log = (m, k) => { try { if (window.__ppLog) window.__ppLog(m, k); } catch (e) {} };
  // Flush anything the head error-handler queued before #debug existed.
  try {
    if (window.__ppLogs && window.__ppLog) {
      window.__ppLogs.splice(0).forEach((a) => window.__ppLog(a[0], a[1]));
    }
  } catch (e) {}
  // Version marker: bump alongside the ?v= cache-buster in index.html so the on-TV overlay
  // proves which copy the (aggressively caching) cast platform actually loaded.

  // ---- Custom message channel (phone -> TV control) -------------------------------------------
  // Keep this in sync with the sender (the Android app) when we wire phone->TV control.
  const PIXELPLAYER_NAMESPACE = 'urn:x-cast:com.theveloper.pixelplay';

  // ---- DOM handles ----------------------------------------------------------------------------
  const el = {
    root: document.documentElement,
    stage: document.getElementById('stage'),
    artWrap: document.getElementById('artWrap'),
    art: document.getElementById('art'),
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    badge: document.getElementById('badge'),
    cur: document.getElementById('cur'),
    dur: document.getElementById('dur'),
    wave: document.getElementById('wave'),
    songInfo: document.getElementById('songInfo'),
    info: document.getElementById('info'),
    progress: document.getElementById('progress'),
    lyricsView: document.getElementById('lyricsView'),
    lyProgressSlot: document.getElementById('lyProgressSlot'),
    lyArt: document.getElementById('lyArt'),
    lyTitle: document.getElementById('lyTitle'),
    lySub: document.getElementById('lySub'),
  };

  // ---- Small helpers --------------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function setVar(name, value) { el.root.style.setProperty(name, value); }

  // sRGB helpers for relative luminance / contrast.
  function relLum(r, g, b) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const la = relLum(a[0], a[1], a[2]) + 0.05;
    const lb = relLum(b[0], b[1], b[2]) + 0.05;
    return la > lb ? la / lb : lb / la;
  }
  const rgb = (c) => `rgb(${c[0]|0}, ${c[1]|0}, ${c[2]|0})`;
  const rgba = (c, a) => `rgba(${c[0]|0}, ${c[1]|0}, ${c[2]|0}, ${a})`;
  const mix = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

  function rgbToHsl(r, g, b) {
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b); let h,s,l=(max+min)/2;
    if (max===min) { h=s=0; }
    else {
      const d=max-min; s=l>0.5? d/(2-max-min): d/(max+min);
      switch(max){ case r: h=(g-b)/d+(g<b?6:0); break; case g: h=(b-r)/d+2; break; default: h=(r-g)/d+4; }
      h/=6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s===0) { r=g=b=l; }
    else {
      const hue2rgb=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
      const q=l<0.5? l*(1+s): l+s-l*s; const p=2*l-q;
      r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
    }
    return [r*255, g*255, b*255];
  }
  const withL = (c, l) => { const [h,s] = rgbToHsl(c[0],c[1],c[2]); return hslToRgb(h, s, l); };
  const withSL = (c, s, l) => { const [h] = rgbToHsl(c[0],c[1],c[2]); return hslToRgb(h, s, l); };

  // ---- Theme ----------------------------------------------------------------------------------
  const NEUTRAL = {
    seed: [141, 110, 197],
  };

  function applyTheme(seed) {
    // Build a small, PixelPlayer-ish dark scheme from one seed colour.
    const [h, s] = rgbToHsl(seed[0], seed[1], seed[2]);
    const sat = clamp(s, 0.35, 0.9);

    const bg0 = hslToRgb(h, clamp(sat * 0.6, 0.18, 0.5), 0.07);
    const bg1 = hslToRgb(h, clamp(sat * 0.7, 0.22, 0.55), 0.14);
    const blobA = hslToRgb(h, sat, 0.42);
    const blobB = hslToRgb((h + 0.06) % 1, clamp(sat * 0.95, 0.3, 0.95), 0.6);
    const blobC = hslToRgb((h + 0.92) % 1, clamp(sat * 0.8, 0.25, 0.8), 0.32);

    // Primary/accent: a bright tone of the seed, guaranteed legible on the dark bg.
    let primary = withSL(seed, clamp(sat + 0.1, 0.5, 1), 0.74);
    if (contrast(primary, bg0) < 4.5) primary = withL(primary, 0.82);
    const onPrimary = contrast([20, 20, 20], primary) >= contrast([245, 245, 245], primary)
      ? [22, 18, 30] : [245, 240, 250];
    const onSurface = [243, 238, 248];

    setVar('--bg-0', rgb(bg0));
    setVar('--bg-1', rgb(bg1));
    setVar('--blob-a', rgb(blobA));
    setVar('--blob-b', rgb(blobB));
    setVar('--blob-c', rgb(blobC));
    setVar('--primary', rgb(primary));
    setVar('--on-primary', rgb(onPrimary));
    setVar('--on-surface', rgb(onSurface));
    setVar('--on-surface-dim', rgba(onSurface, 0.66));
    setVar('--track', rgba(onSurface, 0.18));
    // Seekbar pill: a darker tone of the album hue. File-info pill mirrors the phone's chip
    // (onPrimary-ish background, primary text).
    setVar('--seek-pill', rgba(hslToRgb(h, clamp(sat * 0.5, 0.15, 0.45), 0.12), 0.85));
    setVar('--pill-bg', rgba(onPrimary, 0.85));
    setVar('--pill-fg', rgb(primary));

    theme.primary = primary;
    theme.track = mix(onSurface, bg0, 0.5);
  }

  const theme = { primary: NEUTRAL.seed, track: [120, 120, 130] };

  // True once the phone has pushed its real Material You palette for the CURRENT track (reset on
  // every LOAD). Art-based extraction runs first as the instant approximation — the phone's scheme
  // computation arrives a beat later — and the exact pushed palette then corrects it; the flag
  // stops a slow art load from overwriting a palette that already arrived.
  let paletteForTrack = false;

  // Apply the EXACT palette the phone computed (matches its fullscreen-lyrics blob recipe:
  // blobs are primary/secondary/primaryContainer lerped slightly toward surface).
  function applyPushedPalette(p) {
    try {
      const surface = p.surface, onSurface = p.onSurface;
      const primary = p.primary, onPrimary = p.onPrimary;
      setVar('--bg-0', rgb(surface));
      setVar('--bg-1', rgb(mix(p.primaryContainer, surface, 0.6)));
      setVar('--blob-a', rgb(mix(primary, surface, 0.10)));
      setVar('--blob-b', rgb(mix(p.secondary, surface, 0.10)));
      setVar('--blob-c', rgb(mix(p.primaryContainer, surface, 0.05)));
      setVar('--primary', rgb(primary));
      setVar('--on-primary', rgb(onPrimary));
      setVar('--on-surface', rgb(onSurface));
      setVar('--on-surface-dim', rgba(onSurface, 0.66));
      setVar('--track', rgba(onSurface, 0.18));
      setVar('--seek-pill', rgba(p.surfaceContainerHigh || mix(surface, [0, 0, 0], 0.2), 0.9));
      setVar('--pill-bg', rgba(onPrimary, 0.85));
      setVar('--pill-fg', rgb(primary));
      theme.primary = primary;
      theme.track = mix(onSurface, surface, 0.5);
      paletteForTrack = true;
    } catch (e) {}
  }

  // Extract a vivid dominant colour from the (CORS-enabled) album art via an offscreen canvas.
  function extractSeedFromArt(img) {
    try {
      const c = document.createElement('canvas');
      const W = 24, H = 24;
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data; // throws if the canvas is tainted (no CORS)

      // Pick the pixel with the highest saturation*alpha weight, biased away from near-black/white.
      let best = null, bestScore = -1;
      let avg = [0, 0, 0], n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 128) continue;
        avg[0] += r; avg[1] += g; avg[2] += b; n++;
        const [, sHsl, lHsl] = rgbToHsl(r, g, b);
        const score = sHsl * (1 - Math.abs(lHsl - 0.55) * 1.3);
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      if (n === 0) return null;
      avg = [avg[0]/n, avg[1]/n, avg[2]/n];
      // If the most-saturated pixel is too dull, fall back to the average tinted up.
      if (!best || bestScore < 0.12) best = withSL(avg, 0.5, 0.5);
      return best;
    } catch (e) {
      console.warn('[PixelPlayer] art colour extraction failed (CORS?):', e && e.message);
      return null;
    }
  }

  // ---- Metadata sync --------------------------------------------------------------------------
  let currentArtUrl = null;

  function readMetadata(media) {
    if (!media || !media.metadata) return null;
    const m = media.metadata;
    const images = m.images || [];
    return {
      title: m.title || m.songName || '',
      artist: m.artist || m.albumArtist || m.subtitle || '',
      art: images.length ? images[0].url : null,
    };
  }

  function applyMetadata(meta) {
    if (!meta) return;
    el.title.textContent = meta.title || '';
    el.artist.textContent = meta.artist || '';
    el.lyTitle.textContent = meta.title || '';
    el.lySub.textContent = meta.artist || '';
    el.stage.classList.toggle('idle', !meta.title && !meta.art);

    if (meta.art && meta.art !== currentArtUrl) {
      currentArtUrl = meta.art;
      // Single-fetch art swap: load once via a probe (also used for colour extraction), KEEP the
      // previous art visible until the new one is ready, then swap from cache (instant) with a
      // bouncy pop. Avoids the blank gap + double fetch the old direct-src approach had.
      const url = meta.art;
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => {
        if (currentArtUrl !== url) return; // superseded by a newer track
        el.art.src = url; // same-cache fetch -> instant
        el.lyArt.src = url; // lyrics-mode mini art mirrors the stage art
        el.artWrap.classList.remove('pop');
        void el.artWrap.offsetWidth; // restart the animation
        el.artWrap.classList.add('pop');
        if (!paletteForTrack) { // instant approximation; the exact pushed palette corrects it
          const seed = extractSeedFromArt(probe);
          applyTheme(seed || NEUTRAL.seed);
        }
      };
      probe.onerror = () => {
        if (currentArtUrl !== url) return;
        el.art.src = url;
        if (!paletteForTrack) applyTheme(NEUTRAL.seed);
      };
      probe.src = url;
    }
  }

  // Song file-info pill (sample rate • bitrate • format). Live values pushed from the phone over
  // the custom channel win (the phone probes the actual file); the per-item LOAD customData (what
  // the library scan knew — often just the format) is the fallback until a push arrives.
  let pushedSongInfo = null; // parts array from the latest phone push; cleared on every new LOAD

  function buildInfoParts(src) {
    const parts = [];
    const sr = Number(src.sampleRateHz);
    if (isFinite(sr) && sr > 0) parts.push((sr / 1000).toFixed(1) + ' kHz');
    let br = Number(src.bitrateBps);
    if (isFinite(br) && br > 0) {
      if (br > 10000) br = Math.round(br / 1000); // bps -> kbps
      parts.push(br + ' kbps');
    }
    if (src.format) parts.push(String(src.format));
    return parts;
  }

  function renderSongInfo(parts) {
    if (parts && parts.length) {
      el.songInfo.textContent = parts.join(' • ');
      el.songInfo.style.display = 'inline-block';
    } else {
      el.songInfo.style.display = 'none';
    }
  }

  function updateSongInfo(media) {
    try {
      if (pushedSongInfo) { renderSongInfo(pushedSongInfo); return; }
      const cd = media && media.customData;
      let parts = cd ? buildInfoParts(cd) : [];
      if (!parts.length && media && media.contentType) {
        parts = [media.contentType.split('/').pop().replace(/^x-/, '').toUpperCase()];
      }
      renderSongInfo(parts);
    } catch (e) {}
  }

  function showBadge(text) {
    if (!text) { el.badge.classList.remove('show'); return; }
    el.badge.textContent = text;
    el.badge.classList.add('show');
  }

  // ---- Fullscreen lyrics (pushed from the phone) ------------------------------------------------
  // The phone sends {type:'lyrics', visible, offsetMs, synced:[{t,x}], plain:[...]} whenever its
  // fullscreen lyrics open/close or the track's lyrics change. Synced lines are highlighted and
  // centred from THIS device's playback clock (see tick()), so no position pushes are needed.
  const lyr = {
    layer: document.getElementById('lyrics'),
    scroll: document.getElementById('lyricsScroll'),
    lines: [],      // [{t, node}] for synced lyrics
    activeIdx: -1,
    offsetMs: 0,
    visible: false,
  };

  function setLyrics(msg) {
    try {
      lyr.offsetMs = Number(msg.offsetMs) || 0;
      const synced = Array.isArray(msg.synced) ? msg.synced : [];
      const plain = Array.isArray(msg.plain) ? msg.plain : [];
      lyr.activeIdx = -1;
      lyr.lines = [];
      lyr.scroll.textContent = '';
      lyr.scroll.style.transform = 'translateY(0)';
      const frag = document.createDocumentFragment();
      if (synced.length) {
        synced.forEach((l) => {
          const div = document.createElement('div');
          div.className = 'lyLine';
          div.textContent = l.x || ' ';
          frag.appendChild(div);
          lyr.lines.push({ t: Number(l.t) || 0, node: div });
        });
      } else {
        plain.forEach((x) => {
          const div = document.createElement('div');
          div.className = 'lyLine active'; // plain lyrics: everything readable, no highlight clock
          div.textContent = x || ' ';
          frag.appendChild(div);
        });
      }
      lyr.scroll.appendChild(frag);
      lyr.visible = !!msg.visible && (synced.length + plain.length) > 0;
      document.body.classList.toggle('lyrics-open', lyr.visible);
      // The seekbar (squiggle pill + times) moves between the stage and the lyrics bottom strip
      // so it spans the full screen width under the lyrics. Same canvas keeps drawing; re-size
      // it for the new width.
      if (lyr.visible && el.progress.parentElement !== el.lyProgressSlot) {
        el.lyProgressSlot.appendChild(el.progress);
        sizeWave();
      } else if (!lyr.visible && el.progress.parentElement !== el.info) {
        el.info.appendChild(el.progress);
        sizeWave();
      }
      // Mini now-playing (bottom-left): mirror the stage's art/title/artist.
      if (el.art.src) el.lyArt.src = el.art.src;
      el.lyTitle.textContent = el.title.textContent;
      el.lySub.textContent = el.artist.textContent;
    } catch (e) {}
  }

  function updateLyricsHighlight(curSec) {
    if (!lyr.visible || !lyr.lines.length) return;
    const ms = curSec * 1000 + lyr.offsetMs;
    let idx = -1;
    for (let i = 0; i < lyr.lines.length; i++) {
      if (lyr.lines[i].t <= ms) idx = i; else break;
    }
    if (idx === lyr.activeIdx) return;
    if (lyr.activeIdx >= 0 && lyr.lines[lyr.activeIdx]) {
      lyr.lines[lyr.activeIdx].node.classList.remove('active');
    }
    lyr.activeIdx = idx;
    if (idx >= 0) {
      const node = lyr.lines[idx].node;
      node.classList.add('active');
      // Centre the active line vertically in the view (smooth via the CSS transform transition).
      const y = el.lyricsView.clientHeight / 2 - node.offsetTop - node.offsetHeight / 2;
      lyr.scroll.style.transform = 'translateY(' + y + 'px)';
    }
  }

  // ---- Squiggle progress bar ------------------------------------------------------------------
  const wave = {
    canvas: el.wave,
    ctx: el.wave.getContext('2d'),
    dpr: Math.max(1, window.devicePixelRatio || 1),
    w: 0, h: 0,
    phase: 0,
    progress: 0,
    playing: false,
    amp: 0, // 0..1 amplitude envelope: eases to 1 while playing, to 0 (flat line) while paused
  };

  function sizeWave() {
    const rect = wave.canvas.getBoundingClientRect();
    wave.w = rect.width; wave.h = rect.height;
    wave.canvas.width = Math.round(rect.width * wave.dpr);
    wave.canvas.height = Math.round(rect.height * wave.dpr);
    wave.ctx.setTransform(wave.dpr, 0, 0, wave.dpr, 0, 0);
  }
  window.addEventListener('resize', sizeWave);

  function drawWave() {
    const ctx = wave.ctx;
    let W = wave.w, H = wave.h;
    if (W === 0) { sizeWave(); W = wave.w; H = wave.h; } // re-read, else we draw one stale frame
    ctx.clearRect(0, 0, W, H);

    const cy = H / 2;
    const lineW = 5;
    const pad = lineW + 2;
    const usableW = W - pad * 2;
    const thumbX = pad + clamp(wave.progress, 0, 1) * usableW;

    const amplitude = 3.5;          // wave height
    const wavelength = 30;          // px per cycle
    const k = (Math.PI * 2) / wavelength;
    const taper = 26;               // px over which the wave flattens into the thumb

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Played portion: wavy line up to the thumb.
    ctx.beginPath();
    ctx.strokeStyle = rgb(theme.primary);
    ctx.lineWidth = lineW;
    for (let x = pad; x <= thumbX; x += 3) {
      const distToThumb = thumbX - x;
      // Taper near the thumb (M3 style) and scale by the pause envelope (flattens when paused).
      const amp = amplitude * clamp(distToThumb / taper, 0, 1) * wave.amp;
      const y = cy + Math.sin((x - pad) * k + wave.phase) * amp;
      if (x === pad) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Remaining portion: flat track.
    ctx.beginPath();
    ctx.strokeStyle = rgba(theme.track, 0.5);
    ctx.lineWidth = lineW;
    ctx.moveTo(thumbX, cy);
    ctx.lineTo(W - pad, cy);
    ctx.stroke();

    // Thumb.
    ctx.beginPath();
    ctx.fillStyle = rgb(theme.primary);
    ctx.arc(thumbX, cy, lineW + 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Duration of the current item as the SENDER declared it in the LOAD request. The phone
  // transcodes/streams chunked audio, so the media element reports duration=Infinity once
  // playing — this captured value is the only reliable total. Set by the LOAD interceptor.
  let loadedDurationSec = 0;

  let lastCurTxt = '', lastDurTxt = '';
  let lastCurSeen = -1, lastCurChangeMs = 0;
  let lastDrawnProgress = -1;
  function tick() {
    // Poll playback every frame. getPlayerState() is unreliable/laggy on this device (it read
    // PAUSED while audibly playing and vice versa), so "playing" is derived from whether the
    // position clock is actually advancing — that can't lie.
    try {
      const cur = playerManager.getCurrentTimeSec();
      const nowMs = Date.now();
      if (cur !== lastCurSeen) { lastCurSeen = cur; lastCurChangeMs = nowMs; }
      const moving = isFinite(cur) && cur > 0 && (nowMs - lastCurChangeMs) < 800;
      wave.playing = moving;
      el.artWrap.classList.toggle('paused', !moving && cur > 0);
      updateLyricsHighlight(cur);

      let dur = playerManager.getDurationSec();
      if (!isFinite(dur) || dur <= 0) {
        const mi = playerManager.getMediaInformation();
        if (mi && isFinite(mi.duration) && mi.duration > 0) dur = mi.duration;
      }
      if ((!isFinite(dur) || dur <= 0) && loadedDurationSec > 0) dur = loadedDurationSec;

      const curTxt = fmtTime(cur);
      if (curTxt !== lastCurTxt) { lastCurTxt = curTxt; el.cur.textContent = curTxt; }
      if (isFinite(dur) && dur > 0) {
        const durTxt = fmtTime(dur);
        if (durTxt !== lastDurTxt) { lastDurTxt = durTxt; el.dur.textContent = durTxt; }
        wave.progress = clamp(cur / dur, 0, 1);
      }
    } catch (e) { /* no media / not started yet */ }
    // Full-rate (60fps) squiggle — affordable now that the blur(80px) blobs are gone (they were
    // the real GPU hog). Still skips redraws entirely while paused with the wave settled flat.
    const ampTarget = wave.playing ? 1 : 0;
    if (wave.playing || wave.progress !== lastDrawnProgress || wave.amp !== ampTarget) {
      if (wave.playing) wave.phase += 0.12; // flow the wave while playing
      wave.amp += (ampTarget - wave.amp) * 0.16; // ease the flatten/rise on pause/play
      if (Math.abs(ampTarget - wave.amp) < 0.01) wave.amp = ampTarget;
      drawWave();
      lastDrawnProgress = wave.progress;
    }
    requestAnimationFrame(tick);
  }

  // ---- CAF wiring -----------------------------------------------------------------------------
  if (typeof cast === 'undefined' || !cast.framework) log('CAF framework MISSING', 'err');
  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  // Surface any media-level error on screen (e.g. a load/network failure).
  try {
    playerManager.addEventListener(cast.framework.events.EventType.ERROR, (e) => {
      log('MEDIA ERR code=' + (e && (e.detailedErrorCode || e.reason || JSON.stringify(e))), 'err');
    });
  } catch (e) {}

  function refreshFromPlayer() {
    try {
      const media = playerManager.getMediaInformation();
      applyMetadata(readMetadata(media));
      updateSongInfo(media);
      const dur = playerManager.getDurationSec();
      if (isFinite(dur) && dur > 0) el.dur.textContent = fmtTime(dur);
    } catch (e) { /* ignore until media is ready */ }
  }

  const Ev = cast.framework.events.EventType;
  [Ev.PLAYER_LOAD_COMPLETE, Ev.MEDIA_STATUS, Ev.LOADED_METADATA].forEach((type) => {
    try { playerManager.addEventListener(type, refreshFromPlayer); } catch (e) {}
  });

  // (Player state + time are polled in the tick() render loop — see above — because
  // PLAYER_STATE_CHANGED isn't a valid EventType in this CAF build.)

  // LOAD interceptor: read any PixelPlayer customData the sender attaches (theme override, tags).
  try {
    playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
      try {
        // Capture the duration the SENDER declared before chunked playback overrides it with
        // Infinity. Sanity-check units: anything over 10h is the Android sender's milliseconds
        // leaking through unconverted -> treat as ms.
        let d = request && request.media && request.media.duration;
        if (isFinite(d) && d > 36000) d = d / 1000;
        loadedDurationSec = (isFinite(d) && d > 0) ? d : 0;
        pushedSongInfo = null;  // new track: stale pushed file-info no longer applies
        paletteForTrack = false; // new track: art extraction may colour until the palette push lands
      } catch (e) {}
      try {
        const cd = request && request.customData;
        if (cd && cd.themeSeed && Array.isArray(cd.themeSeed)) applyTheme(cd.themeSeed);
        if (cd && cd.badge) showBadge(cd.badge); else showBadge(null);
      } catch (e) {}
      return request;
    });
  } catch (e) {
    log('LOAD interceptor failed: ' + (e && e.message), 'err');
  }

  // ---- Start ----------------------------------------------------------------------------------
  try {
    sizeWave();
    applyTheme(NEUTRAL.seed);
    requestAnimationFrame(tick);
  } catch (e) {
    log('UI init failed: ' + (e && e.message), 'err');
  }

  // Build the receiver options defensively: if anything here throws (options constructor and the
  // MessageType enum live in the cross-origin CAF script), fall back to a bare start() — a running
  // receiver without the custom channel beats a dead one that times the launch out (error 2473).
  let options;
  try {
    options = new cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[PIXELPLAYER_NAMESPACE] = cast.framework.system.MessageType.JSON;
    // Audio app: keep the session alive a bit after pause rather than dropping to idle instantly.
    options.maxInactivity = 3600;
  } catch (e) {
    log('options failed (' + (e && e.message) + '), starting bare', 'err');
    options = undefined;
  }
  try {
    if (options) context.start(options); else context.start();
  } catch (e) {
    log('START FAILED: ' + (e && e.message), 'err');
  }

  // ---- Phone -> TV custom control channel -----------------------------------------------------
  // Registered AFTER start(): some CAF builds reject adding custom listeners pre-start, which
  // would throw, kill init before start() ran, and time the whole launch out (sender error 2473).
  // Ready for future features (e.g. push fullscreen lyrics from the phone). The sender emits
  // JSON on PIXELPLAYER_NAMESPACE; we react here. No-op until the app sends messages.
  try {
    context.addCustomMessageListener(PIXELPLAYER_NAMESPACE, (event) => {
      const msg = event.data || {};
      switch (msg.type) {
        case 'theme':
          if (msg.palette) applyPushedPalette(msg.palette);
          else if (Array.isArray(msg.seed)) applyTheme(msg.seed);
          break;
        case 'songinfo': {
          const parts = buildInfoParts(msg);
          pushedSongInfo = parts.length ? parts : null;
          if (pushedSongInfo) renderSongInfo(pushedSongInfo);
          break;
        }
        case 'lyrics':
          setLyrics(msg);
          break;
        case 'badge':
          showBadge(msg.text || null);
          break;
        // case 'lyrics': // TODO(phone->TV lyrics): render msg.lines + msg.activeIndex overlay.
        default:
          break;
      }
    });
  } catch (e) {
    log('custom listener failed: ' + (e && e.message), 'err');
  }

  // ---- Default-UI sweep (heavy hammer) --------------------------------------------------------
  // The framework can inject its stock now-playing UI into the page outside the (off-screened)
  // <cast-media-player> host. Hide any direct body child that isn't ours and LOG what was hidden
  // — the log doubles as diagnosis of what the framework actually injects on this device.
  // display:none on media elements does not stop audio, so this is safe for playback.
  try {
    const allowedIds = new Set(['debug', 'bg', 'scrim', 'brand', 'stage', 'idle', 'lyrics']);
    const sweep = () => {
      const children = document.body.children;
      for (let i = 0; i < children.length; i++) {
        const n = children[i];
        const tag = (n.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'cast-media-player') continue; // player must stay for playback
        if (allowedIds.has(n.id)) continue;
        if (n.style.display === 'none') continue; // already swept
        n.style.display = 'none';
      }
    };
    sweep();
    setInterval(sweep, 2000); // the framework may inject later (e.g. on first LOAD)
  } catch (e) {
    log('sweep failed: ' + (e && e.message), 'err');
  }
})();
