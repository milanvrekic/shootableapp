# getshootable.app landing page

Static page in the 10ten app-page style (same system as Huntable's and Fishable's `web/`): Barlow Condensed over IBM
Plex Sans, bark/field neutrals, one brand colour. Crimson stays on the mark; buttons are the app's sage. Red means only
Prohibited and amber only Not confirmed, as in the app; hazards in the diagrams are drawn in sand and white.

- `index.html`: the whole page. `faq/index.html`: questions.
- `img/app-*.webp`: real screens from the app (see below). `img/contours.svg`: BC TRIM contours (40 m), built with
  `pipeline/bc/draft_lib.py`. `img/map-merritt.svg`: the old hero's map, no longer used on the page.
- `fonts/`: copied from Huntable (OFL).
- Early access is one Netlify form named `early-access`, shown in the closing section; every "Get early access" button
  moves that same form into a dialog and back. There's no Netlify site for Shootable yet.
- Never write "legal" in page copy (CLAUDE.md). Invented examples (downrange, lanes, alerts) are labelled as such and
  name no real places.
- `shootableapp` is the published copy: edit here, then copy `web/` there.

## App screens

Phone screens are screenshots of the real app (`app/`, built with `python3 app/build.py release` on the `data-bc` pack and
the fire feed), at 390x844 and 2x, saved as `.webp` (2x) and `-1x.webp`. Map: the self-hosted topo (OpenStreetMap via
Protomaps, Copernicus DEM), credited in the footer.

| File | View | Firearm |
| --- | --- | --- |
| `app-merritt-rifle` | -120.876, 49.9865, z10.2; answer at -120.9028, 50.0525 (No prohibition found), downrange arc hidden | Rifle |
| `app-tricities-rifle` / `-shot` | -122.72, 49.27, z11.2, Areas on | Rifle / Shotgun with shot |

When the pack changes: re-check the hero spot with the engine (it must still answer No prohibition found), recapture the
screens, and update the "BC rules of" dates and the numbers in **What every answer checks** (closed areas mapped and
checked, municipalities and electoral areas verified; counts from `pack.json`: `closed_areas` features, and
`jurisdictions` by `kind` and `coverage`). The FAQ's "Why does it say Not confirmed so often?" quotes the same numbers.

## Source and deploy

Built from `web/` in the private `milanvrekic/shootable` repo (landing page and FAQ as of 2026-11-06). This repo is the
published copy: edit there, then copy `web/` here. It is plain static files with no build step, so any static host serves
it from the repo root. The early-access form (`data-netlify`) only works on Netlify. The page's canonical URL is
`https://getshootable.app/`.
