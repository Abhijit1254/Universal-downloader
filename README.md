# MediaFlow — production launch build

A Next.js/React/TypeScript media converter for **direct public media URLs**. It supports MP3 and MP4 conversion through FFmpeg and does not permanently store source or output files.

## Supported input
Direct public HTTP(S) media files such as MP4, WebM, MOV, MP3, M4A, AAC, WAV and OGG. Platform page URLs are intentionally not scraped, and DRM/private-access protections are not bypassed.

## Render
1. Push this folder to GitHub.
2. In Render, create **New → Blueprint** and select the repository. `render.yaml` configures the Docker web service.
3. Or create a Web Service manually with **Docker** runtime.
4. Health check: `/api/health`.
5. No database or persistent disk is required.

## Environment
- `MAX_SOURCE_BYTES` — maximum source size in bytes; default 524288000 (500 MB).
- `NEXT_PUBLIC_SITE_URL` — optional public site URL.

## Local Docker
`docker build -t mediaflow .`

`docker run --rm -p 3000:3000 -e NODE_ENV=production mediaflow`

Open `http://localhost:3000`.

## Important production notes
The converter temporarily downloads a source to the container filesystem, converts it, streams the result, then deletes the temporary files. This is not permanent storage, but it still consumes Render CPU, RAM, disk and outbound bandwidth.

The built-in rate limiter is per process. For multiple instances, use a shared Redis/Upstash limiter before scaling.

Before monetization, add your Privacy Policy, Terms, copyright/DMCA/contact process and the ad network's required disclosures. Only provide downloads for content you own or are authorized to use.
