---
name: clone-section
description: Rebuild a section of a real website as component code. Use when the user asks to clone, copy, port, recreate, or rebuild part of a live site (a hero, pricing table, footer, navbar), or says "make it look like <url>" and wants actual markup rather than just colors.
---

# Rebuild a section from a live site

Use the `extract_code` tool. It resolves the page's real CSS cascade and returns a
self-contained component with the site's true colors, fonts, spacing and copy, so you
adapt real values instead of guessing from a screenshot.

## Picking the section

When the user names a part of the page ("their pricing table", "the footer", "the nav"),
pass it as `section`: one of `hero`, `header`, `footer`, `pricing`, `features`,
`testimonials`, `faq`, `cta`. MiroMiro finds that block on the page itself, so you never
have to see the markup. Never invent a CSS selector like `.pricing` - a selector that
matches nothing falls back to the hero with a `note`, and the guess still costs a call.

With no `section`, `extract_code` auto-detects the hero. Every response also returns a
`sections` array listing the other extractable sections with a human-readable label and a
ready-to-use selector: when the part the user wants is not one of the named sections, find
it there and call again with that `selector`.

## Choosing the framework

Match the user's project, don't default blindly:

- `tailwind` (default) — Tailwind utility classes in the markup
- `jsx` — a React component; pass `name` to set the component name. Repeated structures
  (tiers, cards, list items) come back as one template plus a `const items = […]` array
  rendered with `.map()` — use the data array, don't re-expand it.
- `vue` — a single-file component with `<script setup>`; `name` applies here too, and
  repeated structures collapse into a `v-for` the same way
- `html` — plain HTML plus a companion `css` string

For every framework, the `css` field may also carry the section's `@keyframes` — add
those to the project's global stylesheet or the animations silently do nothing.

If the repo you are working in already uses one of these, use it without asking.

## Light or dark

Pass `theme: "dark"` when the user is looking at the site in dark mode or asks for the
dark version; the response's `theme` field reports which one you actually got, so tell the
user when it differs from what they see. Sites that switch themes purely in JavaScript
cannot be selected this way.

## When a result comes back thin

The API reads static HTML and CSS by default, and the response tells you how it went:
`summary.styledCoverage` (0-100) is the percentage of elements the CSS cascade resolved
styles for, and when the page is client-rendered or styles itself at runtime the response
includes a `hint` field saying what to do. When you see the `hint` (or coverage is low),
call again with `render: true` — it runs the page in a real browser so its JavaScript
executes first. It is slower and costs 5 extra credits, so treat it as the retry, not
the default. With `render: true` you can also pass `screenshot: true` (or `"full"`) to get
a URL of the rendered page, useful to show the user what was extracted.

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
