# getshootable.app landing page

Static page in the 10ten app-page style (same system as Huntable's and Fishable's `web/`): Barlow Condensed over IBM
Plex Sans, bark/field neutrals, one brand colour. Crimson stays on the mark; buttons are the app's sage so nothing red
on the page is anything but a Prohibited answer.

- `index.html`: the whole page. The hero's example answers are real engine answers from the BC pack; re-check them
  when the data changes (see the comment above the hero script).
- `img/contours.svg`: real BC TRIM contours (40 m), built from the WFS with `pipeline/bc/draft_lib.py`.
- `fonts/`: copied from Huntable (OFL).
- Early access posts a Netlify form named `early-access`; there's no Netlify site for Shootable yet.
- Never write "legal" in page copy (CLAUDE.md).

## Source and deploy

Built from `web/` in the private `milanvrekic/shootable` repo (landing page and FAQ as of 2026-11-03). This repo is the
published copy: edit there, then copy `web/` here. It is plain static files with no build step, so any static host serves
it from the repo root. The early-access form (`data-netlify`) only works on Netlify. The page's canonical URL is
`https://getshootable.app/`.
