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
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
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

// Sections an agent can ask for by name instead of inventing a CSS selector
// (mirrors NAMED_SECTIONS in the API's extractCode.ts).
const NAMED_SECTIONS = ['hero', 'header', 'footer', 'pricing', 'features', 'testimonials', 'faq', 'cta']

// Shared input arg: every tool accepts render=true to execute the page's
// JavaScript in a real (rented) browser before extraction - the fix for
// client-rendered React/Next/SPA sites that return little statically.
const RENDER_ARG = {
  type: 'boolean',
  description: 'Run the page in a real browser first so its JavaScript executes - use for client-rendered (React/Next/SPA) sites, when a normal call came back thin, or after a 403 target_blocked (bot protection refuses plain HTTP requests but usually lets a browser through). Slower, and adds 5 credits to the call.'
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

// Shared fragments for the output schemas below, mirrored from the remote
// server (server/utils/mcpRemote.ts). Every schema keeps additionalProperties
// true and requires only `url`: the /v1 responses can carry extras (usage,
// note, truncation_note) and a strict schema that drifts from the
// implementation would make clients reject valid results.
const OUT_USAGE = { type: 'object', description: 'Credit usage for the authed key (spent, remaining, monthly limit).' }
const OUT_TRUNCATION = { type: 'string', description: 'Present when the result was trimmed - says what was dropped and how to get more.' }
const countedList = (valueKey, desc) => ({
  type: 'array',
  description: desc,
  items: {
    type: 'object',
    properties: { [valueKey]: { type: 'string' }, count: { type: 'number', description: 'How many times it is used on the page' } }
  }
})

const TOOLS = [
  {
    name: 'extract_code',
    title: 'Extract section as code',
    endpoint: 'code',
    description:
      "Use when the user asks to rebuild, clone, copy, port, restyle or 'make it look like' part of a real website, or wants a site's section as Tailwind, HTML+CSS, React (JSX) or Vue. Give it the URL and, when the user named a part of the page, section (hero, header, footer, pricing, features, testimonials, faq, cta) - never invent a CSS selector. With neither, it auto-detects the hero; every call also returns `sections`, each other extractable section with a label and a ready selector for a follow-up call. Returns a self-contained component with the page's real resolved styles (true colors, fonts, spacing, copy) plus the tokens and assets it uses, so you adapt real values instead of estimating from a screenshot. For jsx/vue, repeated structures collapse into a data array rendered with .map()/v-for; ::before/::after come back as real elements; @keyframes ship in the css field. The `theme` field says which theme the code actually is - sites with a prefers-color-scheme dark variant return the light branch unless you pass theme='dark'; say which you returned. Not for: whole-page scraping, page text, or sites that need a login. Reads static HTML/CSS by default; if the result is thin or carries a `hint`, call again with render=true (+5 credits).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL, e.g. stripe.com' },
        section: { type: 'string', enum: NAMED_SECTIONS, description: "Which part of the page, by name - use this when the user asked for the pricing, footer, header/nav, features, testimonials, FAQ or call-to-action block. Resolved on the page itself, so it works without seeing the markup. Omit for the hero. If the page has no such section you get the hero plus a `note` listing what is there." },
        selector: { type: 'string', description: 'CSS selector for the section, ONLY when you have one from a previous result\'s `sections` list (e.g. "section.pricing-grid"). Do not guess selectors: a selector that matches nothing falls back to the hero with a `note`, and the guess costs a call. Prefer `section` for named parts of a page.' },
        framework: { type: 'string', enum: ['tailwind', 'html', 'jsx', 'vue'], description: 'The code to generate (default tailwind).' },
        name: { type: 'string', description: 'Component name for the jsx target (default ExtractedSection). Ignored by tailwind, html and vue. Renaming never re-runs the extraction - it costs 0 credits on a cached section.' },
        theme: { type: 'string', enum: ['light', 'dark'], description: "Which colour scheme to extract (default light). Pass 'dark' when the user is looking at the site in dark mode or asks for the dark version: the page's prefers-color-scheme: dark rules and custom properties become the component itself instead of riding along as dark: variants. Works whether the site expresses its themes as @media (prefers-color-scheme) or as a root attribute/class the CSS is scoped to ([data-theme=dark], html.dark). Sites that switch themes purely in JavaScript cannot be selected this way - you get the page default plus a hint saying so. No extra credits." },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        selector: { type: 'string', description: 'The CSS selector that was extracted' },
        section: { type: 'string', description: 'The named section that was resolved, when one was requested' },
        autoDetected: { type: 'boolean', description: 'True when the hero was auto-detected rather than passed in' },
        note: { type: 'string', description: 'Present when the requested selector or section was not found and the hero was returned instead - says what was asked for and which sections the page does have. Tell the user.' },
        sections: {
          type: 'array',
          description: 'Every extractable section on the page - call again with one of these selectors for a specific part',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              label: { type: 'string' },
              elements: { type: 'number' },
              hasHeading: { type: 'boolean' },
              preview: { type: 'string' }
            }
          }
        },
        framework: { type: 'string', description: 'tailwind | html | jsx | vue' },
        code: { type: 'string', description: 'The generated, paste-ready component code. For jsx/vue, repeated structures (tiers, cards, list items) are collapsed into a data array rendered with .map()/v-for' },
        css: { type: 'string', description: 'Companion CSS: always set for framework=html; for other frameworks it carries the @keyframes the section uses (add to the global stylesheet)' },
        tokens: { type: 'object', description: 'Design tokens the extracted section actually uses' },
        theme: { type: 'string', description: "light | dark: which one the code you just received actually is. Measured from the page, never echoed from your request - so if you asked for a theme the site cannot serve, this reports what you really got. Tell the user which theme they got when it may not match what they see on the site" },
        assets: { description: 'Images/fonts the section references' },
        summary: { description: 'What was extracted, at a glance. styledCoverage (0-100) is the quality signal: the % of elements the cascade found styles for' },
        hint: { type: 'string', description: 'Only present when the extraction looks degraded (client-rendered page, runtime-injected styles) - says what to do: on a static call usually retry with render=true; on a render=true call the styles could not be resolved even in a browser, do not retry' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_brand',
    title: 'Extract brand identity',
    endpoint: 'brand',
    description:
      "Use when the user wants a site's brand: its colors, fonts, logo, theme or social links - 'what colors does stripe use', 'match this brand', 'build something in the style of X'. Returns role colors (primary, accent, background, text) as hex with human-readable names, the wider palette, fonts by role, logo candidates, social profiles, dark/light theme, and a 0-1 confidence score with `signals` explaining where the colors came from: read signals.explanation and tell the user whether they were declared by the site ('css-var'/'theme-color') or inferred from usage frequency ('usage', a guess) - never present inferred colors as the official palette. Not for: markup or layout (use extract_code) or the full token list (use extract_design_tokens).",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL, e.g. stripe.com' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: ['string', 'null'], description: 'Page/og title - the brand name' },
        description: { type: ['string', 'null'] },
        siteName: { type: ['string', 'null'] },
        themeColor: { type: ['string', 'null'], description: "The site's own declared theme-color" },
        theme: { type: 'string', description: 'dark | light' },
        colors: { type: 'object', description: 'Role colors as hex: primary, accent, background, text' },
        colorNames: { type: 'object', description: 'Human-readable names for the role colors ("Royal Blue")' },
        palette: {
          type: 'array',
          description: 'The wider brand palette',
          items: { type: 'object', properties: { color: { type: 'string' }, count: { type: 'number' }, name: { type: ['string', 'null'] } } }
        },
        fonts: { type: 'array', items: { type: 'string' } },
        typography: { type: 'object', description: 'Fonts split by role: primary, mono' },
        logo: { type: ['string', 'null'], description: 'Best single logo URL' },
        logos: { type: 'array', description: 'All icon/logo candidates, tagged by source' },
        ogImage: { type: ['string', 'null'] },
        socials: {
          type: 'array',
          description: 'Social profiles found on the page',
          items: { type: 'object', properties: { platform: { type: 'string' }, url: { type: 'string' }, handle: { type: ['string', 'null'] } } }
        },
        confidence: { type: 'number', description: '0-1: how much the site declared vs how much was inferred' },
        signals: {
          type: 'object',
          description: "WHY the result looks the way it does - the provenance behind `confidence`. Read `signals.explanation` and tell the user what it says instead of quoting the confidence number, which means nothing to them on its own. `primarySource` is the key field: 'css-var' or 'theme-color' means the site declared these colors and they are its real tokens; 'logo' means they were sampled from its logo; 'usage' means nothing was declared and the colors are a frequency-based GUESS - say so rather than presenting them as the brand's official palette.",
          properties: {
            primarySource: { type: ['string', 'null'], description: "css-var | theme-color | logo | usage | null - where colors.primary came from, strongest first. 'usage' is inferred, not declared." },
            declaredBackground: { type: 'boolean', description: 'The background role came from a declared CSS variable' },
            declaredText: { type: 'boolean', description: 'The text role came from a declared CSS variable' },
            declaredLogo: { type: 'boolean', description: 'A real logo was found, not just an og:image fallback' },
            fontsFound: { type: 'number', description: 'How many font families resolved from the CSS cascade' },
            explanation: { type: 'string', description: 'One ready-to-relay sentence describing how much was declared vs inferred. Repeat this to the user when the extraction is uncertain.' }
          }
        },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_design_tokens',
    title: 'Extract design tokens',
    endpoint: 'extract',
    description:
      "Use when the user wants a site's complete token system - every color, font family, size, weight, spacing value, radius, shadow, line height, gradient and breakpoint with usage counts - or a paste-ready :root block (format='css'), tailwind.config (format='tailwind') or W3C Design Tokens file (format='dtcg', for Style Dictionary / Figma variables). Returns values and counts only, not layout or which element uses what: if the user asked to rebuild or clone a section, use extract_code, which returns the markup with the values in place. A site shipping light and dark themes returns the union of both (see colorSchemes) - pick colors by role, not by frequency, and use extract_code with theme=dark for one theme on its own. Not for: a short brand summary (use extract_brand).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL' },
        format: { type: 'string', enum: ['json', 'css', 'tailwind', 'dtcg'], description: "Output shape (default json). 'dtcg' returns a W3C Design Tokens file." },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      description: "format='json' returns the token lists below; format='css'|'tailwind' returns { output } - the paste-ready code block - instead; format='dtcg' returns a standalone W3C Design Tokens document (groups keyed by $type).",
      properties: {
        url: { type: 'string' },
        colors: countedList('color', 'Every color with usage count'),
        fontFamilies: countedList('family', 'Font families with usage counts'),
        fontSizes: countedList('size', 'Font sizes with usage counts'),
        fontWeights: countedList('value', 'Font weights'),
        spacing: countedList('value', 'The spacing scale from margin/padding/gap'),
        borderRadiuses: countedList('value', 'Border radii'),
        boxShadows: countedList('value', 'Box shadows'),
        lineHeights: countedList('value', 'Line heights'),
        gradients: { type: 'array', description: 'Gradients with type (linear/radial/conic) and count' },
        breakpoints: countedList('value', 'Responsive breakpoints from media queries'),
        colorSchemes: { type: 'array', description: 'The colour schemes this page declares: ["light"] or ["light","dark"]. When both, the counts above are the union of the two themes and neither is labelled - pick colours by role, not by frequency, and use extract_code with theme=dark when you need one theme on its own' },
        summary: { type: 'object', description: 'Count per token group' },
        output: { type: 'string', description: "The paste-ready :root{} or tailwind.config block when format='css'|'tailwind'" },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: [],
      additionalProperties: true
    }
  },
  {
    name: 'extract_assets',
    title: 'Extract images',
    endpoint: 'images',
    description:
      "Use when the user wants the images from a page - photos, illustrations, backgrounds, favicon, social image - as resolved URLs tagged by source (img, srcset, picture, CSS background, favicon, og). Not for: icons and vector logos (use extract_svgs) or fonts (use extract_fonts). If images are mounted by JavaScript, call again with render=true (+5 credits).",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Resolved absolute image URL' },
              source: { type: 'string', description: 'img | srcset | picture | background | favicon | og' },
              alt: { type: 'string', description: 'Alt text when present' }
            },
            required: ['url', 'source']
          }
        },
        count: { type: 'number', description: 'Total images found (before any trimming)' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_svgs',
    title: 'Extract SVGs',
    endpoint: 'svg',
    description:
      "Use when the user wants a site's icons or vector logos: inline SVGs as paste-ready markup plus external .svg file URLs. Not for: raster images (use extract_assets). If icons are mounted by JavaScript, call again with render=true (+5 credits).",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        svgs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'inline | file' },
              code: { type: 'string', description: 'Sanitized paste-ready SVG markup (inline SVGs)' },
              url: { type: 'string', description: 'File URL (external .svg references)' }
            },
            required: ['type']
          }
        },
        count: { type: 'number', description: 'Total SVGs found (before any trimming)' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_fonts',
    title: 'Extract fonts',
    endpoint: 'fonts',
    description:
      "Use when the user asks which fonts a site uses or wants to match its typography: every @font-face file with family/weight/style/format, Google Fonts links and preloads, grouped per family in `families` (pass fields='families' for just that). On a type-foundry site the families served are demo cuts (subset, features stripped), flagged demo:true with a note - pass that on, they are not the usable typeface. Not for: colors (use extract_brand) or code (use extract_code).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL' },
        fields: { type: 'string', description: "Optional comma-separated fields to return (e.g. 'families')" },
        render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        fonts: {
          type: 'array',
          description: 'Every font file / stylesheet found',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'font-face | google-fonts | preload' },
              url: { type: 'string', description: 'The font file or stylesheet URL' },
              family: { type: 'string' },
              weight: { type: 'string', description: "'400', '700', or a variable range like '100 900'" },
              style: { type: 'string' },
              format: { type: 'string', description: 'woff2 | woff | ttf | otf | eot' }
            }
          }
        },
        families: {
          type: 'array',
          description: 'Grouped per-family summary - what most callers want',
          items: {
            type: 'object',
            properties: {
              family: { type: 'string' },
              source: { type: 'string' },
              weights: { type: 'array', items: { type: 'string' } },
              styles: { type: 'array', items: { type: 'string' } },
              files: { type: 'number' },
              demo: { type: 'boolean', description: 'The family name marks it a foundry demo/trial cut, not the real font' }
            }
          }
        },
        googleFontsLinks: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
        note: { type: 'string', description: 'Only present when demo/trial families were found - tell the user, these files are subset and feature-stripped, not the usable typeface' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_lottie',
    title: 'Extract Lottie animations',
    endpoint: 'lottie',
    description:
      "Use when the user wants a site's Lottie or animation JSON files. Most Lotties are injected at runtime, so pass render=true (+5 credits) when the static call finds none.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        lotties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The animation JSON / .lottie file URL' },
              source: { type: 'string', description: 'lottie-player | dotlottie-player | data-attr | json-ref' }
            },
            required: ['url']
          }
        },
        count: { type: 'number' },
        note: { type: 'string', description: 'Coverage caveat: only Lotties declared in the initial HTML are found' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_videos',
    title: 'Extract videos',
    endpoint: 'videos',
    description:
      'Use when the user wants the videos on a page: <video>/<source> files, og:video, YouTube/Vimeo/Wistia/Loom embeds and direct video links, each tagged by source with a poster when declared. `source: "embed"` is a player page, not a downloadable file. Most players mount with JavaScript: if the result is thin or empty, call again with render=true (+5 credits).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        videos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Resolved absolute video (or player page) URL' },
              source: { type: 'string', description: 'video | source | og | embed | link. embed is a player page, not a file.' },
              poster: { type: 'string', description: 'Poster image URL when the tag declared one' }
            },
            required: ['url', 'source']
          }
        },
        count: { type: 'number', description: 'Total videos found (before any trimming)' },
        note: { type: 'string', description: 'Coverage caveat: only videos declared in the initial HTML are found - use render=true for JS-mounted players' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  },
  {
    name: 'extract_audio',
    title: 'Extract audio',
    endpoint: 'audio',
    description:
      'Use when the user wants the audio files on a page: <audio>/<source> files, og:audio, podcast enclosures and download links, each tagged by source. If a JavaScript player mounts the audio at runtime, call again with render=true (+5 credits).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The website URL' }, render: RENDER_ARG, fresh: FRESH_ARG, screenshot: SCREENSHOT_ARG },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        audio: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Resolved absolute audio file URL' },
              source: { type: 'string', description: 'audio | source | og | link' }
            },
            required: ['url', 'source']
          }
        },
        count: { type: 'number', description: 'Total audio files found (before any trimming)' },
        note: { type: 'string', description: 'Coverage caveat: only audio declared in the initial HTML is found - use render=true for JS-mounted players' },
        usage: OUT_USAGE,
        truncation_note: OUT_TRUNCATION
      },
      required: ['url'],
      additionalProperties: true
    }
  }
]

