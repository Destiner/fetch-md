# fetch-md

Local CLI that fetches a URL and prints it as markdown. Defuddle cleans the HTML, Turndown converts it. Non-HTML is passed through; binary bodies are replaced with a `[binary body omitted: N bytes]` line. Built on [incur](https://github.com/wevm/incur), so `--help`, `--llms`, `--schema`, `--mcp`, `mcp add`, and token-based pagination flags are inherited.

## Commands

- `bun run src/index.ts <url>` - Run from source
- `bun run build` - Compile `./bin/fetch-md` for the host arch
- `bun run build.ts --target=bun-linux-x64 --outfile=bin/fetch-md-linux-x64` - Cross-compile
- `bun run typecheck` - `tsc --noEmit`
- `bun run test` - Build + run `test/cases.json` (18 cases)
- `bun run test/run.ts test/cases-broad.json` - 100+ cases (slow, hits real network)

## Stack

- Bun + TypeScript (strict, `noUncheckedIndexedAccess`)
- incur + zod for argv parsing, help, manifest, MCP
- Defuddle (`defuddle/node`) + JSDOM + Turndown for HTML extraction

## Structure

- `src/index.ts` - Whole CLI (Cli.create with `args`, `options`, `run`)
- `build.ts` - Custom `Bun.build` invocation with the jsdom/css-tree patches (see Patterns)
- `test/run.ts` - Parallel test harness, JSON-driven
- `test/cases.json`, `test/cases-broad.json` - Test fixtures

## Patterns

- On success: stdout is the body. No envelope, no header, no banner.
- On failure: `run()` returns `c.error({ code, message, retryable })`. incur prints the error envelope to stdout (TOON by default) and exits non-zero. Codes: `INVALID_URL`, `UNSUPPORTED_PROTOCOL`, `FETCH_FAILED`, `HTTP_ERROR`.
- Binary detection is intentional: text-like content types (and NUL-free sniffing) pass through; everything else gets the `[binary body omitted: N bytes]` placeholder. Don't dump raw bytes to stdout.
- Truncation goes to stderr with a `fetch-md:` prefix (not an error — partial body is still emitted).
- `bun build --compile` cannot resolve a few runtime path lookups inside `jsdom` and `css-tree` (`createRequire(import.meta.url) + require('*.json')`, `fs.readFileSync(path.resolve(__dirname, '*.css'))`, and `require.resolve('./xhr-sync-worker.js')`). `build.ts` registers plugins that inline / neutralise those. If a new path-resolved asset surfaces during a Bun, jsdom, or css-tree upgrade, extend the plugins.

## Testing

- Tests hit real URLs; some flake on slow networks. Bump `CONCURRENCY` env var to parallelise (`CONCURRENCY=10 bun run test/run.ts ...`).
- When a case fails because the upstream URL rotted, fix the case — don't relax the assertion to make it pass.
- Error cases assert on `bodyIncludes` (the error envelope on stdout), not stderr.
