# UVEL wordmark alignment — 2026-10-16

The website and the local logo package use one wordmark based on the UVEL lettering in the approved Rack P2 hardware image. The geometric uppercase U/V/L and three separate horizontal E bars replace the former rounded wordmark. The E has no vertical stem, and the current master uses stronger strokes for a balanced lockup.

The existing lemon Mobius ribbon design is retained, with no contour redesign in this revision. Its scale is reduced in the horizontal lockups so the emblem height is 2.1 times the wordmark height. In the local `D:/WORKS/PLAN/UI/UVEL_Lemon_Complete_16_PNG` package, all 12 horizontal lockups were updated and all four square icons were retained byte-for-byte. The original package is backed up under `D:/WORKS/PLAN/UI/.trash/20261016-logo-unification/`.

One master was created with the built-in image generation tool, then exported with a shared alpha mask, flat theme colors and consistent glyph spacing. The current master is 1509 × 328, with 92 px gaps between glyph groups. This is a reference-based reconstruction; no original font file was available, and it is not claimed to be an exact original typeface. Each size uses the same contours, with no independent regeneration. The export report records the emblem-to-wordmark ratio and verifies the dark/light alpha masks and unchanged square icon files.

Horizontal canvases retain their existing 1412 × 480, 712 × 246 and 359 × 126 dimensions, with transparent safety margins. The emblem and complete wordmark are scaled proportionally. The inherited `tight` filenames do not indicate edge-to-edge alpha bounds in this revision.

The user's final selection preserves the original tilted 3D ribbon and the approved wordmark. The final correction changes only the emblem's vertical placement, leaving its pixels, scale, glyphs and horizontal gap intact. At alpha > 128, a repeatable optical axis combines 35% of the visible-bounds center and 65% of the alpha-weighted centroid. The bare emblem moves up 7 px in the standard PNG, 2 px in compact and 13 px in master; plated variants move 0–2 px according to their own centers. PNG rounding error remains below 0.5 px. The 4× website files render the compact layout from high-resolution sources; their measured optical residual is about 0.58 px at a 359 px display width. This rule is an export aid, with final acceptance based on the actual artwork and browser rendering. Pre-correction assets are backed up under `D:/WORKS/PLAN/UI/.trash/20261016-logo-optical-balance/`.

Local master PNGs, the exact prompts, export script and manifest are in `D:/WORKS/PLAN/UI/UVEL/`. The hardware reference is `D:/WORKS/PLAN/UI/UVEL-SKU-2026-09-27/direction-v2/stellarrack-p2-example.png`.

Website consumers:

- `public/logo-lockup-dark.webp`: the same complete emblem-and-wordmark image is used by dark navigation and `SiteFooter.astro`.
- `public/logo-lockup-light.webp`: the corresponding complete image for light navigation.
- Both complete WebP lockups are 1436 × 504 (4× the 359 × 126 layout). They are rendered directly from the high-resolution emblem and wordmark sources, preserving the displayed geometry while avoiding footer upsampling on high-density screens.
- `public/logo-wordmark-dark.webp` and `logo-wordmark-light.webp`: standalone assets from the same 1509 × 328 master; the footer uses the complete lockup instead.
- Navigation and footer scale the complete image as one unit to preserve the emblem-to-wordmark ratio. The footer has one accessible brand label, and its lettering does not depend on locale fonts.
- `public/og.png`: share image using the updated lockup.

Symbol-only favicon/app icons and hardware product imagery remain intact. Validation for this revision uses the current exported image hashes and complete-lockup footer source. Browser acceptance covers dark navigation, the controlled light-style state, mobile menu states, localized footers and inner pages; typography calibration must correspond to the current footer source. The current site has no scroll-triggered light sections, so the controlled light-state check is not a claim of a live light-section transition.

The final optical revision passed three independent reviews (asset integrity 9.1/10, approved-reference preservation 9.3/10 and website rendering 9.3/10), with no P0/P1/P2 findings. Pixel comparison confirmed that all 12 horizontal PNGs differ from the selected pre-correction version only by the specified vertical emblem translation. All 26 published pages loaded the shared logo without horizontal overflow at 390 px; English/Vietnamese home views at 390/1440 px and DPR 2 retained identical layout boxes, with no console errors. Full typography recalibration produced 621 records and 319,328 observations, covering 449 measured controls and 172 preview-dependent controls with zero coverage gaps; advisory character limits remained unchanged. Local review evidence is under `D:/WORKS/PLAN/nexgrid-website/tmp/uvel-logo-20261016/optical-*-review/`.
