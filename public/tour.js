/* NZ Masjid Finder — first-run walkthrough.
 *
 * A short coach-mark tour over the real interface: the card explains, the
 * spotlight points at the element it is talking about. It runs once (the flag
 * is a localStorage key), never blocks the app, and can be replayed from the
 * "How it works" link in the search panel.
 *
 * Nothing here touches data or the network: it is presentation only, so a
 * failed script cannot stop the directory from loading.
 */
(() => {
  'use strict';

  const KEY = 'nzmasjidfinder.tour';
  const STEPS = [
    {
      title: 'Kia ora — a quick look around',
      body: 'Seven short steps, about thirty seconds. You can leave at any point and ' +
        'start again from “How it works”.',
    },
    {
      target: '.searchrow',
      title: 'Find a masjid',
      body: 'Search by name, suburb or postcode, then narrow by region and type. ' +
        '“Verified only” hides the listings nobody has checked yet.',
    },
    {
      target: '.mapwrap',
      title: 'Reading the map',
      body: 'A bubble counts the masjids in an area — tap it to zoom in until ' +
        'individual pins appear.',
    },
    {
      target: '#mList .card',
      fallback: '#mList',
      title: 'What a listing tells you',
      body: 'Directions, phone and website — plus the Jumu’ah time once a person ' +
        'has confirmed it. “Confirm details” is how a listing earns its tick.',
    },
    {
      // The tour drives the real tab bar, so the next step can show the
      // Prayer screen itself instead of describing it. The `.next` row is the
      // prayer still to come; the whole list stands in when the day is done.
      tab: 'prayer',
      target: '#pTimes li.next',
      fallback: '#pTimes',
      title: 'Prayer times',
      body: 'The next prayer and the whole day, calculated for your coordinates — ' +
        'the row in green is the one coming up. It still works with no signal, and ' +
        'the calculation method can be matched to your masjid.',
    },
    {
      // Stays on Prayer on purpose: the active tab is part of what it points at.
      target: '.tabbar',
      title: 'Four more tabs',
      body: 'Prayer sits alongside Masjids, the halal directory, the Ramadan ' +
        'calendar and the qibla compass — one tap each.',
    },
    {
      title: 'Keep it on your phone',
      body: 'Share → Add to Home Screen turns it into an app that opens full screen, ' +
        'keeps the listings offline and puts prayer times one tap away.',
    },
  ];

  let index = 0;
  let root, card, hole, shade, titleEl, bodyEl, dotsEl, nextBtn, backBtn;
  let lastFocus = null;
  let running = false;
  let startTab = 'map';   // where the visitor was before the tour moved them
  let tabTimer = 0;

  const seen = () => {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  };
  const remember = () => {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* private mode: show it again */ }
  };
  const tabOf = (name) => document.querySelector('.tab[data-tab="' + name + '"]');
  const currentTab = () => {
    const on = document.querySelector('.tab.active');
    return (on && on.dataset && on.dataset.tab) || 'map';
  };

  // Drive the app's own switcher, so the view, the hash and the tab's active
  // state all follow the tour as they would for a real tap.
  function goTab(name) {
    if (window.NZApp && typeof window.NZApp.showTab === 'function') {
      window.NZApp.showTab(name);
      return;
    }
    const btn = tabOf(name);
    if (btn && btn.click) btn.click();
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function build() {
    root = el('div', 'tour-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tourTitle');
    root.setAttribute('aria-describedby', 'tourBody');

    shade = el('div', 'tour-shade');
    hole = el('div', 'tour-hole');
    hole.hidden = true;

    card = el('div', 'tour-card');
    titleEl = el('h2', null, '');
    titleEl.id = 'tourTitle';
    bodyEl = el('p', null, '');
    bodyEl.id = 'tourBody';
    dotsEl = el('div', 'tour-dots');
    backBtn = el('button', 'tour-btn ghost', 'Back');
    backBtn.type = 'button';
    nextBtn = el('button', 'tour-btn primary', 'Next');
    nextBtn.type = 'button';
    const skip = el('button', 'tour-btn ghost', 'Skip tour');
    skip.type = 'button';

    const foot = el('div', 'tour-foot');
    foot.appendChild(dotsEl);
    foot.appendChild(skip);
    foot.appendChild(backBtn);
    foot.appendChild(nextBtn);
    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(foot);

    root.appendChild(shade);
    root.appendChild(hole);
    root.appendChild(card);
    document.body.appendChild(root);

    backBtn.addEventListener('click', () => go(index - 1));
    nextBtn.addEventListener('click', () => go(index + 1));
    skip.addEventListener('click', () => finish());
    shade.addEventListener('click', () => finish());
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  }

  function onKey(e) {
    if (!running) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); return; }
    if (e.key === 'Tab') {
      // Keep focus inside the card while it is modal.
      const focusables = Array.from(card.querySelectorAll('.tour-btn')).filter((b) => !b.hidden && b.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function targetFor(step) {
    const bySelector = (sel) => (sel ? document.querySelector(sel) : null);
    return bySelector(step.target) || bySelector(step.fallback);
  }

  function place() {
    if (!running) return;
    const step = STEPS[index];
    const target = targetFor(step);
    if (!target) {
      hole.hidden = true;
      shade.hidden = false;
      card.style.left = Math.max(12, (window.innerWidth - card.offsetWidth) / 2) + 'px';
      card.style.top = Math.max(12, (window.innerHeight - card.offsetHeight) / 2) + 'px';
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.hidden = false;
    shade.hidden = true;
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';

    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 14;
    const below = r.bottom + gap;
    const above = r.top - ch - gap;
    let top = below + ch < window.innerHeight - 12 ? below : above;
    if (top < 12) top = Math.min(window.innerHeight - ch - 12, below);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), window.innerWidth - cw - 12);
    card.style.left = left + 'px';
    card.style.top = Math.max(12, top) + 'px';
  }

  function go(next) {
    if (next < 0 || next >= STEPS.length) { finish(); return; }
    index = next;
    const step = STEPS[index];
    if (step.tab && currentTab() !== step.tab) goTab(step.tab);
    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    backBtn.hidden = index === 0;
    nextBtn.textContent = index === STEPS.length - 1 ? 'Done' : 'Next';
    dotsEl.innerHTML = STEPS.map((s, n) => '<span' + (n === index ? ' class="on"' : '') +
      ' aria-hidden="true"></span>').join('');
    dotsEl.setAttribute('aria-label', 'Step ' + (index + 1) + ' of ' + STEPS.length);

    const target = targetFor(step);
    if (target && target.scrollIntoView) {
      const r = target.getBoundingClientRect();
      if (r.top < 8 || r.bottom > window.innerHeight - 8) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    place();
    nextBtn.focus({ preventScroll: true });
    // A freshly shown view can fill in after it is switched to (prayer times
    // arrive a moment later), so re-measure once the layout has settled.
    clearTimeout(tabTimer);
    if (step.tab) tabTimer = setTimeout(() => { if (running && index === next) place(); }, 350);
  }

  function finish() {
    if (!running) return;
    running = false;
    remember();
    clearTimeout(tabTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    // Put the visitor back on the tab they were reading, not on Prayer.
    if (startTab && currentTab() !== startTab) goTab(startTab);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    else if (nextBtn && nextBtn.blur) nextBtn.blur();
  }

  function start(replay) {
    if (running) return;
    // Remember where they were before the tour starts moving them about.
    const from = currentTab();
    // The tour points at map elements, so start from the map rather than
    // hijacking someone who is halfway through the prayer view.
    const mapView = document.getElementById('view-map');
    const onMap = !mapView || !mapView.hidden;
    if (!onMap && !replay) return;
    if (!onMap && window.NZApp && window.NZApp.showTab) window.NZApp.showTab('map');
    if (document.getElementById('modalWrap') && !document.getElementById('modalWrap').hidden && !replay) return;

    running = true;
    startTab = from;
    lastFocus = document.activeElement;
    build();
    go(0);
    window.requestAnimationFrame(place);
  }

  window.NZTour = { start: () => start(true), stop: finish, seen };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('tourBtn');
    if (btn) btn.addEventListener('click', () => start(true));
    if (seen()) return;
    // Let the map and the first cards settle before pointing at them.
    setTimeout(() => start(false), 1400);
  });
})();
