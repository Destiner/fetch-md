# fetch-md

Local CLI that fetches a URL and prints it as markdown. Defuddle cleans the HTML, Turndown converts it. Non-HTML is passed through; binary bodies are replaced with a `[binary body omitted: N bytes]` line. stdout is the body only — warnings and HTTP failures go to stderr.

## Commands

- `bun run src/index.ts <url>` - Run from source
- `bun run build` - Compile `./bin/fetch-md` for the host arch
- `bun run build.ts --target=bun-linux-x64 --outfile=bin/fetch-md-linux-x64` - Cross-compile
- `bun run typecheck` - `tsc --noEmit`
- `bun run test` - Build + run `test/cases.json` (18 cases)
- `bun run test/run.ts test/cases-broad.json` - 100+ cases (slow, hits real network)

## Stack

- Bun + TypeScript (strict, `noUncheckedIndexedAccess`)
- Defuddle (`defuddle/node`) + JSDOM + Turndown
- No build tooling beyond Bun

## Structure

- `src/index.ts` - Whole CLI
- `build.ts` - Custom `Bun.build` invocation with the jsdom/css-tree patches (see Patterns)
- `test/run.ts` - Parallel test harness, JSON-driven
- `test/cases.json`, `test/cases-broad.json` - Test fixtures

## Patterns

- stdout is the contract: body only, nothing else. No header, no banner, no metadata. Anything else goes to stderr.
- Errors are stderr lines prefixed `fetch-md:`. Exit codes: `0` ok, `1` HTTP ≥ 400 / network failure / truncation only when wrapped in HTTP-error, `2` usage error.
- Binary detection is intentional: text-like content types (and NUL-free sniffing) pass through; everything else gets the `[binary body omitted: N bytes]` placeholder. Don't dump raw bytes to stdout.
- `bun build --compile` cannot resolve a few runtime path lookups inside `jsdom` and `css-tree` (`createRequire(import.meta.url) + require('*.json')`, `fs.readFileSync(path.resolve(__dirname, '*.css'))`, and `require.resolve('./xhr-sync-worker.js')`). `build.ts` registers plugins that inline / neutralise those. If a new path-resolved asset surfaces during a Bun or jsdom upgrade, extend the plugins.

## Testing

- Tests hit real URLs; some flake on slow networks. Bump `CONCURRENCY` env var to parallelise (`CONCURRENCY=10 bun run test/run.ts ...`).
- When a case fails because the upstream URL rotted, fix the case — don't relax the assertion to make it pass.