// Query params a tool may forward to the API, beyond `url`. Anything else in the
// tool arguments is ignored, so a hallucinated param can't reach the endpoint.
const FORWARDED_PARAMS = ['format', 'selector', 'section', 'framework', 'name', 'theme', 'fields', 'render', 'fresh', 'screenshot']

// A selector/section that matched nothing. The API answers 404 (free); the
// stdio server then falls back to the hero so the agent gets the `sections`
// list in the same turn instead of a dead end - mirrors the remote server.
const SELECTOR_MISS_RE = /^No (element matched|"[a-z]+" section was found)/i

async function fetchApi(endpoint, q) {
  const res = await fetch(`${API_BASE}/${endpoint}?${q}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  })
  const isJson = (res.headers.get('content-type') || '').includes('application/json')
  const body = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = isJson ? (body.statusMessage || body.message || JSON.stringify(body)) : body
    const err = new Error(`MiroMiro API ${res.status}: ${msg}`)
    err.status = res.status
    err.apiMessage = String(msg)
    throw err
  }
  return { body, isJson }
}

async function callApi(endpoint, args) {
  const q = new URLSearchParams({ url: args.url })
  for (const p of FORWARDED_PARAMS) {
    if (args[p] !== undefined && args[p] !== null && args[p] !== '') {
      q.set(p, String(args[p]))
    }
  }
  let result
  let note = null
  try {
    result = await fetchApi(endpoint, q)
  } catch (err) {
    const asked = q.get('selector') ? `selector "${q.get('selector')}"` : q.get('section') ? `section "${q.get('section')}"` : null
    if (err.status !== 404 || !asked || !SELECTOR_MISS_RE.test(err.apiMessage || '')) throw err
    q.delete('selector')
    q.delete('section')
    result = await fetchApi(endpoint, q)
    note = `The requested ${asked} was not found on this page, so the auto-detected hero was returned instead. ` +
      'Pick the part the user wants from `sections` (call again with its selector) or pass section=' +
      `${NAMED_SECTIONS.filter(s => s !== 'hero').join('|')}. Tell the user which section you returned.`
  }
  const { body, isJson } = result
  // Compact JSON: pretty-printing spends ~30% more model context on whitespace.
  if (!isJson) return body
  return JSON.stringify(note && body && typeof body === 'object' && !Array.isArray(body) ? { ...body, note } : body)
}

// Prompts: the one MCP primitive a user sees BEFORE the first call. Claude Code
// lists them as /mcp__miromiro__<name>, VS Code as /miromiro.<name>, Cursor in
// its prompt menu. Same text as the remote server.
const PROMPT_URL_ARG = { name: 'url', description: 'The website URL, e.g. stripe.com', required: true }
const PROMPTS = [
  {
    name: 'clone_section',
    title: 'Clone a section of a live site',
    description: 'Rebuild a section of a real website (hero by default) as paste-ready code in the framework you use, with its real colors, fonts and spacing.',
    arguments: [
      PROMPT_URL_ARG,
      { name: 'section', description: `Which part: ${NAMED_SECTIONS.join(', ')} (default hero)` },
      { name: 'framework', description: 'tailwind (default), html, jsx or vue' }
    ],
    render: ({ url, section, framework }) =>
      `Rebuild the ${section || 'hero'} section of ${url} as ${framework || 'tailwind'} code I can paste into my project. ` +
      `Call extract_code with url="${url}"${section ? `, section="${section}"` : ''}${framework ? `, framework="${framework}"` : ''} ` +
      'and adapt the result: keep its real colors, fonts, spacing and copy, fix anything that is clearly page-specific, and tell me which theme (light or dark) the extraction returned. ' +
      'If the result is thin or carries a hint, retry with render=true before giving up. Then list the other sections the page has in case I want one of those next.'
  },
  {
    name: 'brand_kit',
    title: 'Brand kit from a URL',
    description: "A site's brand identity - role colors with names, fonts, logo, socials - explained, not dumped, with a note on how much was declared vs inferred.",
    arguments: [PROMPT_URL_ARG],
    render: ({ url }) =>
      `Give me the brand kit for ${url}: primary, accent, background and text colors (hex plus names), the fonts by role, the best logo URL and social profiles. ` +
      `Call extract_brand with url="${url}". Read signals.explanation and tell me whether the colors were declared by the site or inferred from usage; if they were inferred, say so plainly. ` +
      'Finish with one line on what I could extract next (a section as code, or the full token set).'
  },
  {
    name: 'design_tokens',
    title: 'Design tokens from a URL',
    description: "A site's complete token system as a paste-ready block: CSS custom properties, a Tailwind theme, or a W3C Design Tokens file.",
    arguments: [
      PROMPT_URL_ARG,
      { name: 'format', description: 'css (default), tailwind, dtcg or json' }
    ],
    render: ({ url, format }) =>
      `Extract the design tokens of ${url} as ${format || 'css'}. Call extract_design_tokens with url="${url}", format="${format || 'css'}". ` +
      'Return the block ready to paste, then summarise the system in a few lines: the palette by role, the type scale, the spacing and radius scale. ' +
      'If colorSchemes lists both light and dark, say that the values are the union of the two and that extract_code with theme=dark separates them.'
  }
]

// Server-level guidance, sent once at initialize. Mirrors the `instructions`
// string the remote server (miromiro.app/mcp) returns, so a stdio client gets
// the same steering as a hosted one — chiefly: explain results, don't just dump
// them, and never present inferred brand colors as declared ones.
const INSTRUCTIONS =
  'Use MiroMiro when the user wants anything from a real, live website\'s design: rebuild, clone, copy or ' +
  'restyle a section, or "make mine look like X" (extract_code); its brand colors, fonts and logo (extract_brand); ' +
  'its complete design-token set as CSS variables or a W3C tokens file (extract_design_tokens); or its images, ' +
  'SVG icons, font files, videos, audio or Lottie files (the extract_* asset tools). Any public URL works, no setup. ' +
  'Not for: general web scraping or search, page text, pages behind a login, or CSS questions with no specific site. ' +
  'How to call: give extract_code the URL plus section=hero|header|footer|pricing|features|testimonials|faq|cta when ' +
  'the user named a part of the page; never invent a CSS selector (a miss falls back to the hero with a `note`). Every ' +
  'result lists the page\'s other `sections` with ready selectors for follow-ups. Static HTML+CSS is read by default: when a result is thin, carries a ' +
  '`hint`, or a 403 target_blocked comes back, retry the SAME url with render=true (+5 credits) before telling the ' +
  'user a site cannot be extracted. Theme: a site with a prefers-color-scheme dark variant returns its light branch ' +
  'by default; pass theme=dark to extract_code for the dark version and report the `theme` field you actually got. ' +
  'extract_design_tokens returns values and counts, not layout - not a substitute for extract_code on a rebuild; ' +
  'format=dtcg gives a W3C Design Tokens file. Explain results, do not dump them: extract_brand\'s ' +
  'signals.explanation says whether the colors were declared by the site or inferred (primarySource "usage" = a ' +
  'guess) - repeat it to the user. Rendered calls accept screenshot=true for a public image URL of the page. ' +
  'fresh=true bypasses the 24h cache. Every result carries `usage` (credits left; `packCredits` = never-expiring pack balance when the account holds one).'

const server = new Server(
  { name: 'miromiro', version: '0.7.1' },
  { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS }
)

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }))
}))

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS.find(p => p.name === req.params.name)
  if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`)
  const args = req.params.arguments || {}
  const missing = prompt.arguments.filter(a => a.required && !args[a.name])
  if (missing.length) throw new Error(`Missing required argument: ${missing.map(a => a.name).join(', ')}`)
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }]
  }
})

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, title, description, inputSchema, outputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
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
    // A tool that declares an outputSchema must also return structuredContent
    // matching it (2025-06-18 spec), and structuredContent must be an object.
    // format=css|tailwind on the tokens endpoint returns a raw code string —
    // wrap it as { output }, which that tool's outputSchema declares.
    let structured
    try {
      const parsed = JSON.parse(out)
      structured = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { output: parsed }
    } catch {
      structured = { output: out } // non-JSON body (css/tailwind block)
    }
    return { content: [{ type: 'text', text: out }], structuredContent: structured }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('miromiro-mcp running on stdio')
