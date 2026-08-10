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
      "Turn a section of a LIVE website into clean, paste-ready component code. Give it a URL and (optionally) a CSS selector; it resolves the page's real CSS cascade and returns a self-contained component in Tailwind, plain HTML+CSS, React (JSX) or Vue — plus the design tokens that section actually uses. The response also includes `sections`: every extractable section on the page with a human-readable label and a ready selector — when the user wants a specific part (pricing, footer, testimonials), find it there and call again with that selector. For jsx/vue, repeated structures (pricing tiers, testimonial cards, feature lists) are collapsed into a data array rendered with .map()/v-for - one template plus the data, like a human would write it. The section's ::before/::after decorations come back as real elements, dark-mode styles as dark: variants, and its @keyframes ship in the css field. The `theme` field (light | dark) tells you which theme the returned code actually is - measured from the page, never echoed back from your request. A site that expresses its themes through a prefers-color-scheme media query returns its LIGHT branch by default, so pass theme='dark' when the user is looking at that site in dark mode or asks for its dark version; sites that scope themes to a root attribute or class are read correctly either way. Say which theme you returned. USE THIS whenever the user asks to rebuild, clone, port, or copy a section of a real website: it returns the actual code with true colors, fonts, spacing and copy, so you adapt real values instead of guessing from a screenshot. Note: it reads static HTML/CSS by default - summary.styledCoverage (0-100) tells you how much styling resolved, and a client-rendered app that returns little includes a hint field saying to call again with render=true (+5 credits). Follow it.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The website URL, e.g. stripe.com' },
        selector: { type: 'string', description: 'CSS selector for the section to extract, e.g. "#hero" or ".pricing-card". Omit to auto-detect the hero.' },
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
        autoDetected: { type: 'boolean', description: 'True when the hero was auto-detected rather than passed in' },
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
        hint: { type: 'string', description: 'Only present when the extraction looks degraded (client-rendered page, runtime-injected styles) - says what to do, usually retry with render=true' },
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
      "Get a website's curated brand identity: color roles (primary, accent, background, text) read from the site's own CSS variables and logo — each as hex plus a human-readable name like 'Royal Blue' — dark/light theme detection, the brand palette, fonts split by role (primary/mono), logo, social image, the brand's social profiles (X, GitHub, LinkedIn, …), and a 0-1 confidence score for how much the site declared vs how much was inferred. Use this when you only need a site's STYLE (colors/fonts) rather than its code — to build new UI 'in the style of' a reference site. If you need the actual markup of a section, use extract_code instead. The result also carries `signals`, which explains WHERE the colors came from: check `signals.primarySource` and tell the user whether these are the site's own declared tokens ('css-var'/'theme-color') or values inferred from usage frequency ('usage') — never present inferred colors as the brand's official palette. `signals.explanation` is a sentence written to be repeated to the user.",
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
      "Extract the full design-token system of a URL: every color, font family, font size, border radius, box shadow, line height and z-index (with usage counts). Pass format='css' for a :root {} block, format='tailwind' for a tailwind.config, or format='dtcg' for a standalone W3C Design Tokens file (drops into Style Dictionary / Figma variables pipelines). Use when you need the complete token set, not just the brand summary. Returns VALUES and how often each is used - not layout, spacing composition or shadow stacks, and not which value belongs to which element: if the user asked you to rebuild or clone a section, use extract_code instead, which returns the real markup with the values already in place. Counts are tallied over the whole stylesheet, so a site shipping both light and dark themes returns the union of the two (see colorSchemes) - do not assume the most-used color is the background. The colorSchemes field tells you which themes the page declares; when it lists both, pick colours by role rather than by frequency, and use extract_code with theme=dark when you need one theme on its own.",
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
      "List every image on a page (img, srcset, picture, CSS background, favicon, og:image) as resolved URLs tagged by source. Use to recover imagery from a site or pull reference assets. Best-effort from static HTML: if images are mounted by JavaScript, call again with render=true (+5 credits).",
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
      "Extract inline SVGs (as paste-ready code) and SVG file references from a page. Use to grab icons and vector logos. Best-effort from static HTML: if icons are mounted by JavaScript, call again with render=true (+5 credits).",
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
      "Detect the real typography a site loads by resolving its full CSS cascade: every @font-face file with family/weight/style/format, Google Fonts links, preloads, plus a grouped per-family summary (families). Pass fields='families' for just the summary. Use to match typography.",
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
              files: { type: 'number' }
            }
          }
        },
        googleFontsLinks: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
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
      "Find Lottie/animation JSON files declared on a page. Best-effort from static HTML - most Lotties are runtime-injected, so pass render=true to execute the page JS first and catch those too (+5 credits). Use to recover animations.",
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
      'List every video a page declares: <video>/<source> files, og:video, player embeds (YouTube, Vimeo, Wistia, Loom) and direct video-file links - each tagged by source, with a poster image when declared. Note `source: "embed"` is a player page, not a downloadable file. Best-effort from static HTML: most sites mount their player with JavaScript, so if the result is thin or empty, call again with render=true to execute the page JS first (+5 credits).',
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
      'List every audio file a page declares: <audio>/<source> files, og:audio, and direct audio-file links such as podcast enclosures and download buttons - each tagged by source. Best-effort from static HTML: if a JavaScript player mounts the audio at runtime, call again with render=true (+5 credits).',
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
const FORWARDED_PARAMS = ['format', 'selector', 'framework', 'name', 'theme', 'fields', 'render', 'fresh', 'screenshot']

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

// Server-level guidance, sent once at initialize. Mirrors the `instructions`
// string the remote server (miromiro.app/mcp) returns, so a stdio client gets
// the same steering as a hosted one — chiefly: explain results, don't just dump
// them, and never present inferred brand colors as declared ones.
const INSTRUCTIONS =
  'MiroMiro turns any live URL into design data: section-level code (extract_code), brand identity ' +
  '(extract_brand), the full design-token system (extract_design_tokens), images, SVGs, fonts, videos, audio and Lottie files. ' +
  'Reach for extract_code when asked to rebuild or clone part of a real site; extract_brand when only ' +
  'colors/fonts are needed; extract_design_tokens when you want the whole value system (it returns values ' +
  'and usage counts, NOT layout, spacing composition or which value belongs to which element - it is not a ' +
  'substitute for extract_code on a rebuild). When a site expresses its themes through a ' +
  'prefers-color-scheme media query, extraction returns the LIGHT branch by default and carries the dark ' +
  'one as dark: variants - so pass theme=dark to extract_code when the user is viewing that site in dark ' +
  'mode or asks for its dark version. Every code response reports the theme you actually got: check it and ' +
  'say which one you returned. The API reads static HTML+CSS by default; pass render=true on any tool to ' +
  'execute the page JavaScript in a real browser first (client-rendered sites, +5 credits). When a static ' +
  'call comes back thin because the page is client-rendered, the response includes a hint field saying to ' +
  'retry with render=true - follow it. Explain your results, do not just dump them: extract_brand returns a ' +
  'signals object saying where the colors came from (signals.explanation is a sentence written to be repeated ' +
  'to the user) - when signals.primarySource is "usage" the site declared nothing and the colors are an ' +
  'inferred guess, so say that instead of presenting them as the official palette. Rendered calls can also ' +
  'take screenshot=true for a public image URL of the page (show it to the user to verify an extraction). ' +
  'extract_design_tokens takes format=dtcg for a W3C Design Tokens file. Pass fresh=true on any tool to ' +
  'bypass the 24h cache when a site just changed.'

const server = new Server(
  { name: 'miromiro', version: '0.6.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
)

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
