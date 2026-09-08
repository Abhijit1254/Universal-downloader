import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { downloadSchema, safeFilename } from '@/lib/media';
import { assertPublicHttpUrl } from '@/lib/security';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = () => Number(process.env.MAX_SOURCE_BYTES || 524288000);
const MAX_OUT = () => Number(process.env.MAX_OUTPUT_BYTES || 1073741824);
const TIMEOUT = () => Number(process.env.FFMPEG_TIMEOUT_MS || 300000);

function isYouTubeUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let killed = false;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new Error(`${command} is not installed on the server.`));
      else reject(new Error(`Unable to start ${command}.`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) reject(new Error('Download/conversion timed out.'));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Unable to process media with ${command}.`));
    });
  });
}

async function fetchToFile(raw: string, file: string) {
  let current = raw;

  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicHttpUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'MediaFlow/1.0' },
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error('Source redirect is invalid.');
        current = new URL(location, current).toString();
        continue;
      }

      if (!response.ok || !response.body) throw new Error('Source could not be fetched.');

      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX()) throw new Error('Source file is too large.');

      let total = 0;
      const output = createWriteStream(file);
      const reader = response.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX()) throw new Error('Source file is too large.');
          if (!output.write(Buffer.from(value))) {
            await new Promise<void>((resolve, reject) => {
              output.once('drain', resolve);
              output.once('error', reject);
            });
          }
        }
      } finally {
        output.end();
        await new Promise<void>((resolve, reject) => {
          output.once('close', resolve);
          output.once('error', reject);
        });
        await reader.cancel().catch(() => {});
      }
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects.');
}

function runFfmpeg(input: string, output: string, format: 'mp3' | 'mp4', quality: string) {
  const videoHeight = ['360p', '480p', '720p', '1080p'].includes(quality) ? quality.replace('p', '') : '720';
  const args = format === 'mp3'
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-b:a', quality, '-map', '0:a:0', '-map_metadata', '-1', output]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:${videoHeight}:force_original_aspect_ratio=decrease`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1', output];

  return runCommand('ffmpeg', args, TIMEOUT());
}

async function downloadYouTube(url: string, output: string, format: 'mp3' | 'mp4', quality: string) {
  await assertPublicHttpUrl(url);

  if (format === 'mp3') {
    await runCommand('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', quality.replace('kbps', 'K'),
      '-o', output,
      '--', url,
    ], TIMEOUT());
    return;
  }

  const height = quality.replace('p', '');
  await runCommand('yt-dlp', [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
    '--merge-output-format', 'mp4',
    '-o', output,
    '--', url,
  ], TIMEOUT());
}

export async function POST(req: Request) {
  let dir = '';

  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!rateLimit(`download:${ip}`, 10)) {
      return NextResponse.json({ error: 'Too many downloads. Please try again shortly.' }, { status: 429 });
    }

    const parsed = downloadSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid download request.' }, { status: 400 });

    const { sourceUrl, format, quality } = parsed.data;
    if (format === 'mp4' && !['360p', '480p', '720p', '1080p'].includes(quality)) throw new Error('Invalid video quality.');
    if (format === 'mp3' && !['64kbps', '128kbps', '192kbps', '320kbps'].includes(quality)) throw new Error('Invalid audio quality.');

    dir = await mkdtemp(path.join(os.tmpdir(), 'mediaflow-'));
    const output = path.join(dir, `output.${format}`);

    if (isYouTubeUrl(sourceUrl)) {
      await downloadYouTube(sourceUrl, output, format, quality);
    } else {
      const input = path.join(dir, 'input');
      await fetchToFile(sourceUrl, input);
      await runFfmpeg(input, output, format, quality);
    }

    const info = await stat(output);
    if (info.size > MAX_OUT()) throw new Error('Converted file is too large.');

    const filenameBase = safeFilename(
      isYouTubeUrl(sourceUrl)
        ? 'MediaFlow-Download'
        : path.basename(new URL(sourceUrl).pathname).replace(/\.[^.]+$/, '')
    ) || 'media';

    const headers = new Headers({
      'Content-Type': format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
      'Content-Disposition': `attachment; filename="${filenameBase}.${format}"`,
      'Content-Length': String(info.size),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    });

    const nodeStream = createReadStream(output);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const cleanup = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
    nodeStream.once('close', cleanup);
    nodeStream.once('error', cleanup);
    dir = '';

    return new NextResponse(webStream, { headers });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Download failed.' }, { status: 400 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
