# miromiro-mcp

[![npm version](https://img.shields.io/npm/v/miromiro-mcp)](https://www.npmjs.com/package/miromiro-mcp)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

MCP server for the [MiroMiro](https://miromiro.app/api) design-extraction API. Give your AI agent the real design of any live website - brand colors, fonts, design tokens, SVGs, images, Lottie animations, and paste-ready component code - so it builds from actual values instead of guessing from a screenshot.

Works with Claude (web, desktop, Claude Code), ChatGPT, Cursor, Windsurf, Codex, and any MCP client.

## Claude Code plugin

Install as a plugin to get the tools plus three skills that teach Claude when to reach for
each one (`clone-section`, `match-brand`, `extract-assets`):

```bash
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin install miromiro@claude-community
```

The plugin uses the remote server, so there is nothing to install and no key to paste - on
first use it opens a one-click MiroMiro sign-in that links a free account (100 credits/month,
no card).

## Quick start: remote server (nothing to install)

A hosted server lives at:

```
https://miromiro.app/mcp
```

Paste that URL into any client that accepts a remote MCP server. On first use it opens a one-click MiroMiro sign-in that links a free account (100 credits/month, no card).

- **Claude (web or desktop):** Settings → Connectors → Add custom connector → paste the URL. Or use the [one-click install](https://miromiro.app/api/mcp).
- **ChatGPT:** Settings → Security and login → enable Developer mode, then add the URL as a connector (authentication: OAuth).
- **Cursor (remote):** add `{ "mcpServers": { "miromiro": { "url": "https://miromiro.app/mcp" } } }` to `~/.cursor/mcp.json`.
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
| `extract_code` | A section of a live page as a paste-ready component (Tailwind, HTML+CSS, JSX or Vue) plus the tokens it uses - start here to rebuild real UI | 25 |
| `extract_brand` | Named color roles (primary/accent/background/text), palette, fonts split by role, logo, social profiles, and a 0-1 confidence score | 15 |
| `extract_design_tokens` | Full token system with usage counts; `format: css` or `tailwind` for paste-ready output | 10 |
| `extract_fonts` | Every font file and family the site loads, with weights, formats, and file URLs | 5 |
| `extract_videos` | Video files, `og:video`, and player embeds (YouTube, Vimeo, Wistia, Loom), tagged by source | 1 |
| `extract_audio` | Audio files, `og:audio`, and podcast enclosures, tagged by source | 1 |
| `extract_lottie` | Lottie animation JSON files declared in the page | 3 |
| `extract_svgs` | Inline SVG code (sanitized, paste-ready) plus external SVG file URLs | 1 |
| `extract_assets` | Every image URL on a page, tagged by source, with alt text | 1 |

All tools are read-only and retry-safe. Identical calls within 24 hours are served from cache for free, and failed calls are never billed.

### Controlling output size (remote server)

Remote results are trimmed by default so a big page cannot flood the chat context, and every trimmed response says exactly what was dropped. Two optional arguments loosen it per call:

- `limit` (up to 200) - raise the item cap: "give me 80 SVGs, not 20"
- `full_output: true` - complete long strings, like entire inline SVG markup

The REST API and this local npm server always return everything untrimmed, so `limit` and
`full_output` apply to the remote server only. Every tool on both servers accepts
`render: true`.

## Examples

> "Rebuild stripe.com's pricing section in React"

The agent calls `extract_code` with the URL, gets the section's real markup, colors, fonts, and spacing, and adapts actual values instead of guessing.

> "Build a dashboard in the style of linear.app"

The agent calls `extract_brand` and `extract_design_tokens`, gets Linear's real colors, fonts, and spacing scale, and builds to match.

> "What fonts does apple.com use?"

The agent calls `extract_fonts` and returns every family with its font file URLs and weights.

## Notes

- The API reads static HTML and resolves the full CSS cascade by default, so a fully client-rendered app may return little for images, video, audio and Lottie (tokens, fonts, brand, and code come from CSS and are unaffected). Pass `render: true` on any remote-server tool to run the page in a real browser first so its JavaScript executes (+5 credits).
- Respect the sites you extract from: check their terms before reusing assets commercially.

## Links

[API docs](https://miromiro.app/api/docs) · [Playground (no account)](https://miromiro.app/api/demo) · [Pricing](https://miromiro.app/api/pricing) · [Changelog](https://miromiro.app/api/changelog) · [Connect page](https://miromiro.app/api/mcp)

MIT © [MiroMiro](https://miromiro.app)
