import sharp from 'sharp'
import { config, type FitMode } from './config'

export type OutputFormat = 'jpeg' | 'png' | 'webp'

export interface TransformRequest {
  sourcePath: string
  width: number
  height: number
  format: OutputFormat
  compression: number
  fit: FitMode
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

// One libvips worker is a good default when Docker itself is capped to one CPU.
sharp.concurrency(1)

// The CDN is the useful cache. Keep the process-local cache intentionally small.
sharp.cache({ memory: 32, files: 0, items: 20 })

const transformRoute = /^(.+)\/(\d+)x(\d+)\.(jpe?g|png|webp)$/i

export function parseTransformRequest(pathname: string, url: URL): TransformRequest | null {
  const match = pathname.match(transformRoute)
  if (!match) return null

  const width = Number(match[2])
  const height = Number(match[3])
  if (
    width < 1 ||
    height < 1 ||
    width > config.maxWidth ||
    height > config.maxHeight ||
    width * height > config.maxPixels
  ) {
    throw new HttpError(400, 'Requested dimensions exceed configured limits')
  }

  const rawFormat = match[4].toLowerCase()
  const format: OutputFormat = rawFormat.startsWith('jp') ? 'jpeg' : rawFormat as OutputFormat

  const defaultCompression =
    format === 'jpeg' ? config.jpegCompression :
    format === 'webp' ? config.webpCompression :
    config.pngCompression

  const compression = Number(url.searchParams.get('compression') ?? defaultCompression)
  if (!Number.isInteger(compression) || compression < 1 || compression > 100) {
    throw new HttpError(400, 'compression must be an integer from 1 to 100')
  }

  const fit = (url.searchParams.get('fit') ?? config.defaultFit) as FitMode
  if (!['cover', 'contain', 'fill'].includes(fit)) {
    throw new HttpError(400, 'fit must be cover, contain, or fill')
  }

  return {
    sourcePath: match[1],
    width,
    height,
    format,
    compression,
    fit
  }
}

/** Fetch an upstream object while enforcing MAX_SOURCE_BYTES even without Content-Length. */
export async function fetchOriginal(sourcePath: string, rawQuery = ''): Promise<{ data: Uint8Array, contentType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs)

  try {
    const query = rawQuery ? `?${rawQuery}` : ''
    const upstream = await fetch(`${config.sourceOrigin}${sourcePath}${query}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: '*/*',
        'User-Agent': config.userAgent
      }
    })

    if (!upstream.ok) {
      throw new HttpError(upstream.status === 404 ? 404 : 502, `Upstream returned ${upstream.status}`)
    }

    const declared = Number(upstream.headers.get('content-length') ?? 0)
    if (declared > config.maxSourceBytes) {
      throw new HttpError(413, 'Source object exceeds MAX_SOURCE_BYTES')
    }

    if (!upstream.body) throw new HttpError(502, 'Upstream returned no body')

    const reader = upstream.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      if (total > config.maxSourceBytes) {
        await reader.cancel()
        throw new HttpError(413, 'Source object exceeds MAX_SOURCE_BYTES')
      }
      chunks.push(value)
    }

    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }

    return {
      data,
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream'
    }
  } catch (error: any) {
    if (error instanceof HttpError) throw error
    if (error?.name === 'AbortError') throw new HttpError(504, 'Upstream fetch timed out')
    throw new HttpError(502, 'Upstream fetch failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function transformImage(input: Uint8Array, request: TransformRequest): Promise<Buffer> {
  // Sharp/libvips rejects source images above this decoded pixel count before
  // committing to a huge allocation.
  const sharpFit = request.fit === 'contain' ? 'inside' : request.fit

  let pipeline = sharp(input, {
    limitInputPixels: config.maxSourcePixels,
    sequentialRead: true
  })
    .resize({
      width: request.width,
      height: request.height,
      fit: sharpFit,
      position: 'centre'
    })

  if (request.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: request.compression })
  } else if (request.format === 'webp') {
    pipeline = pipeline.webp({ quality: request.compression, effort: 4 })
  } else {
    pipeline = pipeline.png({ compressionLevel: Math.round(request.compression * 9 / 100) })
  }

  try {
    return await pipeline.toBuffer()
  } catch {
    throw new HttpError(422, 'Image decode/transform failed')
  }
}

export function contentType(format: OutputFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}
