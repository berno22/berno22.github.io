/* Tesla-engine.js - Drive-proof live TV playback for the livetv page.
 *
 * WHY THIS EXISTS
 * ---------------
 * The normal player on this page is video.js + application/x-mpegURL, which
 * means MSE feeding a <video> element. When the car is in Drive, that is the
 * thing that freezes: the picture locks while the audio keeps going. MSE and the
 * media element are the problem, not the stream.
 *
 * So this player never creates a media element for the video path. It fetches
 * the MPEG-TS segments itself and decodes them with WebCodecs, painting each
 * decoded frame onto a <canvas>:
 *
 *   .ts -> mux.js mp4.Transmuxer -> fMP4 -> mp4box.js -> elementary samples
 *       -> WebCodecs VideoDecoder -> canvas
 *       -> WebCodecs AudioDecoder -> ring buffer in an AudioWorklet -> speakers
 *
 * That is the same pipeline proven on the Sky Sports F1 page, generalised for
 * many channels and made restartable.
 *
 * WHAT IS DIFFERENT FROM THE F1 PAGE, AND WHY
 * -------------------------------------------
 * 1. open()/close() instead of a one-shot start(). A channel grid switches
 *    streams constantly, so every decoder, timer and audio node has to be
 *    torn down or they pile up: each switch would leak a VideoDecoder and a
 *    second audio graph, and the page would get slower the more you flick
 *    through channels.
 * 2. Master playlists are followed (#EXT-X-STREAM-INF). F1TV serves a master
 *    playlist whose variant is chosen by bandwidth, and the master has no
 *    segments of its own - reading it as a media playlist yields nothing.
 * 3. Non-media tracks are ignored. F1TV's TS carries scte_35 and timed_id3
 *    alongside the real audio; taking "the first audio track" would decode
 *    SCTE-35 ad markers as if they were sound.
 * 4. Queue caps scale with the real frame rate. Channels run at 25, 30 and
 *    59.94fps, and a cap sized for 25fps overflows on a 60fps one, dropping
 *    exactly the frames that were about to be shown.
 * 5. The audio sample rate comes from the stream, not a hardcoded 48000.
 *    nasa.4k.us is 32kHz; everything else is 48kHz. Forcing 48kHz on a 32kHz
 *    track makes the decoder resample or fail, and the ring then runs at the
 *    wrong rate against the device clock.
 * 6. Canvas size is capped. Decoding happens at source resolution, but the
 *    canvas is scaled down: a 1080p canvas at 60fps is pure paint cost for no
 *    visible gain in a car.
 */
