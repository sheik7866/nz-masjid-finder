/* NZ Masjid Finder
   Read-only public evidence checker for admin submissions.
   It does not approve, reject, or modify any Supabase records.
*/
(() => {
  'use strict';

  if (window.NZMasjidEvidenceChecker) return;

  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const cache = new Map();
  let lastRequestAt = 0;

  const clean = value =>
    String(value || '').replace(/\s+/g, ' ').trim();

  const norm = value =>
    clean(value).toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  function makeElement(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function getSubmissionData(item) {
    const name = clean(
      item.querySelector('.admTop b')?.textContent
    );

    const address = clean(
      item.querySelector('.addr')?.textContent
    ).replace(/\s*[·•]\s*map\s*$/i, '');

    const city = address.split(',').slice(-2).join(',').trim();

    return { name, address, city };
  }

  function showEvidence(item, message, results) {
    item.querySelector('.masjid-evidence-result')?.remove();

    const panel = makeElement(
      'div',
      'masjid-evidence-result'
    );

    panel.style.cssText =
      'margin-top:10px;padding:10px;border:1px solid #cbd5d1;' +
      'border-radius:8px;background:#f7faf8;font-size:13px;' +
      'line-height:1.45;color:#18352d';

    panel.appendChild(makeElement('strong', '', message));

    (results || []).slice(0, 3).forEach((result, index) => {
      const row = makeElement(
        'p',
        '',
        `${index + 1}. ${result.display_name || 'Map result'}`
      );

      row.style.margin = '7px 0 2px';

      const link = makeElement('a', '', 'View map evidence');
      link.href =
        `https://www.openstreetmap.org/${result.osm_type}/${result.osm_id}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      row.append(' — ', link);
      panel.appendChild(row);
    });

    const note = makeElement(
      'p',
      '',
      'This is a public map-data check, not proof that the masjid is operating. An admin must review the evidence before approval.'
    );

    note.style.marginBottom = '0';
    panel.appendChild(note);
    item.appendChild(panel);
  }
    async function check(item, button) {
    const data = getSubmissionData(item);

    if (!data.name) {
      showEvidence(item, 'Cannot check: submission has no name.', []);
      return;
    }

    const query = [
      data.name,
      data.address,
      'New Zealand'
    ].filter(Boolean).join(', ');

    const key = norm(query);

    if (cache.has(key)) {
      const cached = cache.get(key);
      showEvidence(item, cached.message, cached.results);
      return;
    }

    const wait = Math.max(
      0,
      1100 - (Date.now() - lastRequestAt)
    );

    if (wait) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    lastRequestAt = Date.now();
    button.disabled = true;
    button.textContent = 'Checking…';

    try {
      const url = new URL(ENDPOINT);

      url.search = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        addressdetails: '1',
        countrycodes: 'nz',
        limit: '5'
      }).toString();

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`Map search returned ${response.status}`);
      }

      const results = await response.json();

      if (!Array.isArray(results) || !results.length) {
        const result = {
          message: 'No matching public map result found.',
          results: []
        };

        cache.set(key, result);
        showEvidence(item, result.message, result.results);
        return;
      }

      const nameWords = norm(data.name)
        .split(' ')
        .filter(Boolean);

      const ranked = results.map(result => {
        const haystack = norm(result.display_name);

        const matchedWords = nameWords.filter(
          word => haystack.includes(word)
        ).length;

        const nameMatch =
          haystack.includes(norm(data.name)) ||
          matchedWords >= Math.max(
            1,
            Math.ceil(nameWords.length * 0.6)
          );

        const localityMatch =
          !data.city || haystack.includes(norm(data.city));

        return {
          result,
          score: (nameMatch ? 2 : 0) +
            (localityMatch ? 1 : 0)
        };
      }).sort((a, b) => b.score - a.score);

      const best = ranked[0];

      const message = best.score >= 3
        ? 'Possible strong public-map match — admin review required.'
        : best.score >= 2
          ? 'Possible name match — check the address carefully.'
          : 'Results found, but the match is uncertain.';

      const result = {
        message,
        results: ranked.map(entry => entry.result)
      };

      cache.set(key, result);
      showEvidence(item, message, result.results);

    } catch (error) {
      showEvidence(
        item,
        `Could not check map data: ${error.message}`,
        []
      );
    } finally {
      button.disabled = false;
      button.textContent = 'Check public evidence';
    }
  }

  function enhanceAdminQueue() {
    document.querySelectorAll('#modalWrap li.admItem')
      .forEach(item => {
        if (
          !item.querySelector('[data-sub]') ||
          item.querySelector('.masjid-evidence-btn')
        ) return;

        const actions = item.querySelector('.vbtns');
        if (!actions) return;

        const button = makeElement(
          'button',
          'vbtn masjid-evidence-btn',
          'Check public evidence'
        );

        button.type = 'button';

        button.addEventListener('click', () => {
          check(item, button);
        });

        actions.appendChild(button);
      });
  }

  function start() {
    const observer = new MutationObserver(enhanceAdminQueue);

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    enhanceAdminQueue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {
      once: true
    });
  } else {
    start();
  }

  window.NZMasjidEvidenceChecker = {
    scan: enhanceAdminQueue
  };
})();
