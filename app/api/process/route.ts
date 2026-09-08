import { NextResponse } from 'next/server';
import { processSchema, looksLikeMedia, sourceLabel } from '@/lib/media';
import { assertPublicHttpUrl } from '@/lib/security';
import { rateLimit } from '@/lib/rate-limit';
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = () => Number(process.env.MAX_SOURCE_BYTES || 524288000);

function isYouTubeUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return (
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

function runYtDlp(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    p.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('YouTube processing timed out.'));
    }, 30000);

    p.on('error', () => {
      clearTimeout(timer);
      reject(new Error('yt-dlp is not installed on the server.'));
    });

    p.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            stderr.trim() ||
              'Unable to process this YouTube URL.'
          )
        );
      }
    });
  });
}

async function processYouTube(url: string) {
  await assertPublicHttpUrl(url);

  const output = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--dump-single-json',
    '--skip-download',
    '--',
    url,
  ]);

  const data = JSON.parse(output);

  if (!data.id) {
    throw new Error('Unable to find the YouTube video.');
  }

  return {
    title: String(data.title || 'YouTube Video'),
    source: 'youtube.com',
    url,
    contentType: 'video/mp4',
    size: Number(data.filesize || 0),
    duration: Number(data.duration || 0),
    thumbnail: data.thumbnail || null,
    formats: {
      mp3: ['64kbps', '128kbps', '192kbps', '320kbps'],
      mp4: ['360p', '480p', '720p', '1080p'],
    },
  };
}

async function probe(raw: string) {
  let current = raw;

  for (let i = 0; i <= 5; i++) {
    await assertPublicHttpUrl(current);

    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 10000);

    try {
      const r = await fetch(current, {
        method: 'GET',
        headers: {
          'User-Agent': 'MediaFlow/1.0',
          Range: 'bytes=0-0',
        },
        redirect: 'manual',
        signal: c.signal,
      });

      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');

        await r.body?.cancel().catch(() => {});

        if (!loc) {
          throw new Error('Source redirect is invalid.');
        }

        current = new URL(loc, current).toString();
        continue;
      }

      const contentType = r.headers.get('content-type') || '';
      const size = Number(r.headers.get('content-length') || 0);

      await r.body?.cancel().catch(() => {});

      if (!r.ok && r.status !== 206) {
        throw new Error('The source could not be reached.');
      }

      if (size > MAX()) {
        throw new Error('Source file is too large.');
      }

      return {
        url: current,
        contentType,
        size,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects.');
}

export async function POST(req: Request) {
  try {
    const ip =
      req.headers
        .get('x-forwarded-for')
        ?.split(',')[0]
        ?.trim() || 'unknown';

    if (!rateLimit(`process:${ip}`, 30)) {
      return NextResponse.json(
        {
          error:
            'Too many requests. Please try again shortly.',
        },
        { status: 429 }
      );
    }

    const parsed = processSchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Please enter a valid URL.' },
        { status: 400 }
      );
    }

    const url = parsed.data.url;

    // YouTube
    if (isYouTubeUrl(url)) {
      const media = await processYouTube(url);

      return NextResponse.json({
        ok: true,
        supported: true,
        media,
      });
    }

    // Direct media URL
    const p = await probe(url);

    if (!looksLikeMedia(p.url, p.contentType)) {
      return NextResponse.json(
        {
          supported: false,
          source: sourceLabel(p.url),
          message:
            'Paste a direct public video/audio file URL or a supported YouTube URL.',
        },
        { status: 422 }
      );
    }

    const ct = p.contentType
      .split(';')[0]
      .toLowerCase();

    const audio = ct.startsWith('audio/');
    const video = ct.startsWith('video/');

    const path = new URL(p.url).pathname;

    const rawName =
      path.split('/').pop() || 'media';

    const title =
      decodeURIComponent(rawName)
        .replace(/\.[^.]+$/, '') || 'Media';

    return NextResponse.json({
      ok: true,
      supported: true,
      media: {
        title,
        source: sourceLabel(p.url),
        url: p.url,
        contentType: ct,
        size: p.size,
        duration: null,
        thumbnail: null,
        formats: {
          mp3:
            video || audio
              ? ['64kbps', '128kbps', '192kbps', '320kbps']
              : [],
          mp4: video
            ? ['360p', '480p', '720p', '1080p']
            : [],
        },
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : 'Unable to process URL.',
      },
      { status: 400 }
    );
  }
}