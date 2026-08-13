import { Elysia } from 'elysia'
import { config } from './config'
import { Semaphore, SemaphoreQueueFullError } from './semaphore'
import {
  HttpError,
  contentType,
  type TransformRequest,
  fetchOriginal,
  fetchOriginalStream,
  parseTransformRequest,
  transformImage
} from './transform'

const fetchSemaphore = new Semaphore(config.maxConcurrentFetches, config.maxFetchQueue)
const transformSemaphore = new Semaphore(config.maxConcurrentTransforms, config.maxTransformQueue)
const inflightTransforms = new Map<string, Promise<Buffer>>()

function applyCacheHeaders(headers: Record<string, string | number | undefined>): void {
  headers['Cache-Control'] = config.cacheControl
  headers['CDN-Cache-Control'] = config.cdnCacheControl
  headers['X-Content-Type-Options'] = 'nosniff'
}

function applyCorsHeaders(
  headers: Record<string, string | number | undefined>,
  request?: Request
): void {
  headers['Access-Control-Allow-Origin'] = '*'
  headers['Access-Control-Allow-Methods'] =
    request?.headers.get('access-control-request-method') ?? 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
  headers['Access-Control-Allow-Headers'] =
    request?.headers.get('access-control-request-headers') ?? '*'
  headers['Access-Control-Expose-Headers'] = '*'
  headers['Access-Control-Max-Age'] = '86400'
}

async function runTransform(spec: TransformRequest): Promise<Buffer> {
  const releaseFetch = await fetchSemaphore.acquire()
  let input: Uint8Array
  try {
    input = await fetchOriginal(spec.sourcePath)
  } finally {
    releaseFetch()
  }

  const releaseTransform = await transformSemaphore.acquire()
  try {
    return await transformImage(input, spec)
  } finally {
    releaseTransform()
  }
}

function transformCoalesced(spec: TransformRequest): Promise<Buffer> {
  const key = JSON.stringify([
    spec.sourcePath,
    spec.width,
    spec.height,
    spec.format,
    spec.compression,
    spec.fit
  ])
  const existing = inflightTransforms.get(key)
  if (existing) return existing

  const promise = runTransform(spec).finally(() => inflightTransforms.delete(key))
  inflightTransforms.set(key, promise)
  return promise
}

function streamResponse(upstream: Response, release: () => void, request: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream'
  }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers['Content-Length'] = contentLength
  applyCacheHeaders(headers)
  applyCorsHeaders(headers, request)

  const reader = upstream.body!.getReader()
  let released = false
  const releaseOnce = () => {
    if (!released) {
      released = true
      release()
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          releaseOnce()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        releaseOnce()
        controller.error(error)
      }
    },
    async cancel(reason) {
      releaseOnce()
      await reader.cancel(reason)
    }
  })

  return new Response(body, { status: upstream.status, headers })
}

new Elysia()
  .onRequest(({ request, set }) => applyCorsHeaders(set.headers, request))
  .options('/*', ({ set }) => {
    set.status = 204
    return ''
  })
  .get('/healthz', () => ({ ok: true, implementation: 'bun-elysia-sharp' }))
  .get('/*', async ({ request, set }) => {
    const url = new URL(request.url)

    try {
      const spec = parseTransformRequest(url.pathname, url)

      // No transform suffix: behave as a transparent origin proxy so existing
      // CDN image URLs keep working after the origin is switched to this service.
      if (!spec) {
        if (!config.passthroughOriginals) {
          throw new HttpError(404, 'No transform suffix and passthrough is disabled')
        }

        const releaseFetch = await fetchSemaphore.acquire()
        try {
          const upstream = await fetchOriginalStream(url.pathname, url.search.slice(1))
          if (!upstream.body) {
            throw new HttpError(502, 'Upstream returned no body')
          }
          return streamResponse(upstream, releaseFetch, request)
        } catch (error) {
          releaseFetch()
          throw error
        }
      }

      const output = await transformCoalesced(spec)

      set.status = 200
      set.headers['Content-Type'] = contentType(spec.format)
      set.headers['Content-Length'] = String(output.byteLength)
      applyCacheHeaders(set.headers)
      return output
    } catch (error: any) {
      const overloaded = error instanceof SemaphoreQueueFullError
      set.status = overloaded ? 503 : error instanceof HttpError ? error.status : 500
      set.headers['Cache-Control'] = 'no-store'
      if (overloaded) set.headers['Retry-After'] = '1'
      return { error: overloaded ? 'Service is busy' : error?.message ?? 'Image transformation failed' }
    }
  })
  .listen({ port: config.port, hostname: '0.0.0.0' })

console.log(`bun-elysia image-transform listening on :${config.port}`)
