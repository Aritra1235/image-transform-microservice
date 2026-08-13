export type FitMode = 'cover' | 'contain' | 'fill'

function intEnv(name: string, fallback: number): number {
  const raw = Bun.env[name]
  const value = raw === undefined ? fallback : Number(raw)

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name]
  if (raw === undefined) return fallback
  if (raw.toLowerCase() === 'true') return true
  if (raw.toLowerCase() === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function stringEnv(name: string, fallback?: string): string {
  const value = Bun.env[name] ?? fallback
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function qualityEnv(name: string, fallback: number): number {
  const value = intEnv(name, fallback)
  if (value > 100) throw new Error(`${name} must be between 1 and 100`)
  return value
}

const sourceOrigin = stringEnv('SOURCE_ORIGIN').replace(/\/+$/, '')
const originUrl = new URL(sourceOrigin)
if (!['http:', 'https:'].includes(originUrl.protocol)) {
  throw new Error('SOURCE_ORIGIN must use http:// or https://')
}

const defaultFit = stringEnv('DEFAULT_FIT', 'cover') as FitMode
if (!['cover', 'contain', 'fill'].includes(defaultFit)) {
  throw new Error('DEFAULT_FIT must be cover, contain, or fill')
}

export const config = {
  sourceOrigin,
  port: intEnv('PORT', 8080),
  jpegCompression: qualityEnv('DEFAULT_JPEG_COMPRESSION', 82),
  webpCompression: qualityEnv('DEFAULT_WEBP_COMPRESSION', 80),
  pngCompression: qualityEnv('DEFAULT_PNG_COMPRESSION', 70),
  defaultFit,
  maxWidth: intEnv('MAX_WIDTH', 5000),
  maxHeight: intEnv('MAX_HEIGHT', 5000),
  maxPixels: intEnv('MAX_PIXELS', 25_000_000),
  maxSourcePixels: intEnv('MAX_SOURCE_PIXELS', 50_000_000),
  maxSourceBytes: intEnv('MAX_SOURCE_BYTES', 26_214_400),
  fetchTimeoutMs: intEnv('FETCH_TIMEOUT_MS', 10_000),
  maxConcurrentTransforms: intEnv('MAX_CONCURRENT_TRANSFORMS', 1),
  passthroughOriginals: boolEnv('PASSTHROUGH_ORIGINALS', true),
  cacheControl: stringEnv('CACHE_CONTROL', 'public, max-age=31536000, immutable'),
  cdnCacheControl: stringEnv('CDN_CACHE_CONTROL', 'public, max-age=31536000, immutable'),
  userAgent: stringEnv('USER_AGENT', 'aritra-image-transform/1.0')
} as const
