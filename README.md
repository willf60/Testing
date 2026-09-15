# Disturbia Shopify Theme

Alternative (goth) fashion Shopify store running a heavily customized **Prestige** theme (v6.0.0, by Maestrooo). Three storefronts share this single theme source:

| Store | myshopify.com | Domain | Market |
|-------|---------------|--------|--------|
| UK (production) | disturbia-uk | www.disturbia.co.uk | UK & ROW |
| US (production) | disturbia-us | www.disturbia.us | North America |
| EU (production) | disturbia-eu | www.disturbia.nl | EU |
| UK (dev) | disturbia-uk-dev | dev.disturbia.co.uk | UK & ROW |
| US (dev) | disturbia-us-dev | dev.disturbia.us | North America |
| EU (dev) | disturbia-eu-dev | dev.disturbia.nl | EU |

Storefront variations are handled through theme settings and geo-targeting, not separate branches.

## Getting Started

Unless otherwise indicated, these commands honour any exclusions that have been configured in `shopify.theme.toml` (usually JSON settings and template files).

```bash
# Authenticate with Shopify
shopify auth login

# Preview theme locally (connects to store API for live product data)
npm run dev -- -e <environment>

# Push to a theme for testing/review
npm run push -- -e <environment>

# Push to multiple themes on multiple stores
npm run deploy

# Pull theme code from Shopify
npm run push -- -e <environment>

# Pull latest theme settings from Shopify (overrides configured exclusions)
npm run settings -- -e <environment>

# Verify font metric fallback overrides in css-variables.liquid match current brand fonts
npm run check-fonts
```

Multi-environment config lives in `shopify.theme.toml`. There is no build step - assets are served directly by Shopify CDN. JavaScript in `assets/` is vanilla JS (jQuery is available globally).

## Branch naming

Branch names should usually start with one of the following prefixes:

- `feature/` for new functionality
- `fix/` for bug fixes
- `perf/` for performance enhangements
- `test/` for A/B tests (or similar)
- `dev/` for pipeline improvements (e.g. npm scripts)
- `tidy/` for code cleanups

## Repo Structure

```
layout/theme.liquid          Main HTML shell - global JS/CSS, header/footer
templates/*.json             JSON templates composing sections (some legacy *.liquid too)
templates/*.context.*.json   Market-specific template overrides (e.g., index.context.de.json)
sections/*.liquid            Content blocks (main-* = one per page, others reusable)
snippets/*.liquid            Partials via {% render %} - no global scope access
assets/                      Static files on Shopify CDN - edit directly
config/settings_schema.json  Theme settings definitions
config/settings_data.json    Live settings values - commit carefully (merchandising state)
locales/                     Translations: en.default.json is source of truth (other maintained languages include de, es, fr, pl)
```

## Locales

- **en.default**: Primary English source of truth.
- **de, es, fr, pl**: Translations currently maintained and in use (currently on EU store).
- **it, jp**: Unused translations, not maintained.
- **en-US**: In addition to the rewards programme customizations mentioned below, US date and address formats are different from other markets.
- **en-_XX_**: English translations for specific markets. These are required because the rewards programme is only available to GB customers on the UK store, but all markets on the other stores. If new markets are added to the EU or US stores which are in the rewards programme, create new market-specific English translations here as appropriate.

## Key Custom Systems

### Geo-Targeting

The geo system controls content visibility, free shipping thresholds, storefront redirects, and product availability across all three storefronts. Core snippets:

- **geo-zone.liquid** - maps country code to zone (home, eu, na, row)
- **geo-content.liquid** - conditionally renders content by country/zone
- **storefront-redirect.liquid** - client-side redirect between storefronts
- **markets-redirect.liquid** - Shopify Markets-level country redirect

Many sections have `geo_show`/`geo_hide` settings for per-country visibility.

### Visibility Controls

`snippets/hiltonian-hide.liquid` gates product/content visibility based on customer tags (`hidden`, `draft`, `vip`, `user: sometag`) and metafields (`hiltonian.visibility_*`, `hiltonian.hidden_locations`, `hiltonian.geo_show`/`geo_hide`).

### Colour Swatches

Products link to colour variations via `product.metafields.custom.colour_variations`. `custom.js` handles card-swapping on swatch click by fetching alternate product cards and replacing the DOM node.

## Key Files

| File | Purpose |
|------|---------|
| `assets/theme.js` | Core framework (sections, cart drawer, modals, lazy loading). Avoid casual edits. |
| `assets/custom.js` | All Disturbia customizations (geo UI, swatches, modals, redirects). |
| `assets/geolocate.js` | Fires `country` CustomEvent with detected 2-letter code. |
| `assets/events.js` | Analytics/tracking event layer. |
| `assets/custom.css` | All custom styles (~100KB). |

## Third-Party Integrations

Loaded in `theme.liquid`: jQuery, Klaviyo (email/analytics), PrimeAI (visual search on product pages), Google Ads (gtag with consent defaults denied), Yotpo (reviews/referrals), js.cookie, lazysizes. Search uses a bespoke Klevu integration (toggled by `settings.search_bespoke`).

## Git Workflow

- Feature branch, PR, merge to `main`
- Never push directly to `main` (ruleset enforced: 1 approval + CODEOWNER review, no bypass)
- CODEOWNER: @richard-disturbia (all files)
- PRs should be focused - one concern per PR
- `config/settings_data.json` and `templates/*.json` are excluded from theme pulls/pushes via CLI - do not commit without coordinating

## AI Agent Configuration

`AGENTS.md` provides architecture context for AI coding tools (Claude Code, Copilot, Cursor, etc.). `CLAUDE.md` imports it for Claude Code specifically. These files help agents understand the geo system, visibility controls, and theme structure before making changes.
