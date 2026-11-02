# Launch Review — approved typography, tokens and themes

Date: 2026-10-22. Status: founder-approved on 2026-10-22. The Launch Review identity and refined landing/desktop/mobile direction are approved. The font pairing, semantic token baseline and theme scope below were explicitly approved. Planning only; no application CSS, components, packages or fonts have been installed. Pinned font sources used for the approved standalone logo assets are separate.

## 1. Typography

| Role | Family | Weight | Size / line height |
| ---- | ------ | ------ | ------------------ |
| Marketing display | Manrope | 700; 800 for short hero emphasis | Fluid 40–80px / 1.05; tracking -0.035em |
| Marketing section heading | Manrope | 700 | Fluid 28–48px / 1.15; tracking -0.025em |
| App page heading | Manrope | 700 | Fluid 24–32px / 1.2; tracking -0.02em |
| App section heading | Inter | 600 | 20px / 28px |
| Body and editor prose | Inter | 400 | 16px / 24px; editorial prose 16px / 28px |
| Controls, navigation and tables | Inter | 400–600 | 14px / 20px; form inputs 16px / 24px |
| Supporting metadata | Inter | 400–500 | 13px / 18px; never the only place essential instructions appear |
| Source/code excerpts | ui-monospace, SFMono-Regular, Menlo, Consolas, monospace | 400 | 13px / 20px; user zoom supported |

Manrope gives the approved broad, confident headlines a distinct shape; Inter handles dense operational content and genuine italic editorial text. This is the approved pairing, not a claim that generated images used these exact fonts. Use tabular numerals for comparable counts, dates and money; normal numerals in prose. Do not force single-line headlines or truncate essential guidance. Limit long-form reading width to 68ch.

Self-host pinned WOFF2 assets and retain license notices. Load upright variable Manrope and Inter only on routes using them; load Inter italic where editorial content requires it. Use font-display swap and measured fallback metrics. Preload only critical above-the-fold faces. System monospace avoids a third downloadable family. The founder subsequently approved a Manrope-based LyraSEO AI wordmark paired with a compact L symbol. The exact final balanced LyraSEO AI Solid logo was founder-approved on 2026-10-22 and is supplied as outlined vector assets with optical spacing, including AEO/GEO lettering embedded inside every L symbol, including compact logos and favicons; see [logo specification](./logo-direction-options.md).

