// whacharjuntos — transmitir desde el navegador (alternativa a OBS).
// Captura con getDisplayMedia (pantalla / ventana / pestaña, nunca micrófono
// ni cámara) y publica por WHIP a MediaMTX con las credenciales de publisher.
(() => {
  'use strict';

  const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

  // Tope de captura + bitrate sugerido (mismos valores que el README para OBS).
  const PRESETS = {
    '720p30': { width: 1280, height: 720, fps: 30, mbps: 3 },
    '1080p30': { width: 1920, height: 1080, fps: 30, mbps: 6 },
    '1080p60': { width: 1920, height: 1080, fps: 60, mbps: 9 },
    '1440p60': { width: 2560, height: 1440, fps: 60, mbps: 14 },
    '2160p30': { width: 3840, height: 2160, fps: 30, mbps: 20 },
    '2160p60': { width: 3840, height: 2160, fps: 60, mbps: 35 },
  };
  const AUDIO_BITRATE = 160000;

  const RETRY_BASE_MS = 1000;
  const RETRY_MAX_MS = 10000;
  const ICE_GATHER_TIMEOUT_MS = 1000;
  const ICE_CONNECT_TIMEOUT_MS = 12000;
  const DISCONNECT_GRACE_MS = 5000;

  const STORE_AUTH = 'whacharjuntos.publisher';
  const STORE_SETTINGS = 'whacharjuntos.publishSettings';

  const UDP_HINT = 'La señalización respondió pero el media no llega al VPS (ICE no conecta). ' +
    'Revisá que UDP 8189 esté abierto en el firewall del VPS';

  const $ = (id) => document.getElementById(id);
  const el = {
    preview: $('preview'),
    stageEmpty: $('stage-empty'),
    status: $('status'),
    unsupported: $('unsupported'),
    form: $('form'),
    access: document.querySelector('#form fieldset'),
    room: $('room'),
    user: $('user'),
    pass: $('pass'),
    remember: $('remember'),
    preset: $('preset'),
    bitrate: $('bitrate'),
    content: $('content'),
    audio: $('audio'),
    error: $('error'),
    btnPick: $('btn-pick'),
    btnStart: $('btn-start'),
    btnStop: $('btn-stop'),
    share: $('share'),
    shareUrl: $('share-url'),
    btnCopy: $('btn-copy'),
    statCells: document.querySelectorAll('.stats-grid dd'),
  };

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

  const readJson = (area, key) => {
    try { return JSON.parse(area.get(key) || 'null'); } catch { return null; }
  };

  const validCred = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !v.includes(':');

  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.RTCPeerConnection);

  // ---------------------------------------------------------------------------
  // Estado

  const STATES = {
    idle: 'sin transmitir',
    connecting: 'conectando',
    live: 'en vivo',
    reconnecting: 'reconectando',
    error: 'error',
  };

  let media = null; // MediaStream capturado
  let session = null; // sesión WHIP actual
  let wantLive = false; // el usuario apretó "Iniciar" y no "Detener"
  let attempt = 0;
  let retryTimer = 0;

  function setState(state) {
    el.status.dataset.state = state;
    el.status.textContent = STATES[state];
  }

  function showError(msg) {
    el.error.textContent = msg || '';
    el.error.hidden = !msg;
  }

  function updateUi() {
    el.btnStart.hidden = wantLive;
    el.btnStart.disabled = !supported;
    el.btnStop.hidden = !wantLive;
    el.btnPick.disabled = !supported;
    el.btnPick.textContent = media ? 'Cambiar pantalla' : 'Elegir pantalla';
    // Sala y credenciales no se tocan en vivo; la calidad sí.
    el.access.disabled = wantLive;
    el.stageEmpty.hidden = !!media;

    const room = el.room.value.trim();
    el.share.hidden = !ROOM_RE.test(room);
    el.shareUrl.value = `${location.origin}/?r=${room}`;
  }

  // ---------------------------------------------------------------------------
  // Ajustes

  function preset() {
    return PRESETS[el.preset.value] || PRESETS['1080p30'];
  }

  function bitrateBps() {
    const mbps = Number(el.bitrate.value);
    return Math.round((Number.isFinite(mbps) && mbps > 0 ? mbps : preset().mbps) * 1e6);
  }

  function saveSettings() {
    store.set(STORE_SETTINGS, JSON.stringify({
      room: el.room.value.trim(),
      preset: el.preset.value,
      bitrate: el.bitrate.value,
      content: el.content.value,
      audio: el.audio.checked,
    }));
  }

  function loadSettings() {
    const s = readJson(store, STORE_SETTINGS);
    if (s) {
      if (typeof s.room === 'string') el.room.value = s.room;
      if (PRESETS[s.preset]) el.preset.value = s.preset;
      if (s.bitrate) el.bitrate.value = s.bitrate;
      if (s.content === 'motion' || s.content === 'detail') el.content.value = s.content;
      if (typeof s.audio === 'boolean') el.audio.checked = s.audio;
    }
    const c = readJson(tabStore, STORE_AUTH) || readJson(store, STORE_AUTH);
    if (c && validCred(c.user) && validCred(c.pass)) {
      el.user.value = c.user;
      el.pass.value = c.pass;
    }
    if (!el.user.value) el.user.value = 'publisher';
  }

  function saveCreds() {
    const raw = JSON.stringify({ user: el.user.value.trim(), pass: el.pass.value });
    store.remove(STORE_AUTH);
    tabStore.remove(STORE_AUTH);
    (el.remember.checked ? store : tabStore).set(STORE_AUTH, raw);
  }

  function forgetPass() {
    store.remove(STORE_AUTH);
    tabStore.remove(STORE_AUTH);
    el.pass.value = '';
  }

  // Cambios de calidad en vivo, sin cortar la transmisión.
  async function applyQuality() {
    saveSettings();
    const p = preset();
    const v = media && media.getVideoTracks()[0];
    if (v) {
      v.contentHint = el.content.value;
      v.applyConstraints({
        width: { max: p.width }, height: { max: p.height }, frameRate: { ideal: p.fps, max: p.fps },
      }).catch(() => {});
    }
    if (session && session.videoSender) await tuneSender(session.videoSender);
  }

  async function tuneSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrateBps();
      params.encodings[0].maxFramerate = preset().fps;
      // Película: bajar resolución antes que fps. Texto: al revés.
      params.degradationPreference = el.content.value === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      await sender.setParameters(params);
    } catch { /* navegador sin soporte para algún campo */ }
  }

  // ---------------------------------------------------------------------------
  // Captura

  async function pick() {
    showError('');
    const p = preset();
    let next;
    try {
      next = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: p.width }, height: { max: p.height }, frameRate: { ideal: p.fps, max: p.fps } },
        audio: el.audio.checked
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
          : false,
        systemAudio: 'include',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') showError(`No se pudo capturar la pantalla: ${err.message}`);
      return false; // NotAllowedError = canceló el selector
    }

    const v = next.getVideoTracks()[0];
    v.contentHint = el.content.value;
    v.addEventListener('ended', () => onShareEnded(next));
    if (el.audio.checked && !next.getAudioTracks().length) {
      showError('Lo que elegiste no tiene audio. Para compartir sonido elegí una pestaña y marcá ' +
        '“Compartir audio de la pestaña” (o el audio del sistema en Windows).');
    }

    const prev = media;
    media = next;
    el.preview.srcObject = media;
    el.preview.play().catch(() => {});

    // En vivo: cambiar la fuente sin cortar si los tracks son del mismo tipo;
    // si cambia (ej. antes había audio y ahora no), renegociar.
    if (session && session.videoSender) {
      const a = media.getAudioTracks()[0];
      const sameShape = !!a === !!session.audioSender;
      if (sameShape) {
        await session.videoSender.replaceTrack(v);
        if (a) await session.audioSender.replaceTrack(a);
      } else if (wantLive) {
        attempt = 0;
        publish();
      }
    }
    if (prev) prev.getTracks().forEach((t) => t.stop());
    updateUi();
    return true;
  }

  function stopMedia() {
    if (media) media.getTracks().forEach((t) => t.stop());
    media = null;
    el.preview.srcObject = null;
  }

  // El usuario apretó "Dejar de compartir" en la barra del navegador.
  function onShareEnded(stream) {
    if (stream !== media) return;
    const wasLive = wantLive;
    stopBroadcast();
    stopMedia();
    updateUi();
    if (wasLive) showError('Dejaste de compartir la pantalla, así que la transmisión se detuvo.');
  }

  // ---------------------------------------------------------------------------
  // WHIP

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

  // H.264 primero (lo decodifican todos los navegadores y sirve para LL-HLS);
  // VP9 solo si el navegador no codifica H.264.
  function videoCodecPreferences() {
    const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
    if (!caps) return null;
    const packetizationMode = (c) => (/packetization-mode=1/.test(c.sdpFmtpLine || '') ? 1 : 0);
    const h264 = caps.codecs
      .filter((c) => c.mimeType.toLowerCase() === 'video/h264')
      .sort((a, b) => packetizationMode(b) - packetizationMode(a));
    const vp9 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp9');
    const extras = caps.codecs.filter((c) => /\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
    const main = h264.length ? h264 : vp9;
    if (!main.length) return null;
    return [...main, ...extras];
  }

  // Pedirle a nuestro encoder Opus estéreo y a 160 kbps (por defecto WebRTC
  // manda mono a ~32 kbps, pensado para voz).
  function opusStereo(sdp) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!m) return sdp;
    const pt = m[1];
    const extra = ['stereo=1', 'sprop-stereo=1', `maxaveragebitrate=${AUDIO_BITRATE}`];
    const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (fmtp.test(sdp)) {
      return sdp.replace(fmtp, (_, params) => {
        const kept = params.split(';').map((x) => x.trim())
          .filter((x) => x && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x));
        return `a=fmtp:${pt} ${kept.concat(extra).join(';')}`;
      });
    }
    return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${extra.join(';')}`);
  }

  // Chrome arranca el estimador de ancho de banda en ~300 kbps y tarda en
  // subir. Le indicamos un punto de partida más cercano al objetivo.
  function videoStartBitrate(sdp) {
    const kbps = Math.round(Math.min(bitrateBps(), 8e6) / 2 / 1000);
    const lines = sdp.split('\r\n');
    const pts = new Set();
    for (const line of lines) {
      const m = line.match(/^a=rtpmap:(\d+) (H264|VP9)\/90000/i);
      if (m) pts.add(m[1]);
    }
    return lines.map((line) => {
      const m = line.match(/^a=fmtp:(\d+) (.*)$/);
      if (!m || !pts.has(m[1]) || /x-google-start-bitrate/.test(line)) return line;
      return `${line};x-google-start-bitrate=${kbps}`;
    }).join('\r\n');
  }

  function publish() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    stopSession();
    const s = { closed: false, live: false, cleanup: [], videoSender: null, audioSender: null };
    session = s;
    setState(attempt > 0 ? 'reconnecting' : 'connecting');
    runPublish(s).catch((err) => fail(s, 'retry', err));
  }

  function stopSession() {
    const s = session;
    session = null;
    if (!s || s.closed) return;
    s.closed = true;
    for (const fn of s.cleanup.reverse()) {
      try { fn(); } catch { /* seguir limpiando */ }
    }
    renderStats(null);
  }

  // kind: 'retry' (reintentar con backoff) o 'fatal' (no tiene sentido reintentar)
  function fail(s, kind, detail) {
    if (s.closed || s !== session) return;
    stopSession();
    const msg = detail instanceof Error ? detail.message : detail;

    if (kind === 'fatal' || !wantLive) {
      wantLive = false;
      attempt = 0;
      setState('error');
      showError(msg);
      updateUi();
      return;
    }

    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS) * (0.8 + Math.random() * 0.4);
    attempt += 1;
    setState('reconnecting');
    showError(`${msg ? `${msg} · ` : ''}Reintentando en ${Math.max(1, Math.round(delay / 1000))} s`);
    retryTimer = setTimeout(publish, delay);
  }

  async function runPublish(s) {
    const room = el.room.value.trim();
    const authorization = `Bearer ${el.user.value.trim()}:${el.pass.value}`;
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    const abort = new AbortController();
    let resourceUrl = null;
    let connectTimer = 0;
    let disconnectTimer = 0;
    let statsTimer = 0;
    let connectedAt = 0;

    const deleteResource = () => {
      if (!resourceUrl) return;
      fetch(resourceUrl, { method: 'DELETE', headers: { Authorization: authorization }, keepalive: true })
        .catch(() => {});
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

    const v = media.getVideoTracks()[0];
    const a = media.getAudioTracks()[0];
    const vt = pc.addTransceiver(v, {
      direction: 'sendonly',
      streams: [media],
      sendEncodings: [{ maxBitrate: bitrateBps(), maxFramerate: preset().fps }],
    });
    const prefs = videoCodecPreferences();
    if (!prefs) {
      fail(s, 'fatal', 'Este navegador no puede codificar H.264 ni VP9. Usá Chrome, Edge o Firefox actualizados, u OBS.');
      return;
    }
    try { vt.setCodecPreferences(prefs); } catch { /* el navegador elige */ }
    s.videoSender = vt.sender;

    if (a) {
      const at = pc.addTransceiver(a, {
        direction: 'sendonly',
        streams: [media],
        sendEncodings: [{ maxBitrate: AUDIO_BITRATE }],
      });
      s.audioSender = at.sender;
    }

    pc.onconnectionstatechange = () => {
      if (s.closed) return;
      switch (pc.connectionState) {
        case 'connected':
          if (!connectedAt) connectedAt = performance.now();
          clearTimeout(connectTimer);
          clearTimeout(disconnectTimer);
          break;
        case 'disconnected':
          clearTimeout(disconnectTimer);
          disconnectTimer = setTimeout(
            () => fail(s, 'retry', connectedAt ? 'Se perdió la conexión con el VPS' : UDP_HINT), DISCONNECT_GRACE_MS);
          break;
        case 'failed':
        case 'closed':
          fail(s, 'retry', connectedAt ? 'Se cortó la conexión con el VPS' : UDP_HINT);
          break;
        default:
          break;
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
    if (s.closed) return;

    const res = await fetch(`/${encodeURIComponent(room)}/whip`, {
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
    if (res.status === 401 || res.status === 403) {
      forgetPass();
      fail(s, 'fatal', 'Usuario o contraseña de publisher incorrectos (son PUBLISH_USER y PUBLISH_PASS del .env).');
      return;
    }
    if (res.status === 400) {
      const body = await res.json().catch(() => null);
      fail(s, 'fatal', `El servidor rechazó la transmisión${body && body.error ? `: ${body.error}` : ''}`);
      return;
    }
    if (res.status !== 201) {
      fail(s, 'retry', `El servidor respondió HTTP ${res.status}`);
      return;
    }

    const answer = videoStartBitrate(opusStereo(await res.text()));
    if (s.closed) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await tuneSender(vt.sender);

    connectTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') fail(s, 'retry', UDP_HINT);
    }, ICE_CONNECT_TIMEOUT_MS);

    let prev = null;
    statsTimer = setInterval(async () => {
      let report;
      try { report = await pc.getStats(); } catch { return; }
      if (s.closed) return;
      const sum = summarize(report, prev, performance.now());
      prev = sum.sample;
      renderStats(sum.view);
      if (!s.live && pc.connectionState === 'connected' && sum.framesSent > 0) {
        s.live = true;
        attempt = 0;
        setState('live');
        showError('');
      }
    }, 1000);
  }

  function summarize(report, prev, now) {
    let video = null;
    let audio = null;
    let remote = null;
    let pair = null;
    let selectedPairId = null;

    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') video = r;
      else if (r.type === 'outbound-rtp' && r.kind === 'audio') audio = r;
      else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r;
      else if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
    });
    if (selectedPairId) pair = report.get(selectedPairId) || null;
    if (!pair) {
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
      });
    }
    const codec = video && video.codecId ? report.get(video.codecId) : null;

    const vBytes = video ? video.bytesSent || 0 : 0;
    const aBytes = audio ? audio.bytesSent || 0 : 0;
    let vRate = null;
    let aRate = null;
    if (prev && now > prev.time) {
      const dt = (now - prev.time) / 1000;
      vRate = ((vBytes - prev.vBytes) * 8) / dt;
      aRate = ((aBytes - prev.aBytes) * 8) / dt;
    }

    const rttSec = remote && remote.roundTripTime != null ? remote.roundTripTime
      : pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime : null;
    const reasons = { none: 'nada', cpu: 'CPU', bandwidth: 'ancho de banda', other: 'otro' };

    return {
      sample: { time: now, vBytes, aBytes },
      framesSent: video ? video.framesSent || 0 : 0,
      view: {
        codec: codec ? codec.mimeType.replace(/^video\//i, '') : '—',
        bitrate: fmtBitrate(vRate),
        resolution: video && video.frameWidth ? `${video.frameWidth}×${video.frameHeight}` : '—',
        fps: video && video.framesPerSecond != null ? String(Math.round(video.framesPerSecond)) : '—',
        limit: video && video.qualityLimitationReason ? reasons[video.qualityLimitationReason] || video.qualityLimitationReason : '—',
        rtt: rttSec != null ? `${Math.round(rttSec * 1000)} ms` : '—',
        loss: remote && remote.fractionLost != null ? `${(remote.fractionLost * 100).toFixed(1)} %` : '—',
        audio: audio ? fmtBitrate(aRate) : 'sin audio',
      },
    };
  }

  function fmtBitrate(bps) {
    if (bps == null || !Number.isFinite(bps) || bps < 0) return '—';
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
    return `${Math.round(bps / 1e3)} kbps`;
  }

  function renderStats(view) {
    el.statCells.forEach((dd) => {
      dd.textContent = (view && view[dd.dataset.k]) || '—';
    });
  }

  // ---------------------------------------------------------------------------
  // Acciones

  async function onStart(e) {
    e.preventDefault();
    showError('');
    const room = el.room.value.trim();
    if (!ROOM_RE.test(room)) {
      showError('La sala solo puede tener letras, números, _ y - (hasta 64).');
      return;
    }
    if (!validCred(el.user.value.trim()) || !validCred(el.pass.value)) {
      showError('Completá usuario y contraseña de publisher (sin ":").');
      return;
    }
    saveSettings();
    saveCreds();

    // getDisplayMedia necesita el gesto del usuario: se llama sin esperar nada antes.
    if (!media && !(await pick())) return;

    wantLive = true;
    attempt = 0;
    updateUi();
    publish();
  }

  function stopBroadcast() {
    wantLive = false;
    attempt = 0;
    clearTimeout(retryTimer);
    retryTimer = 0;
    stopSession();
    setState('idle');
    updateUi();
  }

  function bind() {
    el.form.addEventListener('submit', onStart);
    el.btnPick.addEventListener('click', () => { pick(); });
    el.btnStop.addEventListener('click', () => {
      stopBroadcast();
      stopMedia();
      showError('');
      updateUi();
    });

    el.preset.addEventListener('change', () => {
      el.bitrate.value = String(preset().mbps);
      applyQuality();
    });
    el.bitrate.addEventListener('change', applyQuality);
    el.content.addEventListener('change', applyQuality);
    el.audio.addEventListener('change', saveSettings);
    el.room.addEventListener('input', updateUi);

    el.btnCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el.shareUrl.value);
        el.btnCopy.textContent = '¡Copiado!';
      } catch {
        el.shareUrl.select();
        el.btnCopy.textContent = 'Ctrl+C';
      }
      setTimeout(() => { el.btnCopy.textContent = 'Copiar'; }, 1500);
    });

    // Avisar antes de cerrar la pestaña en vivo; si se cierra igual, avisar al server.
    window.addEventListener('beforeunload', (e) => {
      if (!wantLive) return;
      e.preventDefault();
      e.returnValue = '';
    });
    window.addEventListener('pagehide', stopSession);
  }

  function init() {
    loadSettings();
    bind();
    setState('idle');
    if (!supported) el.unsupported.hidden = false;
    updateUi();
  }

  init();
})();
