# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

Disturbia is an alternative (goth) fashion Shopify store running the **Prestige** theme (v6.0.0 per `config/settings_schema.json`, by Maestrooo), heavily customized. Note: the CSS class `prestige--v4` in `theme.liquid` is a legacy namespace, not the version. Three storefronts (US, UK, EU) share this single theme source - variations are handled through theme settings and geo-targeting, not branches.

**Live stores:** disturbia.co.uk (UK & ROW), disturbia.us (US & North America), disturbia.nl (EU), plus regional variants.

## Development Commands

```bash
# Authenticate with Shopify
shopify auth login

# Preview theme locally (connects to store API for live product data)
npm run dev -- -e <environment>

# Push to a theme for testing/review
npm run push -- -e <environment>

# Pull latest theme settings from live
npm run settings -- -e <environment>
```

Multi-environment config lives in `shopify.theme.toml`. There is no build step - assets are served directly by Shopify CDN. JavaScript in `assets/` is authored as vanilla JS (jQuery is available globally).

## Architecture

### Theme Structure (Shopify OS 2.0)

- `layout/theme.liquid` - Main HTML shell. Loads all global JS/CSS, sets `window.theme` config object, renders header/footer sections. This is the critical path for performance work.
- `templates/*.json` - JSON templates that compose sections. Each page type has a default (e.g., `product.json`) and named alternates (e.g., `product.pre-order.json`). Some legacy `templates/*.liquid` files also exist.
- `templates/*.context.{country}.json` - Market-specific template overrides (e.g., `index.context.de.json` shows different homepage content in Germany).
- `sections/*.liquid` - Reusable content blocks. Prefixed `main-` sections are page-specific (one per template). Other sections are reusable across pages.
- `snippets/*.liquid` - Partials rendered via `{% render 'snippet-name' %}`. No global scope access - all data must be passed as parameters.
- `assets/` - Static files served by Shopify CDN. No compilation. Edit directly.
- `config/settings_schema.json` - Theme settings definitions. `config/settings_data.json` holds live values (do not commit carelessly - it contains merchandising state).
- `locales/` - Translation files. `en.default.json` is the source of truth. Active locales: de, es, fr, it (pl coming soon). `ja.json` is unused and pending removal.

### Key JavaScript Files

- `assets/theme.js` - Core theme framework (large file). Section rendering, cart drawer, product forms, modals, image lazy loading. Do not casually edit.
- `assets/custom.js` - All Disturbia customizations. Geolocation UI, colour swatch card swapping, modal helpers, storefront redirect logic. This is where most custom JS lives.
- `assets/geolocate.js` - Fires a `country` CustomEvent with detected 2-letter country code. Other scripts listen for this event.
- `assets/events.js` - Analytics/tracking event layer.

### The Geo System (Critical to Understand)

Three storefronts serve different markets from the same theme. Geo-targeting is pervasive - it controls content visibility, free shipping thresholds, storefront redirects, and product availability.

**Core snippets:**

- `snippets/geo-zone.liquid` - Maps a country code to a zone (`home`, `eu`, `na`, `row`). Zones are defined in theme settings as comma-separated country lists (`geo_zone_home`, `geo_zone_eu`, etc.).
- `snippets/geo-content.liquid` - Conditionally renders content based on country/zone. Used everywhere via `show`/`hide` parameters. Pattern: capture content, then `{% render 'geo-content', content: geo_content, show: '...', hide: '...' %}`.
- `snippets/storefront-redirect.liquid` - Client-side redirect between storefronts based on geolocation. Two modes: `redirect` (automatic) and `popup` (modal prompt).
- `snippets/markets-redirect.liquid` - Shopify Markets-level country redirect (separate from storefront redirect).
- `snippets/geo-warehouse.liquid` - Returns warehouse country code (US or GB). Deprecated/unused.
- `snippets/geo-alternatives.liquid` - Swaps text per country. Deprecated/unused.

**Section-level geo fields:** Many sections have `geo_show`/`geo_hide` settings (comma-separated country/zone codes) that filter visibility. Template JSON files contain these values.

### Visibility System

Products, collections, and content can be hidden based on customer tags and metafields. `snippets/hiltonian-hide.liquid` is the gatekeeper:

- Tag `hidden` on a product hides it from everyone
- Tag `draft` restricts to customers tagged `admin`
- Tag `vip` restricts to customers tagged `vip` or `admin`
- Tag `user: sometag` restricts to customers with that tag
- Metafields under `hiltonian.visibility_*` provide the same controls via metafields
- `hiltonian.hidden_locations` hides products by warehouse region
- `hiltonian.geo_show`/`geo_hide` metafields filter by country/zone

### Section Rendering Pattern

Sections use `data-section-type` attributes that `theme.js` uses to initialize JS behavior:

```html
<section data-section-id="{{ section.id }}" data-section-type="collection" data-section-settings='{{ section_settings }}'>
```

Section settings are passed as a JSON string in `data-section-settings`. The theme JS framework reads these on initialization.

### Colour Swatches

Products link to colour variations via `product.metafields.custom.colour_variations` (a list of product references). Each variant product has `product.metafields.custom.colour_code` for the swatch color. `custom.js` handles card-swapping when a swatch is clicked - it fetches alternate product cards and replaces the DOM node. The `dynamic-search` section is used by the Klevu search integration and is unrelated to swatch card swapping.

### Custom Events

```javascript
// Fired by geolocate.js when country is detected
document.addEventListener('country', event => { /* event.detail = 2-letter code */ });

// Theme events
document.addEventListener('variant:changed', event => { /* event.detail.variant */ });
document.addEventListener('product:added', event => { /* event.detail.variant, event.detail.quantity */ });
document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
```

## Git Workflow

- Feature branch, PR, merge to `main`. Never push directly to `main` (ruleset enforced: 1 approval + CODEOWNER review required, no bypass).
- CODEOWNER: @richard-disturbia (all files).
- PRs should be focused (one concern per PR). Include before/after Lighthouse screenshots for performance work.
- `config/settings_data.json` and `templates/*.json` are currently excluded from theme pulls/pushes via the CLI. Do not commit these without coordinating - they reflect live merchandising state.

## Third-Party Integrations

Loaded in `layout/theme.liquid`: jQuery, Klaviyo (email/analytics), PrimeAI (visual search on product pages), Google Ads (gtag with consent defaults denied), Yotpo (reviews/referrals), js.cookie, lazysizes. Search can use a bespoke Klevu integration (toggled by `settings.search_bespoke`).

## Performance Context

Current engagement targets mobile PSI improvement via CrUX field data. The main bottleneck is LCP on homepage (2.7s p75) caused by late discovery of hero images (1,963ms resource load delay). 84% of traffic is mobile. Measure with PageSpeed Insights field data, not lab scores.
