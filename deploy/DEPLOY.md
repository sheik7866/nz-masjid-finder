# Deployment

Static site, no build step, no server, no paid service.

## Source of truth
Publish the `public/` folder as-is: 118 masjids, 223 halal businesses, 8 JS
modules, one stylesheet, the PWA manifest and icons. GitHub Pages serves the
byte-identical mirror in `docs/` — refresh it with `sh scripts/sync_docs.sh`, and
`tests/mirror.test.cjs` fails if the two ever drift.

**No prebuilt archive is committed.** A zip of `public/` lived here and was two
weeks out of date because nothing regenerated it, so anyone uploading it would
have shipped an older site. If a host only accepts an archive, build one at
deploy time:

```
cd public && zip -r ../deploy/nz-masjid-finder-site.zip .
```

## Option A — Cloudflare Pages (recommended, free)
1. dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**.
2. Project name: `nz-masjid-finder`.
3. Drag the `public/` folder (or a zip built as above) into the uploader.
4. Deploy. You get `https://nz-masjid-finder.pages.dev` on HTTPS immediately.

HTTPS matters: iOS refuses the compass and precise location on plain http.

## Option B — Netlify (free)
app.netlify.com/drop → drag the `public/` folder → done.

## Option C — GitHub Pages (free)
Pushes to `main` publish `docs/` automatically, so run `sh scripts/sync_docs.sh`
before committing so the mirror matches `public/`.

## After deploying
- Open the URL on an iPhone in Safari, tap **Allow** on location and motion.
- Install to home screen: Share → Add to Home Screen.
- Check the Verify bar reads “shared via Supabase”.
- Nothing in `public/` contains a secret key: only the publishable key.
