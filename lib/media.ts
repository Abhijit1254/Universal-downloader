import { z } from 'zod';
export const processSchema = z.object({ url: z.string().trim().url().max(2048) });
export const downloadSchema = z.object({
  sourceUrl: z.string().trim().url().max(2048),
  format: z.enum(['mp3','mp4']),
  quality: z.string().regex(/^(64|128|192|320)kbps$|^(360|480|720|1080)p$/)
});
export function isHttpUrl(value: string) { try { const u=new URL(value); return u.protocol==='http:'||u.protocol==='https:'; } catch { return false; } }
export function hostname(value: string) { return new URL(value).hostname.toLowerCase(); }
export function looksLikeMedia(url: string, contentType='') {
  const path=new URL(url).pathname.toLowerCase();
  return /^(audio|video)\//.test(contentType.split(';')[0]) || /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|3gp|ts|m2ts|mp3|m4a|m4b|aac|wav|ogg|oga|opus|flac|wma)(?:$|\.)/.test(path);
}
export function sourceLabel(url:string){ return hostname(url).replace(/^www\./,''); }
export function safeFilename(name:string){ return name.replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100)||'media'; }
