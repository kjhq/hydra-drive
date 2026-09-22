# Waypoint brand assets

A warm, map-inspired identity for the GitHub repository. The route-shaped W ends
at a separate circular waypoint; the banner expands that idea into a game-world
landscape with a path back to your progress.

| Asset                                      | Use                                              |
| ------------------------------------------ | ------------------------------------------------ |
| [waypoint-mark.svg](waypoint-mark.svg)     | Scalable amber mark on a transparent background. |
| [waypoint-icon.svg](waypoint-icon.svg)     | Mark on a rounded charcoal tile.                 |
| [waypoint-icon.png](waypoint-icon.png)     | 512 × 512 raster export of the icon.             |
| [waypoint-banner.png](waypoint-banner.png) | 2172 × 724 illustrated README cover.             |

## Identity

- **Name:** Waypoint
- **Tagline:** Your games. Your progress. Your way.
- **Charcoal:** `#191A18`
- **Ivory:** `#F4EFE5`
- **Amber:** `#F2B866`

Use the mark on charcoal or another dark neutral. Keep clear space of at least
one endpoint-dot diameter around it. Preserve its proportions and the gap
between the route and the endpoint. The icon is the self-contained option for
light backgrounds. The banner's wordmark is baked into the image; the README
repeats its name and tagline as accessible text for small screens.

## Production

The SVG mark and icon are original vector artwork. The PNG icon was rasterized
from `waypoint-icon.svg` with Sharp. The banner was generated with the built-in
image-generation tool using that icon as its identity reference, then copied
into this directory without resizing. Its exact prompt is saved in
[banner-prompt.txt](banner-prompt.txt).

These files currently brand the repository only. They are not installed as
application icons or used by the hosted website.
