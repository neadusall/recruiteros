# 2026-07-14: Meridian enterprise redesign (full UI/UX overhaul)

Complete visual and UX rebuild of every surface: the Command Center portal (all tabs), the
auth pages, the public marketing site, and all satellite pages (PiP Studio, Alfred, Campaign
Studio and Builder, owner consoles, help center, candidate vetting pages, watch page). One
design system, "Meridian", now drives everything; the spec lives in `docs/DESIGN-SYSTEM.md`.
Branch: `redesign/enterprise-ui`, not yet deployed.

## What changed and why

The old look was the stock AI-generated aesthetic: dark violet/cyan/pink gradients, animated
aurora blobs, film-grain noise, shimmer headline text, glassmorphism blur, emoji as icons,
19 different border radii, and ~85% of the stylesheet as per-tab one-offs. It read as a
prototype. The goal was a platform a staffing firm or executive search company would deploy
to a large team.

## The new system (Meridian)

- **Light-first**: light is the default theme everywhere (dark remains fully supported,
  token-driven, selectable from the account menu). New users land on light.
- **Tokens**: one neutral scale (`--bg/--bg-soft/--surface/--surface-2/--border/...`), one
  accent (`--brand: #2e5bd7`, white-label overridable), and semantic status PAIRS
  (`--ok/--ok-bg`, `--warn/--warn-bg`, `--danger/--danger-bg`, `--info/--info-bg`).
  Gradients are retired; legacy `--grad`/`--grad-text` resolve to flat brand color.
- **Iconography**: inline SVG sprite (Lucide-style 1.7px stroke) in `command.html`; every
  emoji in chrome, nav, buttons, badges, and playbook icon slots was replaced or removed
  (500+ sites in `command.js` alone).
- **Shape and elevation**: radii collapsed to 6/8/12px; cards are border-only; shadows exist
  only on overlays (menus, modals, drawers); zero `backdrop-filter`.
- **Typography**: Inter 400/500/600 only (650 for large KPI numerals), 11px uppercase
  micro-labels, `tabular-nums` on all KPI/table numerics; the shell `zoom` hacks are gone.
- **Navigation**: sidebar rebuilt; portal badge and workspace card restyled; the BD/Recruiting
  motion toggle is a proper segmented control (no per-motion color gradients); a **Replies**
  nav item now surfaces the reply inbox (previously the live hot-reply badge counter had no
  nav home); Setup moved into the Admin group; Playbooks and Help Center pinned to the sidebar
  footer; the whole sidebar scrolls as one (the Admin group used to clip silently); the
  gradient help FAB is gone.
- **White-label contract preserved**: `wl-theme.js` still derives everything from one accent
  and writes `--brand/--brand-2/--brand-soft/--accent/--focus-ring/--grad/--grad-text`;
  `command.js` branding apply-path unchanged.

## Files

- Rewritten from scratch: `assets/css/styles.css` (tokens + base + marketing layout),
  `assets/css/app.css` (shell), `assets/css/auth.css`, `command.html`, `login.html`,
  `assets/js/wl-theme.js`, `assets/js/pw-toggle.js` (SVG eye).
- Transformed selector-for-selector (no class renamed, JS untouched by the restyle):
  `assets/css/command.css` (the obsolete `html[data-theme="light"]` retrofit block was
  deleted; light is now the token default), `campaign-studio.css`, `vetting.css`,
  `alfred.css`, `owner.css`.
- `assets/js/command.js`: hardcoded hex/rgba colors moved to tokens (~400 sites), all
  em-dashes removed (house rule), emoji-to-SVG sweep, banner/badge chrome cleaned.
- Marketing pages (15): FX layers removed, emoji mega-menus cleaned, SVG feature icons,
  fake-customer logo marquee removed, new favicon; `landing.js` particle/scroll-progress
  code deleted; the `.reveal` scroll-hide animation retired (sections are always visible).
- Standalone pages rethemed to Meridian light (PiP Studio also honors `ros_theme` so the
  embedded studio matches the portal).

## Verified

Headless-Chromium screenshot matrix before commit (house rule): all 28 portal routes at
1280 light, key tabs dark, 1024 and 500 widths (the sidebar now actually collapses at
mobile widths; a specificity bug previously kept it visible), marketing home + login +
signup + helpcenter + vetting opt-in + watch at 1280/500. Repo-wide scans: zero em-dashes
in HTML/CSS/JS, zero emoji in user-facing surfaces, zero `backdrop-filter`, zero brand
gradients, `node --check` passes on every touched JS bundle.

## Round 2 (same day): enterprise UX layer

New `assets/js/command-ux.js` (DOM-driven, loads after command.js): command palette
(Ctrl/Cmd+K + topbar Search trigger), collapsible sidebar icon rail (Ctrl+B, persisted),
mobile navigation drawer (below 920px the sidebar previously just vanished), skip link,
aria-current nav, dialog focus trap + aria-modal in openModal, skeleton loading rows,
140ms view fade, OS-preference theme default. Injected-style font weights normalized
(94 sites), Hire Signals in-app headline tamed, duplicate Senders title removed.
pricing.html created (the /pricing route existed with no file, so it 404'd) and
Features/Pricing links added to every marketing nav.

## Round 3 (same day): navigation intelligence

- Variable Inter (400..700) on all 31 pages so the 600/650 weights render true
  (static cuts silently substituted 700 before).
- Palette: Recent group (last-visited tabs, tracked in ros_recents) leads the empty
  state; quick-create commands (New campaign, Add prospect/candidate, Invite recruiter)
  navigate and press the view's primary action; recency boosts fuzzy ranking.
- Keyboard chords: g then a letter jumps tabs (g d dashboard, g c clients, g h hire
  signals, ...), gated by what the sidebar actually shows (RBAC + motion). ? opens a
  keyboard-shortcuts sheet listing everything live.
- Wayfinding: breadcrumb appends the drill-down segment (e.g. "Operate / Email
  capacity"), the browser tab title follows the active view ("Clients · Admin Portal"),
  route changes scroll the content pane to top and hand focus to the page title for
  screen readers, and opening /command bare restores the last route.
- Marketing nav highlights the current page (aria-current + brand color).
