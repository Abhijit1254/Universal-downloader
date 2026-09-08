import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { processSchema, looksLikeMedia, sourceLabel } from '@/lib/media';
import { assertPublicHttpUrl } from '@/lib/security';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = () => Number(process.env.MAX_SOURCE_BYTES || 524288000);
const MAX_REDIRECTS = 5;

function isYouTubeUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function runYtDlp(args: string[], timeoutMs = 30000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new Error('yt-dlp is not installed on the server.'));
      else reject(new Error('Unable to start YouTube processor.'));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('YouTube processing timed out.'));
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || 'Unable to process this YouTube URL.'));
    });
  });
}

async function processYouTube(url: string) {
  await assertPublicHttpUrl(url);

  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--dump-single-json',
    '--no-check-certificates',
    '--',
    url,
  ]);

  const data = JSON.parse(raw);
  if (!data.id) throw new Error('Unable to find the YouTube video.');

  return {
    title: String(data.title || 'YouTube Video'),
    source: 'youtube.com',
    url,
    contentType: 'video/mp4',
    size: Number(data.filesize || data.filesize_approx || 0),
    duration: Number(data.duration || 0),
    thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : null,
    formats: {
      mp3: ['64kbps', '128kbps', '192kbps', '320kbps'],
      mp4: ['360p', '480p', '720p', '1080p'],
    },
  };
}

async function probe(raw: string) {
  let current = raw;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHttpUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(current, {
        method: 'GET',
        headers: { 'User-Agent': 'MediaFlow/1.0', Range: 'bytes=0-0' },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error('Source redirect is invalid.');
        current = new URL(location, current).toString();
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const size = Number(response.headers.get('content-length') || 0);
      await response.body?.cancel().catch(() => {});

      if (!response.ok && response.status !== 206) throw new Error('The source could not be reached.');
      if (size > MAX()) throw new Error('Source file is too large.');
      return { url: current, contentType, size };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects.');
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!rateLimit(`process:${ip}`, 30)) {
      return NextResponse.json({ error: 'Too many requests. Please try again shortly.' }, { status: 429 });
    }

    const parsed = processSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'Please enter a valid URL.' }, { status: 400 });

    const url = parsed.data.url;

    if (isYouTubeUrl(url)) {
      const media = await processYouTube(url);
      return NextResponse.json({ ok: true, supported: true, media });
    }

    const p = await probe(url);
    if (!looksLikeMedia(p.url, p.contentType)) {
      return NextResponse.json({
        supported: false,
        source: sourceLabel(p.url),
        message: 'Paste a direct public video/audio file URL or a supported YouTube URL.',
      }, { status: 422 });
    }

    const contentType = p.contentType.split(';')[0].toLowerCase();
    const audio = contentType.startsWith('audio/');
    const video = contentType.startsWith('video/');
    const pathname = new URL(p.url).pathname;
    const rawName = pathname.split('/').pop() || 'media';
    const title = decodeURIComponent(rawName).replace(/\.[^.]+$/, '') || 'Media';

    return NextResponse.json({
      ok: true,
      supported: true,
      media: {
        title,
        source: sourceLabel(p.url),
        url: p.url,
        contentType,
        size: p.size,
        duration: null,
        thumbnail: null,
        formats: {
          mp3: video || audio ? ['64kbps', '128kbps', '192kbps', '320kbps'] : [],
          mp4: video ? ['360p', '480p', '720p', '1080p'] : [],
        },
      },
    });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to process URL.',
    }, { status: 400 });
  }
}
