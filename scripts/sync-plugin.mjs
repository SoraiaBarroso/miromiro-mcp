// Builds plugin/ - the Claude Code plugin folder the Claude directory scans - from the repo root.
//
// Why a separate folder: the directory scans every file in the folder that holds
// .claude-plugin/plugin.json. At the repo root that included the npm stdio server (src/), which
// reads MIROMIRO_API_KEY from the environment, and the directory refuses plugins that read a
// credential from the user's machine. The plugin itself only needs the remote server
// (https://miromiro.app/mcp, OAuth, no key) and the skills.
//
// skills/ at the root stays the source of truth (ClawHub, Cursor and Kimi read it). This copies
// each SKILL.md into plugin/skills/ without the OpenClaw "primaryEnv" field, plus .mcp.json,
// LICENSE and the icon. Run after editing a skill:  node scripts/sync-plugin.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = join(root, 'plugin')

rmSync(join(plugin, 'skills'), { recursive: true, force: true })
for (const name of readdirSync(join(root, 'skills'))) {
  const src = join(root, 'skills', name, 'SKILL.md')
  if (!existsSync(src)) continue
  // The REST fallback (curl + "ask the user for their key") is for agents without the tools;
  // the plugin always has them (remote server, OAuth), so its copy leaves that block out.
  const body = readFileSync(src, 'utf8').replace(/\r\n/g, '\n')
    .replace(/\n<!-- rest-fallback[^>]*-->[\s\S]*?<!-- \/rest-fallback -->\n/g, '')
  // Front matter the directory can read: plain `key: "value"` lines. The OpenClaw `metadata`
  // line is a { } mapping (refused as FILE_NOT_PLAIN -> LOCAL_CODE_NOT_READ), so it is dropped.
  const text = body.replace(/^---\n([\s\S]*?)\n---\n/, (_, fm) => '---\n' + fm.split('\n')
    .filter(line => !/^metadata:/.test(line))
    .map(line => line.replace(/^([a-z][\w-]*):\s+(?!")(.+)$/, (_, k, v) => `${k}: "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`))
    .join('\n') + '\n---\n')
  mkdirSync(join(plugin, 'skills', name), { recursive: true })
  writeFileSync(join(plugin, 'skills', name, 'SKILL.md'), text)
}

cpSync(join(root, '.mcp.json'), join(plugin, '.mcp.json'))
cpSync(join(root, 'LICENSE'), join(plugin, 'LICENSE'))
mkdirSync(join(plugin, 'assets'), { recursive: true })
cpSync(join(root, 'assets', 'icon.svg'), join(plugin, 'assets', 'icon.svg'))

// Guard: nothing in the plugin folder may read or ask for a key (the directory refuses plugins
// that use a credential from the user's machine).
const walk = dir => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)])
// "pass `x`" also counts: the scan read it as a password handed to the server.
const banned = /MIROMIRO_API_KEY|YOUR_API_KEY|Authorization: Bearer|rest-fallback|environment variable|\bpass(es|ed|ing)?\b|^metadata:/im
const hits = walk(plugin).filter(f => banned.test(readFileSync(f, 'utf8')))
if (hits.length) {
  console.error('plugin/ still handles an API key in:\n' + hits.join('\n'))
  process.exit(1)
}
console.log('plugin/ synced:', walk(plugin).map(f => f.slice(plugin.length + 1).replace(/\\/g, '/')).join(', '))
