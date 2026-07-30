#!/usr/bin/env node
/**
 * MiroMiro MCP server (playbook §3).
 *
 * Exposes the MiroMiro design-extraction API as MCP tools so a coding agent
 * (Cursor / Claude Code / Windsurf) can pull the real design of any URL and
 * build UI in that style — instead of guessing at colors and fonts.
 *
 * Auth: set MIROMIRO_API_KEY in the environment (get one free, no card, at
 * https://miromiro.app/api/dashboard).
 *
 * Run:  MIROMIRO_API_KEY=mm_live_… npx miromiro-mcp
 * Or wire it into your agent's MCP config (see README).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE = process.env.MIROMIRO_API_BASE || 'https://miromiro.app/api/v1'
const API_KEY = process.env.MIROMIRO_API_KEY

// Tool → endpoint map. Each tool takes a single `url` (design_tokens also takes
// an optional `format`). Descriptions are written for the agent, so it knows
// WHEN to reach for each one.
// Every tool is a read against the public web: no writes, retry-safe (cached
// repeats), open-world. Clients use readOnlyHint to label tools as safe.
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

// Shared input arg: every tool accepts render=true to execute the page's
// JavaScript in a real (rented) browser before extraction - the fix for
// client-rendered React/Next/SPA sites that return little statically.
const RENDER_ARG = {
  type: 'boolean',
  description: 'Run the page in a real browser first so its JavaScript executes - use for client-rendered (React/Next/SPA) sites, or when a normal call came back thin. Slower, and adds 5 credits to the call.'
}

// Shared input arg: skip the 24h cache for this one call (charged normally).
const FRESH_ARG = {
  type: 'boolean',
  description: 'Skip the 24-hour cache and re-extract the live page - use when the site just changed and a cached result would be stale. Charged normally; the fresh result replaces the cached copy.'
}

// Shared input arg: a screenshot URL alongside the data (requires render=true).
const SCREENSHOT_ARG = {
  type: ['boolean', 'string'],
  description: "Requires render=true. Adds a screenshot field to the result: a public URL of a capture of the page (live 7 days), taken by the same browser that rendered it. Pass true for the 1440x900 viewport or 'full' for the entire page height. No extra credits beyond the render surcharge. Useful for showing the user what the extracted site looks like."
}

const TOOLS = [
  {
    name: 'extract_code',
    title: 'Extract section as code',
    endpoint: 'code',
    description:
      "Turn a section of a LIVE website into clean, paste-ready component code. Give it a URL and (optionally) a CSS selector; it resolves the page's real CSS cascade and returns a self-contained component in Tailwind, plain HTML+CSS, React (JSX) or Vue — plus the design tokens that section actually uses. The response also includes `sections`: every extractable section on the page with a human-readable label and a ready selector — when the user wants a specific part (pricing, footer, testimonials), find it there and call again with that selector. For jsx/vue, repeated structures (pricing tiers, testimonial cards, feature lists) are collapsed into a data array rendered with .map()/v-for - one template plus the data, like a human would write it. The section's ::before/::after decorations come back as real elements, dark-mode styles as dark: variants, and its @keyframes ship in the css field. USE THIS whenever the user asks to rebuild, clone, port, or copy a section of a real website: it returns the actual code with true colors, fonts, spacing and copy, so you adapt real values instead of guessing from a screenshot. Note: it reads static HTML/CSS by default - summary.styledCoverage (0-100) tells you how much styling resolved, and a client-rendered app that returns little includes a hint field saying to call again with render=true (+5 credits). Follow it.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL, e.g. stripe.com' },
        selector: { type: 'string', description: 'CSS selector for the section to extract, e.g. "#hero" or ".pricing-card". Omit to auto-detect the hero.' },
        framework: { type: 'string', enum: ['tailwind', 'html', 'jsx', 'vue'], description: 'The code to generate (default tailwind).' },
        name: { type: 'string', description: 'Component name for the jsx/vue targets (default ExtractedSection).' },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    }
  },
  {
    name: 'extract_brand',
    title: 'Extract brand identity',
    endpoint: 'brand',
    description:
      "Get a website's curated brand identity: color roles (primary, accent, background, text) read from the site's own CSS variables and logo — each as hex plus a human-readable name like 'Royal Blue' — dark/light theme detection, the brand palette, fonts split by role (primary/mono), logo, social image, the brand's social profiles (X, GitHub, LinkedIn, …), and a 0-1 confidence score for how much the site declared vs how much was inferred. Use this when you only need a site's STYLE (colors/fonts) rather than its code — to build new UI 'in the style of' a reference site. If you need the actual markup of a section, use extract_code instead.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL, e.g. stripe.com' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  },
  {
    name: 'extract_design_tokens',
    title: 'Extract design tokens',
    endpoint: 'extract',
    description:
      "Extract the full design-token system of a URL: every color, font family, font size, border radius, box shadow, line height and z-index (with usage counts). Pass format='css' for a :root {} block, format='tailwind' for a tailwind.config, or format='dtcg' for a standalone W3C Design Tokens file (drops into Style Dictionary / Figma variables pipelines). Use when you need the complete token set, not just the brand summary.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL' },
        format: { type: 'string', enum: ['json', 'css', 'tailwind', 'dtcg'], description: "Output shape (default json). 'dtcg' returns a W3C Design Tokens file." },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    }
  },
  {
    name: 'extract_assets',
    title: 'Extract images',
    endpoint: 'images',
    description:
      "List every image on a page (img, srcset, picture, CSS background, favicon, og:image) as resolved URLs tagged by source. Use to recover imagery from a site or pull reference assets. Best-effort from static HTML: if images are mounted by JavaScript, call again with render=true (+5 credits).",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  },
  {
    name: 'extract_svgs',
    title: 'Extract SVGs',
    endpoint: 'svg',
    description:
      "Extract inline SVGs (as paste-ready code) and SVG file references from a page. Use to grab icons and vector logos. Best-effort from static HTML: if icons are mounted by JavaScript, call again with render=true (+5 credits).",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  },
  {
    name: 'extract_fonts',
    title: 'Extract fonts',
    endpoint: 'fonts',
    description:
      "Detect the real typography a site loads by resolving its full CSS cascade: every @font-face file with family/weight/style/format, Google Fonts links, preloads, plus a grouped per-family summary (families). Pass fields='families' for just the summary. Use to match typography.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL' },
        fields: { type: 'string', description: "Optional comma-separated fields to return (e.g. 'families')" },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    }
  },
  {
    name: 'extract_lottie',
    title: 'Extract Lottie animations',
    endpoint: 'lottie',
    description:
      "Find Lottie/animation JSON files declared on a page. Best-effort from static HTML - most Lotties are runtime-injected, so pass render=true to execute the page JS first and catch those too (+5 credits). Use to recover animations.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  },
  {
    name: 'extract_videos',
    title: 'Extract videos',
    endpoint: 'videos',
    description:
      'List every video a page declares: <video>/<source> files, og:video, player embeds (YouTube, Vimeo, Wistia, Loom) and direct video-file links - each tagged by source, with a poster image when declared. Note `source: "embed"` is a player page, not a downloadable file. Best-effort from static HTML: most sites mount their player with JavaScript, so if the result is thin or empty, call again with render=true to execute the page JS first (+5 credits).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  },
  {
    name: 'extract_audio',
    title: 'Extract audio',
    endpoint: 'audio',
    description:
      'List every audio file a page declares: <audio>/<source> files, og:audio, and direct audio-file links such as podcast enclosures and download buttons - each tagged by source. Best-effort from static HTML: if a JavaScript player mounts the audio at runtime, call again with render=true (+5 credits).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    }
  }
]

// Query params a tool may forward to the API, beyond `url`. Anything else in the
// tool arguments is ignored, so a hallucinated param can't reach the endpoint.
const FORWARDED_PARAMS = ['format', 'selector', 'framework', 'name', 'fields', 'render', 'fresh', 'screenshot']

async function callApi(endpoint, args) {
  const q = new URLSearchParams({ url: args.url })
  for (const p of FORWARDED_PARAMS) {
    if (args[p] !== undefined && args[p] !== null && args[p] !== '') {
      q.set(p, String(args[p]))
    }
  }
  const res = await fetch(`${API_BASE}/${endpoint}?${q}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  })
  const isJson = (res.headers.get('content-type') || '').includes('application/json')
  const body = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = isJson ? (body.statusMessage || body.message || JSON.stringify(body)) : body
    throw new Error(`MiroMiro API ${res.status}: ${msg}`)
  }
  // Compact JSON: pretty-printing spends ~30% more model context on whitespace.
  return isJson ? JSON.stringify(body) : body
}

const server = new Server(
  { name: 'miromiro', version: '0.4.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, ...TOOL_ANNOTATIONS }
  }))
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!API_KEY) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'MIROMIRO_API_KEY is not set. Get a free key at https://miromiro.app/api/dashboard and set it in your MCP config env.' }]
    }
  }
  const tool = TOOLS.find(t => t.name === req.params.name)
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
  }
  const args = req.params.arguments || {}
  if (!args.url) {
    return { isError: true, content: [{ type: 'text', text: 'The "url" argument is required.' }] }
  }
  try {
    const out = await callApi(tool.endpoint, args)
    return { content: [{ type: 'text', text: out }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('miromiro-mcp running on stdio')
