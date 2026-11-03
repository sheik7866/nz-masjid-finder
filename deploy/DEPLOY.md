# Deployment

Static site, no build step, no server, no paid service.

## Bundle
`nz-masjid-finder-site.zip` — 15 files, site at the archive root.
Contents: 118 masjids, 223 halal businesses,
8 JS/CSS files, PWA manifest and icons.

## Option A — Cloudflare Pages (recommended, free)
1. dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**.
2. Project name: `nz-masjid-finder`.
3. Drag `nz-masjid-finder-site.zip` (or the `public/` folder) into the uploader.
4. Deploy. You get `https://nz-masjid-finder.pages.dev` on HTTPS immediately.

HTTPS matters: iOS refuses the compass and precise location on plain http.

## Option B — Netlify (free)
app.netlify.com/drop → drag the `public/` folder → done.

## Option C — GitHub Pages (free)
Push this repo, Settings → Pages → Deploy from branch → `/docs`, and copy
`public/` to `docs/`.

## After deploying
- Open the URL on an iPhone in Safari, tap **Allow** on location and motion.
- Install to home screen: Share → Add to Home Screen.
- Check the Verify bar reads “shared via Supabase”.
- Nothing in `public/` contains a secret key: only the publishable key.
