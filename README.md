# Bun + Elysia implementation

Stack: Bun, Elysia, Sharp (libvips-backed).

```bash
cp .env.example .env
# edit SOURCE_ORIGIN

docker build -t image-transform-bun .
docker run --rm --cpus=1 --memory=512m -p 8080:8080 --env-file .env image-transform-bun
```

Test:

```bash
curl -sS -o /dev/null -D - 'http://localhost:8080/static/uploads/example/cover.jpg/500x500.webp?compression=70'
curl 'http://localhost:8080/healthz'
```

Sharp concurrency is fixed to one worker and its in-process cache is kept small because the CDN is the real cache.
