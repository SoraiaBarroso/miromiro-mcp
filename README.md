# miromiro-mcp

[![npm version](https://img.shields.io/npm/v/miromiro-mcp)](https://www.npmjs.com/package/miromiro-mcp)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

MCP server for the [MiroMiro](https://miromiro.app/api) design-extraction API. Give your AI agent the real design of any live website - brand colors, fonts, design tokens, SVGs, images, Lottie animations, and paste-ready component code - so it builds from actual values instead of guessing from a screenshot.

Works with Claude (web, desktop, Claude Code), ChatGPT, Cursor, Windsurf, Codex, and any MCP client.

## Claude Code plugin

Install as a plugin to get the tools plus five skills that teach Claude when to reach for
each one:

- `elementor-section` - any site's section as an Elementor template to import into WordPress
- `shopify-section` - any site's section as a Shopify theme section (`.liquid`)
- `clone-section` - a section as Tailwind, HTML+CSS, React or Vue
- `match-brand` - a site's colors, fonts and design tokens to build in its style
- `extract-assets` - images, SVG icons, videos, audio and Lottie files

```bash
claude plugin marketplace add SoraiaBarroso/miromiro-mcp
claude plugin install miromiro@miromiro
```

The plugin uses the remote server, so there is nothing to install and no key to paste - on
first use it opens a one-click MiroMiro sign-in that links a free account (300 credits/month,
no card).

## Skills for OpenClaw and other agents

The same skills live in [`skills/`](skills). Each one uses the MiroMiro MCP tools when they
are connected and otherwise calls the REST API with `MIROMIRO_API_KEY` (free key, 300
credits a month: https://miromiro.app/api/onboarding).

## Quick start: remote server (nothing to install)

A hosted server lives at:

```
https://miromiro.app/mcp
```

Paste that URL into any client that accepts a remote MCP server. On first use it opens a one-click MiroMiro sign-in that links a free account (300 credits/month, no card).

- **Claude (web or desktop):** Settings → Connectors → Add custom connector → paste the URL. Or use the [one-click install](https://miromiro.app/api/mcp).
- **ChatGPT:** Settings → Security and login → enable Developer mode, then Settings → Plugins → New Plugin with the URL (authentication: OAuth).
- **Cursor (remote):** add `{ "mcpServers": { "miromiro": { "url": "https://miromiro.app/mcp" } } }` to `~/.cursor/mcp.json`.
- **Claude Code:** `claude mcp add --transport http miromiro https://miromiro.app/mcp`, then `/mcp` in a session to sign in.
- **Codex:** add `[mcp_servers.miromiro]` with `url = "https://miromiro.app/mcp"` to `~/.codex/config.toml`, then run `codex mcp login miromiro`.
- **Grok Bot:** ask the bot "Add a custom MCP server called miromiro at https://miromiro.app/mcp", then press Authorize.
- **Muse:** Settings → Connectors → Add custom connector → paste the URL.
- Step-by-step pages for each agent: https://miromiro.app/api/agents/chatgpt (swap the last part for `claude`, `claude-code`, `codex`, `cursor`, `grok-bot`, `muse` or `openai-dots`).
- **Raw API key instead of OAuth:** append `?access_key=mm_live_...` to the URL, or send it as an `Authorization: Bearer` header.

## Local server (npm)

Prefer a local stdio process with the key in an env var? Get a free key at [miromiro.app/api/dashboard](https://miromiro.app/api/dashboard), then:

**Cursor** (`~/.cursor/mcp.json`) / **Windsurf** (Settings → MCP):

```json
{
  "mcpServers": {
    "miromiro": {
      "command": "npx",
      "args": ["-y", "miromiro-mcp"],
      "env": { "MIROMIRO_API_KEY": "mm_live_your_key" }
    }
  }
}
```

**Claude Code** (run in your terminal, not inside a `claude` session):

```bash
claude mcp add miromiro -s user \
  --env MIROMIRO_API_KEY=mm_live_your_key \
  -- npx -y miromiro-mcp
```

## Tools

| Tool | What it returns | Credits |
|---|---|---|
| `extract_code` | A section of a live page as a paste-ready component (Tailwind, HTML+CSS, JSX or Vue) or an importable Elementor template / Shopify section, plus the tokens it uses - start here to rebuild real UI | 25 |
| `extract_brand` | Named color roles (primary/accent/background/text), palette, fonts split by role, logo, social profiles, a 0-1 confidence score, and `signals` explaining where the colors came from (declared tokens vs inferred) | 15 |
| `extract_design_tokens` | Full token system with usage counts; `format: css` or `tailwind` for paste-ready output, `dtcg` for a W3C Design Tokens file (Style Dictionary / Figma variables) | 10 |
| `extract_fonts` | Every font file and family the site loads, with weights, formats, and file URLs | 5 |
| `extract_videos` | Video files, `og:video`, and player embeds (YouTube, Vimeo, Wistia, Loom), tagged by source; a direct video-file URL is returned as the single result, and a YouTube/Vimeo/TikTok/Dailymotion/Loom video URL returns its player embed without a fetch | 1 |
| `extract_audio` | Audio files, `og:audio`, and podcast enclosures, tagged by source; a direct audio-file URL is returned as the single result | 1 |
| `extract_lottie` | Lottie animation JSON files declared in the page | 3 |
| `extract_svgs` | Inline SVG code (sanitized, paste-ready) plus external SVG file URLs | 1 |
| `extract_assets` | Every image URL on a page, tagged by source, with alt text; a direct image-file URL is returned as the single result | 1 |

All tools are read-only and retry-safe. Identical calls within 24 hours are served from cache for free, and failed calls are never billed.

### Asking for a part of the page by name

`extract_code` takes `section` - one of `hero`, `header`, `footer`, `pricing`, `features`, `testimonials`, `faq`, `cta` - so the agent never has to invent a CSS selector for a page it cannot see. Every result also lists the page's other `sections` with ready selectors for follow-up calls. A selector or section that matches nothing falls back to the hero with a `note` saying what the page does have, instead of a dead-end 404.

### Prompts (slash commands)

The server exposes three MCP prompts, which clients surface before the first call - Claude Code as `/mcp__miromiro__clone_section`, `/mcp__miromiro__brand_kit` and `/mcp__miromiro__design_tokens`, VS Code as `/miromiro.<name>`, Cursor in its prompt menu:

| Prompt | Arguments | What it does |
|---|---|---|
| `clone_section` | `url`, `section?`, `framework?` | Rebuild a section of a live site as paste-ready code, with its real values, and list the other sections |
| `brand_kit` | `url` | The brand colors, fonts, logo and socials, explained (declared vs inferred) |
| `design_tokens` | `url`, `format?` | The complete token system as CSS, Tailwind, DTCG or JSON, with a short summary |

### Controlling output size (remote server)

Remote results are trimmed by default so a big page cannot flood the chat context, and every trimmed response says exactly what was dropped. Two optional arguments loosen it per call:

- `response_format: 'concise' | 'detailed'` - the one-word knob: `concise` keeps lists to 10 entries for a chat answer, `detailed` returns everything the tool has
- `limit` (up to 200) - raise the item cap: "give me 80 SVGs, not 20"
- `full_output: true` - complete long strings, like entire inline SVG markup

Generated code is never trimmed. Results stop at roughly 20k tokens (25k for `extract_code`) so they fit the tool-result cap of Claude Code, Claude Desktop and Cursor, and the `truncation_note` says how many tokens were cut and which argument brings them back.

The REST API and this local npm server always return everything untrimmed, so `limit` and
`full_output` apply to the remote server only. Every tool on both servers accepts
`render: true` (free accounts get 5 renders a month, then the call runs static and `usage.renderSkipped` says so; paid API plans and credit packs render without a monthly limit - see Notes), plus two more shared arguments:

- `fresh: true` - skip the 24-hour cache and re-extract the live page (charged normally); use when the site just changed
- `screenshot: true` (requires `render: true`) - the result gains a `screenshot` field: a public URL of a 1440x900 capture of the page, live for 7 days, at no extra credits - show it to the user to verify an extraction. Pass `'full'` instead of `true` for the entire page height.

## Examples

> "Rebuild stripe.com's pricing section in React"

The agent calls `extract_code` with the URL, gets the section's real markup, colors, fonts, and spacing, and adapts actual values instead of guessing.

Extraction returns a page's light styles by default, so a site you know as dark comes back light unless you ask otherwise:

> "Rebuild linear.app's pricing card in its dark theme"

The agent passes `theme: "dark"` and the page's `prefers-color-scheme: dark` rules and custom properties become the component itself. Every result also carries a `theme` field saying which one you actually got. Sites that switch themes with a JavaScript class toggle cannot be selected this way - you get the page default plus a hint saying so.

> "Build a dashboard in the style of linear.app"

The agent calls `extract_brand` and `extract_design_tokens`, gets Linear's real colors, fonts, and spacing scale, and builds to match.

> "What fonts does apple.com use?"

The agent calls `extract_fonts` and returns every family with its font file URLs and weights.

## Notes

- The API reads static HTML and resolves the full CSS cascade by default, so a fully client-rendered app may return little for images, video, audio and Lottie (tokens, fonts, brand, and code come from CSS and are unaffected). Pass `render: true` on any remote-server tool to run the page in a real browser first so its JavaScript executes (+5 credits). Free accounts get 5 renders a month (`usage.freeRender` reports each one and how many are left); after that a `render: true` call runs as the static extraction and `usage.renderSkipped` says so - never a refusal. Paid API plans and credit packs render without a monthly limit.
- The same allowance also works without the flag: when the SITE refuses a free account's plain request (401, 403 or 406 - publishers commonly turn away datacenter IPs even for a public page), the server retries that call in a real browser automatically and free, a few times a month. The result then carries `usage.renderRescue` (a sentence to read to the user) and `usage.renderRescuesLeft`. So on a free account, do not treat a 401/403/406 as "this site cannot be extracted" until those are used up.
- Every result carries `usage` with the credits left this month. If the account holds a credit pack (one-off credits that never expire, bought at https://miromiro.app/api/pricing), `usage.packCredits` is the pack balance left; packs are drawn after the monthly credits, so a free account with a pack keeps working past its 300 credits.
- Respect the sites you extract from: check their terms before reusing assets commercially.

## Links

[API docs](https://miromiro.app/api/docs) · [Playground (no account)](https://miromiro.app/api/demo) · [Pricing](https://miromiro.app/api/pricing) · [Changelog](https://miromiro.app/api/changelog) · [Connect page](https://miromiro.app/api/mcp)

MIT © [MiroMiro](https://miromiro.app)
