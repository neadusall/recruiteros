# RecruitersOS Design System ("Meridian")

The single visual language for the entire product: portal, auth, marketing site,
and satellite pages. Introduced in the 2026-07 enterprise redesign. If a page or
component does not look like it came from this document, it is wrong.

## Design position

RecruitersOS is an operating system for recruiting teams. The UI should read as
calm, precise, and trustworthy: closer to Linear, Stripe Dashboard, and Ashby
than to a consumer app. Density is a feature: recruiters live in tables and
queues all day. Decoration is not.

**Removed permanently** (the old "AI-generated" look): aurora blobs, film-grain
noise overlays, animated dot grids, shimmer/gradient headline text, glow
shadows, glassmorphism blur panels, emoji as iconography, rainbow accent
palette (violet + cyan + pink at once), pill-shaped everything, floating
gradient FABs.

## Themes

Light is the primary theme (enterprise default; what screenshots, sales demos,
and docs show). Dark remains fully supported and token-driven. All theming goes
through CSS custom properties on `:root` / `html[data-theme="dark"]`; no
component may hardcode a surface or text color.

## Color tokens

Neutral scale (light):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f7f8fa` | App canvas |
| `--bg-soft` | `#f0f2f5` | Recessed areas, table headers |
| `--surface` | `#ffffff` | Cards, panels, sidebar |
| `--surface-2` | `#f5f6f8` | Nested surfaces, hovers |
| `--border` | `#e4e7ec` | Hairlines |
| `--border-strong` | `#cfd4dd` | Inputs, emphasized dividers |
| `--text` | `#10151d` | Primary text |
| `--text-muted` | `#414b5e` | Secondary text |
| `--text-dim` | `#69748a` | Tertiary, labels, meta (still >= 4.5:1 on white) |

Dark equivalents are true neutrals (no purple cast): canvas `#0e1116`, surface
`#161a21`, surface-2 `#1d222b`, borders `#262c37` / `#39414f`, text `#f4f6fa` /
`#b3bbc9` / `#8791a3`.

Contrast pass (2026-07-14): secondary/tertiary text was darkened one step so
small labels stay legible; cards carry `--shadow-xs` (a 1px hairline lift),
headings sit at weight 650, stat values at 700. Elevation stays borders-first;
`--shadow-xs` is the only shadow allowed on in-flow cards.

Accent (white-label overridable; keep these names, wl-theme.js writes them):

| Token | Value | Use |
|---|---|---|
| `--brand` | `#2f5eE8` | Primary actions, active nav, links, focus |
| `--brand-2` | derived lighter | Secondary accent contexts |
| `--brand-soft` | `rgba(47,94,232,.09)` | Selected rows, active chips |
| `--grad` | flat (brand to brand) | Legacy uses; renders as solid |

Semantic status (fixed, never white-labeled):

| Token | Light | Use |
|---|---|---|
| `--ok` / `--accent-green` | `#177245`-family (`#16a34a` fg on tint) | Success, live, sent |
| `--warn` / `--accent-amber` | `#b45309` | Warning, pending, trial |
| `--danger` / `--accent-red` | `#dc2626` | Errors, destructive, DNC |
| `--info` | `#0369a1` | Informational |

Every status color ships as a pair: `--ok` (text/icon) + `--ok-bg` (tint
surface). Badges always use the pair, never a raw rgba.

## Typography

- Family: Inter (400/500/600); JetBrains Mono only for IDs, counts, code, and
  tabular data cells that benefit from `font-variant-numeric: tabular-nums`.
- No 700/800 weights in the app. Hierarchy comes from size + color, not
  heaviness.
- Scale: 12 (meta/labels), 13 (body dense/tables), 14 (body/controls),
  16 (section titles), 18 (page titles), 24/32 (marketing only).
- Labels and table headers: 11px, 500, uppercase, `letter-spacing: .05em`,
  `--text-dim`.
- No gradient text anywhere.

## Shape, elevation, motion

- Radius: 6px (controls, inputs, badges get 4px or 6px), 8px (cards, modals),
  10px (large modals). Nothing above 12px except avatars. No `border-radius:
  999px` pills except tiny count badges and avatars.
- Elevation: borders first. Shadows only on overlays: menus/popovers
  `0 4px 16px rgba(16,24,40,.10)`, modals `0 12px 32px rgba(16,24,40,.16)`.
  Cards get NO shadow, just `1px solid var(--border)`.
