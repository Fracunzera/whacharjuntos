// whacharjuntos — viewer de solo lectura.
// Cliente WHEP escrito a mano (RTCPeerConnection + fetch) y fallback LL-HLS.
// Nunca pide micrófono ni cámara: solo transceivers "recvonly".
(() => {
  'use strict';

  // Usuario fijo del link compartido ?t=<token> (opcional, ver mediamtx.yml).
  // Los amigos normalmente entran con su propio usuario y contraseña.
  const VIEWER_USER = 'viewer';
  const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const HIDE_UI_MS = 3000;
  const RETRY_BASE_MS = 1000;
  const RETRY_MAX_OFFLINE_MS = 5000; // esperando a que arranque OBS: chequear seguido
  const RETRY_MAX_ERROR_MS = 15000;
  const ICE_GATHER_TIMEOUT_MS = 1000;
  const ICE_CONNECT_TIMEOUT_MS = 12000;
  const DISCONNECT_GRACE_MS = 5000;
  const WHEP_STALL_MS = 6000;
  const WHEP_FIRST_FRAME_MS = 8000;
  const HLS_STALL_MS = 10000;
  const HLS_START_TIMEOUT_MS = 20000;

  // Síntoma clásico de UDP 8189 cerrado: la señalización (HTTPS) anda, pero
  // ICE nunca conecta y el player quedaría cargando para siempre.
  const UDP_HINT = 'La señalización respondió pero el media no llega (ICE no conecta). ' +
    'Si sos el host: revisá que UDP 8189 esté abierto en el firewall del VPS';

  const STORE_MODE = 'whacharjuntos.mode';
  const STORE_VOLUME = 'whacharjuntos.volume';
  const STORE_AUTH = 'whacharjuntos.auth';
  const STORE_ROOM = 'whacharjuntos.room';
  const STORE_LAST_USER = 'whacharjuntos.lastUser';

  const $ = (id) => document.getElementById(id);
  const el = {
    player: $('player'),
    video: $('video'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayDetail: $('overlay-detail'),
    unmute: $('unmute'),
    controls: $('controls'),
    status: $('status'),
    btnMute: $('btn-mute'),
    volume: $('volume'),
    btnStats: $('btn-stats'),
    btnFullscreen: $('btn-fullscreen'),
    btnLogout: $('btn-logout'),
    login: $('login'),
    loginRoomField: $('login-room-field'),
    loginRoom: $('login-room'),
    loginUser: $('login-user'),
    loginPass: $('login-pass'),
    loginRemember: $('login-remember'),
    loginError: $('login-error'),
    stats: $('stats'),
    modeButtons: document.querySelectorAll('.mode button'),
    statCells: document.querySelectorAll('#stats dd'),
  };

  // El storage puede no existir o tirar (modo privado, storage bloqueado).
  const makeStore = (getArea) => ({
    get(key) {
      try { return getArea().getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { getArea().setItem(key, value); } catch { /* sin persistencia */ }
    },
    remove(key) {
      try { getArea().removeItem(key); } catch { /* nada */ }
    },
  });
  const store = makeStore(() => window.localStorage);
  const tabStore = makeStore(() => window.sessionStorage);

  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('r') || '';
  let room = roomFromUrl || store.get(STORE_ROOM) || '';

  // ---------------------------------------------------------------------------
  // Credenciales. Sin cuentas ni base de datos: MediaMTX valida usuario y
  // contraseña en cada conexión (usuarios de solo lectura). Acá solo se
  // recuerdan para no tipearlas cada vez.

  let creds = null;
  // MediaMTX acepta "Authorization: Bearer usuario:contraseña".
  let authorization = '';

  const validCred = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !v.includes(':');

  function setCreds(next, remember) {
    creds = next;
    authorization = `Bearer ${next.user}:${next.pass}`;
    const raw = JSON.stringify(next);
    store.remove(STORE_AUTH);
    tabStore.remove(STORE_AUTH);
    (remember ? store : tabStore).set(STORE_AUTH, raw);
  }

  function loadCreds() {
    for (const area of [tabStore, store]) {
      try {
        const c = JSON.parse(area.get(STORE_AUTH) || 'null');
        if (c && validCred(c.user) && validCred(c.pass)) return c;
      } catch { /* JSON roto: ignorar */ }
    }
    return null;
  }

  function clearCreds() {
    creds = null;
    authorization = '';
    store.remove(STORE_AUTH);
    tabStore.remove(STORE_AUTH);
  }

  // Deja la sala en la URL (para compartirla) y nunca el token.
  function syncUrl() {
    const q = new URLSearchParams(location.search);
    q.delete('t');
    if (room) q.set('r', room);
    const qs = q.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  }

  // ---------------------------------------------------------------------------
  // Estado visible

  const STATES = {
    waiting: { label: 'esperando transmisión', title: 'Esperando transmisión…' },
    connecting: { label: 'conectando', title: 'Conectando…' },
    live: { label: 'en vivo', title: '' },
    reconnecting: { label: 'reconectando', title: 'Reconectando…' },
    error: { label: 'error', title: 'Error' },
  };

  function setState(state, title, detail) {
    el.status.dataset.state = state;
    el.status.textContent = STATES[state].label;
    el.overlay.dataset.state = state;
    el.overlay.classList.toggle('is-hidden', state === 'live');
    el.overlayTitle.textContent = title ?? STATES[state].title;
    el.overlayDetail.textContent = detail ?? '';
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida de la sesión + reconexión con backoff exponencial

  let mode = store.get(STORE_MODE) === 'hls' ? 'hls' : 'whep';
  let session = null;
  let retryTimer = 0;
  let attempt = 0;
  let wasLive = false;
  let lastFailure = null;
  let lastDetail = '';

  function connect() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    stopSession();

    const s = { closed: false, live: false, stats: null, cleanup: [] };
    session = s;

    if (lastFailure === 'offline') {
      setState('waiting', undefined, `El host todavía no está transmitiendo en “${room}”.`);
    } else {
      // Mantener visible el motivo del último fallo mientras reintentamos.
      setState(wasLive || attempt > 0 ? 'reconnecting' : 'connecting', undefined, lastDetail);
    }

    const start = mode === 'hls' ? startHls : startWhep;
    start(s).catch((err) => fail(s, 'error', err));
  }

  function stopSession() {
    const s = session;
    session = null;
    if (!s || s.closed) return;
    s.closed = true;
    for (const fn of s.cleanup.reverse()) {
      try { fn(); } catch { /* seguir limpiando */ }
    }
    resetVideo();
  }

  // kind: 'offline' (no hay publisher), 'auth', 'unsupported', 'error'
  function fail(s, kind, detail) {
    if (s.closed || s !== session) return;
    stopSession();
    lastFailure = kind;

    if (kind === 'auth') {
      const viaLink = creds && creds.user === VIEWER_USER;
      clearCreds();
      showLogin(viaLink
        ? 'El link no es válido o fue revocado. Entrá con tu usuario y contraseña.'
        : 'Usuario o contraseña incorrectos.');
      return;
    }
    if (kind === 'unsupported') {
      setState('error', 'LL-HLS no disponible',
        'Este navegador no soporta LL-HLS con autenticación. Cambiá a WebRTC.');
      return;
    }

    const cap = kind === 'offline' ? RETRY_MAX_OFFLINE_MS : RETRY_MAX_ERROR_MS;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, cap) * jitter;
    attempt += 1;

    if (kind === 'offline') {
      setState('waiting', undefined, `El host todavía no está transmitiendo en “${room}”.`);
    } else {
      const msg = detail instanceof Error ? detail.message : detail;
      lastDetail = msg || '';
      const secs = Math.max(1, Math.round(delay / 1000));
      setState('reconnecting', undefined, `${msg ? `${msg} · ` : ''}Reintentando en ${secs} s`);
    }
    retryTimer = setTimeout(connect, delay);
  }

  // El servidor aceptó la sesión: salir de "esperando transmisión".
  function progressed(s) {
    if (s.closed || s !== session || lastFailure !== 'offline') return;
    lastFailure = null;
    setState(wasLive ? 'reconnecting' : 'connecting');
  }

  function markLive(s) {
    if (s.closed || s !== session || s.live) return;
    s.live = true;
    attempt = 0;
    wasLive = true;
    lastFailure = null;
    lastDetail = '';
    setState('live');
  }

  function resetVideo() {
    const v = el.video;
    if (v.srcObject) v.srcObject = null;
    if (v.hasAttribute('src')) {
      v.removeAttribute('src');
      v.load();
    }
  }

  // Política de autoplay: arrancamos muteados (siempre permitido). Si el
  // usuario ya activó el sonido y el navegador igual rechaza play(), volvemos a
  // muteado y mostramos el botón grande otra vez, en vez de quedar en negro.
  async function play() {
    try {
      await el.video.play();
    } catch (err) {
      if (err && err.name === 'NotAllowedError' && !el.video.muted) {
        el.video.muted = true;
        try { await el.video.play(); } catch { /* lo reintenta el próximo gesto */ }
      }
      // AbortError: cambió la fuente en el medio; no es un error real.
    }
  }

  // ---------------------------------------------------------------------------
  // WHEP (WebRTC, sub-segundo)

  function waitIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, timeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async function startWhep(s) {
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    const abort = new AbortController();
    let resourceUrl = null;
    let connectTimer = 0;
    let disconnectTimer = 0;
    let statsTimer = 0;
    let connectedAt = 0;

    const deleteResource = () => {
      if (!resourceUrl) return;
      fetch(resourceUrl, {
        method: 'DELETE',
        headers: { Authorization: authorization },
        keepalive: true,
      }).catch(() => {});
      resourceUrl = null;
    };

    s.cleanup.push(() => {
      abort.abort();
      clearTimeout(connectTimer);
      clearTimeout(disconnectTimer);
      clearInterval(statsTimer);
      pc.close();
      deleteResource();
    });

    // Solo recepción. Nada de getUserMedia.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const stream = new MediaStream();
    pc.ontrack = (ev) => {
      stream.addTrack(ev.track);
      if (el.video.srcObject !== stream) el.video.srcObject = stream;
      play();
    };

    pc.onconnectionstatechange = () => {
      if (s.closed) return;
      switch (pc.connectionState) {
        case 'connected':
          if (!connectedAt) connectedAt = performance.now();
          clearTimeout(connectTimer);
          clearTimeout(disconnectTimer);
          break;
        case 'disconnected':
          // Puede recuperarse solo (cambio de red breve); si no, reconectamos.
          clearTimeout(disconnectTimer);
          disconnectTimer = setTimeout(
            () => fail(s, 'error', connectedAt ? 'Se perdió la conexión' : UDP_HINT), DISCONNECT_GRACE_MS);
          break;
        case 'failed':
        case 'closed':
          // Si nunca llegó a conectar, el problema es el camino UDP, no un corte.
          fail(s, 'error', connectedAt ? 'Se cortó la conexión WebRTC' : UDP_HINT);
          break;
        default:
          break;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Sin trickle: mandamos la oferta con los candidatos ya juntados. Sin
    // STUN configurado esto tarda milisegundos.
    await waitIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
    if (s.closed) return;

    const res = await fetch(`/${encodeURIComponent(room)}/whep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: authorization },
      body: pc.localDescription.sdp,
      signal: abort.signal,
      cache: 'no-store',
    });

    if (res.status === 201) {
      const loc = res.headers.get('Location');
      if (loc) resourceUrl = new URL(loc, location.href).href;
    }
    if (s.closed) {
      deleteResource();
      return;
    }
    if (res.status === 404) {
      fail(s, 'offline');
      return;
    }
    if (res.status === 401 || res.status === 403) {
      fail(s, 'auth');
      return;
    }
    if (res.status !== 201) {
      const body = await res.json().catch(() => null);
      const why = body && body.error ? `: ${body.error}` : '';
      fail(s, 'error', `El servidor respondió HTTP ${res.status}${why}`);
      return;
    }

    const answer = await res.text();
    if (s.closed) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    progressed(s);

    connectTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') fail(s, 'error', UDP_HINT);
    }, ICE_CONNECT_TIMEOUT_MS);

    // Monitor: stats + "en vivo" cuando se decodifica el primer frame +
    // watchdog si dejan de llegar frames (ej. cortaste OBS).
    let prev = null;
    let lastFrames = -1;
    let lastProgress = performance.now();
    statsTimer = setInterval(async () => {
      let report;
      try { report = await pc.getStats(); } catch { return; }
      if (s.closed) return;

      const now = performance.now();
      const sum = summarizeRtc(report, prev, now);
      prev = sum.sample;
      s.stats = sum.view;

      if (sum.framesDecoded > lastFrames) {
        lastFrames = sum.framesDecoded;
        lastProgress = now;
        if (sum.framesDecoded > 0) markLive(s);
      } else if (s.live && now - lastProgress > WHEP_STALL_MS) {
        fail(s, 'error', 'Dejaron de llegar frames');
        return;
      } else if (!s.live && connectedAt && now - connectedAt > WHEP_FIRST_FRAME_MS) {
        // Pasa si el publisher se cayó sin cerrar su sesión: MediaMTX todavía
        // acepta lectores, pero no hay video. Reintentamos hasta que dé 404.
        fail(s, 'error', 'Conectado, pero no llega video');
        return;
      }
      renderStats();
    }, 1000);
  }

  function summarizeRtc(report, prev, now) {
    let video = null;
    let audio = null;
    let pair = null;
    let selectedPairId = null;

    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
      else if (r.type === 'inbound-rtp' && r.kind === 'audio') audio = r;
      else if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
    });
    if (selectedPairId) pair = report.get(selectedPairId) || null;
    if (!pair) {
      // Firefox no expone "transport": usa candidate-pair.selected.
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
      });
    }

    const bytes = (video ? video.bytesReceived || 0 : 0) + (audio ? audio.bytesReceived || 0 : 0);
    const jbDelay = video ? video.jitterBufferDelay || 0 : 0;
    const jbCount = video ? video.jitterBufferEmittedCount || 0 : 0;

    let bitrate = null;
    let buffer = null;
    if (prev && now > prev.time) {
      bitrate = ((bytes - prev.bytes) * 8) / ((now - prev.time) / 1000);
      if (jbCount > prev.jbCount) buffer = ((jbDelay - prev.jbDelay) / (jbCount - prev.jbCount)) * 1000;
    }

    const lost = (video ? video.packetsLost || 0 : 0) + (audio ? audio.packetsLost || 0 : 0);

    return {
      sample: { bytes, time: now, jbDelay, jbCount },
      framesDecoded: video ? video.framesDecoded || 0 : 0,
      view: {
        proto: 'WebRTC (WHEP)',
        bitrate: fmtBitrate(bitrate),
        resolution: video && video.frameWidth ? `${video.frameWidth}×${video.frameHeight}` : '—',
        fps: video && video.framesPerSecond != null ? String(Math.round(video.framesPerSecond)) : '—',
        dropped: video && video.framesDropped != null ? String(video.framesDropped) : '—',
        lost: String(lost),
        rtt: pair && pair.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '—',
        jitter: video && video.jitter != null ? `${Math.round(video.jitter * 1000)} ms` : '—',
        latency: buffer != null ? `${Math.round(buffer)} ms (buffer)` : '—',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // LL-HLS (más latencia, más estable: va por HTTPS/TCP)

  let hlsJs = null;
  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsJs) {
      hlsJs = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = '/_lib/hls.min.js'; // embebido en MediaMTX, lo proxya Caddy
        tag.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js no cargó')));
        tag.onerror = () => {
          hlsJs = null;
          tag.remove();
          reject(new Error('No se pudo cargar hls.js'));
        };
        document.head.appendChild(tag);
      });
    }
    return hlsJs;
  }

  async function startHls(s) {
    const Hls = await loadHlsJs();
    if (s.closed) return;
    // Sin MSE (iPhone viejo) habría que usar HLS nativo, que no permite
    // mandar el header Authorization: no hay forma de autenticar.
    if (!Hls.isSupported()) {
      fail(s, 'unsupported');
      return;
    }

    const hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      xhrSetup(xhr) {
        xhr.setRequestHeader('Authorization', authorization);
      },
    });
    let timer = 0;
    let mediaRecovered = false;
    let bytes = 0;

    const onPlaying = () => markLive(s);
    el.video.addEventListener('playing', onPlaying);

    s.cleanup.push(() => {
      clearInterval(timer);
      el.video.removeEventListener('playing', onPlaying);
      hls.destroy();
    });

    // payload no sirve para medir: hls.js lo transfiere al worker y queda vacío.
    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const loadStats = data.part ? data.part.stats : data.frag.stats;
      if (loadStats) bytes += loadStats.loaded || 0;
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      progressed(s);
      play();
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      const code = data.response ? data.response.code : 0;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (code === 404) {
          fail(s, 'offline');
        } else if ((code === 401 || code === 403) && data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
          fail(s, 'auth');
        } else {
          fail(s, 'error', `Error de red HLS${code ? ` (HTTP ${code})` : ''}`);
        }
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
        mediaRecovered = true;
        hls.recoverMediaError();
        return;
      }
      fail(s, 'error', `Error HLS: ${data.details}`);
    });

    hls.attachMedia(el.video);
    hls.loadSource(`/${encodeURIComponent(room)}/index.m3u8`);

    // Si nunca arranca (ej. el navegador no decodifica el codec), no quedarse
    // "conectando" para siempre sin explicación.
    const startTimer = setTimeout(() => {
      if (!s.live) fail(s, 'error', 'LL-HLS no arrancó (¿codec no soportado por este navegador?)');
    }, HLS_START_TIMEOUT_MS);
    s.cleanup.push(() => clearTimeout(startTimer));

    let prev = { bytes: 0, frames: 0, time: performance.now() };
    let lastTime = -1;
    let lastProgress = performance.now();
    timer = setInterval(() => {
      if (s.closed) return;
      const v = el.video;
      const now = performance.now();

      if (v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastProgress = now;
      } else if (s.live && !v.paused && now - lastProgress > HLS_STALL_MS) {
        fail(s, 'error', 'El video se trabó');
        return;
      }

      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const frames = q ? q.totalVideoFrames : 0;
      const dt = (now - prev.time) / 1000;
      s.stats = {
        proto: 'LL-HLS',
        bitrate: fmtBitrate(dt > 0 ? ((bytes - prev.bytes) * 8) / dt : null),
        resolution: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—',
        fps: q && dt > 0 ? String(Math.round((frames - prev.frames) / dt)) : '—',
        dropped: q ? String(q.droppedVideoFrames) : '—',
        lost: '—',
        rtt: '—',
        jitter: '—',
        latency: Number.isFinite(hls.latency) && hls.latency > 0 ? `${hls.latency.toFixed(1)} s` : '—',
      };
      prev = { bytes, frames, time: now };
      renderStats();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Stats

  function fmtBitrate(bps) {
    if (bps == null || !Number.isFinite(bps) || bps < 0) return '—';
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
    return `${Math.round(bps / 1e3)} kbps`;
  }

  function renderStats() {
    if (el.stats.hidden) return;
    const view = (session && session.stats) || { proto: mode === 'hls' ? 'LL-HLS' : 'WebRTC (WHEP)' };
    el.statCells.forEach((dd) => {
      dd.textContent = view[dd.dataset.k] || '—';
    });
  }

  function toggleStats() {
    el.stats.hidden = !el.stats.hidden;
    el.btnStats.setAttribute('aria-pressed', String(!el.stats.hidden));
    renderStats();
  }

  // ---------------------------------------------------------------------------
  // Controles

  let hideTimer = 0;
  let overControls = false;

  function showUi() {
    el.player.classList.add('show-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideUi, HIDE_UI_MS);
  }

  function hideUi() {
    // Si el mouse está encima de la barra (ej. ajustando volumen), no la sacamos.
    if (overControls) {
      hideTimer = setTimeout(hideUi, HIDE_UI_MS);
      return;
    }
    el.player.classList.remove('show-ui');
  }

  function updateMuteUi() {
    const muted = el.video.muted || el.video.volume === 0;
    el.btnMute.dataset.muted = String(muted);
    el.btnMute.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
    el.unmute.hidden = !el.video.muted || userMuted;
  }

  let userMuted = false;
  function setMuted(muted) {
    userMuted = muted;
    el.video.muted = muted;
    if (!muted) {
      if (el.video.volume === 0) {
        el.video.volume = 0.5;
        el.volume.value = '0.5';
      }
      play();
    }
    updateMuteUi();
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    store.set(STORE_MODE, mode);
    updateModeUi();
    attempt = 0;
    lastFailure = null;
    lastDetail = '';
    if (creds) connect();
  }

  function updateModeUi() {
    el.modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  }

  function toggleFullscreen() {
    const doc = document;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      return;
    }
    const p = el.player;
    if (p.requestFullscreen) p.requestFullscreen().catch(() => {});
    else if (p.webkitRequestFullscreen) p.webkitRequestFullscreen();
    else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen(); // iPhone
  }

  function bindUi() {
    el.player.addEventListener('pointermove', showUi);
    el.player.addEventListener('pointerdown', showUi);
    el.controls.addEventListener('pointerenter', (e) => { overControls = e.pointerType === 'mouse'; });
    el.controls.addEventListener('pointerleave', () => { overControls = false; });

    el.unmute.addEventListener('click', () => setMuted(false));
    el.btnMute.addEventListener('click', () => setMuted(!el.video.muted));
    el.video.addEventListener('volumechange', updateMuteUi);
    el.volume.addEventListener('input', () => {
      const v = Number(el.volume.value);
      el.video.volume = v;
      store.set(STORE_VOLUME, String(v));
      if (v > 0 && el.video.muted) setMuted(false);
    });

    el.modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    el.btnStats.addEventListener('click', toggleStats);
    el.btnFullscreen.addEventListener('click', toggleFullscreen);
    el.video.addEventListener('dblclick', toggleFullscreen);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      // No robar teclas mientras se escribe (login) ni sin sesión.
      if (!creds || (e.target instanceof Element && e.target.closest('input, textarea, form'))) return;
      switch (e.key.toLowerCase()) {
        case 's': toggleStats(); break;
        case 'f': toggleFullscreen(); break;
        case 'm': setMuted(!el.video.muted); break;
        default: return;
      }
      showUi();
    });

    // Al volver a la pestaña (móviles pausan en background), seguir reproduciendo.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && el.video.paused && session) play();
    });
    // Volvió la red: no esperar al próximo backoff.
    window.addEventListener('online', () => {
      if (retryTimer) {
        attempt = 0;
        connect();
      }
    });
    // Cerrar la sesión WHEP en el servidor al irse; reabrir si vuelve del bfcache.
    window.addEventListener('pagehide', stopSession);
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && creds) connect();
    });

    el.login.addEventListener('submit', onLoginSubmit);
    el.btnLogout.addEventListener('click', () => {
      clearCreds();
      showLogin('');
    });
  }

  // ---------------------------------------------------------------------------
  // Login

  function showLogin(message) {
    clearTimeout(retryTimer);
    retryTimer = 0;
    stopSession();
    attempt = 0;
    wasLive = false;
    lastFailure = null;
    lastDetail = '';

    el.player.classList.add('logged-out');
    el.login.hidden = false;
    // Si la sala vino en el link no hace falta preguntarla.
    el.loginRoomField.hidden = ROOM_RE.test(roomFromUrl);
    el.loginRoom.required = !el.loginRoomField.hidden;
    el.loginRoom.value = room;
    el.loginUser.value = el.loginUser.value || store.get(STORE_LAST_USER) || '';
    el.loginPass.value = '';
    el.loginError.textContent = message || '';
    document.title = 'whacharjuntos';

    const first = [el.loginRoom, el.loginUser, el.loginPass].find((i) => !i.closest('[hidden]') && !i.value);
    (first || el.loginPass).focus();
  }

  function onLoginSubmit(e) {
    e.preventDefault();
    const nextRoom = el.loginRoomField.hidden ? room : el.loginRoom.value.trim();
    const user = el.loginUser.value.trim();
    const pass = el.loginPass.value;

    if (!ROOM_RE.test(nextRoom)) {
      el.loginError.textContent = 'La sala solo puede tener letras, números, _ y - (hasta 64).';
      return;
    }
    if (!validCred(user) || !validCred(pass)) {
      el.loginError.textContent = 'Completá usuario y contraseña (sin ":").';
      return;
    }

    room = nextRoom;
    store.set(STORE_ROOM, room);
    store.set(STORE_LAST_USER, user);
    setCreds({ user, pass }, el.loginRemember.checked);
    enterPlayer();

    // El click en "Entrar" es un gesto del usuario: podemos arrancar con
    // sonido. Si el navegador igual lo bloquea, play() vuelve a muteado.
    userMuted = false;
    el.video.muted = false;
    updateMuteUi();
  }

  function enterPlayer() {
    el.login.hidden = true;
    el.player.classList.remove('logged-out');
    syncUrl();
    document.title = `${room} · whacharjuntos`;
    showUi();
    connect();
  }

  // ---------------------------------------------------------------------------

  function init() {
    const savedVolume = Number(store.get(STORE_VOLUME));
    if (store.get(STORE_VOLUME) !== null && savedVolume >= 0 && savedVolume <= 1) {
      el.video.volume = savedVolume;
      el.volume.value = String(savedVolume);
    }
    el.video.muted = true;

    bindUi();
    updateModeUi();
    updateMuteUi();
    showUi();

    // Link compartido ?t=<token>: se usa una vez y se saca de la barra de
    // direcciones (queda solo para esta pestaña).
    const linkToken = params.get('t');
    if (validCred(linkToken)) {
      setCreds({ user: VIEWER_USER, pass: linkToken }, false);
    } else {
      creds = loadCreds();
      if (creds) authorization = `Bearer ${creds.user}:${creds.pass}`;
    }

    if (!creds || !ROOM_RE.test(room)) {
      syncUrl();
      showLogin('');
      return;
    }
    enterPlayer();
  }

  init();
})();
