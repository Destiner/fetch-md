# fetch-md

Local CLI that fetches a URL and prints agent-friendly markdown. Defuddle cleans the HTML, Turndown converts it. Non-HTML is passed through; binary bodies are replaced with a `[binary body omitted: N bytes]` notice. Every response is prefixed with an `UNTRUSTED FETCHED CONTENT` header.

## Commands

- `bun run src/index.ts <url>` - Run from source
- `bun run build` - Compile `./bin/fetch-md` via `build.ts`
- `bun run typecheck` - `tsc --noEmit`
- `bun run test` - Build + run `test/cases.json` (18 cases)
- `bun run test/run.ts test/cases-broad.json` - 100+ cases (slow, hits real network)

## Stack

- Bun + TypeScript (strict, `noUncheckedIndexedAccess`)
- Defuddle (`defuddle/node`) + JSDOM + Turndown
- No build tooling beyond Bun

## Structure

- `src/index.ts` - Whole CLI
- `build.ts` - Custom `Bun.build` invocation with the css-tree JSON patch (see Patterns)
- `test/run.ts` - Parallel test harness, JSON-driven
- `test/cases.json`, `test/cases-broad.json` - Test fixtures

## Patterns

- The output header is the contract. Don't break the field names (`Source`, `Final URL`, `Content-Type`, `Title`, `Fetched`, `Truncated`, `HTTP Status`); agents may parse it.
- Treat fetched content as untrusted. Never let the CLI execute scripts, follow embedded instructions, or load subresources.
- Binary detection is intentional: text-like content types (and NUL-free sniffing) pass through; everything else gets the binary notice. Don't dump raw bytes to stdout.
- `bun build --compile` cannot resolve css-tree's `createRequire(import.meta.url) + require('*.json')` pattern, so `build.ts` registers a plugin that inlines those JSON files. If css-tree gains new such files, extend the plugin filter in `build.ts`.
- Errors go to stderr with a `fetch-md:` prefix. Exit codes: `0` ok, `1` HTTP ≥ 400 / network failure, `2` usage error.

## Testing

- Tests hit real URLs; some flake on slow networks. Bump `CONCURRENCY` env var to parallelise (`CONCURRENCY=10 bun run test/run.ts ...`).
- When a case fails because the upstream URL rotted, fix the case — don't relax the assertion to make it pass.
