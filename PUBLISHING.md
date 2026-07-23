# Publishing miromiro-mcp to npm (internal — not shipped in the package)

Users install this server with `npx -y miromiro-mcp`, which downloads it from the
public npm registry. Until we publish, that command 404s and every MCP tutorial
on the site is a dead end — so publish is part of the API launch, AFTER the site
deploys (the server calls https://miromiro.app/api/v1, which must exist first).

## One-time setup

1. Create an account at https://www.npmjs.com/signup (free).
2. Log the machine in:

   ```powershell
   npm login
   ```

   Opens a browser to authenticate; the token is stored in `~/.npmrc`. Run
   `npm whoami` to confirm it worked.

## Publish (first release)

```powershell
cd mcp
npm pack --dry-run   # sanity check: should list exactly LICENSE, README.md, package.json, src/index.mjs
npm publish          # uploads to registry.npmjs.org; unscoped packages are public by default
npm view miromiro-mcp   # confirm it's live (name, version, tarball)
```

What each command does:
- `npm pack --dry-run` — builds the tarball in memory and lists its contents
  WITHOUT uploading. The `files: ["src"]` field in package.json is what keeps
  `node_modules/`, the lockfile, and this file out; README, LICENSE, and
  package.json are always included automatically.
- `npm publish` — creates the package on the registry and claims the name.
  First publish of a name is permanent-ish: you can unpublish within 72h,
  after that versions are immutable (you can only publish NEW versions).
- `npm view` — reads the public registry entry; what users' `npx` will see.

Then smoke-test as a real user (in any directory OUTSIDE this repo, so the
local folder can't shadow the registry copy):

```powershell
claude mcp add miromiro -s user --env MIROMIRO_API_KEY=mm_live_yourkey -- npx -y miromiro-mcp
claude mcp list      # look for "miromiro ... ✓ Connected"
claude               # then: "Use the miromiro server to get the brand colors of stripe.com"
```

## Releasing an update

Registry versions are immutable — to ship a change you bump the version and
publish again:

```powershell
cd mcp
npm version patch    # 0.1.0 -> 0.1.1; edits package.json (use `minor` for new tools, `major` for breaking changes)
npm publish
```

Users get the new version automatically: `npx -y miromiro-mcp` resolves to the
latest published version on each cold start (npx caches, but re-checks the
registry). No action needed on their side.

Keep `mcp/src/index.mjs`'s `new Server({ version })` string in sync with
package.json when bumping — it's what MCP clients display.

## Gotchas

- **Don't run `npm publish` from the repo root** — that would try to publish the
  whole Nuxt site (root package.json). Always `cd mcp` first.
- The tarball must stay tiny (~5 kB). If `npm pack --dry-run` ever lists
  `node_modules`, the `files` field got lost — stop and fix before publishing.
- 2FA: if the npm account has 2FA set to "authorization and writes", `npm publish`
  prompts for an OTP — normal, type the code from the authenticator app.
- The name `miromiro-mcp` was confirmed free on 2026-07-15.
