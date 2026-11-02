# LyraSEO AI Solid logo assets

The founder explicitly approved the final balanced LyraSEO AI Solid logo and all supplied variants on 2026-10-22. These are final design assets; application building is not authorized. See [logo usage](../../docs/logo-direction-options.md).

All logo lettering is outlined from the pinned Manrope source in `source/`, with the original SIL Open Font License and exact upstream commit in `provenance.json`. Logo SVGs contain paths, shapes and local masks only, with accessible titles; no scripts, remote references or font loading. SVGs are transparent; the preview includes sample backgrounds. PNG lockups preserve transparency.

Each light/dark/black/white family includes an integrated-lettering primary lockup and symbol, with AEO/GEO in every symbol, including compact placements. Plain-L variants have been withdrawn. AEO runs vertically within the stem; GEO runs horizontally within the foot. Lettering is knocked out with local SVG masks so monochrome variants work on different surfaces. Nothing is placed beneath the wordmark. The -aeo-geo filenames alias the integrated primary variant. The favicon uses a white L containing AEO/GEO on a cobalt tile. Embedded lettering is retained at every size, even where it becomes too small to read. PNG exports include eight icon sizes; the ICO contains 16/24/32/48/256 pixel frames.

Balanced refinement requested by the founder: AEO/GEO uses 14.25-unit Manrope 800 lettering, midway between the earlier 11.5-unit and enlarged 17-unit versions. The L uses a 24-unit stem and 23.5-unit foot; tile icons use a 44-unit symbol, midway between 40 and 48. Every variant retains the embedded lettering.

Reproduction uses Python with fontTools to run `source/generate.py`, then Node with sharp to run `source/render.cjs`. These are standalone design tools, not application dependencies. The ICO is assembled from the matching exported PNG sizes using Pillow. Regenerate the ICO after geometry changes. The previous below-wordmark preview is retained in source/ as superseded history. The original generated comparison remains in `.impeccable/mocks/logo/` for historical reference.

The application fonts remain a separate implementation task. This asset set does not make any domain-availability or trademark-clearance claim.

[Approval record](./approval.json) records the exact approved asset hashes.
