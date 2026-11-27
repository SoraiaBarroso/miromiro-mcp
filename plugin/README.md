# MiroMiro plugin for Claude

Turn any live website into code your project can use. MiroMiro reads a public page the way a
designer's inspector does and gives Claude the real values behind it: a section as Tailwind,
HTML, React or Vue, an Elementor template for WordPress or a Shopify Liquid section, plus the
site's brand colors, fonts, design tokens, SVGs, images and Lottie animations.

The plugin connects Claude to the remote MiroMiro MCP server (`https://miromiro.app/mcp`).
You sign in with your MiroMiro account the first time a tool runs (OAuth); no API key is stored
on your machine. The free plan includes 300 credits a month.

## Data it sends

When a tool runs, the plugin sends MiroMiro the public URL you asked about and the tool's
options (such as the section, framework or theme). MiroMiro loads that page on its servers and
returns the result. Nothing else from your project files or your conversation is sent, and the
plugin runs no code on your machine.

## Skills

- `clone-section`: rebuild a section of a live site as component code
- `match-brand`: build new UI in the style of an existing site
- `extract-assets`: pull images, SVG icons, videos, audio and Lottie files off a page
- `elementor-section`: turn a section into an Elementor template for WordPress
- `shopify-section`: turn a section into a Shopify theme section

## Install

In Claude Code:

```
claude plugin marketplace add SoraiaBarroso/miromiro-mcp
claude plugin install miromiro@miromiro
```

## Links

- Docs: https://miromiro.app/api/mcp
- Support: https://miromiro.app/contact
- Privacy policy: https://miromiro.app/api/legal/privacy
- Terms: https://miromiro.app/api/legal/terms
