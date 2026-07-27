---
description: Rebuild a section of a real website as component code. Use when the user asks to clone, copy, port, recreate, or rebuild part of a live site (a hero, pricing table, footer, navbar), or says "make it look like <url>" and wants actual markup rather than just colors.
---

# Rebuild a section from a live site

Use the `extract_code` tool. It resolves the page's real CSS cascade and returns a
self-contained component with the site's true colors, fonts, spacing and copy, so you
adapt real values instead of guessing from a screenshot.

## Picking the section

Call `extract_code` with just the `url` first. It auto-detects the hero and — this is the
part worth using — returns a `sections` array listing every extractable section on the page
with a human-readable label and a ready-to-use selector.

When the user wants a specific part ("their pricing table", "the footer"), read `sections`
from that first response, find the matching entry, and call again with its `selector`.
Guessing a selector like `.pricing` wastes a call; the `sections` list already has the
real one.

## Choosing the framework

Match the user's project, don't default blindly:

- `tailwind` (default) — Tailwind utility classes in the markup
- `jsx` — a React component; pass `name` to set the component name
- `vue` — a single-file component; `name` applies here too
- `html` — plain HTML plus a companion `css` string

If the repo you are working in already uses one of these, use it without asking.

## When a result comes back thin

The API reads static HTML and CSS by default. A fully client-rendered app (React, Next,
most SPAs) may return very little. When that happens, call again with `render: true` — it
runs the page in a real browser so its JavaScript executes first. It is slower and costs
5 extra credits, so treat it as the retry, not the default.

## After you get the code

Adapt rather than paste verbatim:

- Keep the extracted colors, fonts, spacing and copy — that fidelity is the whole point.
- Rewrite the structure to fit the target project's conventions and component patterns.
- Swap any absolute asset URLs for local assets, or keep them if the user wants a
  reference build.
- The response also carries the design tokens that section actually uses. Wire those into
  the project's theme instead of hardcoding hex values, when the project has a theme.

Remind the user to check a site's terms before reusing its assets or copy commercially.
Extracting for reference and learning is fine; republishing someone's content is theirs to
license, not yours to assume.
