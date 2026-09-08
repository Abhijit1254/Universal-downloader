# Deployment

## Docker (recommended)

Build:
`docker build -t mediaflow .`

Run:
`docker run --rm -p 3000:3000 -e NEXT_PUBLIC_SITE_URL=https://your-domain.com mediaflow`

Put HTTPS/CDN/reverse proxy in front of port 3000.

## Environment
Copy `.env.example` to your deployment environment. Do not commit `.env.local` or API keys.

## Before public launch
- Connect a domain and HTTPS.
- Configure your ad network after the site passes its review.
- Set a conservative `MAX_SOURCE_BYTES`.
- Add Redis/Upstash rate limiting for multi-instance deployments; the included limiter is per-process only.
- Monitor bandwidth because proxying/conversion consumes server egress even though media is not permanently stored.
- Add Terms, Privacy, Copyright/DMCA/contact pages appropriate to your jurisdiction and business model.