(function (global) {
  'use strict';

  // How much already-downloaded media to keep ahead of playback. This is the
  // cushion that absorbs a slow segment fetch or a decode hiccup without the
  // listener hearing a gap.
  var BUFFER_TARGET_S = 12;

  // Decode video well ahead of presentation. Chrome's WebCodecs decoder takes
  // about 500ms to return an IDR on two cameras, and about 1.6s on Toddlers View
  // 2 when all three grid decoders are active. A 250ms feed horizon therefore
  // lets keyframes arrive late and creates a visible gap every 3s. 2.2s covers
  // the worst measured decode time plus margin. Frames are still painted on
  // their original media clock, so this is decode buffering, not display lag.
  // The frame queue cap (40) holds 4s at the source's 10fps.
  var VIDEO_DECODE_LEAD_MS = 2200;

  // How far ahead of its due time audio is decoded and poured into the ring.
  // A ring holding exactly this much is playing the same media instant the
  // picture is showing - the decode lead and the buffered depth cancel each
  // other - so this is both the feed horizon and the target the sync trim
  // steers to. It and AUDIO_LEAD_S must stay in step.
  var AUDIO_LEAD_MS = 1500;
  var AUDIO_LEAD_S = AUDIO_LEAD_MS / 1000;

  // Every network fetch in this engine is raced against a timeout. A fetch that
  // never settles is the worst failure mode here: the pump is a single sequential
  // loop, so ONE hung segment request stops the whole pipeline forever and the
  // picture freezes with no error anywhere. Observed in practice as a stuck
  // camera. A timeout turns that into an ordinary, recoverable fetch error.
  var FETCH_TIMEOUT_MS = 15000;
  // googlevideo and its relay answer 429 when the upstream is being hammered.
  // It is temporary by nature, so every fetch retries a couple of times with
  // increasing delay instead of failing the stream immediately.
  var RETRYABLE_STATUS = function (status) { return status === 429 || status === 503; };
  var retry429 = function (make, n) {
    if (n === undefined) n = 0;
    return make().then(function (r) {
      if (RETRYABLE_STATUS(r.status) && n < 2) {
        return sleep(1500 + n * 2500).then(function () { return retry429(make, n + 1); });
      }
      return r;
    });
  };
  var fetchT = function (url, opts) {
    var attempt = function (n) {
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = null;
      var req = { cache: 'no-store' };
      if (ctl) req.signal = ctl.signal;
      if (opts && opts.range) req.headers = { Range: opts.range };
      var abortable = fetch(url, req);
      var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          if (ctl) { try { ctl.abort(); } catch (e) {} }
          reject(new Error('fetch timeout after ' + FETCH_TIMEOUT_MS + 'ms'));
        }, FETCH_TIMEOUT_MS);
      });
      return Promise.race([abortable, timeout]).then(function (r) {
        if (timer) clearTimeout(timer);
        if (RETRYABLE_STATUS(r.status) && n < 2) {
          return sleep(1500 + n * 2500).then(function () { return attempt(n + 1); });
        }
        return r;
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw e;
      });
    };
    return attempt(0);
  };

  var has = function (k) { return typeof global[k] !== 'undefined'; };

  function missingLibs(needAudio) {
    var miss = [];
    if (!has('muxjs') || !global.muxjs.mp4 || !global.muxjs.mp4.Transmuxer) miss.push('mux.js');
    if (!has('MP4Box')) miss.push('mp4box.js');
    if (!has('VideoDecoder') || !has('EncodedVideoChunk')) miss.push('WebCodecs VideoDecoder');
    if (needAudio && (!has('AudioDecoder') || !has('AudioData'))) miss.push('WebCodecs AudioDecoder');
    return miss;
  }

  // ==========================================================================
  // The ring buffer, as an AudioWorklet.
  //
  // The obvious implementation - one AudioBuffer plus a BufferSourceNode per
  // decoded audio frame - sounds bad. At 1024 samples a frame that is ~47
  // buffer sources per second, each scheduled independently, and any sub-block
  // scheduling error becomes a discontinuity: a click on every boundary. It
  // also allocates a buffer per frame.
  //
  // Instead the decoder output is poured into a ring buffer that the worklet
  // pulls at exactly one steady rate. One uninterrupted stream, no per-block
  // seams, and the decoder can run ahead into the buffer while playback stays
  // smooth.
  // ==========================================================================
  var RING_WORKLET = [
    'class LoFiRing extends AudioWorkletProcessor {',
    '  constructor(opts) {',
    '    super();',
    '    const p = (opts && opts.processorOptions) || {};',
    '    this.cap = p.capacity || sampleRate * 8;',
    '    this.ch = [new Float32Array(this.cap), new Float32Array(this.cap)];',
    '    this.w = 0; this.r = 0; this.avail = 0; this.pos = 0;',
    '    this.underruns = 0; this.fed = false; this.tick = 0;',
    // The stream's rate is not always the device's. nasa.4k.us is 32kHz and
    // the AudioContext is 48kHz, so reading one source sample per output sample
    // drains the ring 1.5x too fast and it starves continuously - a permanent
    // crackle. Linear interpolation between the source rate and the device rate
    // keeps the two clocks in step.
    '    this.srcRate = p.sourceRate || sampleRate;',
    '    this.step = this.srcRate / sampleRate;',
    // A trim of 1 reads at the stream's own rate. The main thread nudges it a
    // fraction of a percent either way to hold the ring at the depth that
    // keeps the sound level with the picture; see trimAudio().
    '    this.trim = 1;',
    '    this.port.onmessage = (e) => {',
    '      const d = e.data;',
    // Switching channels must not play out the tail of the previous one, so the
    // ring is emptied on a switch. fed resets too, so the underrun counter
    // measures the new channel rather than inheriting the old one's.
    '      if (d && d.flush) { this.w = 0; this.r = 0; this.avail = 0; this.pos = 0; this.fed = false; return; }',
    '      if (d && d.trim) { this.trim = d.trim; return; }',
    // A new channel may arrive at a different rate. Re-step and empty, because
    // the existing contents are in the old rate's timeline.
    '      if (d && d.rate) {',
    '        this.srcRate = d.rate; this.step = d.rate / sampleRate;',
    '        this.w = 0; this.r = 0; this.avail = 0; this.pos = 0; this.fed = false;',
    '        return;',
    '      }',
    '      const frames = d;',
    '      if (!frames || !frames.length) return;',
    '      const n = frames[0].length;',
    '      if (this.avail + n > this.cap) {',
    '        const room = Math.max(0, this.cap - this.avail);',
    '        for (let i = 0; i < room; i++) {',
    '          this.ch[0][this.w] = frames[0][i]; this.ch[1][this.w] = frames[1][i];',
    '          this.w = (this.w + 1) % this.cap;',
    '        }',
    '        this.avail += room;',
    '        return;',
    '      }',
    '      for (let i = 0; i < n; i++) {',
    '        this.ch[0][this.w] = frames[0][i]; this.ch[1][this.w] = frames[1][i];',
    '        this.w = (this.w + 1) % this.cap;',
    '      }',
    '      this.avail += n; this.fed = true;',
    '    };',
    '  }',
    '  process(inputs, outputs) {',
    '    const out = outputs[0];',
    '    if (!out || !out.length) return true;',
    '    const n = out[0].length;',
    '    let starved = false;',
    '    const L = this.ch[0], R = this.ch[1];',
    // One read per OUTPUT SAMPLE POSITION, not per channel. Advancing the read
    // pointer inside the per-channel loop consumed 2 samples per output frame on
    // a stereo stream, so the ring drained at exactly double rate, always ran
    // dry, and gave the right channel the wrong samples.
    '    const st = this.step * this.trim;',
    '    for (let i = 0; i < n; i++) {',
    '      let l = 0, r = 0;',
    '      if (this.avail >= 1) {',
    '        const i0 = this.pos | 0;',
    '        const i1 = i0 + 1;',
    '        const f = this.pos - i0;',
    '        const a0 = i0 % this.cap, a1 = i1 % this.cap;',
    '        if (f > 0) {',
    '          l = L[a0] + (L[a1] - L[a0]) * f;',
    '          r = R[a0] + (R[a1] - R[a0]) * f;',
    '        } else { l = L[a0]; r = R[a0]; }',
    '        this.pos += st;',
    '        this.avail -= st;',
    '      } else { starved = true; }',
    '      out[0][i] = l;',
    '      if (out.length > 1) out[1][i] = r;',
    '      if (out.length > 2) for (let c = 2; c < out.length; c++) out[c][i] = l;',
    '      this.sum = (this.sum || 0) + l * l;',
    '      this.count = (this.count || 0) + 1;',
    '      if (this.count >= 2048) { this.rms = Math.sqrt(this.sum / this.count); this.count = 0; this.sum = 0; }',
    '    }',
    // Report sparingly. process() runs every 128 samples, ~375 times a second,
    // and posting on every call floods the main thread, which starves the paint
    // timer and the decoder feed. A tick every ~10 quanta is plenty.
    '    this.tick++;',
    // Only count a dropout once audio has actually been supplied. The graph is
    // built at tap time, well before the first segment is demuxed, so the ring
    // is legitimately empty for the first seconds - that is silence because
    // there is nothing yet, not a gap in playback.
    '    if (starved && this.fed) {',
    '      this.underruns++;',
    '      if (this.tick > 8) { this.tick = 0; this.port.postMessage({ starved: 1, underruns: this.underruns }); }',
    '    } else if (this.tick >= 8) {',
    '      this.tick = 0;',
    '      this.port.postMessage({ depth: this.avail / this.srcRate, rms: this.rms || 0 });',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('lofi-ring', LoFiRing);"
  ].join('\n');

  function hex2(n) { return (n == null ? 0 : n).toString(16).padStart(2, '0'); }

  // avcC record -> the flat AVCDecoderConfigurationRecord WebCodecs wants.
  function avcCDescription(avcC) {
    if (!avcC || !avcC.SPS || !avcC.SPS.length || !avcC.PPS || !avcC.PPS.length) return undefined;
    var parts = [avcC.configurationVersion, avcC.AVCProfileIndication,
      avcC.profile_compatibility, avcC.AVCLevelIndication,
      0xFC | (avcC.lengthSizeMinusOne & 3), 0xE0 | avcC.SPS.length];
    for (var i = 0; i < avcC.SPS.length; i++) {
      var s = avcC.SPS[i].nalu;
      parts.push((s.length >> 8) & 255, s.length & 255);
      for (var j = 0; j < s.length; j++) parts.push(s[j]);
    }
    parts.push(avcC.PPS.length);
    for (var k = 0; k < avcC.PPS.length; k++) {
      var p = avcC.PPS[k].nalu;
      parts.push((p.length >> 8) & 255, p.length & 255);
      for (var m = 0; m < p.length; m++) parts.push(p[m]);
    }
    return new Uint8Array(parts);
  }

  // esds -> the AudioSpecificConfig WebCodecs wants for AAC.
  function ascFromEsds(esds) {
    try {
      var d = esds.esd.esdDescs[0].descs[0].descs;
      var i = 0;
      while (i < d.length) {
        if (d[i].tag === 0x05) return new Uint8Array(d[i].data);
        i++;
      }
    } catch (e) { /* fall through: the codec string alone is enough for most AAC */ }
    return undefined;
  }

  // ========================================================================
  // The player
  // ========================================================================
  function TeslaPlayer(opts) {
    this.opts = opts || {};
    this.canvas = this.opts.canvas;
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    // Cap the canvas. Decoding is at source resolution either way, but a 1080p
    // canvas repainted at 60fps is a lot of paint for a car display.
    this.maxW = this.opts.maxWidth || 1280;
    this.gainValue = this.opts.gain || 4;
    // Remembered rather than applied here. The gain node does not exist until
    // the audio graph is built on the first gesture, and a channel opened while
    // muted must not start audible just because finish() ran later.
    this.muted = !!this.opts.muted;
    this.paused = false;
    this.repeat = false;   // loop VOD playback, set from the Repeat button
    this.keepFrame = false; // a seek must not flash the canvas black
    this.gen = 0;          // bumped by close(); every async callback checks it
    this.live = null;      // the running stream, or null
    this.actx = null;      // AudioContext, kept across channels
    this.activated = false; // has a user gesture happened yet
    // The audio output chain, built once and shared by every channel.
    this.audio = { ready: false, pending: null, node: null, push: null, flush: null,
                   setRate: null, setTrim: null, rate: 0, sourceRate: 0, trim: 1,
                   path: '', modErr: '', depth: 0, rms: 0, underruns: 0,
                   gain: null, limiter: null, analyser: null, buf: null };
    this.listeners = {};
  }

  TeslaPlayer.prototype.on = function (ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    return this;
  };
  TeslaPlayer.prototype.emit = function (ev, data) {
    var l = this.listeners[ev];
    if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](data); } catch (e) {} }
  };

  // ---- audio unlock -------------------------------------------------------
  // Must happen inside a real user gesture. Creating the AudioContext later,
  // when the first segment finishes demuxing, is a network callback and not a
  // gesture: strict autoplay policies then leave the context suspended, every
  // sample is discarded, and you get a perfect picture with total silence and
  // no error anywhere.
  TeslaPlayer.prototype.unlock = function () {
    var self = this;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return Promise.resolve(false);
    this.activated = true;
    if (!this.actx) {
      try { this.actx = new AC(); } catch (e) { return Promise.resolve(false); }
    }
    var p = this.actx.state === 'suspended' ? this.actx.resume() : Promise.resolve();
    return p.then(function () {
      // Some engines only fully unlock on a real source.
      try {
        var b = self.actx.createBuffer(1, 1, 44100);
        var s = self.actx.createBufferSource();
        s.buffer = b; s.connect(self.actx.destination); s.start(0);
      } catch (e) {}
      // Build the ring while the gesture is still valid.
      return self.ensureAudio();
    }).catch(function () { return false; });
  };

  // A 1kHz tone through the same output chain. If this is silent, audio is not
  // reaching the speakers and the problem is the environment, not the decode
  // path - otherwise the two are indistinguishable.
  TeslaPlayer.prototype.tone = function () {
    if (!this.actx) { this.emit('note', 'no audio context'); return; }
    if (this.actx.state === 'suspended') this.actx.resume().catch(function () {});
    var t = this.actx.currentTime;
    var o = this.actx.createOscillator();
    var g = this.actx.createGain();
    o.frequency.value = 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.setValueAtTime(0.25, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(this.actx.destination);
    o.start(t); o.stop(t + 0.55);
    this.emit('note', 'tone played');
  };

  // ---- lifecycle ----------------------------------------------------------
  TeslaPlayer.prototype.open = function (url, meta) {
    var self = this;
    this.close();                     // never two pipelines at once
    this.gen++;
    var gen = this.gen;

    var s = {
      url: url, meta: meta || {}, t0: Date.now(),
      kind: (meta && meta.type) || 'hls',
      vod: !!(meta && meta.vod),
      startSec: (meta && Number(meta.startSec)) || 0,
      // Content-time position at which this pipeline actually starts. For an
      // MP4 seek it is the keyframe the sidx contained, which can precede the
      // requested time by one subsegment.
      playStartSec: 0,
      // Until the first chunks arrive we cannot know whether the MP4 carries a
      // seek index. Default to true so the bar is usable, then correct it.
      seekable: !!(meta && meta.vod), seekChecked: false, headBuf: null, headLen: 0,
      rangeOk: false,
      maxHeight: (meta && meta.maxHeight) || 1080,
      pickedHeight: (meta && meta.pickedHeight) || 0, availableHeight: 0,
      base: url, segs: [], cursor: 0, lastUrl: null,
      target: 4, edgeLen: 0,
      tm: null, mbox: null, filePos: 0, initFed: false,
      vTrack: null, aTrack: null,
      vdec: null, adec: null, ctl: null, aCtl: null, mp4Done: false,
      duration: (meta && meta.vod ? (Number(meta.durationHint) || 0) : 0),
      audioUrl: (meta && meta.audioUrl) || '', aStarted: false, aMux: null, aMbox: null, aFilePos: 0,
      aInitFed: false, aSegs: [], aCursor: 0, aBase: '', aPlaylistUrl: '',
      aLastUrl: null, aPushedKeys: null, aPumpRunning: false, aSegDur: 5,
      aMediaEnd: 0, aSegsFetched: 0, aLastQueuedTs: null,
      fq: [], pend: [], aPend: [], prePend: [], preStart: 0,
      paused: !!this.paused, pausedAt: this.paused ? Date.now() : 0,
      vT0: -1, vBaseSec: -1, mediaEnd: 0, frameIv: 0, lastFrameDue: -1,
      paintTimer: null, pumpTimer: null, rafId: 0, statsTimer: 0,
      stopped: false, fatal: null, ended: false, firstFrameAt: 0,
      // Fixed, and deliberately generous. These hold the WORST-CASE buffer -
      // downloading happens a whole segment at a time, so the buffer oscillates
      // between the 12s target and target+segment (~25s) - for the heaviest
      // channel here (59.94fps, 13s segments): 2000 video samples is 33s at
      // 60fps, and 2400 AAC frames is 36s at 48kHz.
      //
      // They are NOT derived from the measured frame rate. An earlier version
      // sized them from a running average of the frame intervals, and one
      // outlier timestamp was enough to shrink the cap below a single segment's
      // worth of samples - at which point the queue overflowed on every segment
      // and dropped the oldest entries, which are the frames about to be shown.
      // A fixed cap cannot have that failure mode.
      caps: { fq: 40, v: 2000, a: 2400 },
      ivWin: [],
      aOutRms: 0,
      // counters
      drawn: 0, drops: 0, dropsLate: 0, dropsQ: 0, dropsPre: 0, dropsFq: 0,
      aSkips: 0, segsFetched: 0, samples: 0, frames: 0,
      aFrames: 0, aSeconds: 0, aUnderruns: 0, aQueue: 0, aRms: 0,
      // A/V sync: aPrimed marks the one-time drop of already-due audio when
      // joining live, aDepth is the smoothed ring depth the trim is computed
      // from, and aTrim is the correction last sent to the ring.
      aPrimed: !!((meta && meta.vod)), aDepth: 0, aTrim: 1, lastTrimAt: 0,
      codec: '-', width: 0, height: 0, srcRate: 0,
      decFps: 0, paintFps: 0, lastDecT: 0, lastPaintT: 0,
      gaps: [], lastGapAt: 0, buffered: 0
    };
    this.live = s;
    this.emit('state', this.state());

    var miss = missingLibs(true);
    if (miss.length) { this.fail('needs ' + miss.join(', ')); return Promise.resolve(false); }

    // unlock() awaits AudioContext.resume(), which does not settle until a real
    // user gesture arrives. Awaiting it unconditionally means load() never runs
    // and NOT ONE SEGMENT IS EVER FETCHED - the canvas stays blank on any page
    // that opens a stream before the user has tapped anything.
    var unlocked = this.unlock();
    var startLoad = function () {
      if (s.kind === 'mp4') {
        // A seek reopens the whole pipeline at a later byte range. The video
        // loader starts the matching audio range itself once it knows which
        // keyframe it landed on.
        if (s.startSec > 0.05) return self.loadMp4Seek(s, gen);
        var loaded = self.loadMp4(s, gen);
        if (s.audioUrl) self.startAudioMp4(s, gen, s.audioUrl);
        return loaded;
      }
      return self.load(s, gen);
    };
    if (this.muted) {
      // Nothing to wait for. A muted player makes no sound, so the AudioContext
      // state cannot affect playback and the playlist fetch must not be delayed
      // by it. This used to race unlock() against a 1500ms timer, which put a
      // fixed 1.5s of dead time in front of every load on the relay's muted grid
      // (measured: first frame at ~1874ms, of which ~1.5s was this wait). Start
      // immediately; unlock() still completes on its own if a gesture arrives.
      return startLoad().then(function () { return true; });
    }
    Promise.race([
      unlocked,
      new Promise(function (r) { setTimeout(r, 1500); })
    ]).then(startLoad);
    return Promise.resolve(true);
  };

  TeslaPlayer.prototype.load = function (s, gen) {
    var self = this;
    return this.loadPlaylist(s, gen).then(function () {
      if (s.stopped || self.gen !== gen) return;
      // Join a couple of segments back from the edge so there is something to play
      // immediately. The -6 was written for a long DVR playlist; on a live edge
      // there are only ~3 segments, so it clamps to 0 - the OLDEST one, which is
      // also the first to be evicted, so starting there risks a miss and a
      // re-fetch of a segment already pushed. A VOD seek starts at the segment
      // that contains the requested time instead.
      s.cursor = s.vod ? segmentAt(s.segs, s.startSec) : Math.max(0, s.segs.length - 2);
      if (s.vod) {
        s.playStartSec = 0;
        for (var i = 0; i < s.cursor; i++) s.playStartSec += s.segs[i].dur;
      }
      self.startMux(s, gen);
      if (s.audioUrl) self.startAudio(s, gen, s.audioUrl);
    }).catch(function (e) { self.fail('playlist: ' + e.message); });
  };

  // Fetch the playlist, following a master playlist to its best variant.
  TeslaPlayer.prototype.loadPlaylist = function (s, gen) {
    var self = this;
    return fetchT(s.url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // The starlite URL 301s to a per-session CDN host; segment paths are
      // relative to THAT, not to the URL we asked for. Resolving against the
      // original yields "Resource not found" for every segment.
      var finalUrl = r.url || s.url;
      return r.text().then(function (t) { return { text: t, finalUrl: finalUrl }; });
    }).then(function (o) {
      if (s.stopped || self.gen !== gen) return null;
      var text = o.text, base = o.finalUrl;
      // A master playlist lists variants with #EXT-X-STREAM-INF and has no
      // segments of its own. F1TV is one. Pick the highest bandwidth variant:
      // the car can take it, and picking by bandwidth is more predictable than
      // guessing from a RESOLUTION attribute.
      var variant = pickVariant(text, base, s.maxHeight);
      if (variant) {
        s.base = variant.url;
        s.master = true;
        s.pickedHeight = variant.height || 0;
        s.availableHeight = variant.availableHeight || 0;
        if (variant.audio) s.audioUrl = variant.audio;
        return fetchT(variant.url).then(function (r2) {
          if (!r2.ok) throw new Error('variant HTTP ' + r2.status);
          var f2 = r2.url || variant.url;
          return r2.text().then(function (t2) { return { text: t2, finalUrl: f2 }; });
        });
      }
      return { text: text, finalUrl: base };
    }).then(function (o) {
      if (s.stopped || self.gen !== gen || !o) return;
      s.base = o.finalUrl;
      var p = parsePlaylist(o.text);
      if (!p.segs.length) throw new Error('no segments in playlist');
      s.target = p.target;
      s.segs = p.segs;
      s.edgeLen = p.segs.reduce(function (a, x) { return a + x.dur; }, 0);
      s.segDur = p.segs.length ? p.segs[0].dur : 4;
      if (p.endList) {
        s.vod = true;
        s.duration = s.edgeLen;
      }
    });
  };

  TeslaPlayer.prototype.loadMp4 = function (s, gen) {
    s.mbox = MP4Box.createFile();
    this.startPipeline(s, gen);
    this.pumpMp4(s, gen);
    return Promise.resolve(true);
  };

  TeslaPlayer.prototype.pumpMp4 = function (s, gen) {
    var self = this;
    var ctl = new AbortController();
    s.ctl = ctl;
    retry429(function () { return fetch(s.url, { cache: 'no-store', signal: ctl.signal }); }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!r.body || !r.body.getReader) {
        return r.arrayBuffer().then(function (buf) {
          if (s.stopped || self.gen !== gen) return;
          s.segsFetched++;
          self.feedMp4(s, new Uint8Array(buf));
          try { s.mbox.flush(); } catch (e) {}
          s.mp4Done = true;
        });
      }
      var reader = r.body.getReader();
      return (function readLoop() {
        if (s.stopped || self.gen !== gen || s.mp4Done) return Promise.resolve();
        // Before the clock is anchored, hold the download instead of demuxing
        // the whole file into the pre-anchor queue: the anchor can be waiting
        // for a separate audio file, and letting 139 seconds of video pile up
        // would either lose samples at the cap or waste memory.
        if (s.vBaseSec < 0 && s.prePend.length > 300) return sleep(100).then(readLoop);
        if (s.vTrack && bufferedOf(s) > 24) return sleep(200).then(readLoop);
        return reader.read().then(function (part) {
          if (part.done) {
            try { s.mbox.flush(); } catch (e) {}
            s.mp4Done = true;
            return;
          }
          s.segsFetched++;
          self.feedMp4(s, part.value);
          return readLoop();
        });
      })();
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen || !e || e.name === 'AbortError') return;
      self.fail('video: ' + e.message);
    });
  };

  // A VOD seek on fragmented MP4 is a ranged restart. The head fetch supplies
  // the moov (decoder config) and the sidx (time -> byte offset). From there
  // only the target subsegment and everything after it is downloaded.
  //
  // mp4box expects a contiguous stream, so the init section and the fragment
  // are fed as if they were adjacent (the sidx bytes are skipped). Sample
  // byte offsets are therefore relative to this synthetic layout, while the
  // timestamps from tfdt stay the file's real timeline - which is exactly what
  // A/V sync and the progress bar need.
  TeslaPlayer.prototype.loadMp4Seek = function (s, gen) {
    var self = this;
    return fetchT(s.url, { range: 'bytes=0-262143' }).then(function (r) {
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      s.rangeOk = r.status === 206;
      return r.arrayBuffer();
    }).then(function (buf) {
      if (s.stopped || self.gen !== gen) return;
      var head = new Uint8Array(buf);
      var scan = scanInit(head);
      if (scan.state !== 'sidx') throw new Error('no byte index in this file');
      var sidx = parseSidx(head, scan.sidxOff, scan.sidxEnd);
      var pick = sidx && pickSidxEntry(sidx, s.startSec);
      if (!pick) throw new Error('no seek point for this time');
      if (!s.rangeOk) throw new Error('server does not support byte ranges');
      s.playStartSec = pick.startSec;
      // Audio goes to the video's keyframe, not to the requested time: the
      // picture resumes at (or just before) the request, and audio starting
      // later would leave a silent gap until it caught up.
      if (s.audioUrl) self.startAudioMp4Seek(s, gen, s.audioUrl, pick.startSec);
      s.mbox = MP4Box.createFile();
      self.startPipeline(s, gen);
      s.filePos = 0;
      self.feedMp4(s, head.subarray(0, scan.moovEnd));
      s.filePos = scan.moovEnd;
      return self.pumpMp4Range(s, gen, pick.offset);
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen) return;
      // The head itself failed or the index could not be read: fall back to
      // the start rather than leaving a black player. The pipeline has not
      // started yet, so loadMp4() can bring it up cleanly.
      s.seekable = false;
      self.emit('note', 'Seeking is not available for this stream.');
      self.loadMp4(s, gen);
      if (s.audioUrl) self.startAudioMp4(s, gen, s.audioUrl);
      self.emit('note', 'seek fallback: ' + e.message);
    });
  };

  TeslaPlayer.prototype.pumpMp4Range = function (s, gen, offset) {
    var self = this;
    var ctl = new AbortController();
    s.ctl = ctl;
    return retry429(function () {
      return fetch(s.url, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + offset + '-' },
        signal: ctl.signal
      });
    }).then(function (r) {
      if (r.status !== 206) throw new Error('range HTTP ' + r.status);
      if (!r.body || !r.body.getReader) {
        return r.arrayBuffer().then(function (buf) {
          if (s.stopped || self.gen !== gen) return;
          s.segsFetched++;
          self.feedMp4(s, new Uint8Array(buf));
          try { s.mbox.flush(); } catch (e) {}
          s.mp4Done = true;
        });
      }
      var reader = r.body.getReader();
      return (function readLoop() {
        if (s.stopped || self.gen !== gen || s.mp4Done) return Promise.resolve();
        if (s.vBaseSec < 0 && s.prePend.length > 300) return sleep(100).then(readLoop);
        if (s.vTrack && bufferedOf(s) > 24) return sleep(200).then(readLoop);
        return reader.read().then(function (part) {
          if (part.done) {
            try { s.mbox.flush(); } catch (e) {}
            s.mp4Done = true;
            return;
          }
          s.segsFetched++;
          self.feedMp4(s, part.value);
          return readLoop();
        });
      })();
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen || !e || e.name === 'AbortError') return;
      self.fail('video seek: ' + e.message);
    });
  };

  // Remember whether the leading bytes of an MP4 carry a sidx, so the bar can
  // disable seeking on progressive files instead of restarting them at zero.
  TeslaPlayer.prototype.noteSeekHead = function (s, bytes) {
    if (s.seekChecked) return;
    if (!s.headBuf) { s.headBuf = new Uint8Array(262144); s.headLen = 0; }
    var n = Math.min(bytes.length, s.headBuf.length - s.headLen);
    if (n > 0) {
      s.headBuf.set(bytes.subarray(0, n), s.headLen);
      s.headLen += n;
    }
    var scan = scanInit(s.headBuf.subarray(0, s.headLen));
    if (scan.state === 'sidx') {
      s.seekable = true;
      s.seekChecked = true;
      s.headBuf = null;
    } else if (scan.state === 'none' || s.headLen >= s.headBuf.length) {
      s.seekable = false;
      s.seekChecked = true;
      s.headBuf = null;
    }
  };

  // Adaptive MP4 sources (YouTube VOD above 360p) keep the audio in its own
  // file: the video rendition is video-only, so instead of a second playlist
  // the app hands over an audio-only MP4. It is demuxed straight into the same
  // audio track machinery the HLS rendition path uses - feedAudioMp4 starts
  // the track as soon as the moov in the leading chunks has been parsed.
  TeslaPlayer.prototype.startAudioMp4 = function (s, gen, url) {
    var self = this;
    if (s.aStarted || s.stopped || this.gen !== gen) return;
    s.aStarted = true;
    s.aPlaylistUrl = url;
    s.aMbox = MP4Box.createFile();
    fetchT(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!r.body || !r.body.getReader) {
        return r.arrayBuffer().then(function (buf) {
          if (s.stopped || self.gen !== gen) return;
          s.aSegsFetched++;
          self.feedAudioMp4(s, new Uint8Array(buf));
          try { s.aMbox.flush(); } catch (e) {}
        });
      }
      var reader = r.body.getReader();
      return (function readLoop() {
        if (s.stopped || self.gen !== gen) return Promise.resolve();
        if (s.aTrack && s.aPend.length > 1500) return sleep(200).then(readLoop);
        return reader.read().then(function (part) {
          if (part.done) {
            try { s.aMbox.flush(); } catch (e) {}
            return;
          }
          s.aSegsFetched++;
          self.feedAudioMp4(s, part.value);
          return readLoop();
        });
      })();
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen || !e || e.name === 'AbortError') return;
      s.aErr = 'audio: ' + e.message;
    });
  };

  // The audio half of a ranged VOD restart. targetSec is the video keyframe,
  // so both files resume on the same media instant even though their subsegment
  // boundaries are not aligned.
  TeslaPlayer.prototype.startAudioMp4Seek = function (s, gen, url, targetSec) {
    var self = this;
    if (s.aStarted || s.stopped || this.gen !== gen) return;
    s.aStarted = true;
    s.aPlaylistUrl = url;
    s.aMbox = MP4Box.createFile();
    fetchT(url, { range: 'bytes=0-262143' }).then(function (r) {
      if (r.status !== 206) throw new Error('range HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      if (s.stopped || self.gen !== gen) return;
      var head = new Uint8Array(buf);
      var scan = scanInit(head);
      if (scan.state !== 'sidx') throw new Error('no byte index in this file');
      var sidx = parseSidx(head, scan.sidxOff, scan.sidxEnd);
      var pick = sidx && pickSidxEntry(sidx, targetSec);
      if (!pick) throw new Error('no audio seek point');
      s.aFilePos = 0;
      self.feedAudioMp4(s, head.subarray(0, scan.moovEnd));
      s.aFilePos = scan.moovEnd;
      return self.pumpAudioMp4Range(s, gen, url, pick.offset);
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen) return;
      s.aErr = 'audio seek: ' + e.message;
    });
  };

  TeslaPlayer.prototype.pumpAudioMp4Range = function (s, gen, url, offset) {
    var self = this;
    var ctl = new AbortController();
    s.aCtl = ctl;
    return retry429(function () {
      return fetch(url, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + offset + '-' },
        signal: ctl.signal
      });
    }).then(function (r) {
      if (r.status !== 206) throw new Error('range HTTP ' + r.status);
      if (!r.body || !r.body.getReader) {
        return r.arrayBuffer().then(function (buf) {
          if (s.stopped || self.gen !== gen) return;
          s.aSegsFetched++;
          self.feedAudioMp4(s, new Uint8Array(buf));
          try { s.aMbox.flush(); } catch (e) {}
        });
      }
      var reader = r.body.getReader();
      return (function readLoop() {
        if (s.stopped || self.gen !== gen) return Promise.resolve();
        if (s.aTrack && s.aPend.length > 1500) return sleep(200).then(readLoop);
        return reader.read().then(function (part) {
          if (part.done) {
            try { s.aMbox.flush(); } catch (e) {}
            return;
          }
          s.aSegsFetched++;
          self.feedAudioMp4(s, part.value);
          return readLoop();
        });
      })();
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen || !e || e.name === 'AbortError') return;
      s.aErr = 'audio seek: ' + e.message;
    });
  };

  // Master playlists can carry the audio in its own rendition playlist
  // (#EXT-X-MEDIA TYPE=AUDIO), which is what googlevideo's live HLS does. The
  // video variant then has no audio track at all, so it needs a second TS
  // demuxer feeding the same AudioDecoder.
  TeslaPlayer.prototype.startAudio = function (s, gen, url) {
    var self = this;
    if (s.aStarted || s.stopped || this.gen !== gen) return;
    s.aStarted = true;
    s.aPlaylistUrl = url;
    s.aMux = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, removeEPK: true });
    s.aMbox = MP4Box.createFile();
    s.aMux.on('data', function (event) {
      if (s.stopped || self.gen !== gen) return;
      if (event.initSegment && !s.aInitFed) {
        s.aInitFed = true;
        self.feedAudioMp4(s, new Uint8Array(event.initSegment));
      }
      if (event.data) self.feedAudioMp4(s, new Uint8Array(event.data));
    });
    fetchT(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      s.aBase = r.url || url;
      return r.text();
    }).then(function (text) {
      if (s.stopped || self.gen !== gen) return;
      var p = parsePlaylist(text);
      if (!p.segs.length) throw new Error('no segments in audio playlist');
      s.aSegs = p.segs;
      s.aSegDur = p.segs[0].dur;
      s.aCursor = s.vod ? segmentAt(p.segs, s.startSec) : Math.max(0, p.segs.length - 2);
      self.pumpAudio(s, gen);
    }).catch(function (e) {
      if (s.stopped || self.gen !== gen) return;
      s.aErr = 'audio playlist: ' + e.message;
    });
  };

  TeslaPlayer.prototype.feedAudioMp4 = function (s, bytes) {
    if (!s.aMbox || s.stopped) return;
    try {
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ab.fileStart = s.aFilePos;
      s.aMbox.appendBuffer(ab);
      s.aFilePos += ab.byteLength;
      if (!s.aTrack) this.setupAudioTracks(s);
    } catch (e) { s.aErr = 'audio demux: ' + e.message; }
  };

  TeslaPlayer.prototype.setupAudioTracks = function (s) {
    var self = this;
    var info;
    try { info = s.aMbox.getInfo(); } catch (e) { return; }
    if (!info) return;
    var tracks = info.audioTracks || [];
    if (!tracks.length) return;
    var at = null;
    for (var i = 0; i < tracks.length; i++) {
      var c = (tracks[i].codec || '') + ' ' + (tracks[i].type || '');
      if (/mp4a|aac/i.test(c)) { at = tracks[i]; break; }
      if (!at) at = tracks[i];
    }
    if (!at) return;
    s.aTrack = at;
    try { this.setupAudio(s, s.aMbox.getTrackById(at.id)); } catch (e) {
      s.aErr = 'audio config: ' + e.message;
      return;
    }
    s.aMbox.setExtractionOptions(at.id, null, { nbSamples: 200 });
    s.aMbox.onSamples = function (id, user, samples) { self.onSamples(s, id, samples, true); };
    s.aMbox.start();
  };

  TeslaPlayer.prototype.pumpAudio = function (s, gen) {
    var self = this;
    if (s.aPumpRunning) return;
    s.aPumpRunning = true;
    (function loop() {
      if (s.stopped || self.gen !== gen) { s.aPumpRunning = false; return; }
      if (s.aCursor >= s.aSegs.length) {
        if (s.vod) {
          s.aPumpRunning = false;
          try { if (s.aMux) s.aMux.flush(); } catch (e) {}
          return;
        }
        fetchT(s.aPlaylistUrl).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          s.aBase = r.url || s.aBase;
          return r.text();
        }).then(function (text) {
          var p = parsePlaylist(text);
          if (p.segs.length) {
            s.aSegs = p.segs;
            s.aSegDur = p.segs[0].dur;
          }
          self.reanchorAudio(s);
          return sleep(0);
        }).catch(function () { return sleep(1500); }).then(function () { loop(); });
        return;
      }
      // Keep audio at roughly the same distance ahead of playback as video.
      // The sample queue is a second limit for the window before the video
      // clock exists.
      var pos = s.vT0 >= 0 ? (clockNow(s) - s.vT0) / 1000 : 0;
      if (s.vT0 >= 0 && s.aMediaEnd && s.aMediaEnd - pos > BUFFER_TARGET_S) {
        sleep(200).then(loop);
        return;
      }
      if (s.aPend.length > 300) { sleep(200).then(loop); return; }
      var seg = s.aSegs[s.aCursor];
      if (!seg) { sleep(100).then(loop); return; }
      s.aCursor++;
      s.aLastUrl = seg.url;
      var sk = segKey(seg.url);
      if (s.aPushedKeys && s.aPushedKeys[sk]) { loop(); return; }
      s.aPushedKeys = s.aPushedKeys || {};
      s.aPushedKeys[sk] = 1;
      if (Object.keys(s.aPushedKeys).length > 24) {
        var keys = Object.keys(s.aPushedKeys);
        for (var d = 0; d < keys.length - 24; d++) delete s.aPushedKeys[keys[d]];
      }
      fetchT(absolute(seg.url, s.aBase)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        if (s.stopped || self.gen !== gen) return;
        s.aSegsFetched++;
        s.aMux.push(new Uint8Array(buf));
        s.aMux.flush();
      }).catch(function (e) {
        if (!s.stopped && self.gen === gen) s.aErr = 'audio segment: ' + e.message;
      }).then(function () { loop(); });
    })();
  };

  TeslaPlayer.prototype.reanchorAudio = function (s) {
    var i = -1;
    var last = segKey(s.aLastUrl);
    if (last) {
      for (var k = 0; k < s.aSegs.length; k++) {
        if (segKey(s.aSegs[k].url) === last) { i = k; break; }
      }
    }
    s.aCursor = i >= 0 ? i + 1 : Math.max(0, s.aSegs.length - 1);
  };

  // Best variant, or null when this is already a media playlist. Prefer the
  // highest variant at or below maxHeight (720p for the fast live start, then
  // 1080p after the automatic upgrade). availableHeight reports the best
  // rendition the master offers so the page can decide whether an upgrade is
  // worthwhile. Master playlists may keep audio in a separate #EXT-X-MEDIA
  // rendition (googlevideo's live HLS does), so return that URI alongside the
  // variant.
  function m3uAttr(line, name) {
    var q = new RegExp(name + '="([^"]*)"').exec(line);
    if (q) return q[1];
    var u = new RegExp('(?:^|,)' + name + '=([^,]*)').exec(line);
    return u ? u[1] : null;
  }

  function pickVariant(text, base, maxHeight) {
    var lines = text.split(/\r?\n/);
    var cap = maxHeight || 1080;
    var best = null, bestBw = -1, bestH = 0, bestGroup = null;
    var under = null, underH = -1, underBw = -1, underGroup = null;
    var availableH = 0;
    var pending = null, audio = {}, defaultAudio = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-MEDIA:') === 0) {
        if (m3uAttr(line, 'TYPE') === 'AUDIO') {
          var group = m3uAttr(line, 'GROUP-ID') || '';
          var uri = m3uAttr(line, 'URI');
          if (uri) {
            audio[group] = uri;
            if (m3uAttr(line, 'DEFAULT') === 'YES') defaultAudio = uri;
            if (!defaultAudio && m3uAttr(line, 'AUTOSELECT') === 'YES') defaultAudio = uri;
          }
        }
      } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        pending = line;
      } else if (line && line.charAt(0) !== '#' && pending) {
        var bw = /BANDWIDTH=(\d+)/.exec(pending);
        var w = bw ? parseInt(bw[1], 10) : 0;
        var res = /RESOLUTION=(\d+)x(\d+)/.exec(pending);
        var h = res ? parseInt(res[2], 10) : 0;
        var ag = m3uAttr(pending, 'AUDIO');
        if (h > 0 && h <= 1080 && h > availableH) availableH = h;
        if (w > bestBw) { bestBw = w; best = line; bestH = h; bestGroup = ag; }
        if (h > 0 && h <= cap && (h > underH || (h === underH && w > underBw))) {
          underH = h; underBw = w; under = line; underGroup = ag;
        }
        pending = null;
      } else if (line && line.charAt(0) !== '#') {
        // A segment with no preceding STREAM-INF: this is a media playlist.
        return null;
      }
    }
    var pick = under || best;
    if (!pick) return null;
    var chosenGroup = under ? underGroup : bestGroup;
    var audioUri = (chosenGroup && audio[chosenGroup]) || defaultAudio || null;
    return {
      url: absolute(pick, base),
      audio: audioUri ? absolute(audioUri, base) : null,
      height: under ? underH : bestH,
      availableHeight: availableH
    };
  }

  function absolute(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function parsePlaylist(text) {
    var segs = [], dur = 0, target = 4, map = null, endList = false;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
        target = parseFloat(line.slice(21)) || target;
      } else if (line.indexOf('#EXT-X-MAP:') === 0) {
        var mu = /URI="([^"]+)"/.exec(line);
        if (mu) map = mu[1];
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        endList = true;
      } else if (line.indexOf('#EXTINF:') === 0) {
        dur = parseFloat(line.slice(8));
      } else if (line.charAt(0) !== '#') {
        segs.push({ url: line, dur: dur || target });
        dur = 0;
      }
    }
    return { segs: segs, target: target, map: map, endList: endList };
  }

  // The VOD seek bar works on the byte ranges announced by the file's 'sidx'
  // box. Adaptive YouTube renditions are fragmented MP4 with the index right
  // after the moov, so a seek is: read the head once, map the target time to
  // the covering subsegment, then fetch only from that moof onward.
  function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function u64(b, o) {
    return u32(b, o) * 4294967296 + u32(b, o + 4);
  }

  function boxType(b, o) {
    return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
  }

  // Walk top-level boxes in the leading bytes of an MP4. 'sidx' means seeking
  // is possible and gives us the moov to configure the decoders from; 'none'
  // means the init section is over without an index (progressive MP4, or a
  // fragmented file without one), so the bar must stay display-only.
  function scanInit(b) {
    var off = 0, moovEnd = 0;
    while (off + 8 <= b.length) {
      var size = u32(b, off);
      var type = boxType(b, off);
      var hdr = 8;
      if (size === 1) {
        if (off + 16 > b.length) return { state: 'unknown', moovEnd: moovEnd };
        size = u64(b, off + 8);
        hdr = 16;
      } else if (size === 0) {
        size = b.length - off;
      }
      if (size < hdr) return { state: 'none', moovEnd: moovEnd };
      if (off + size > b.length) return { state: 'unknown', moovEnd: moovEnd };
      if (type === 'moov') {
        moovEnd = off + size;
      } else if (type === 'sidx') {
        if (!moovEnd) return { state: 'none', moovEnd: moovEnd };
        return { state: 'sidx', moovEnd: moovEnd, sidxOff: off, sidxEnd: off + size };
      } else if (type === 'mdat' || type === 'moof' || type === 'mfra') {
        return { state: 'none', moovEnd: moovEnd };
      }
      off += size;
    }
    return { state: 'unknown', moovEnd: moovEnd };
  }

  function parseSidx(b, off, end) {
    var version = b[off + 8];
    var p = off + 12;
    p += 4; // reference_ID
    var timescale = u32(b, p); p += 4;
    var earliest, firstOffset;
    if (version === 0) {
      earliest = u32(b, p); p += 4;
      firstOffset = u32(b, p); p += 4;
    } else {
      earliest = u64(b, p); p += 8;
      firstOffset = u64(b, p); p += 8;
    }
    if (p + 4 > end) return null;
    p += 2;
    var count = (b[p] << 8) | b[p + 1]; p += 2;
    var entries = [];
    for (var i = 0; i < count; i++) {
      if (p + 12 > end) return null;
      var ref = u32(b, p); p += 4;
      var dur = u32(b, p); p += 4;
      p += 4;
      entries.push({ size: ref & 0x7fffffff, dur: dur });
    }
    return { timescale: timescale || 1, earliest: earliest, firstOffset: firstOffset, entries: entries, end: end };
  }

  // The subsegment containing (or immediately preceding) targetSec. Its first
  // moof starts on an IDR, so playback can start there without decoding from
  // the beginning. startSec is also the anchor the separate audio file seeks
  // to: starting audio LATER than the video keyframe would leave silence until
  // the audio caught up, so the audio seek uses this exact time.
  function pickSidxEntry(sidx, targetSec) {
    var entries = sidx.entries;
    if (!entries.length) return null;
    var ts = sidx.timescale;
    var target = Math.max(0, Number(targetSec) || 0);
    var t = sidx.earliest / ts;
    var offset = sidx.end + sidx.firstOffset;
    var best = 0, bestStart = t, bestOffset = offset;
    for (var i = 0; i < entries.length; i++) {
      var start = t;
      var dur = entries[i].dur / ts;
      if (start <= target + 0.001) {
        best = i;
        bestStart = start;
        bestOffset = offset;
      }
      offset += entries[i].size;
      t += dur;
      if (t > target) break;
    }
    return { index: best, startSec: bestStart, offset: bestOffset };
  }

  function segmentAt(segs, sec) {
    var t = 0, best = 0;
    for (var i = 0; i < segs.length; i++) {
      if (t <= sec + 0.001) best = i;
      t += segs[i].dur;
      if (t > sec) break;
    }
    return best;
  }

  // ---- mux setup ----------------------------------------------------------
  TeslaPlayer.prototype.startMux = function (s, gen) {
    var self = this;
    s.mbox = MP4Box.createFile();
    s.tm = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, removeEPK: true });

    // mux.js 6 is an EventEmitter. It fires at a SEGMENT BOUNDARY, so segment
    // N's fMP4 only appears once N+1 has been pushed - which is why a single
    // push() produces nothing.
    s.tm.on('data', function (event) {
      if (s.stopped || self.gen !== gen) return;
      // The init segment (ftyp+moov) is fed exactly once. mux.js repeats it on
      // every event, and handing mp4box a second moov makes it rebuild its
      // sample tables against truns it has not seen; appendBuffer then throws
      // and the whole pipeline stops.
      if (event.initSegment && !s.initFed) { s.initFed = true; self.feedMp4(s, new Uint8Array(event.initSegment)); }
      if (event.data) self.feedMp4(s, new Uint8Array(event.data));
    });

    this.startPipeline(s, gen);
    // The pump is a self-rescheduling loop rather than a tight while, so closing
    // a channel mid-fetch cannot leave an orphaned loop running.
    self.pump(s, gen);
  };

  TeslaPlayer.prototype.startPipeline = function (s, gen) {
    var self = this;
    s.vdec = new VideoDecoder({
      output: function (frame) { self.onVideoFrame(s, frame); },
      error: function (e) { self.fail('video decoder: ' + e.message); }
    });

    s.pumpTimer = setInterval(function () {
      if (s.stopped || self.gen !== gen) return;
      self.feedDecoders(s, Date.now());
    }, 10);
    self.schedulePaint(s, gen);

    s.statsTimer = setInterval(function () {
      if (s.stopped || self.gen !== gen) return;
      self.checkVodEnd(s);
      self.emit('state', self.state());
    }, 500);
  };

  TeslaPlayer.prototype.feedMp4 = function (s, bytes) {
    if (!s.mbox || s.stopped) return;
    // The first chunks also tell us whether this file can be seeked at all.
    // A ranged seek feeds a head without its sidx, so only inspect the normal
    // sequential load.
    if (s.kind === 'mp4' && s.startSec <= 0.05) this.noteSeekHead(s, bytes);
    try {
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ab.fileStart = s.filePos;
      s.mbox.appendBuffer(ab);
      s.filePos += ab.byteLength;
      if (!s.vTrack) this.setupTracks(s);
    } catch (e) { this.fail('demux: ' + e.message); }
  };

  // Pick the real video and audio tracks. getInfo() is only a summary; the
  // sample-entry box tree (where avcC and esds live) comes from getTrackById().
  TeslaPlayer.prototype.setupTracks = function (s) {
    var self = this;
    var info;
    try { info = s.mbox.getInfo(); } catch (e) { return; }
    if (!info) return;

    var tracks = (info.videoTracks || []);
    if (!tracks.length) { s.noVideo = (s.noVideo || 0) + 1; return; }
    var vt = tracks[0];
    s.vTrack = vt;
    // Only MP4 keeps its duration in the moov. For HLS the playlist is the
    // authority: mux.js's generated init segment carries a nonsense duration
    // and letting it through replaced a 12s VOD with a 13-hour one.
    if (s.kind === 'mp4' && info.duration && info.timescale) s.duration = info.duration / info.timescale;

    // Choose the audio track by codec, not by position. F1TV's TS carries
    // scte_35 and timed_id3 beside the real audio; taking the first entry
    // decodes SCTE-35 ad markers as if they were sound.
    var at = null;
    var ats = info.audioTracks || [];
    for (var i = 0; i < ats.length; i++) {
      var c = (ats[i].codec || '') + ' ' + (ats[i].type || '');
      if (/mp4a|aac/i.test(c)) { at = ats[i]; break; }
      if (!at) at = ats[i];
    }
    s.aTrack = at || null;

    var videoTrak = s.mbox.getTrackById(vt.id);
    try {
      var videoEntry = videoTrak.mdia.minf.stbl.stsd.entries[0];
      var lengthSizeMinusOne = videoEntry && videoEntry.avcC && videoEntry.avcC.lengthSizeMinusOne;
      s.nalLengthSize = Number.isInteger(lengthSizeMinusOne) ? lengthSizeMinusOne + 1 : 4;
    } catch (e) { s.nalLengthSize = 4; }
    var cfg = this.videoConfig(videoTrak);
    s.codec = cfg.codec;
    try {
      s.vdec.configure(cfg);
    } catch (e) { this.fail('video config: ' + e.message); return; }

    if (s.aTrack) { try { this.setupAudio(s, s.mbox.getTrackById(s.aTrack.id)); } catch (e) {} }

    // One segment holds ~30 frames here (10fps x 3s). Asking mp4box for 90 samples
    // makes it re-deliver up to three segments' worth every extraction, so frames
    // already decoded get decoded again - the demuxer sees the timestamp sequence
    // run backwards and the picture stutters once per segment. Keep the batch at
    // roughly one segment so each sample is handed over exactly once.
    s.mbox.setExtractionOptions(vt.id, null, { nbSamples: 40 });
    if (s.aTrack) s.mbox.setExtractionOptions(s.aTrack.id, null, { nbSamples: 200 });
    s.mbox.onSamples = function (id, user, samples) { self.onSamples(s, id, samples); };
    s.mbox.start();   // without start() mp4box never releases samples
  };

  TeslaPlayer.prototype.videoConfig = function (trak) {
    var entry = trak.mdia.minf.stbl.stsd.entries[0];
    var desc = avcCDescription(entry && entry.avcC);
    var codec = trak.codec || (entry && entry.avcC
      ? 'avc1.' + hex2(entry.avcC.AVCProfileIndication) + hex2(entry.avcC.profile_compatibility) + hex2(entry.avcC.AVCLevelIndication)
      : 'avc1.64001f');
    // No hardwareAcceleration hint. 'prefer-hardware' is NOT a graceful fallback
    // in Chrome: where the platform exposes no H.264 hardware decoder
    // (software-only rendering, some VMs, some mobile builds), isConfigSupported()
    // returns false and configure() throws "Unsupported configuration" - the
    // decoder dies and the canvas stays blank forever. Omitting the field lets the
    // browser choose, which uses hardware where present and software otherwise.
    var cfg = { codec: codec, optimizeForLatency: true };
    if (desc) cfg.description = desc;
    return cfg;
  };

  // ---- audio --------------------------------------------------------------
  // The audio graph is owned by the PLAYER, not by a stream. It is built once
  // and shared across every channel, and only the decoder feeding it changes.
  //
  // Building it per channel was a real bug: each switch created another
  // AudioWorkletNode, gain, limiter and analyser, and re-ran addModule for the
  // same processor name. Flick through a few channels and you have a stack of
  // live audio chains fighting over the output.
  TeslaPlayer.prototype.setupAudio = function (s, trak) {
    var self = this;
    if (!this.actx) return;
    var entry = trak.mdia.minf.stbl.stsd.entries[0];
    var desc = ascFromEsds(entry && entry.esds);

    // The sample rate comes from the stream, and it has to be read from the
    // right place. Two things bite here:
    //   - the sample entry's field is `samplerate`, all lowercase, and it is
    //     16.16 FIXED POINT in a uint32, so 48000 arrives as 3145728000;
    //   - the audio TRACK's timescale is the sample rate directly (32000 on
    //     nasa.4k.us, 48000 on the rest), which is the reliable source.
    // Getting this wrong configures the decoder for a rate the data is not,
    // and the channel comes up with a perfect picture and no sound at all.
    var rate = 0;
    if (s.aTrack && s.aTrack.timescale) rate = s.aTrack.timescale;
    if (!rate && entry) {
      var raw = entry.samplerate || entry.samplingRate || 0;
      if (raw > 65536) rate = Math.round(raw / 65536);
      else if (raw) rate = raw;
    }
    if (!rate) rate = (this.actx && this.actx.sampleRate) || 48000;
    s.srcRate = rate;
    // Real channel count too, rather than assuming stereo.
    s.srcCh = (entry && (entry.channel_count || entry.channelCount)) || 2;

    s.adec = new AudioDecoder({
      output: function (data) { self.queueAudio(s, data); data.close(); },
      error: function (e) {
        s.aErr = 'audio decoder: ' + (e && e.message);
        s.adec = null;
        // A single decode error used to silence the rest of the stream. Rebuild
        // the decoder once and keep feeding the queue: the gap is under a
        // second, which is far better than permanent silence.
        if (!s.adecRetried && !s.stopped) {
          s.adecRetried = true;
          setTimeout(function () {
            if (s.stopped || !s.aTrack || !s.aMbox || !s.aMbox.getTrackById) return;
            try { self.setupAudio(s, s.aMbox.getTrackById(s.aTrack.id)); } catch (err) {}
          }, 250);
        }
      }
    });
    var cfg = { codec: 'mp4a.40.2', sampleRate: s.srcRate, numberOfChannels: s.srcCh };
    if (desc) cfg.description = desc;
    try { s.adec.configure(cfg); } catch (e) { s.aErr = 'audio config: ' + e.message; s.adec = null; return; }
    this.ensureAudio(s.srcRate);
  };

  // Build the ring and its output chain. Idempotent, and shared by every
  // channel. sourceRate tells the ring the stream's rate so it can resample to
  // the device's; channels differ (32kHz vs 48kHz), so it is set per channel.
  TeslaPlayer.prototype.ensureAudio = function (sourceRate) {
    var a = this.audio;
    if (sourceRate) a.sourceRate = sourceRate;
    if (!this.actx) return Promise.resolve(false);
    if (a.ready) { this.setAudioRate(a.sourceRate); return Promise.resolve(true); }
    if (a.pending) return a.pending;
    a.pending = true;
    var self = this, ctx = this.actx;
    var urls = [
      URL.createObjectURL(new Blob([RING_WORKLET], { type: 'application/javascript' })),
      'data:application/javascript;base64,' + btoa(RING_WORKLET)
    ];
    var tryUrl = function (i) {
      if (i >= urls.length) { useScriptProcessor(); return; }
      ctx.audioWorklet.addModule(urls[i]).then(function () {
        wire();
      }).catch(function (e) {
        // Record the refusal rather than swallowing it: a refused module used
        // to leave the page with a perfect picture and no sound at all, with
        // nothing on screen to say why.
        a.modErr += ' [' + (i ? 'data' : 'blob') + ': ' + (e && e.message) + ']';
        tryUrl(i + 1);
      });
    };
    tryUrl(0);

    function wire() {
      a.node = new AudioWorkletNode(ctx, 'lofi-ring', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { capacity: Math.max(48000 * 8, ctx.sampleRate * 8),
                            sourceRate: a.sourceRate || ctx.sampleRate }
      });
      a.node.port.onmessage = function (e) {
        var d = e.data || {};
        if (typeof d.depth === 'number') a.depth = d.depth;
        if (typeof d.rms === 'number') a.rms = d.rms;
        if (d.starved) a.underruns = d.underruns;
      };
      a.push = function (planes) { a.node.port.postMessage(planes); };
      a.setRate = function (r) { a.node.port.postMessage({ rate: r }); };
      // 1 = the stream's own rate; the sync loop nudges it either side.
      a.setTrim = function (x) { a.node.port.postMessage({ trim: x }); };
      finish(a.node);
      a.path = 'AudioWorklet';
    }

    // Last resort: the same ring, pulled by a ScriptProcessorNode. Deprecated,
    // but it is a built-in node type - no module loading, no blob URL, so
    // nothing can block it the way a CSP blocks addModule(). It resamples from
    // the stream's rate to the device's, for the same reason the worklet does.
    function useScriptProcessor() {
      try {
        var sp = ctx.createScriptProcessor(2048, 1, 2);
        var cap = Math.max(48000 * 8, ctx.sampleRate * 8);
        var ch = [new Float32Array(cap), new Float32Array(cap)];
        var st = { w: 0, pos: 0, avail: 0, fed: false, under: 0, trim: 1, srcRate: a.sourceRate || ctx.sampleRate };
        st.step = st.srcRate / ctx.sampleRate;
        sp.onaudioprocess = function (ev) {
          var out = ev.outputBuffer, n = out.length, starved = false;
          var stp = st.step * st.trim;
          for (var i = 0; i < n; i++) {
            var l = 0, rr = 0;
            if (st.avail >= 1) {
              var i0 = st.pos | 0, i1 = i0 + 1, f = st.pos - i0;
              var a0 = i0 % cap, a1 = i1 % cap;
              if (f > 0) {
                l = ch[0][a0] + (ch[0][a1] - ch[0][a0]) * f;
                rr = ch[1][a0] + (ch[1][a1] - ch[1][a0]) * f;
              } else { l = ch[0][a0]; rr = ch[1][a0]; }
              st.pos += stp; st.avail -= stp;
            } else starved = true;
            out.getChannelData(0)[i] = l;
            if (out.numberOfChannels > 1) out.getChannelData(1)[i] = rr;
          }
          if (starved && st.fed) { st.under++; a.underruns = st.under; }
          a.depth = st.avail / st.srcRate;
        };
        a.push = function (planes) {
          var n = planes[0].length;
          if (st.avail + n > cap) {
            var room = Math.max(0, cap - st.avail);
            for (var i = 0; i < room; i++) {
              ch[0][st.w] = planes[0][i]; ch[1][st.w] = planes[1][i]; st.w = (st.w + 1) % cap;
            }
            st.avail += room;
            return;
          }
          for (var j = 0; j < n; j++) {
            ch[0][st.w] = planes[0][j]; ch[1][st.w] = planes[1][j]; st.w = (st.w + 1) % cap;
          }
          st.avail += n; st.fed = true;
        };
        a.setRate = function (r) {
          st.srcRate = r; st.step = r / ctx.sampleRate;
          st.w = 0; st.pos = 0; st.avail = 0; st.fed = false;
        };
        a.setTrim = function (x) { st.trim = x; };
        a.flush = function () { st.w = 0; st.pos = 0; st.avail = 0; st.fed = false; };
        a.node = sp;
        finish(sp);
        a.path = 'ScriptProcessor (fallback)';
      } catch (e) {
        a.path = 'unavailable';
        a.modErr += ' [sproc: ' + e.message + ']';
        a.pending = false;
      }
    }

    function finish(node) {
      // gain -> limiter -> analyser -> destination.
      // The source is quiet (about -30dB mean on these feeds, against roughly
      // -20dB for normal broadcast), so it is lifted back to programme level.
      // The limiter is what stops peaks that were already near -10dB from
      // clipping once they are amplified.
      var g = ctx.createGain();
      g.gain.value = self.muted ? 0 : self.gainValue;
      var lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12;
      lim.attack.value = 0.003; lim.release.value = 0.25;
      var an = ctx.createAnalyser();
      an.fftSize = 2048;
      node.connect(g); g.connect(lim); lim.connect(an); an.connect(ctx.destination);
      a.gain = g; a.limiter = lim; a.analyser = an; a.buf = new Float32Array(2048);
      a.ready = true; a.pending = false;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      a.pending = Promise.resolve(true);
    }
    return a.pending;
  };

  // Tell the ring which rate the incoming samples are in. Sent when a channel
  // opens, because channels differ: the ring drains at the device's rate, so a
  // mismatch starves it continuously.
  TeslaPlayer.prototype.setAudioRate = function (r) {
    var a = this.audio;
    if (!r || a.rate === r) return;
    a.rate = r;
    if (a.setRate) a.setRate(r);
  };

  // Loop playback for VOD. Turning it on while the last frame is already
  // showing restarts immediately, so the button feels like it acts on what is
  // on screen rather than silently on the next playthrough.
  TeslaPlayer.prototype.setRepeat = function (on) {
    this.repeat = !!on;
    var s = this.live;
    if (this.repeat && s && s.vod && s.ended && !s.stopped) this.seek(0);
  };

  // VOD has no signal event of its own: the samples simply run out while the
  // wall clock keeps going. Detect the end from the media clock, loop when
  // Repeat is on, and otherwise report it once so the stall watchdog knows the
  // frozen picture is intentional.
  TeslaPlayer.prototype.checkVodEnd = function (s) {
    if (!s.vod || s.ended || s.stopped || s.paused || s.duration <= 0 || s.vT0 < 0) return;
    var pos = s.playStartSec + (clockNow(s) - s.vT0) / 1000;
    if (pos < s.duration - 0.5) return;
    s.ended = true;
    if (this.repeat) {
      this.seek(0);
    } else {
      this.emit('ended');
    }
  };

  // Mute by zeroing the gain node the volume already runs through, rather than
  // by tearing the audio graph down. Two reasons: the picture must keep
  // running while muted, and the ring keeps filling, so unmuting is instant
  // instead of starting again on a starved buffer.
  TeslaPlayer.prototype.setMuted = function (on) {
    this.muted = !!on;
    var a = this.audio;
    if (a.gain && this.actx) {
      var target = this.muted ? 0 : this.gainValue;
      try {
        var t = this.actx.currentTime;
        // Ramped, not stepped: snapping the gain to zero clicks on anything
        // with content above the noise floor.
        a.gain.gain.cancelScheduledValues(t);
        a.gain.gain.setValueAtTime(a.gain.gain.value, t);
        a.gain.gain.linearRampToValueAtTime(target, t + 0.04);
      } catch (e) {
        a.gain.gain.value = target;
      }
    }
    return this.muted;
  };

  // ---- audio/video sync ---------------------------------------------------
  // Audio is decoded AUDIO_LEAD_S ahead of its due time and poured into a ring
  // the device drains; the picture is painted against the system clock at each
  // frame's due time. The two agree only when the ring holds exactly the decode
  // lead, because the lead and the buffered depth cancel each other - so the
  // depth of the ring IS the sync error, and it is the one number this needs.
  //
  // Any drift between the audio device's clock and the system clock (there is
  // always some) pushes the depth off that target and slides the sound against
  // the picture. The correction is to resample the ring read by a fraction of
  // a percent: faster when the ring is too deep, slower when it is too shallow.
  // That is inaudible where dropping or repeating samples to catch up clicks,
  // and unlike moving the video clock it does not need to know which of the two
  // clocks is the correct one.
  var TRIM_MAX = 0.02;       // never shift pitch by more than 2%
  // A proportional gain, sized so a realistic clock error asks for a tiny
  // correction. 0.25 leaves a 20ms residual for an extreme 0.5% clock error
  // and well under 2ms for the 50-200ppm an ordinary device shows, which is
  // far below the ~40ms where a lip-sync offset starts to be visible. It is
  // also far enough from the 400ms resend interval to keep the loop stable.
  var TRIM_GAIN = 0.25;
  var TRIM_DEADBAND = 0.0005;

  TeslaPlayer.prototype.trimAudio = function (s, now) {
    var a = this.audio;
    if (!a.ready || !a.setTrim) return;
    // Smooth the depth before treating it as an error: the worklet reports it
    // once per process block and the decoder delivers in bursts, so a single
    // reading is noise. Seeded from the first non-zero reading because a ring
    // that is still filling is legitimately empty, not "audio is early".
    s.aDepth = s.aDepth ? s.aDepth * 0.85 + a.depth * 0.15 : a.depth;
    var f = (s.aDepth - AUDIO_LEAD_S) * TRIM_GAIN;
    if (f > TRIM_MAX) f = TRIM_MAX; else if (f < -TRIM_MAX) f = -TRIM_MAX;
    if (Math.abs(f) < TRIM_DEADBAND) f = 0;
    this.setAudioTrim(s, 1 + f, now);
  };

  // Sending on every 10ms tick would flood the audio thread for no gain - the
  // ring moves far slower than that. Send only when the correction has moved
  // enough to matter, and at most a few times a second otherwise.
  TeslaPlayer.prototype.setAudioTrim = function (s, trim, now) {
    if (s.aTrim === trim) return;
    if (now - (s.lastTrimAt || 0) < 400 && Math.abs(trim - s.aTrim) < 0.002) return;
    s.aTrim = trim;
    s.lastTrimAt = now;
    this.audio.trim = trim;
    try { this.audio.setTrim(trim); } catch (e) {}
  };

  // Drop whatever the previous channel left in the ring, so a switch does not
  // play out the tail of the old one.
  TeslaPlayer.prototype.flushAudio = function () {
    var a = this.audio;
    if (a.flush) a.flush();
    else if (a.node && a.node.port) { try { a.node.port.postMessage({ flush: 1 }); } catch (e) {} }
    a.underruns = 0; a.depth = 0;
    // Sound the next channel at its own rate. A trim left over from the last
    // one would be invisible to the new stream (its sync state starts at 1)
    // and would run the ring off-cadence until the loop noticed.
    a.trim = 1;
    if (a.setTrim) { try { a.setTrim(1); } catch (e) {} }
  };

  TeslaPlayer.prototype.queueAudio = function (s, data) {
    if (s.stopped) return;
    var a = this.audio;
    if (!a.ready || !a.push) return;
    var n = data.numberOfFrames;
    var planes = [new Float32Array(n), new Float32Array(n)];
    var nch = data.numberOfChannels || 1;
    for (var c = 0; c < 2; c++) {
      data.copyTo(planes[c], { planeIndex: c < nch ? c : 0, format: 'f32-planar' });
    }
    a.push(planes);
    s.aFrames++;
    // Counted in the track's own timebase, so a 32kHz channel reports seconds
    // rather than being read as if it were 48kHz.
    s.aSeconds += n / (data.sampleRate || s.srcRate || 48000);
  };

  // ---- samples ------------------------------------------------------------
  // MP4Box does not always mark AVC IDRs as is_sync. Inspect the sample's
  // length-prefixed NAL units as a fallback; type 5 is an H.264 IDR slice.
  // Crucially, an extraction callback's first sample is NOT necessarily a
  // segment/keyframe boundary: nbSamples batching can split a segment or span
  // several. Treating each callback's first P-frame as a key made Chrome's
  // decoder incur its ~500ms keyframe path at arbitrary points in the stream.
  function hasAvcIdr(data, lengthSize) {
    if (!data) return false;
    var bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
    var size = lengthSize === 1 || lengthSize === 2 || lengthSize === 4 ? lengthSize : 4;
    var offset = 0;
    while (offset + size < bytes.byteLength) {
      var naluSize = 0;
      for (var i = 0; i < size; i++) naluSize = naluSize * 256 + bytes[offset + i];
      if (!naluSize || naluSize > bytes.byteLength - offset - size) return false;
      if ((bytes[offset + size] & 0x1f) === 5) return true;
      offset += size + naluSize;
    }
    return false;
  }

  // A dual-file VOD (video-only + audio-only MP4) must not start its media
  // clock until the audio side can actually play. The relay serves the two
  // files with very different cold-start latency: anchoring on the first video
  // sample can leave the audio arriving seconds late, at which point the
  // release loop drops everything already due and the sound stays half a
  // second behind, with only the 2%/s trim to catch up. Hold the first video
  // samples until the audio track exists and its queue has samples.
  TeslaPlayer.prototype.audioReadyForAnchor = function (s) {
    if (!s.audioUrl) return true;
    if (s.aErr) return true; // audio failed: do not sacrifice the picture
    var a = this.audio;
    if (!a || !a.ready) return false;
    if (!s.aTrack) return false;
    return s.aPend.length > 0;
  };

  TeslaPlayer.prototype.anchorVideo = function (s) {
    if (s.vBaseSec >= 0 || !s.prePend.length) return;
    s.vBaseSec = s.prePend[0].sec;
    s.vT0 = Date.now();
    while (s.prePend.length) {
      var p = s.prePend.shift();
      var rel = p.sec - s.vBaseSec;
      if (rel > s.mediaEnd) s.mediaEnd = rel;
      s.pend.push({ sync: p.sync, ts: Math.round(rel * 1e6), due: s.vT0 + rel * 1000, raw: p.raw });
    }
    while (s.pend.length > s.caps.v) { s.pend.shift(); s.dropsPre++; }
  };

  TeslaPlayer.prototype.onSamples = function (s, id, samples, isAudioBox) {
    var self = this;
    s.samples += samples.length;
    var firstAudioSample = true;
    for (var i = 0; i < samples.length; i++) {
      var sm = samples[i];
      if (!sm || !sm.data || !sm.data.byteLength) continue;
      var raw = new Uint8Array(sm.data.buffer.slice(sm.data.byteOffset, sm.data.byteOffset + sm.data.byteLength));
      if (!isAudioBox && s.vTrack && id === s.vTrack.id) {
        // Only real sync samples/IDRs should be marked as key. A callback can
        // start in the middle of a GOP; its first sample is not automatically
        // a keyframe.
        var sync = !!sm.is_sync || hasAvcIdr(sm.data, s.nalLengthSize);
        var vs = (s.vTrack.timescale || 90000);
        var sec = sm.cts / vs;
        // mux.js keeps the source timestamps so audio and video from separate
        // renditions share one origin. Anchor the media clock on the first
        // decoded video sample and measure everything relative to it, which
        // keeps the state position small and the anchor independent of how
        // far into the live window we joined.
        if (s.vBaseSec < 0) {
          if (s.prePend.length < 600) s.prePend.push({ sync: sync, sec: sec, raw: raw });
          else s.drops++;
          if (s.audioUrl && !self.audioReadyForAnchor(s)) {
            if (!s.preStart) s.preStart = Date.now();
            continue;
          }
          self.anchorVideo(s);
          continue;
        }
        var rel = sec - s.vBaseSec;
        if (rel > s.mediaEnd) s.mediaEnd = rel;
        s.pend.push({ sync: sync, ts: Math.round(rel * 1e6), due: s.vT0 + rel * 1000, raw: raw });
      } else if (s.aTrack && s.adec && id === s.aTrack.id) {
        // Audio gets its own queue, paced on the same media clock. Sharing the
        // video queue lets audio evict video - AAC frames outnumber video ~2:1 -
        // and feeding it unpaced delivers a whole segment in one burst, which
        // runs the scheduler far ahead of the audio clock and stutters.
        var as = (s.aTrack.timescale || 48000);
        var asec = sm.cts / as;
        // No due time yet: vT0 may not exist if this track was demuxed before
        // the first video sample. feedDecoders() computes it against whichever
        // anchor exists by the time the sample is released.
        // MP4Box can re-deliver samples that were already emitted (and can
        // parse a fresh moof with a transiently wrong timescale) while the
        // next segment is appended. Feeding the duplicates decodes the same
        // audio twice; the ring then holds seconds more than the video clock,
        // which is the desync that shows up right after a segment boundary.
        // Drop anything at or behind the newest queued timestamp.
        if (s.aLastQueuedTs != null && asec * 1e6 <= s.aLastQueuedTs) continue;
        s.aLastQueuedTs = Math.round(asec * 1e6);
        s.aPend.push({ sync: !!sm.is_sync || firstAudioSample, ts: Math.round(asec * 1e6), raw: raw });
        if (s.vBaseSec >= 0) {
          var arel = asec - s.vBaseSec;
          if (arel > s.aMediaEnd) s.aMediaEnd = arel;
        }
        firstAudioSample = false;
      }
    }
    // Cap each queue at the WORST-CASE buffer, not the target. Fetching happens
    // a whole segment at a time, so the buffer oscillates between the target and
    // target+segment; capping at the target overflowed on every segment and the
    // overflow drops the OLDEST entries - the frames about to be shown, which
    // shows up as multi-second stalls.
    while (s.pend.length > s.caps.v) { s.pend.shift(); s.dropsQ++; }
    while (s.aPend.length > s.caps.a) { s.aPend.shift(); s.aSkips++; }
    if (s.vod && samples.length) {
      var last = samples[samples.length - 1];
      if (last && typeof last.number === 'number') {
        var box = isAudioBox ? s.aMbox : s.mbox;
        try { if (box) box.releaseUsedSamples(id, last.number); } catch (e) {}
      }
    }
  };

  // The media clock's wall reference. While paused the clock is frozen at
  // pausedAt; setPaused() shifts vT0 forward by the paused duration on resume,
  // so every consumer can keep using the same formula.
  function clockNow(s) {
    return s.pausedAt ? s.pausedAt : Date.now();
  }

  // Seconds of downloaded media ahead of what is playing right now. Negative
  // means we have run past the download and are starved.
  function bufferedOf(s) {
    if (s.vT0 < 0 || !s.mediaEnd) return 0;
    return s.mediaEnd - (clockNow(s) - s.vT0) / 1000;
  }

  // Pause freezes the picture, the media clock and the audio graph without
  // tearing anything down. The download and demux loops keep running behind
  // their buffer caps, so resuming has data waiting instead of a restart.
  TeslaPlayer.prototype.setPaused = function (on) {
    var want = !!on;
    this.paused = want;
    var s = this.live;
    if (s && !s.stopped) {
      if (want && !s.paused) {
        s.paused = true;
        s.pausedAt = Date.now();
        if (this.actx && this.actx.state === 'running') {
          try { this.actx.suspend(); } catch (e) {}
        }
      } else if (!want && s.paused) {
        var shift = Date.now() - s.pausedAt;
        s.paused = false;
        s.pausedAt = 0;
        if (s.vT0 >= 0) s.vT0 += shift;
        for (var i = 0; i < s.pend.length; i++) s.pend[i].due += shift;
        for (var j = 0; j < s.fq.length; j++) {
          if (s.fq[j] && typeof s.fq[j].due === 'number') s.fq[j].due += shift;
        }
        if (this.actx && this.actx.state === 'suspended') {
          try { this.actx.resume(); } catch (e) {}
        }
      }
    }
    this.emit('state', this.state());
    return want;
  };

  // Feed the decoders on the media clock. Handing every sample straight to
  // decode() lets the decoder sprint through a whole segment in milliseconds
  // and dump it at once, so the paint gate almost never finds a frame waiting.
  TeslaPlayer.prototype.feedDecoders = function (s, now) {
    if (!s.vdec || s.vdec.state !== 'configured') return;
    if (s.paused) return;
    if (s.vBaseSec < 0 && s.prePend.length) {
      // A seek resumes at a keyframe both sides share. The audio fragment can
      // take seconds to arrive from a deep byte offset, so wait well past the
      // live limit: anchoring the picture first leaves the sound seconds late,
      // and the catch-up then skips samples and shows up as drift.
      var anchorWait = (s.vod && s.startSec > 0.05) ? 15000 : 5000;
      if (this.audioReadyForAnchor(s) || (s.preStart && now - s.preStart > anchorWait)) this.anchorVideo(s);
    }
    while (s.pend.length && s.pend[0].due < now - 500) { s.pend.shift(); s.dropsLate++; }
    // Feed well before presentation. The canvas still paints against each
    // frame's due time; this is decode buffering only, not added playback lag.
    while (s.pend.length && s.pend[0].due - now < VIDEO_DECODE_LEAD_MS) {
      if (s.vdec.decodeQueueSize > 6) break;
      var c = s.pend.shift();
      try {
        s.vdec.decode(new EncodedVideoChunk({ type: c.sync ? 'key' : 'delta', timestamp: c.ts, data: c.raw }));
      } catch (e) { /* queue full */ }
    }
    // Audio is released further ahead of its due time than video, because a ring
    // buffer only smooths jitter if it actually holds a cushion. Releasing it
    // just before it is due leaves the ring at zero and turns every hiccup into
    // a dropout. The cushion is what the sync trim below holds steady.
    //
    // Nothing is fed until the first video sample has anchored the shared media
    // clock. Before that vT0 is -1 and an audio due time is meaningless: every
    // queued sample would test as due at once, the whole queue would be dumped
    // into the ring, and the sound would sit seconds behind the picture for the
    // rest of the stream. The due time is worked out here, at release, rather
    // than when the sample was queued, because audio can be demuxed before the
    // anchor exists.
    if (s.adec && s.adec.state === 'configured' && s.vT0 >= 0) {
      // Audio timestamps come from the shared source clock; subtract the video
      // anchor so this queue lines up with the video due times instead of
      // playing seconds ahead or behind when the two renditions joined at
      // slightly different segment boundaries.
      var aOff = s.vT0 - (s.vBaseSec >= 0 ? s.vBaseSec : 0) * 1000;
      var aDue = function (x) { return aOff + x.ts / 1000; };
      // The first release of a stream drops what is already due. Joining live
      // means the head of the queue is in the past, and playing it would start
      // the ring deeper than the lead - the exact offset this is here to avoid.
      if (!s.aPrimed && s.aPend.length) {
        while (s.aPend.length && aDue(s.aPend[0]) <= now) { s.aPend.shift(); s.aSkips++; }
        s.aPrimed = true;
      }
      while (s.aPend.length && aDue(s.aPend[0]) < now - 500) { s.aPend.shift(); s.aSkips++; }
      while (s.aPend.length && aDue(s.aPend[0]) - now < AUDIO_LEAD_MS) {
        if (s.adec.decodeQueueSize > 40) break;
        var a = s.aPend.shift();
        try {
          s.adec.decode(new EncodedAudioChunk({ type: a.sync ? 'key' : 'delta', timestamp: a.ts - (s.vBaseSec >= 0 ? s.vBaseSec : 0) * 1e6, data: a.raw }));
        } catch (e) {}
      }
      this.trimAudio(s, now);
    }
  };

  // ---- video frames -------------------------------------------------------
  TeslaPlayer.prototype.onVideoFrame = function (s, frame) {
    if (s.stopped) { try { frame.close(); } catch (e) {} return; }
    s.frames++;
    var sec = (frame.timestamp || 0) / 1e6;
    var due = s.vT0 >= 0 ? s.vT0 + sec * 1000 : 0;
    // A short queue, not a single slot. The decoder runs slightly ahead of the
    // wall clock, so the NEWEST frame is always a few ms in the future; keeping
    // only that one meant every paint check found "not due yet" and nothing was
    // ever shown.
    //
    // The cap has to exceed the decoder's lookahead or the overflow discards
    // the frames that were due next and the picture skips. With a 250ms lead at
    // 60fps that is ~15 frames, so the cap scales with the learned frame rate.
    if (s.lastFrameDue >= 0 && due > s.lastFrameDue) {
      // The source's real frame interval, as a rolling MEDIAN of the gaps
      // between consecutive decoded frames.
      //
      // A plain exponential average is not safe here. One outlier - a
      // timestamp gap across a segment boundary, or a B-frame reordering - pulls
      // the estimate far enough that anything derived from it moves too, and
      // when that something is a queue cap the queue starts shedding the frames
      // it is supposed to be holding. The median ignores outliers by
      // construction, so a single bad gap cannot resize anything.
      var d = due - s.lastFrameDue;
      s.ivWin.push(d);
      if (s.ivWin.length > 60) s.ivWin.shift();
      if (s.ivWin.length > 8) {
        var sorted = s.ivWin.slice().sort(function (a, b) { return a - b; });
        s.frameIv = sorted[sorted.length >> 1];
        // The frame queue has to hold the whole decode lead. A fixed 40 was
        // sized for 10fps cameras: at 30fps it holds 1.3s, less than the 2.2s
        // lead, so the queue immediately starts evicting the frames that are
        // due next and the picture stalls after the first couple of frames.
        var need = Math.ceil(VIDEO_DECODE_LEAD_MS / s.frameIv) + 12;
        if (need > s.caps.fq) s.caps.fq = need;
      }
    }
    s.lastFrameDue = due;
    s.fq.push({ frame: frame, due: due });
    while (s.fq.length > s.caps.fq) { s.fq.shift().frame.close(); s.dropsFq++; }
  };

  // ---- paint --------------------------------------------------------------
  // Painting is driven by a timer aimed at each frame's own due time, not by
  // rAF. rAF only fires about every 16.7ms, so a 25fps source (a frame every
  // 40ms) is always caught at the NEXT rAF after it comes due - a fixed ~10ms
  // late, every frame, forever. That is not judder you can filter out later; it
  // is a 20fps picture no matter what the source says.
  TeslaPlayer.prototype.schedulePaint = function (s, gen) {
    var self = this;
    if (s.paintTimer || s.stopped) return;
    if (!s.fq.length || s.paused) {
      s.paintTimer = setTimeout(function () { s.paintTimer = null; self.schedulePaint(s, gen); }, 10);
      return;
    }
    var wait = Math.max(0, s.fq[0].due - Date.now());
    s.paintTimer = setTimeout(function () {
      s.paintTimer = null;
      if (s.stopped || self.gen !== gen) return;
      self.paintOne(s);
      self.schedulePaint(s, gen);
    }, wait);
  };

  TeslaPlayer.prototype.paintOne = function (s) {
    if (!s.fq.length) return;
    var wall = Date.now();
    // Oldest DUE frame, first-in-first-out. Taking the newest discards
    // everything queued before it, which is a silent drop.
    if (s.fq[0].due && s.fq[0].due > wall) return;
    var box = s.fq.shift();
    var frame = box.frame;
    var w = frame.displayWidth || frame.codedWidth;
    var h = frame.displayHeight || frame.codedHeight;
    if (!w || !h) { try { frame.close(); } catch (e) {} return; }
    s.width = w; s.height = h;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    try { frame.close(); } catch (e) {}
    s.drawn++;
    if (!s.firstFrameAt) {
      s.firstFrameAt = wall;
      // Signal the first successful canvas paint immediately. The page uses
      // this to remove its loading overlay; polling state once a second left
      // "Connecting..." over an already-visible image for up to a full second.
      this.emit('firstframe');
    }
    if (s.lastGapAt) {
      var gap = wall - s.lastGapAt;
      s.gaps.push(gap);
      if (s.gaps.length > 400) s.gaps.shift();
    }
    s.lastGapAt = wall;
    s.lastPaintT = wall;
    this.updateFps(s, wall);
  };

  TeslaPlayer.prototype.updateFps = function (s, wall) {
    var dt = s.lastDecT ? (wall - s.lastDecT) / 1000 : 0;
    s.decFps = s.decFps ? s.decFps * 0.7 + (1 / dt) * 0.3 : (dt ? 1 / dt : 0);
    s.paintFps = s.paintFps ? s.paintFps * 0.7 + (1 / dt) * 0.3 : (dt ? 1 / dt : 0);
    s.lastDecT = wall;
  };

  // ---- segment pump -------------------------------------------------------
  // The live window slides: old segments fall off the front of the playlist as
  // new ones appear, so position is tracked by URL, never by index. And the
  // download is paced to buffer depth, not to a fixed clock - decode runs far
  // faster than real time, so an unpaced loop chews through the whole window in
  // seconds and re-downloads the same segments forever.
  // The identity of a segment is the epoch in its filename (v-<epoch>.ts). The
    // full URL is NOT stable: a proxy rewrites it between playlist fetches - a
    // changing ?sourceId= or token, a CDN query, or a relay rewriting segment
    // URLs on the way through. Matching on the whole string therefore fails
    // even when the very same segment is still listed, reanchor falls through
    // to its "slid out of the window" branch, and the pump re-fetches a segment
    // it has already pushed to the decoder.
    //
    // Replaying a segment is not harmless: the duplicate frames make the
    // timestamp sequence appear to jump backwards (~-1.1s steps), so frames get
    // painted in bunches with gaps between them - a visible stutter at exactly
    // one segment duration. Measured as 148 duplicate-timestamp frames per 20s.
  var segKey = function (u) {
    var m = /v-(\d+)\.ts/.exec(u || '');
    if (m) return m[1];
    // googlevideo HLS puts the playlist sequence number in the segment URL:
    // /sq/2817/.../seg.ts. Match on that, not on the whole signed URL (the
    // signature and host rotate between playlist fetches).
    var sq = /\/sq\/(\d+)(?:\/|$)/.exec(u || '');
    return sq ? 'sq' + sq[1] : (u || '');
  };

  TeslaPlayer.prototype.reanchor = function (s) {
    var i = -1;
    var last = segKey(s.lastUrl);
    if (last) {
      for (var k = 0; k < s.segs.length; k++) { if (segKey(s.segs[k].url) === last) { i = k; break; } }
    }
    // -1 means our last segment has genuinely slid out of the window, so the
    // newest segment still listed is the earliest one we can fetch.
    s.cursor = i >= 0 ? i + 1 : Math.max(0, s.segs.length - 1);
  };

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  TeslaPlayer.prototype.pump = function (s, gen) {
    var self = this;
    if (s.pumpRunning) return;
    s.pumpRunning = true;
    (function loop() {
      if (s.stopped || self.gen !== gen) { s.pumpRunning = false; return; }
      if (s.cursor >= s.segs.length) {
        if (s.vod) {
          s.pumpRunning = false;
          try { if (s.tm) s.tm.flush(); } catch (e) {}
          return;
        }
        fetchT(s.base).then(function (r) {
          return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status));
        }).then(function (t) {
          var p = parsePlaylist(t);
          if (p.segs.length) { s.segs = p.segs; s.target = p.target; s.segDur = p.segs[0].dur; }
          self.reanchor(s);
          return sleep(0);
        }).catch(function (e) { return sleep(1500); }).then(function () { loop(); });
        return;
      }
      // Pace by BUFFER DEPTH. One segment per segment-duration means media
      // arrives exactly when it is needed, so the audio ring sits at zero and
      // every hiccup becomes a dropout.
      if (bufferedOf(s) > BUFFER_TARGET_S) { sleep(200).then(loop); return; }
      var seg = s.segs[s.cursor];
      if (!seg) { sleep(100).then(loop); return; }
      s.cursor++; s.lastUrl = seg.url;
      // Never push the same segment twice. Replaying one duplicates every frame
      // in it, which the demuxer sees as a timestamp sequence that runs backwards,
      // and that reads on screen as a stutter once per segment.
      var sk = segKey(seg.url);
      if (s.pushedKeys && s.pushedKeys[sk]) { loop(); return; }
      s.pushedKeys = s.pushedKeys || {};
      s.pushedKeys[sk] = 1;
      // Keep the memory bounded: only recent segments can still be re-offered.
      if (Object.keys(s.pushedKeys).length > 24) {
        var ks = Object.keys(s.pushedKeys);
        for (var d = 0; d < ks.length - 24; d++) delete s.pushedKeys[ks[d]];
      }
      fetchT(absolute(seg.url, s.base)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        if (s.stopped || self.gen !== gen) return;
        s.segsFetched++;
        s.tm.push(new Uint8Array(buf));
        // push() only feeds the parser. flush() is what tells mux.js the segment
        // ended, and that is what makes it remux and emit 'data' - without it
        // the transmuxer just buffers and nothing ever comes out.
        s.tm.flush();
      }).catch(function (e) {
        s.fetchErr = e.message;
      }).then(function () { loop(); });
    })();
  };

  // ---- teardown -----------------------------------------------------------
  // Without this every channel change leaks a VideoDecoder, an AudioDecoder, a
  // paint timer and a pump loop. Flick through a dozen channels and the page
  // is running a dozen pipelines at once.
  TeslaPlayer.prototype.close = function () {
    var s = this.live;
    if (!s) return;
    s.stopped = true;
    this.gen++;                      // orphan every in-flight callback
    this.live = null;
    this.emit('state', this.state());
    try { if (s.ctl) s.ctl.abort(); } catch (e) {}
    try { if (s.aCtl) s.aCtl.abort(); } catch (e) {}
    try { if (s.vdec && s.vdec.state !== 'closed') s.vdec.close(); } catch (e) {}
    try { if (s.adec && s.adec.state !== 'closed') s.adec.close(); } catch (e) {}
    // The audio graph deliberately SURVIVES a channel switch - it belongs to the
    // player, not the stream. Only the ring's contents are dropped, so the next
    // channel does not play out the tail of this one.
    this.flushAudio();
    try { if (s.tm) s.tm.removeAllListeners(); } catch (e) {}
    try { if (s.mbox) s.mbox.stop(); } catch (e) {}
    try { if (s.aMux) s.aMux.removeAllListeners(); } catch (e) {}
    try { if (s.aMbox) s.aMbox.stop(); } catch (e) {}
    try { if (s.paintTimer) clearTimeout(s.paintTimer); } catch (e) {}
    try { if (s.pumpTimer) clearInterval(s.pumpTimer); } catch (e) {}
    try { if (s.statsTimer) clearInterval(s.statsTimer); } catch (e) {}
    try { if (s.rafId) cancelAnimationFrame(s.rafId); } catch (e) {}
    // Release any frames still queued. VideoFrames hold GPU/system memory and
    // an unclosed frame is a leak the GC will not collect.
    for (var i = 0; i < s.fq.length; i++) { try { s.fq[i].frame.close(); } catch (e) {} }
    s.fq.length = 0;
    s.pend.length = 0; s.aPend.length = 0;
    // A seek tears the pipeline down and rebuilds it. Painting black here
    // would flash the player for the length of the seek, so keep the last
    // frame until the new pipeline delivers one.
    if (!this.keepFrame) {
      this.ctx2d.fillStyle = '#000';
      this.ctx2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.keepFrame = false;
  };

  // Public seek entry point. VOD only: the live path intentionally stays at
  // the edge. Reopening resets the decoders and the audio ring, which is why
  // this is a hard restart at a byte offset rather than an in-place seek.
  TeslaPlayer.prototype.seek = function (sec) {
    var s = this.live;
    if (!s || s.stopped || !s.vod) return false;
    if (s.fatal) return false;
    if (s.kind === 'mp4' && s.seekable === false) return false;
    var dur = s.duration || 0;
    sec = Math.max(0, Number(sec) || 0);
    if (dur > 0) sec = Math.min(sec, Math.max(0, dur - 0.5));
    var meta = {};
    for (var k in s.meta) {
      if (Object.prototype.hasOwnProperty.call(s.meta, k)) meta[k] = s.meta[k];
    }
    meta.startSec = sec;
    this.keepFrame = true;
    this.open(s.url, meta);
    return true;
  };

  // Tear the persistent audio graph down. Only needed when leaving Drive mode
  // for good - a channel switch must NOT do this, or every switch would rebuild
  // the whole chain and re-register the processor name.
  TeslaPlayer.prototype.destroy = function () {
    this.close();
    var a = this.audio;
    try { if (a.node) { if (a.node.port) a.node.port.onmessage = null; a.node.disconnect(); } } catch (e) {}
    try { if (a.gain) a.gain.disconnect(); } catch (e) {}
    try { if (a.limiter) a.limiter.disconnect(); } catch (e) {}
    try { if (a.analyser) a.analyser.disconnect(); } catch (e) {}
    if (this.actx) { try { this.actx.close(); } catch (e) {} }
    this.actx = null;
    this.audio = { ready: false, pending: null, node: null, push: null, flush: null,
                   setRate: null, setTrim: null, rate: 0, sourceRate: 0, trim: 1,
                   path: '', modErr: '', depth: 0, rms: 0, underruns: 0,
                   gain: null, limiter: null, analyser: null, buf: null };
  };

  TeslaPlayer.prototype.fail = function (msg) {
    if (this.live) { this.live.fatal = msg; this.emit('note', msg); }
    if (this.listeners.fail) this.emit('fail', msg);
  };

  // ---- reporting ----------------------------------------------------------
  TeslaPlayer.prototype.state = function () {
    var s = this.live;
    if (!s) return { stage: 'idle' };
    var position = 0;
    if (s.vod) {
      var elapsed = s.vT0 >= 0 ? (clockNow(s) - s.vT0) / 1000 : 0;
      position = Math.max(0, s.playStartSec + elapsed);
      if (s.duration > 0) position = Math.min(position, s.duration);
    }
    var st = {
      stage: s.fatal ? 'error' : (s.firstFrameAt ? (s.vod ? 'vod' : 'live') : 'starting'),
      channel: s.meta.name || '',
      url: s.url,
      master: !!s.master,
      vod: !!s.vod,
      live: !s.vod,
      ended: !!s.ended,
      paused: !!s.paused,
      seekable: !!s.vod && !s.fatal && (s.kind !== 'mp4' || s.seekable !== false),
      position: position,
      duration: s.vod ? (s.duration || 0) : 0,
      codec: s.codec, width: s.width, height: s.height,
      maxHeight: s.maxHeight, pickedHeight: s.pickedHeight, availableHeight: s.availableHeight,
      srcRate: s.srcRate, srcCh: s.srcCh || 2, fps: s.frameIv ? (1000 / s.frameIv) : 0,
      drawn: s.drawn, drops: s.drops, segs: s.segsFetched,
      dropsLate: s.dropsLate, dropsQ: s.dropsQ, dropsPre: s.dropsPre, dropsFq: s.dropsFq,
      aSkips: s.aSkips,
      audioPath: this.audio.path, modErr: this.audio.modErr,
      muted: this.muted,
      ctxState: this.actx ? this.actx.state : 'none',
      aFrames: s.aFrames, aSeconds: s.aSeconds, aUnder: this.audio.underruns,
      aQueue: this.audio.depth, aRms: this.audio.rms,
      // aDrift is the sound's position against the picture: positive means the
      // audio is ahead, negative behind, zero in sync. aTrim is the resample
      // correction being applied to hold it there.
      aDrift: this.audio.depth ? (AUDIO_LEAD_S - this.audio.depth) : 0,
      aTrim: s.aTrim || 1,
      outRms: this.outRms(),
      buffered: bufferedOf(s),
      fatal: s.fatal, fetchErr: s.fetchErr, aErr: s.aErr || '',
      firstFrameMs: s.firstFrameAt ? (s.firstFrameAt - s.t0) : 0
    };
    // The paint interval is the number that says whether the picture is smooth.
    // 40ms for a 25fps source is perfect; 50ms means judder.
    if (s.gaps.length > 4) {
      var g = s.gaps.slice().sort(function (a, b) { return a - b; });
      st.medGap = Math.round(g[Math.floor(g.length / 2)]);
      st.worstGap = Math.round(g[Math.floor(g.length * 0.95)]);
      st.spread = Math.round(g[Math.floor(g.length * 0.9)] - g[Math.floor(g.length / 2)]);
    }
    st.canvW = this.canvas.width; st.canvH = this.canvas.height;
    return st;
  };

  // Level actually leaving the graph, measured after the gain and the limiter.
  // Reading it before the gain would say nothing about audibility.
  TeslaPlayer.prototype.outRms = function () {
    var a = this.audio;
    if (!a.analyser || !a.buf) return 0;
    a.analyser.getFloatTimeDomainData(a.buf);
    var sum = 0;
    for (var i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
    return Math.sqrt(sum / a.buf.length);
  };

  global.TeslaPlayer = TeslaPlayer;
  global.TeslaEngine = {
    missingLibs: missingLibs,
    RING_WORKLET: RING_WORKLET
  };
})(window);
