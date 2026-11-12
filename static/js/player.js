// The player in the bottom bar. It lives outside #main-content, so the router (router.js) swaps
// pages around it and the music keeps playing. Playlists are derived from where play is pressed:
//
//   [data-play="<source>"]              play this track, then the rest of its [data-playlist]
//                                       container in the order shown (the explorer's filter and
//                                       sort, a genre page, an archive month, related tracks)
//   [data-play-radio="<source>"]        this track, then its related tracks and theirs
//   [data-play-all="<container id>"]    every visible track of that container, from the first
//   [data-queue="<source>"]             append to the queue
//   [data-play-video="<id>"]            a video that is not a catalogue track (inside a review)
//
// The queue, the position and the time are kept in localStorage, so a full reload offers to
// resume. The YouTube IFrame API (youtube-nocookie host) is loaded only when something plays;
// the video stays visible while it plays, as YouTube's terms require.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var bar = document.getElementById('player');
  if (!Sonic || !bar) return;
  var KEY = 'sonic-player';
  var $ = function (sel) { return bar.querySelector(sel); };
  var el = {
    video: document.getElementById('player-video'),
    panel: document.getElementById('player-panel'),
    title: $('[data-player-title]'),
    artist: $('[data-player-artist]'),
    thumb: $('[data-player-thumb]'),
    toggle: $('[data-player-toggle]'),
    prev: $('[data-player-prev]'),
    next: $('[data-player-next]'),
    seek: $('[data-player-seek]'),
    time: $('[data-player-time]'),
    duration: $('[data-player-duration]'),
    queueButton: $('[data-player-queue]'),
    queueCount: $('[data-player-count]'),
    queuePanel: document.getElementById('player-queue'),
    queueList: document.querySelector('[data-player-list]'),
    exportLink: document.querySelector('[data-player-export]'),
    close: $('[data-player-close]'),
  };
  var state = { queue: [], index: -1, time: 0 };
  var yt = null;
  var ready = false;
  var ticker = null;
  var pendingStart = 0;

  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function current() { return state.queue[state.index] || null; }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function item(t) {
    return { source: t.source || '', path: t.path || '', artist: t.artist || '', track: t.track || t.title || '',
      youtube: t.youtube, thumbnail: t.youtube ? 'https://i.ytimg.com/vi/' + t.youtube + '/mqdefault.jpg' : '' };
  }

  // --- The bar. ------------------------------------------------------------------------------
  function show() {
    bar.hidden = false;
    document.body.classList.add('has-player');
  }
  function paint() {
    var t = current();
    if (!t) return;
    show();
    el.title.textContent = t.track;
    el.title.href = t.path ? Sonic.base + '/' + t.path : 'https://www.youtube.com/watch?v=' + t.youtube;
    el.artist.textContent = t.artist;
    el.thumb.src = t.thumbnail;
    el.thumb.alt = '';
    el.prev.disabled = state.index <= 0;
    el.next.disabled = state.index >= state.queue.length - 1;
    el.queueCount.textContent = String(state.queue.length);
    // The queue from the current track as an ad-hoc YouTube playlist (at most 50 videos): the
    // YouTube app keeps playing it when the phone locks, which no embedded player may do.
    el.exportLink.href = 'https://www.youtube.com/watch_videos?video_ids=' + state.queue
      .slice(state.index, state.index + 50).map(function (q) { return q.youtube; }).join(',');
    var playing = yt && ready && yt.getPlayerState && yt.getPlayerState() === 1;
    el.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    el.toggle.querySelector('[data-icon-play]').hidden = playing;
    el.toggle.querySelector('[data-icon-pause]').hidden = !playing;
    document.documentElement.dataset.player = playing ? 'playing' : 'paused';
    markCards();
    paintQueue();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new window.MediaMetadata({ title: t.track, artist: t.artist,
        album: document.title.split(' · ').pop(), artwork: t.thumbnail ? [{ src: t.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : [] });
    }
  }
  function paintQueue() {
    el.queueList.replaceChildren();
    state.queue.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'flex items-center gap-3 rounded-lg px-2 py-2' + (i === state.index ? ' bg-primary-50 dark:bg-gray-700' : '');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'flex min-w-0 flex-1 items-center gap-3 text-left';
      b.dataset.playerJump = String(i);
      var img = document.createElement('img');
      img.src = t.thumbnail; img.alt = ''; img.width = 64; img.height = 36; img.loading = 'lazy';
      img.className = 'h-9 w-16 shrink-0 rounded object-cover';
      var text = document.createElement('span');
      text.className = 'min-w-0';
      text.innerHTML = '<span class="block truncate text-sm font-medium text-gray-900 dark:text-white"></span>'
        + '<span class="block truncate text-xs text-gray-500 dark:text-gray-400"></span>';
      text.children[0].textContent = t.track;
      text.children[1].textContent = t.artist;
      b.append(img, text);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-600 dark:hover:text-white';
      rm.dataset.playerRemove = String(i);
      rm.setAttribute('aria-label', 'Remove ' + t.track + ' from the queue');
      rm.innerHTML = '<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>';
      li.append(b, rm);
      el.queueList.appendChild(li);
    });
  }
  // Cards of the page that hold the current track get a ring and an "playing" badge.
  function markCards() {
    var t = current();
    document.querySelectorAll('[data-track]').forEach(function (card) {
      card.toggleAttribute('data-now-playing', !!t && card.dataset.source === t.source);
    });
  }

  // --- YouTube. ------------------------------------------------------------------------------
  function api() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (previous) previous(); resolve(); };
      Sonic.script('https://www.youtube.com/iframe_api').catch(reject);
    });
  }
  function load(autoplay) {
    var t = current();
    if (!t) return;
    paint();
    el.panel.hidden = false;
    api().then(function () {
      if (!yt) {
        yt = new window.YT.Player(el.video, {
          host: 'https://www.youtube-nocookie.com',
          videoId: t.youtube,
          playerVars: { autoplay: autoplay ? 1 : 0, rel: 0, playsinline: 1, start: Math.floor(pendingStart) },
          events: {
            onReady: function () { ready = true; if (autoplay) yt.playVideo(); paint(); },
            onStateChange: function (e) {
              if (e.data === 0) next(); // ended
              paint();
            },
            onError: function () { next(); }, // removed, private or not embeddable: skip it
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
    if ((document.documentElement.dataset.player === 'playing') !== playing) paint();
    el.time.textContent = fmt(time);
    el.duration.textContent = fmt(duration);
    if (document.activeElement !== el.seek) {
      el.seek.max = String(Math.floor(duration));
      el.seek.value = String(Math.floor(time));
    }
    if (Math.abs(time - state.time) >= 5) { state.time = time; save(); }
  }

  // --- Commands. -----------------------------------------------------------------------------
  function play(tracks, start) {
    state.queue = tracks.filter(function (t) { return t && t.youtube; }).map(item);
    state.index = Math.max(0, Math.min(start || 0, state.queue.length - 1));
    state.time = 0;
    save();
    if (state.queue.length) load(true);
  }
  function enqueue(t) {
    if (!t || !t.youtube) return;
    state.queue.push(item(t));
    if (state.index < 0) state.index = 0;
    save();
    paint();
    if (state.queue.length === 1) load(true);
  }
  function jump(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    state.time = 0;
    save();
    load(true);
  }
  function next() { if (state.index < state.queue.length - 1) jump(state.index + 1); else paint(); }
  function prev() { if (state.index > 0) jump(state.index - 1); }
  function toggle() {
    if (!yt || !ready) { pendingStart = state.time || 0; load(true); return; }
    if (yt.getPlayerState() === 1) yt.pauseVideo(); else yt.playVideo();
  }
  function stop() {
    if (yt && ready) yt.stopVideo();
    state = { queue: [], index: -1, time: 0 };
    save();
    bar.hidden = true;
    el.panel.hidden = true;
    el.queuePanel.hidden = true;
    document.body.classList.remove('has-player');
    document.documentElement.dataset.player = '';
    markCards();
  }

  // The tracks a [data-playlist] container shows, in the order shown, skipping hidden ones.
  function listOf(container) {
    return Array.prototype.slice.call(container.querySelectorAll('[data-track]'))
      .filter(function (card) { return !card.hidden && card.offsetParent !== null; })
      .map(function (card) { return card.dataset.source; });
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest && event.target.closest(
      '[data-play],[data-play-radio],[data-play-all],[data-queue],[data-play-video],[data-player-jump],[data-player-remove]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.playerJump) { jump(Number(target.dataset.playerJump)); return; }
    if (target.dataset.playerRemove) {
      var i = Number(target.dataset.playerRemove);
      state.queue.splice(i, 1);
      if (i < state.index) state.index -= 1;
      if (!state.queue.length) { stop(); return; }
      if (i === state.index) { state.index = Math.min(state.index, state.queue.length - 1); load(true); }
      save(); paint();
      return;
    }
    if (target.dataset.playVideo) {
      play([{ youtube: target.dataset.playVideo, track: target.dataset.playTitle || 'Video', artist: '' }], 0);
      return;
    }
    Sonic.catalog().then(function (c) {
      var bySource = {};
      c.tracks.forEach(function (t) { bySource[t.source] = t; });
      if (target.dataset.queue) { enqueue(bySource[target.dataset.queue]); return; }
      if (target.dataset.playRadio) {
        var seed = bySource[target.dataset.playRadio];
        var order = [seed.source];
        seed.related.forEach(function (r) { if (order.indexOf(r.source) < 0) order.push(r.source); });
        seed.related.forEach(function (r) {
          bySource[r.source].related.forEach(function (r2) { if (order.indexOf(r2.source) < 0) order.push(r2.source); });
        });
        play(order.map(function (s) { return bySource[s]; }), 0);
        return;
      }
      if (target.dataset.playAll) {
        var box = document.getElementById(target.dataset.playAll);
        if (box) play(listOf(box).map(function (s) { return bySource[s]; }), 0);
        return;
      }
      var container = target.closest('[data-playlist]');
      var sources = container ? listOf(container) : [target.dataset.play];
      var start = Math.max(0, sources.indexOf(target.dataset.play));
      play(sources.map(function (s) { return bySource[s]; }), start);
    });
  });

  el.toggle.addEventListener('click', toggle);
  el.next.addEventListener('click', next);
  el.prev.addEventListener('click', prev);
  el.close.addEventListener('click', stop);
  el.queueButton.addEventListener('click', function () {
    el.queuePanel.hidden = !el.queuePanel.hidden;
    el.queueButton.setAttribute('aria-expanded', String(!el.queuePanel.hidden));
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
  if (current()) { pendingStart = state.time || 0; paint(); }
  window.SonicPlayer = { play: play, enqueue: enqueue, next: next, prev: prev, toggle: toggle, stop: stop,
    state: function () { return JSON.parse(JSON.stringify(state)); } };
})();