- Motion: 120ms ease on hover/active states, 160ms on overlays. No floating,
  drifting, shimmering, or infinite animations. Respect reduced-motion.

## Iconography

Inline SVG only (Lucide-style: 1.5px stroke, round caps, `currentColor`),
via the `icon(name)` helper in command.js / the `.icon` sprite in static pages.
Emoji are banned in UI chrome (nav, buttons, badges, headings, empty states).

## Components (single canonical set)

- **Buttons**: `.btn` base; variants `-primary` (solid brand), `-secondary`
  (white, 1px border), `-ghost` (borderless, text-muted), `-danger`; sizes
  `-sm` (28px), default (34px), `-lg` (40px, marketing/auth only). One primary
  action per view region.
- **Inputs**: `.field` wraps label + control + help/error. 34px control height,
  white surface, `--border-strong` border, brand focus ring
  (`box-shadow: 0 0 0 3px var(--brand-soft)`).
- **Cards**: `.card` = surface + border + 8px radius + 20px padding, with
  optional `.card-head` (title + actions) and `.card-foot`.
- **Tables**: `.tbl` = full-width, 13px, 40px rows, sticky uppercase header on
  `--bg-soft`, row hover `--surface-2`, selected `--brand-soft`, right-aligned
  numerics with tabular-nums. Toolbar pattern above every table: left = search
  input + filter controls, right = bulk/primary actions. Footer = count +
  pagination.
- **Badges**: `.badge` + semantic variant. 4px radius (not pills), 11px/500,
  tint background + strong foreground from the status pair.
- **KPI tiles**: `.kpi` = label (11 uppercase dim) over value (24/600
  tabular-nums) over optional delta; border card, no glow dots.
- **Modals**: centered, 8-10px radius, header (title + close), body, footer
  (actions right, cancel as secondary). Scrim `rgba(16,24,40,.5)`, no blur.
- **Drawers**: right-side, 480-640px, same header/body/footer anatomy; for
  record detail (candidate, client, campaign) so list context is never lost.
- **Toasts**: bottom-right stack, surface + border + overlay shadow, icon +
  message + optional action, auto-dismiss 4s.
- **Empty states**: icon (SVG, dim), one-line headline, one-line explanation,
  ONE primary action. No emoji, no walls of text.
- **Loading**: skeleton rows/blocks for content areas; button-level spinners
  for actions. No full-screen spinners.
- **Segmented controls**: `.seg` for exclusive mode switches (BD/Recruiting,
  chart ranges): recessed track, white raised active segment, no gradients.

## App shell

- Sidebar 232px, `--surface`, single hairline right border: workspace block
  (name + plan + portal role) at top, motion switch as a proper segmented
  control, grouped nav (11px group labels, 32px items, SVG icons, active =
  `--brand-soft` bg + brand text + 2px left rail), pinned bottom: Playbooks,
  Help, Settings.
- Topbar 56px: breadcrumb + page title left; global context (env pill), page
  primary action, account menu right. Page-level actions live in the page
  header, not floating.
- Content: max-width 1320px, 24px gutters, 24px section rhythm. No `zoom`
  hacks (the old shell used `zoom: 1.06/1.12`; deleted).
- Help is a normal topbar/nav item, not a gradient FAB.

## Sanctioned decoration and delight

Two narrow exceptions to the no-decoration rule, both quiet:

- **Brand wash**: a single radial brand tint (`var(--brand-soft)`, under 10%
  strength) radiating from the top edge of marketing heroes, the CTA band, and
  the auth pitch panel. Never inside the app shell, never stacked, never
  animated.
- **Functional motion only**: KPI values may count up once within 2.5s of a
  route change (never on live refresh), theme switches cross-fade for ~300ms,
  views fade in for 140ms, skeletons sweep while loading. Everything honors
  `prefers-reduced-motion`. Nothing floats, drifts, shimmers, or loops.

Empty states are illustrated by a single dim outline glyph (CSS mask on
`.empty::before`), one line of copy, and at most one action. The one-time
keyboard tip (`.ux-tip`) may appear once per user, ever.

## Voice

Sentence case everywhere (buttons, nav, headings). No exclamation marks in
chrome. No em-dashes in any copy (house rule). Numbers get tabular-nums.
