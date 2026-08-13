import { Elysia } from 'elysia'
import { config } from './config'
import { Semaphore } from './semaphore'
import {
  HttpError,
  contentType,
  fetchOriginal,
  parseTransformRequest,
  transformImage
} from './transform'

const transformSemaphore = new Semaphore(config.maxConcurrentTransforms)

function applyCacheHeaders(headers: Record<string, string>): void {
  headers['Cache-Control'] = config.cacheControl
  headers['CDN-Cache-Control'] = config.cdnCacheControl
  headers['X-Content-Type-Options'] = 'nosniff'
}

new Elysia()
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

        const original = await fetchOriginal(url.pathname, url.search.slice(1))
        set.status = 200
        set.headers['Content-Type'] = original.contentType
        set.headers['Content-Length'] = String(original.data.byteLength)
        applyCacheHeaders(set.headers)
        return original.data
      }

      // Acquire before fetching so queued transform requests do not each hold a
      // large source image in memory while waiting for the CPU-heavy stage.
      const release = await transformSemaphore.acquire()
      try {
        const original = await fetchOriginal(spec.sourcePath)
        const output = await transformImage(original.data, spec)

        set.status = 200
        set.headers['Content-Type'] = contentType(spec.format)
        set.headers['Content-Length'] = String(output.byteLength)
        applyCacheHeaders(set.headers)
        return output
      } finally {
        release()
      }
    } catch (error: any) {
      set.status = error instanceof HttpError ? error.status : 500
      set.headers['Cache-Control'] = 'no-store'
      return { error: error?.message ?? 'Image transformation failed' }
    }
  })
  .listen({ port: config.port, hostname: '0.0.0.0' })

console.log(`bun-elysia image-transform listening on :${config.port}`)
