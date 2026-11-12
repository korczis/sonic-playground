// Shell behaviour of the Flowbite Pro layout: theme toggle (Pro dark-mode contract), the mobile
// drawer's backdrop and accessibility state, the privacy-friendly video player, the "/" search
// shortcut and the random-track button over the derived catalogue. No track is named here.
(function () {
  'use strict';
  var root = document.documentElement;
  var body = document.body;

  // --- Theme: flip the class and remember the choice. ----------------------------------------
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var dark = !root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      try { localStorage.setItem('color-theme', dark ? 'dark' : 'light'); } catch (e) {}
      document.dispatchEvent(new Event('dark-mode'));
    });
  }

  // --- Mobile drawer: Flowbite's default backdrop (z-30) would cover the Pro sidebar (z-20)
  // and swallow every tap inside it; the Pro shell stacks nav z-30 > sidebar z-20 > backdrop
  // z-10. A closed drawer is inert on mobile; aria-expanded follows it. ----------------------
  var DRAWER_BACKDROP = 'fixed inset-0 z-10 bg-gray-900/50 dark:bg-gray-900/90';
  var sidebar = document.getElementById('sidebar');
  var sidebarToggle = document.getElementById('toggleSidebarMobile');
  var desktop = window.matchMedia('(min-width: 1024px)');
  var drawer = null;
  function syncSidebar() {
    if (!sidebar) return;
    if (desktop.matches) {
      if (drawer && drawer.isVisible && drawer.isVisible()) drawer.hide();
      sidebar.removeAttribute('aria-hidden');
      sidebar.removeAttribute('inert');
      var shell = document.getElementById('main-content');
      if (shell) shell.removeAttribute('inert');
      return;
    }
    var closed = sidebar.classList.contains('-translate-x-full');
    var main = document.getElementById('main-content');
    if (closed) {
      sidebar.setAttribute('aria-hidden', 'true');
      sidebar.setAttribute('inert', '');
      if (main) main.removeAttribute('inert');
      // Focus returns to the toggle that opened the drawer.
      if (sidebar.contains(document.activeElement) && sidebarToggle) sidebarToggle.focus();
    } else {
      sidebar.removeAttribute('aria-hidden');
      sidebar.removeAttribute('inert');
      // An open drawer is modal: the page behind it is inert, focus moves into the drawer.
      if (main) main.setAttribute('inert', '');
      if (!sidebar.contains(document.activeElement)) {
        var first = sidebar.querySelector('a[href], input, button');
        if (first) first.focus();
      }
    }
    if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawer && !desktop.matches && drawer.isVisible && drawer.isVisible()) {
      drawer.hide();
    }
  });
  window.addEventListener('load', function () {
    var registry = window.FlowbiteInstances;
    drawer = registry && registry.getInstance && registry.getInstance('Drawer', 'sidebar');
    if (drawer && drawer._options) drawer._options.backdropClasses = DRAWER_BACKDROP;
    syncSidebar();
  });
  if (sidebar) {
    new MutationObserver(syncSidebar)
      .observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    desktop.addEventListener('change', syncSidebar);
    syncSidebar();
  }

  // Videos play in the bottom-bar player (static/js/player.js), never inline: the still's link
  // carries data-play-radio / data-play-video. The router closes the mobile drawer on navigation.
  if (window.Sonic) {
    window.Sonic.on('sonic:navigated', function () {
      if (drawer && !desktop.matches && drawer.isVisible && drawer.isVisible()) drawer.hide();
      syncSidebar();
    });
  }

  // --- Thumbnails: a still that fails (a video removed from YouTube) becomes the placeholder
  // tile instead of a broken image; the catalogue keeps the id, scripts/probe-videos.py names it.
  function fallback(img) {
    if (img.dataset.thumbFailed) return;
    img.dataset.thumbFailed = 'true';
    img.removeAttribute('src');
    img.alt = '';
    img.classList.add('invisible');
    var box = img.parentElement;
    if (box) box.classList.add('bg-gradient-to-br', 'from-primary-200', 'to-pink-200',
      'dark:from-primary-900', 'dark:to-gray-800');
  }
  document.addEventListener('error', function (event) {
    var el = event.target;
    if (el && el.tagName === 'IMG' && el.hasAttribute('data-thumb')) fallback(el);
  }, true);
  function checkThumbs() {
    document.querySelectorAll('img[data-thumb]').forEach(function (img) {
      if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fallback(img);
    });
  }
  checkThumbs();
  if (window.Sonic) window.Sonic.on('sonic:page', checkThumbs);

  // --- Copy link (the share row): the clipboard, then a check mark for two seconds. ---------
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('[data-copy-link]');
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.getAttribute('data-copy-link')).then(function () {
      var idle = button.querySelector('[data-copy-idle]');
      var done = button.querySelector('[data-copy-done]');
      var label = button.querySelector('[data-copy-label]');
      if (idle) idle.hidden = true;
      if (done) done.hidden = false;
      if (label) label.textContent = window.Sonic ? window.Sonic.t('share.copied') : '';
      setTimeout(function () {
        if (idle) idle.hidden = false;
        if (done) done.hidden = true;
        if (label) label.textContent = window.Sonic ? window.Sonic.t('share.copy') : '';
      }, 2000);
    }).catch(function () {});
  });

  // --- "/" focuses the visible search field. -------------------------------------------------
  document.addEventListener('keydown', function (event) {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    var fields = document.querySelectorAll('#explorer-q, [data-search-input]');
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].offsetParent !== null) {
        event.preventDefault();
        fields[i].focus();
        return;
      }
    }
  });

  // --- Random track: pick from the derived catalogue, open it without stopping the player. ---
  var random = document.querySelector('[data-random-track]');
  if (random && window.Sonic) {
    random.disabled = false;
    random.classList.remove('hidden');
    random.addEventListener('click', function () {
      random.disabled = true;
      window.Sonic.catalog().then(function (c) {
        random.disabled = false;
        var here = window.location.pathname;
        var pick;
        do {
          pick = c.tracks[Math.floor(Math.random() * c.tracks.length)];
        } while (c.tracks.length > 1 && here.endsWith('/' + pick.path));
        var url = window.Sonic.base + '/' + pick.path;
        if (window.SonicRouter) window.SonicRouter.go(url); else window.location.href = url;
      }).catch(function () { random.disabled = false; });
    });
  }
})();
