---
description: Build new UI in the visual style of an existing site. Use when the user says "in the style of <url>", "match our brand", "use their colors and fonts", or wants a theme, palette, tailwind config or CSS variables derived from a real website rather than a section's markup.
---

# Build in the style of a real site

Two tools cover this, and picking the right one matters more than it looks.

## Which tool

**`extract_brand`** — the curated identity. Color roles already resolved to
`primary` / `accent` / `background` / `text`, each with a hex and a human-readable name,
plus dark/light theme detection, fonts split by role (primary/mono), logo, social image,
and a 0-1 `confidence` score for how much the site declared versus how much was inferred.

Reach for this when you are designing something new and need a small set of decisions you
can act on. It is the right default for "make it feel like linear.app".

**`extract_design_tokens`** — the exhaustive system. Every color, font family, font size,
border radius, box shadow, line height and z-index, each with usage counts. Reach for this
when you need the full scale, not a summary: building a theme file, a spacing scale, or
matching an existing design system closely.

Do not call both by reflex. `extract_brand` for direction, `extract_design_tokens` for
completeness.

## Getting paste-ready output

`extract_design_tokens` takes a `format`:

- `json` (default) — structured, with usage counts, best when you are reasoning about it
- `css` — a `:root {}` block of custom properties
- `tailwind` — a `tailwind.config` fragment

If the target project uses Tailwind or CSS variables, ask for that format directly instead
of converting the JSON yourself. Fewer transcription errors.

## Reading the confidence score

`extract_brand` returns `confidence` between 0 and 1. A low score means the site declared
little and MiroMiro inferred most of it — usually a site with no CSS variables and no
theme-color. When confidence is low, say so rather than presenting inferred colors as the
brand's official palette, and consider `extract_design_tokens` to see what the site
actually uses by frequency.

## Typography

`extract_fonts` is the specialist when the question is only about type. It resolves the
full cascade and returns every `@font-face` file with family, weight, style and format,
plus Google Fonts links and preloads. Pass `fields: "families"` for just the grouped
per-family summary when you do not need individual file URLs.

Note that knowing which font a site loads is not a license to use it. Commercial fonts
need their own license — flag this if the user is heading toward production.

## When results look thin

The API reads static HTML and CSS by default. For a client-rendered app, retry with
`render: true` to execute the page's JavaScript first (+5 credits). Brand, tokens and
fonts come from CSS and usually survive without it, so try the normal call first.
