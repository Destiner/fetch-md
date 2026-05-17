#!/usr/bin/env bun
import { Defuddle } from 'defuddle/node'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

const USER_AGENT = 'fetch-md/0.1 (+local CLI; treats content as untrusted)'
const DEFAULT_MAX_BYTES = 5_000_000
const DEFAULT_TIMEOUT_MS = 15_000

type FetchResult = {
  body: Uint8Array
  contentType: string
  finalUrl: string
  status: number
  statusText: string
  truncated: boolean
}

async function fetchUrl(url: string): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.8',
      },
    })

    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > DEFAULT_MAX_BYTES) {
            truncated = true
            try {
              await reader.cancel()
            } catch {}
            break
          }
          chunks.push(value)
        }
      }
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      body.set(c, offset)
      offset += c.byteLength
    }

    return {
      body,
      contentType: res.headers.get('content-type') ?? '',
      finalUrl: res.url || url,
      status: res.status,
      statusText: res.statusText,
      truncated,
    }
  } finally {
    clearTimeout(timer)
  }
}

function isHtml(contentType: string, body: Uint8Array): boolean {
  const ct = contentType.toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true
  if (ct && !ct.includes('html')) return false
  // Fallback: sniff first bytes for an HTML signature when content-type is missing or ambiguous.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(body.subarray(0, 512))
    .trimStart()
    .toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body')
}

function isTextLike(contentType: string, body: Uint8Array): boolean {
  const ct = contentType.toLowerCase()
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('yaml') ||
    ct.includes('toml') ||
    ct.includes('csv') ||
    ct.includes('x-sh') ||
    ct.includes('x-www-form-urlencoded')
  ) {
    return true
  }
  if (ct && ct.length > 0) return false
  // Sniff: if there are no NUL bytes in the first 4KB, treat as text.
  const sample = body.subarray(0, Math.min(body.byteLength, 4096))
  for (const b of sample) {
    if (b === 0) return false
  }
  return sample.length > 0
}

async function extractMarkdown(html: string, url: string): Promise<{ title: string; markdown: string }> {
  const dom = new JSDOM(html, { url })
  const result = await Defuddle(dom as unknown as { window: { document: Document; location: { href: string } } }, url, {
    markdown: false,
  })
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    linkStyle: 'inlined',
  })
  turndown.remove(['script', 'style', 'noscript', 'iframe'] as Array<keyof HTMLElementTagNameMap>)
  const markdown = turndown.turndown(result.content || '').trim()
  return { title: result.title || '', markdown }
}

function logError(msg: string): void {
  process.stderr.write(`fetch-md: ${msg}\n`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const first = argv[0]
  if (first === undefined || first === '-h' || first === '--help') {
    process.stderr.write('usage: fetch-md <url>\n')
    return first === undefined ? 2 : 0
  }
  if (first === '--version' || first === '-V') {
    process.stdout.write('fetch-md 0.1.0\n')
    return 0
  }

  const url = first
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    logError(`invalid URL: ${url}`)
    return 2
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logError(`unsupported protocol: ${parsed.protocol}`)
    return 2
  }

  let fetched: FetchResult
  try {
    fetched = await fetchUrl(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError(`fetch failed: ${msg}`)
    return 1
  }

  let body = ''
  if (isHtml(fetched.contentType, fetched.body)) {
    const html = new TextDecoder('utf-8', { fatal: false }).decode(fetched.body)
    try {
      body = (await extractMarkdown(html, fetched.finalUrl)).markdown
    } catch (err) {
      logError(`extraction failed: ${err instanceof Error ? err.message : String(err)}; emitting raw HTML`)
      body = html
    }
  } else if (isTextLike(fetched.contentType, fetched.body)) {
    body = new TextDecoder('utf-8', { fatal: false }).decode(fetched.body)
  } else {
    body = `[binary body omitted: ${fetched.body.byteLength} bytes]`
  }

  if (fetched.truncated) logError(`response exceeded ${DEFAULT_MAX_BYTES} bytes; body truncated`)
  if (fetched.status >= 400) logError(`HTTP ${fetched.status} ${fetched.statusText}`)

  process.stdout.write(body)
  if (!body.endsWith('\n')) process.stdout.write('\n')

  return fetched.status >= 400 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logError(err instanceof Error ? err.stack || err.message : String(err))
    process.exit(1)
  })