Sources checked: [Manrope distribution metadata](https://github.com/google/fonts/blob/main/ofl/manrope/METADATA.pb) records its OFL license and 200–800 variable weight axis; [Inter repository](https://github.com/rsms/inter) documents the variable family and SIL Open Font License. Preserve each shipped version's license and inspect actual file coverage during implementation.

## 2. Semantic color tokens

Keep values behind semantic names; components never choose a theme by swapping arbitrary hex colors. Cobalt is brand/action color, not severity. “Needs review” is neutral, independent of the issue's assessed severity.

| Token | Light | Dark | Use |
| ----- | ----- | ---- | --- |
| canvas | #F5F7FC | #0B1220 | App background |
| surface | #FFFFFF | #111827 | Primary reading surface |
| surface-raised | #FFFFFF | #1D2939 | Menus, dialogs and raised panels |
| text-primary | #101828 | #F2F4F7 | Headings and body |
| text-secondary | #475467 | #98A2B3 | Supporting copy |
| text-muted | #667085 | #98A2B3 | Metadata; no blanket opacity reduction |
| border-subtle | #D0D5DD | #344054 | Decorative separators only |
| border-control | #667085 | #98A2B3 | Required input/control boundaries |
| action | #2449D8 | #6C8CFF | Primary action fill |
| action-hover | #1D3DB8 | #8AA4FF | Hover fill |
| on-action | #FFFFFF | #101828 | Text/icons on primary actions |
| link | #2449D8 | #A8BAFF | Links; underline in prose |
| selected-bg | #EEF2FF | #1B2850 | Selected rows/navigation |
| selected-text | #2449D8 | #A8BAFF | Selected labels |
| focus | #2449D8 | #A8BAFF | Focus indicator, paired with surface offset |
| success-bg / text | #ECFDF3 / #067647 | #053321 / #75E0A7 | Confirmed success |
| warning-bg / text | #FFFAEB / #93370D | #3B2506 / #FEC84B | Attention, with icon and label |
| danger-bg / text | #FEF3F2 / #B42318 | #451A1A / #FDA29B | Destructive/error state |
| info-bg / text | #EFF8FF / #175CD3 | #102A43 / #84CAFF | Informational messages |

Marketing hero remains #2449D8 with white text in either visitor system preference. Its white CTA uses #101828 text; secondary hero links stay white and underlined where needed. Dark-app buttons deliberately use dark text on the lighter blue fill: white text on #6C8CFF is insufficient for normal-size labels.

Charts use light series #2449D8, #0E7490, #7E22CE, #B45309 and dark series #A8BAFF, #67E8F9, #D8B4FE, #FCD34D. Always pair series with direct labels, markers/dashes or a table; no color-only distinction or implied significance. Status colors never become arbitrary series colors. Final rendered chart contrast and dense-label behavior need testing.

## 3. Layout and component tokens

| Category | Approved baseline |
| -------- | --------------- |
| Spacing | 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96px; use rem equivalents |
| Page gutters | 16px phone, 24px tablet, 32px desktop; marketing may expand to 48px |
| Marketing content | max-width 1280px; section padding 48px phone / 80px desktop |
| App sidebar | 240px expanded; off-canvas below 1024px |
| App content | max-width 1600px; dense workspace may use available width |
| Breakpoint references | 640, 768, 1024, 1280, 1536px; content fit governs transitions |
| Audit split | List 320–400px; detail min 480px; collapse into list/detail navigation when space is insufficient |
| Control heights | 44px standard, 48px primary mobile, 36px compact desktop where accessible target spacing permits |
| Table row | 48px default; expandable details rather than clipped essential text |
| Radius | 6px small, 8px controls, 12px panels, 16px dialogs; full pill only for badges/avatars |
| Icon sizes | 16px inline, 20px controls, 24px navigation; consistent 1.75–2px visual stroke |
| Borders | 1px; selected row has a 3px indicator plus background and text state |
| Focus | 2px ring with 2px surface-colored offset; separate inverse treatment on cobalt surfaces |
| Shadow | Light raised: 0 8px 24px rgba(16,24,40,0.10); dark raised: 0 8px 24px rgba(0,0,0,0.28), with visible border |
| Layers | Base 0, sticky 10, dropdown 20, overlay 40, dialog 50, tooltip/toast 60; one documented stacking strategy |

Use rem-based text and spacing so user font preferences remain useful. Breakpoints are layout references, not a reason to ignore zoom/reflow. At 320 CSS px content remains readable without page-wide horizontal scrolling; intrinsically wide evidence/table regions may scroll locally with clear affordances. No fixed hero height that clips text. Mobile bottom navigation uses safe-area padding and must not cover content or the keyboard.

## 4. Motion

Micro-feedback 120ms, selection/menu transitions 160ms, panel transitions 220ms; maximum ordinary entrance 280ms. Easing: cubic-bezier(0.2,0,0,1). Animate opacity/transform, preserve focus and avoid layout shifts. No scroll hijacking, looping hero effects or decorative delay before an action. Reduced motion removes spatial movement and uses immediate updates or a brief opacity change. Loading indicators represent activity without claiming fabricated completion percentages.

## 5. Theme scope

Approved scope: **fixed branded marketing; light, dark and system choices throughout the app from its initial build**. Both app themes are in the initial build scope; neither is deferred to phase 2.

| Surface | Approved behavior |
| ------- | ----------------- |
| Marketing and public informational pages | One approved cobalt/white identity, no theme toggle and no automatic inversion |
| App, onboarding, sign-in/recovery, settings | Light / Dark / System; System default until user explicitly chooses |
| Agency/client portal and lean staff admin | Same theme behavior and quality as the app |
| Editors, charts, evidence viewers, dialogs and states | Full parity in both themes; preserve source-image appearance where inversion would corrupt evidence |
| Branded reports and PDF exports | White paper layout optimized for print, independent of app theme |
| Transactional email | Light authored layout with dark-client-safe colors/logos where supported; clients may override rendering |

Persist only the theme preference in a non-sensitive browser cookie so the initial server response and early system-preference handling avoid a wrong-theme flash. Follow OS changes only in System mode; explicit choice wins. No new preference service or cross-device sync is required initially. Use native color-scheme behavior consistently and review controls, autofill, charts and embedded content. Never apply CSS inversion filters. Theme switching must preserve the current job, input, selection and scroll position.

## 6. Verification and approval boundary

Check foreground/background pairs mathematically before adopting tokens, then test actual rendered text, focus, disabled/hover states, charts and overlays. Normal text target is at least 4.5:1; meaningful control boundaries and graphics at least 3:1 against adjacent colors. Decorative separators are exempt from acting as essential control boundaries. Contrast arithmetic alone is not a WCAG conformance claim.

Founder approved this font pairing, semantic token baseline and theme scope as a package on 2026-10-22. Token adjustments that preserve the chosen identity and improve verified accessibility remain normal engineering refinement. No implementation starts from approval alone.

### Planning contrast checks

Computed from opaque sRGB values; these checks cover the listed text pairs only, not rendered accessibility.

| Pair | Foreground | Background | Contrast |
| ---- | ---------- | ---------- | -------- |
| success light | #067647 | #ECFDF3 | 5.40:1 |
| success dark | #75E0A7 | #053321 | 8.64:1 |
| warning light | #93370D | #FFFAEB | 7.21:1 |
| warning dark | #FEC84B | #3B2506 | 9.34:1 |
| danger light | #B42318 | #FEF3F2 | 6.05:1 |
| danger dark | #FDA29B | #451A1A | 7.64:1 |
| info light | #175CD3 | #EFF8FF | 5.57:1 |
| info dark | #84CAFF | #102A43 | 8.28:1 |
| light action | #FFFFFF | #2449D8 | 6.95:1 |
| dark action | #101828 | #6C8CFF | 5.77:1 |
| light selected | #2449D8 | #EEF2FF | 6.22:1 |
| dark selected | #A8BAFF | #1B2850 | 7.59:1 |
| light muted | #667085 | #FFFFFF | 4.97:1 |
| dark muted raised | #98A2B3 | #1D2939 | 5.71:1 |
