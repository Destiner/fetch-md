#!/usr/bin/env bun
import { Cli, z } from 'incur'
import { Defuddle } from 'defuddle/node'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

const USER_AGENT = 'fetch-md/0.2 (+local CLI; treats content as untrusted)'

type FetchResult = {
  body: Uint8Array
  contentType: string
  finalUrl: string
  status: number
  statusText: string
  truncated: boolean
}

async function fetchUrl(url: string, timeoutMs: number, maxBytes: number): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
          if (total > maxBytes) {
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
  const sample = body.subarray(0, Math.min(body.byteLength, 4096))
  for (const b of sample) {
    if (b === 0) return false
  }
  return sample.length > 0
}

async function extractMarkdown(html: string, url: string): Promise<string> {
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
  return turndown.turndown(result.content || '').trim()
}

Cli.create('fetch-md', {
  version: '0.2.0',
  description: 'Fetch a URL and print it as markdown. HTML is cleaned and converted; text-like responses pass through; binary responses are reported as a placeholder.',
  args: z.object({
    url: z.string().describe('URL to fetch (http or https)'),
  }),
  options: z.object({
    timeoutMs: z.coerce.number().int().positive().default(15_000).describe('Request timeout in milliseconds'),
    maxBytes: z.coerce.number().int().positive().default(5_000_000).describe('Maximum response body size in bytes'),
  }),
  examples: [
    { args: { url: 'https://example.com' }, description: 'Fetch a page' },
    { args: { url: 'https://raw.githubusercontent.com/kepano/defuddle/main/README.md' }, description: 'Plain text passthrough' },
    {
      args: { url: 'https://example.com' },
      options: { timeoutMs: 30_000, maxBytes: 10_000_000 },
      description: 'Larger timeout and cap',
    },
  ],
  async run(c) {
    const { url } = c.args
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return c.error({ code: 'INVALID_URL', message: `invalid URL: ${url}`, retryable: false })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.error({
        code: 'UNSUPPORTED_PROTOCOL',
        message: `unsupported protocol: ${parsed.protocol} (only http/https supported)`,
        retryable: false,
      })
    }

    let fetched: FetchResult
    try {
      fetched = await fetchUrl(url, c.options.timeoutMs, c.options.maxBytes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.error({ code: 'FETCH_FAILED', message: `fetch failed: ${msg}`, retryable: true })
    }

    let body = ''
    if (isHtml(fetched.contentType, fetched.body)) {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(fetched.body)
      try {
        body = await extractMarkdown(html, fetched.finalUrl)
      } catch (err) {
        process.stderr.write(
          `fetch-md: extraction failed: ${err instanceof Error ? err.message : String(err)}; emitting raw HTML\n`,
        )
        body = html
      }
    } else if (isTextLike(fetched.contentType, fetched.body)) {
      body = new TextDecoder('utf-8', { fatal: false }).decode(fetched.body)
    } else {
      body = `[binary body omitted: ${fetched.body.byteLength} bytes]`
    }

    if (fetched.truncated) {
      process.stderr.write(`fetch-md: response exceeded ${c.options.maxBytes} bytes; body truncated\n`)
    }

    if (fetched.status >= 400) {
      return c.error({
        code: 'HTTP_ERROR',
        message: `HTTP ${fetched.status} ${fetched.statusText}`,
        retryable: fetched.status >= 500,
      })
    }

    return body
  },
}).serve()
