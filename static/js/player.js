// The player in the bottom bar. It lives outside #main-content, so the router (router.js) swaps
// pages around it and the music keeps playing (knowledge player-and-background-playback).
//
// One control, one effect (an owner finding of 2026-11-12: "play" used to queue a whole page or a
// track's radio, and "+ Queue" appended duplicates). The queue holds each track once.
//
//   [data-play="<source>"]              play this one track now; the queue after it is kept
//   [data-play-next="<source>"]         play this track after the current one
//   [data-queue="<source>"]             toggle: add to the end of the queue / take it out again
//   [data-play-radio="<source>"]        replace the queue: this track, its related tracks, theirs
//   [data-play-all="<container id>"]    replace the queue: every visible track of that container
//   [data-play-video="<id>"]            play a video that is not a catalogue track (in a review)
//
// The bar: previous (restarts a track past 3 s), play/pause, next (skip), repeat (off, all, one),
// the queue panel (now playing, up next with reorder and remove, played; shuffle and clear),
// a smaller video, minimise to a pill, close. Every change is announced in a toast. The queue,
// the position and the view are kept in localStorage, so a reload offers to resume, paused. The
// YouTube IFrame API (youtube-nocookie host) is loaded only when something plays; the video stays
// visible while it plays (small at the least), as YouTube's terms require.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var bar = document.getElementById('player');
  if (!Sonic || !bar) return;
  var KEY = 'sonic-player';
  var html = document.documentElement;
  /** @param {string} sel @returns {HTMLElement} */
  var $ = function (sel) { return /** @type {HTMLElement} */ (document.querySelector(sel)); };
  var el = {
    video: document.getElementById('player-video'),
    panel: $('#player-panel'),
    title: /** @type {HTMLAnchorElement} */ ($('[data-player-title]')),
    artist: $('[data-player-artist]'),
    thumb: /** @type {HTMLImageElement} */ ($('[data-player-thumb]')),
    toggle: $('[data-player-toggle]'),
    prev: /** @type {HTMLButtonElement} */ ($('[data-player-prev]')),
    next: /** @type {HTMLButtonElement} */ ($('[data-player-next]')),
    repeat: $('[data-player-repeat]'),
    seek: /** @type {HTMLInputElement} */ ($('[data-player-seek]')),
    time: $('[data-player-time]'),
    duration: $('[data-player-duration]'),
    queueButton: $('[data-player-queue]'),
    queueCount: $('[data-player-count]'),
    queuePanel: $('#player-queue'),
    queueList: $('[data-player-list]'),
    exportLink: /** @type {HTMLAnchorElement} */ ($('[data-player-export]')),
    shuffle: /** @type {HTMLButtonElement} */ ($('[data-player-shuffle]')),
    clear: /** @type {HTMLButtonElement} */ ($('[data-player-clear]')),
    size: $('[data-player-size]'),
    minimise: $('[data-player-minimise]'),
    expand: $('[data-player-expand]'),
    close: $('[data-player-close]'),
    toast: $('#player-toast'),
    toastText: $('[data-player-toast-text]'),
  };
  var REPEAT = ['off', 'all', 'one'];
  var state = { queue: [], index: -1, time: 0, repeat: 'off', view: 'full', video: 'small' };
  var yt = null;
  var ready = false;
  var ticker = null;
  var toastTimer = null;
  var pendingStart = 0;
  var ended = false;
  var started = false; // a frame exists: the docked video is shown with the bar
  var errorStreak = 0;

  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}
  if (REPEAT.indexOf(state.repeat) < 0) state.repeat = 'off';

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function current() { return state.queue[state.index] || null; }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  // A queue entry is identified by its catalogue source, or by its video for a loose video.
  function keyOf(t) { return t.source || 'yt:' + t.youtube; }
  function indexOf(key) {
    for (var i = 0; i < state.queue.length; i++) if (keyOf(state.queue[i]) === key) return i;
    return -1;
  }
  function item(t) {
    return { source: t.source || '', path: t.path || '', artist: t.artist || '', track: t.track || t.title || '',
      youtube: t.youtube, thumbnail: t.youtube ? 'https://i.ytimg.com/vi/' + t.youtube + '/mqdefault.jpg' : '' };
  }
  function upcoming() { return Math.max(0, state.queue.length - state.index - 1); }
  // Every interface string is written as Sonic.t('<key>') with a literal key, so scripts/i18n.py
  // proves each one exists in every locale.
  function repeatLabel() {
    return state.repeat === 'one' ? Sonic.t('player.repeat_one')
      : state.repeat === 'all' ? Sonic.t('player.repeat_all') : Sonic.t('player.repeat_off');
  }
  /** @param {string} text */
  function toast(text) {
    el.toastText.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3000);
  }

  // --- Painting. -----------------------------------------------------------------------------
  function paint() {
    var t = current();
    if (!t) { hide(); return; }
    bar.hidden = false;
    el.panel.hidden = !started;
    document.body.classList.add('has-player');
    html.dataset.playerViewState = state.view;
    html.dataset.playerVideoState = state.video;
    el.title.textContent = t.track;
    el.title.href = t.path ? Sonic.base + '/' + t.path : 'https://www.youtube.com/watch?v=' + t.youtube;
    el.artist.textContent = t.artist;
    el.thumb.src = t.thumbnail;
    el.thumb.alt = '';
    el.prev.disabled = false;
    el.next.disabled = state.index >= state.queue.length - 1 && state.repeat === 'off';
    el.queueCount.textContent = String(upcoming());
    el.queueCount.hidden = upcoming() === 0;
    el.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    el.repeat.setAttribute('aria-label', repeatLabel());
    el.repeat.title = repeatLabel();
    /** @type {HTMLElement} */ (el.repeat.querySelector('[data-icon-repeat-one]')).hidden = state.repeat !== 'one';
    var small = state.video === 'small';
    el.size.setAttribute('aria-pressed', String(small));
    var sizeLabel = small ? Sonic.t('player.video_large') : Sonic.t('player.video_small');
    el.size.setAttribute('aria-label', sizeLabel);
    el.size.title = sizeLabel;
    // The queue from the current track as an ad-hoc YouTube playlist (at most 50 videos): the
    // YouTube app keeps playing it when the phone locks, which no embedded player may do.
    el.exportLink.href = 'https://www.youtube.com/watch_videos?video_ids=' + state.queue
      .slice(state.index, state.index + 50).map(function (q) { return q.youtube; }).join(',');
    var playing = yt && ready && yt.getPlayerState && yt.getPlayerState() === 1;
    el.toggle.setAttribute('aria-label', playing ? Sonic.t('player.pause') : Sonic.t('player.play'));
    /** @type {HTMLElement} */ (el.toggle.querySelector('[data-icon-play]')).hidden = playing;
    /** @type {HTMLElement} */ (el.toggle.querySelector('[data-icon-pause]')).hidden = !playing;
    html.dataset.playerState = playing ? 'playing' : 'paused';
    markCards();
    paintQueue();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new window.MediaMetadata({ title: t.track, artist: t.artist,
        album: document.title.split(' · ').pop(), artwork: t.thumbnail ? [{ src: t.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : [] });
    }
  }
  function hide() {
    bar.hidden = true;
    el.panel.hidden = true;
    setQueueOpen(false);
    document.body.classList.remove('has-player');
    html.dataset.playerState = '';
    html.dataset.playerViewState = '';
    markCards();
  }
  /** @param {string} cls @param {string} [text] */
  function span(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    if (text !== undefined) s.textContent = text;
    return s;
  }
  var ICON = {
    up: 'M5 15l7-7 7 7',
    down: 'M19 9l-7 7-7-7',
    remove: 'M6 18 18 6M6 6l12 12',
  };
  function iconButton(kind, i, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-600 dark:hover:text-white';
    b.setAttribute('data-player-' + kind, String(i));
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = '<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + ICON[kind] + '"/></svg>';
    return b;
  }
  /** @param {string} text */
  function heading(text) {
    var li = document.createElement('li');
    li.className = 'px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
    li.textContent = text;
    return li;
  }
  function row(t, i, kind) {
    var li = document.createElement('li');
    li.className = 'flex items-center gap-1 rounded-lg px-2 py-1.5'
      + (kind === 'now' ? ' bg-primary-50 dark:bg-gray-700' : '') + (kind === 'played' ? ' opacity-60' : '');
    li.dataset.queueRow = kind;
    li.dataset.source = keyOf(t);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'flex min-w-0 flex-1 items-center gap-3 rounded text-left focus:outline-none focus:ring-2 focus:ring-primary-300';
    b.dataset.playerJump = String(i);
    b.setAttribute('aria-label', Sonic.t('player.jump', { track: t.track }));
    var img = document.createElement('img');
    img.src = t.thumbnail; img.alt = ''; img.width = 64; img.height = 36; img.loading = 'lazy';
    img.className = 'h-9 w-16 shrink-0 rounded object-cover';
    var text = span('min-w-0');
    text.append(span('block truncate text-sm font-medium text-gray-900 dark:text-white', t.track),
      span('block truncate text-xs text-gray-500 dark:text-gray-400', t.artist));
    b.append(img, text);
    li.append(b);
    if (kind === 'next') {
      var up = iconButton('up', i, Sonic.t('player.move_up', { track: t.track }));
      var down = iconButton('down', i, Sonic.t('player.move_down', { track: t.track }));
      up.disabled = i === state.index + 1;
      down.disabled = i === state.queue.length - 1;
      li.append(up, down);
    }
    if (kind !== 'now') li.append(iconButton('remove', i, Sonic.t('player.remove', { track: t.track })));
    return li;
  }
  function paintQueue() {
    var list = el.queueList;
    list.replaceChildren();
    var t = current();
    if (!t) return;
    list.append(heading(Sonic.t('player.now')), row(t, state.index, 'now'));
    list.append(heading(Sonic.t('player.up_next', { n: String(upcoming()) })));
    if (!upcoming()) {
      var empty = document.createElement('li');
      empty.className = 'px-2 py-2 text-sm text-gray-500 dark:text-gray-400';
      empty.dataset.queueEmpty = '';
      empty.textContent = Sonic.t('player.up_next_empty');
      list.append(empty);
    }
    for (var i = state.index + 1; i < state.queue.length; i++) list.append(row(state.queue[i], i, 'next'));
    if (state.index > 0) {
      list.append(heading(Sonic.t('player.played', { n: String(state.index) })));
      for (var j = state.index - 1; j >= 0; j--) list.append(row(state.queue[j], j, 'played'));
    }
    el.shuffle.disabled = upcoming() < 2;
    el.clear.disabled = state.queue.length < 2;
  }
  // Cards of the page that hold the current track get a ring and a "playing" badge; queue
  // toggles show whether their track is waiting in the queue.
  function markCards() {
    var t = current();
    var now = t ? keyOf(t) : '';
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-track]')).forEach(function (card) {
      card.toggleAttribute('data-now-playing', !!now && card.dataset.source === now);
    });
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-queue]')).forEach(function (b) {
      var at = indexOf(b.dataset.queue);
      b.setAttribute('aria-pressed', String(at > state.index));
    });
  }

  // --- YouTube. ------------------------------------------------------------------------------
  function api() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise(/** @param {(v?: unknown) => void} resolve */ function (resolve, reject) {
      var previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (previous) previous(); resolve(); };
      Sonic.script('https://www.youtube.com/iframe_api').catch(reject);
    });
  }
  function load(autoplay) {
    var t = current();
    if (!t) return;
    ended = false;
    started = true;
    paint();
    api().then(function () {
      if (!yt) {
        // The frame is built here, not by the API: the API's own `allow` list names features
        // (web-share) that some browsers do not know and warn about in the console
        // (knowledge console-clean-by-construction). The API then attaches to this frame.
        var frame = document.createElement('iframe');
        var params = new URLSearchParams({ enablejsapi: '1', autoplay: autoplay ? '1' : '0', rel: '0',
          playsinline: '1', start: String(Math.floor(pendingStart)), origin: location.origin });
        frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(t.youtube) + '?' + params;
        frame.title = 'YouTube video player';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.className = 'h-full w-full';
        frame.id = 'player-video';
        el.video.replaceWith(frame);
        el.video = frame;
        yt = new window.YT.Player(frame, {
          events: {
            onReady: function () { ready = true; if (autoplay) yt.playVideo(); paint(); },
            onStateChange: function (e) {
              if (e.data === 1) errorStreak = 0;
              if (e.data === 0) advance(true); // ended
              paint();
            },
            // Removed, private or not embeddable: skip it, but never loop over a dead queue.
            onError: function () { errorStreak += 1; if (errorStreak < state.queue.length) advance(false); },
          },
        });
      } else if (ready) {
        if (autoplay) yt.loadVideoById({ videoId: t.youtube, startSeconds: pendingStart });
        else yt.cueVideoById({ videoId: t.youtube, startSeconds: pendingStart });
      }
      pendingStart = 0;
      if (!ticker) ticker = setInterval(tick, 500);
    }).catch(function () {
      // The API could not load (offline, blocked): open the video on YouTube instead.
      window.open('https://www.youtube.com/watch?v=' + t.youtube, '_blank', 'noopener');
    });
  }
  function tick() {
    if (!yt || !ready || !yt.getCurrentTime) return;
    var time = yt.getCurrentTime() || 0;
    var duration = yt.getDuration() || 0;
    // The state can change without an event (an ad, buffering): keep the toggle honest.
    var playing = yt.getPlayerState && yt.getPlayerState() === 1;
    if ((html.dataset.playerState === 'playing') !== playing) paint();
    el.time.textContent = fmt(time);
    el.duration.textContent = fmt(duration);
    if (document.activeElement !== el.seek) {
      el.seek.max = String(Math.floor(duration));
      el.seek.value = String(Math.floor(time));
    }
    if (Math.abs(time - state.time) >= 5) { state.time = time; save(); }
  }

  // --- Commands. -----------------------------------------------------------------------------
  function jump(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    state.time = 0;
    save();
    load(true);
  }
  // Take entry i out of the queue, keeping the current track where it is.
  function take(i) {
    var gone = state.queue.splice(i, 1)[0];
    if (i < state.index) state.index -= 1;
    return gone;
  }
  /** Play one track now; whatever was queued after the current track stays queued. */
  function playNow(t) {
    if (!t || !t.youtube) return;
    var at = indexOf(keyOf(t));
    if (at >= 0 && at === state.index) { if (!yt || !ready || yt.getPlayerState() !== 1) toggle(); return; }
    if (at >= 0) take(at);
    var pos = state.queue.length ? state.index + 1 : 0;
    state.queue.splice(pos, 0, item(t));
    jump(pos);
  }
  /** Play a track right after the current one (moved there when it is already queued). */
  function playNext(t) {
    if (!t || !t.youtube) return;
    var at = indexOf(keyOf(t));
    if (at >= 0 && at === state.index) return;
    if (at >= 0) take(at);
    if (!state.queue.length) { playNow(t); return; }
    state.queue.splice(state.index + 1, 0, item(t));
    save(); paint();
    toast(Sonic.t('player.toast_next', { track: t.track }));
    if (ended) jump(state.index + 1);
  }
  /** Toggle a track in the queue: add it at the end, or take it out when it is waiting there. */
  function toggleQueued(t) {
    if (!t || !t.youtube) return;
    var at = indexOf(keyOf(t));
    if (at >= 0 && at > state.index) {
      take(at); save(); paint();
      toast(Sonic.t('player.toast_removed', { track: t.track }));
      return;
    }
    if (at >= 0 && at === state.index) { toast(Sonic.t('player.toast_playing', { track: t.track })); return; }
    if (at >= 0) take(at); // played before: queue it again at the end
    state.queue.push(item(t));
    toast(Sonic.t('player.toast_added', { track: t.track }));
    if (state.index < 0) { jump(0); return; }
    if (ended) { jump(state.queue.length - 1); return; }
    save(); paint();
  }
  /** Replace the queue (Play all, Radio): an explicit, labelled choice. */
  function playList(tracks, start) {
    var seen = {};
    var list = [];
    tracks.forEach(function (t) {
      if (t && t.youtube && !seen[keyOf(t)]) { seen[keyOf(t)] = true; list.push(item(t)); }
    });
    if (!list.length) return;
    state.queue = list;
    state.time = 0;
    toast(Sonic.t('player.toast_list', { n: String(list.length) }));
    jump(Math.max(0, Math.min(start || 0, list.length - 1)));
  }
  function remove(i) {
    if (i < 0 || i >= state.queue.length) return;
    var wasCurrent = i === state.index;
    take(i);
    if (!state.queue.length) { stop(); return; }
    if (wasCurrent) { state.index = Math.min(state.index, state.queue.length - 1); load(true); }
    save(); paint();
  }
  function move(i, by) {
    var j = i + by;
    if (i <= state.index || j <= state.index || j >= state.queue.length) return;
    var t = state.queue[i];
    state.queue[i] = state.queue[j];
    state.queue[j] = t;
    save(); paint();
  }
  /** Flush the queue: everything but the current track goes. */
  function clear() {
    var t = current();
    if (!t) return;
    state.queue = [t];
    state.index = 0;
    save(); paint();
    toast(Sonic.t('player.toast_cleared'));
  }
  function shuffle() {
    for (var i = state.queue.length - 1; i > state.index + 1; i--) {
      var j = state.index + 1 + Math.floor(Math.random() * (i - state.index));
      var t = state.queue[i];
      state.queue[i] = state.queue[j];
      state.queue[j] = t;
    }
    save(); paint();
    toast(Sonic.t('player.toast_shuffled'));
  }
  // After a track: repeat one plays it again; past the end, repeat all starts over, else it stops.
  function advance(finished) {
    if (finished && state.repeat === 'one') { jump(state.index); return; }
    if (state.index < state.queue.length - 1) jump(state.index + 1);
    else if (state.repeat === 'all' && state.queue.length) jump(0);
    else { ended = true; paint(); }
  }
  function next() { advance(false); }
  function prev() {
    if (yt && ready && yt.getCurrentTime && yt.getCurrentTime() > 3) { yt.seekTo(0, true); return; }
    if (state.index > 0) jump(state.index - 1);
    else if (yt && ready) yt.seekTo(0, true);
  }
  function toggle() {
    if (!current()) return;
    if (!yt || !ready) { pendingStart = state.time || 0; load(true); return; }
    if (ended) { jump(state.index); return; }
    if (yt.getPlayerState() === 1) yt.pauseVideo(); else yt.playVideo();
  }
  function cycleRepeat() {
    state.repeat = REPEAT[(REPEAT.indexOf(state.repeat) + 1) % REPEAT.length];
    save(); paint();
    toast(repeatLabel());
  }
  function setView(view) {
    state.view = view;
    if (view === 'mini') setQueueOpen(false);
    save(); paint();
    (view === 'mini' ? el.expand : el.minimise).focus();
  }
  function setVideo(size) { state.video = size; save(); paint(); }
  function setQueueOpen(open) {
    el.queuePanel.hidden = !open;
    el.queueButton.setAttribute('aria-expanded', String(open));
    html.dataset.playerQueueState = open ? 'open' : '';
  }
  function stop() {
    if (yt && ready) yt.stopVideo();
    state.queue = [];
    state.index = -1;
    state.time = 0;
    save();
    hide();
  }

  // The tracks a container shows, in the order shown, skipping hidden ones.
  function listOf(container) {
    return Array.prototype.slice.call(container.querySelectorAll('[data-track]'))
      .filter(function (card) { return !card.hidden; })
      .map(function (card) { return card.dataset.source; });
  }

  document.addEventListener('click', function (event) {
    var origin = /** @type {Element} */ (event.target);
    var target = /** @type {HTMLElement | null} */ (origin.closest && origin.closest(
      '[data-play],[data-play-next],[data-queue],[data-play-radio],[data-play-all],[data-play-video],'
      + '[data-player-jump],[data-player-remove],[data-player-up],[data-player-down]'));
    if (!target) return;
    event.preventDefault();
    var d = target.dataset;
    if (d.playerJump) { jump(Number(d.playerJump)); return; }
    if (d.playerRemove) { remove(Number(d.playerRemove)); return; }
    if (d.playerUp) { move(Number(d.playerUp), -1); return; }
    if (d.playerDown) { move(Number(d.playerDown), 1); return; }
    if (d.playVideo) {
      playNow({ youtube: d.playVideo, track: d.playTitle || Sonic.t('player.video'), artist: '' });
      return;
    }
    Sonic.catalog().then(function (c) {
      var bySource = {};
      c.tracks.forEach(function (t) { bySource[t.source] = t; });
      if (d.play) { playNow(bySource[d.play]); return; }
      if (d.playNext) { playNext(bySource[d.playNext]); return; }
      if (d.queue) { toggleQueued(bySource[d.queue]); return; }
      if (d.playRadio) {
        var seed = bySource[d.playRadio];
        var order = [seed.source];
        seed.related.forEach(function (r) { if (order.indexOf(r.source) < 0) order.push(r.source); });
        seed.related.forEach(function (r) {
          bySource[r.source].related.forEach(function (r2) { if (order.indexOf(r2.source) < 0) order.push(r2.source); });
        });
        playList(order.map(function (s) { return bySource[s]; }), 0);
        return;
      }
      if (d.playAll) {
        var box = document.getElementById(d.playAll);
        if (box) playList(listOf(box).map(function (s) { return bySource[s]; }), 0);
      }
    });
  });

  el.toggle.addEventListener('click', toggle);
  el.next.addEventListener('click', next);
  el.prev.addEventListener('click', prev);
  el.repeat.addEventListener('click', cycleRepeat);
  el.shuffle.addEventListener('click', shuffle);
  el.clear.addEventListener('click', clear);
  el.size.addEventListener('click', function () { setVideo(state.video === 'small' ? 'large' : 'small'); });
  el.minimise.addEventListener('click', function () { setView('mini'); });
  el.expand.addEventListener('click', function () { setView('full'); });
  el.close.addEventListener('click', stop);
  el.queueButton.addEventListener('click', function () { setQueueOpen(el.queuePanel.hidden); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.queuePanel.hidden) { setQueueOpen(false); el.queueButton.focus(); }
  });
  el.seek.addEventListener('change', function () {
    if (yt && ready) yt.seekTo(Number(el.seek.value), true);
  });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('nexttrack', next);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('play', toggle);
      navigator.mediaSession.setActionHandler('pause', toggle);
    } catch (e) {}
  }
  // A new page: mark its cards. A reload with a saved queue: show the bar, paused (no third-party
  // request until the reader presses play).
  Sonic.on('sonic:page', markCards);
  Sonic.on('sonic:navigated', markCards);
  Sonic.on('sonic:locale', function () { if (current()) paint(); });
  if (current()) { pendingStart = state.time || 0; paint(); }
  window.SonicPlayer = { playNow: playNow, playNext: playNext, toggleQueued: toggleQueued, playList: playList,
    remove: remove, move: move, clear: clear, shuffle: shuffle, next: next, prev: prev, toggle: toggle,
    stop: stop, jump: jump,
    state: function () { return JSON.parse(JSON.stringify(state)); } };
})();
