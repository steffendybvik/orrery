# Logo and favicon

The brief for Orrery's mark, and the files it needs. The current mark is a placeholder drawn in SVG:
a dark sun and one planet on a tilted orbit, on an amber tile (`web/public/favicon.svg`, and inline in
`AppSidebar.vue` and `EmptyProjects.vue`).

## Prompt for an image model

Paste this as is (it's written for Nano Banana, and works for any text-to-image model):

```
A minimal app icon for "Orrery", a calm, keyboard-first roadmap board where a developer and their AI
coding sessions track work across projects. An orrery is a mechanical model of the solar system:
the idea is one centre with work moving around it in ordered orbits.

The mark: a rounded-square tile (corner radius about 22% of its width) filled with a smooth diagonal
gradient from warm amber #FBBF6A at the top left to burnt orange #E06A1F at the bottom right. On it, in
near-black #09090B, a solid central sun, one thin elliptical orbit ring tilted about 25 degrees
counter-clockwise, and one small solid planet sitting on the ring at the upper right. Optionally a
second, fainter inner orbit, but only if it still reads at 16 pixels.

Style: flat vector, geometric, precise, like the icons of Linear, Vercel or Raycast. Even line weight,
perfectly centred, generous padding (the drawing fills about 65% of the tile). No text, no letters, no
stars, no sparkles, no 3D, no bevels, no glow, no gradients on the black shapes, no drop shadow, no
texture, no mockup or device frame.

Output: a single icon, centred on a plain flat white background, square 1024x1024 PNG. Show it large,
nothing else in the image.
```

Ask for a few at once, then follow up on the one you like: "same icon, without the tile: the black
shapes alone on white", and "same, with the shapes in white on #09090B" for the dark version.

## Files it needs

Image models give back a raster PNG on a background, so the 1024 px master is the source: trace it
into SVG (or redraw it, the shapes are simple), then export the rest from the SVG.

| File | Size | Notes |
|---|---|---|
| `web/public/favicon.svg` | viewBox `0 0 32 32` | The tile and mark, transparent outside the tile. What browsers use first. |
| `web/public/favicon.ico` | 16, 32, 48 px in one file | For browsers and tools that don't take SVG. |
| `web/public/apple-touch-icon.png` | 180 × 180 | Full-bleed square, no transparency, no rounded corners (iOS rounds them). |
| `web/public/icon-192.png` | 192 × 192 | Web app manifest. |
| `web/public/icon-512.png` | 512 × 512 | Web app manifest. |
| `web/public/icon-512-maskable.png` | 512 × 512 | Full-bleed gradient, the mark inside the middle 80% (the safe zone). |
| Glyph SVG for the app | viewBox `0 0 24 24` | The black shapes alone, `currentColor`, for the sidebar (shown at 16 px on a 28 px tile) and the empty state. |
| `docs/images/social.png` (optional) | 1200 × 630 | The mark and "orrery" in Geist Semibold, lowercase, on #09090B. |

Check the 16 px favicon on both a light and a dark tab bar before settling: the planet and the ring are
the first things to blur together.

The name stays as text, not a drawn wordmark: lowercase "orrery" in Geist Semibold with tight
tracking, as in the sidebar.
