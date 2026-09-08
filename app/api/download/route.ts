import { NextResponse } from 'next/server';
import { downloadSchema, safeFilename } from '@/lib/media';
import { assertPublicHttpUrl } from '@/lib/security';
import { rateLimit } from '@/lib/rate-limit';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path'; import os from 'node:os';
export const runtime='nodejs'; export const dynamic='force-dynamic';
const MAX=()=>Number(process.env.MAX_SOURCE_BYTES||524288000);
const MAX_OUT=()=>Number(process.env.MAX_OUTPUT_BYTES||1073741824);
const TIMEOUT=()=>Number(process.env.FFMPEG_TIMEOUT_MS||300000);
async function fetchToFile(raw:string,file:string){
  let current=raw;
  for(let redirects=0;redirects<=5;redirects++){
    await assertPublicHttpUrl(current);
    const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),20000);
    try{
      const res=await fetch(current,{redirect:'manual',headers:{'User-Agent':'MediaFlow/1.0'},signal:ac.signal});
      if(res.status>=300&&res.status<400){ const loc=res.headers.get('location'); await res.body?.cancel().catch(()=>{}); if(!loc) throw new Error('Source redirect is invalid.'); current=new URL(loc,current).toString(); continue; }
      if(!res.ok||!res.body) throw new Error('Source could not be fetched.');
      const declared=Number(res.headers.get('content-length')||0); if(declared>MAX()) throw new Error('Source file is too large.');
      let total=0; const out=createWriteStream(file); const reader=res.body.getReader();
      try{ while(true){ const {done,value}=await reader.read(); if(done) break; total+=value.byteLength; if(total>MAX()) throw new Error('Source file is too large.'); if(!out.write(Buffer.from(value))) await new Promise<void>((resolve,reject)=>{out.once('drain',resolve);out.once('error',reject);}); } }
      finally{ out.end(); await new Promise<void>((resolve,reject)=>{out.once('close',resolve);out.once('error',reject);}); await reader.cancel().catch(()=>{}); }
      return;
    } finally { clearTimeout(timer); }
  }
  throw new Error('Too many redirects.');
}
function runFfmpeg(input:string,output:string,format:'mp3'|'mp4',quality:string){
  return new Promise<void>((resolve,reject)=>{
    const q=format==='mp3'?quality:['360p','480p','720p','1080p'].includes(quality)?quality:'720p';
    const args=format==='mp3'?['-hide_banner','-loglevel','error','-y','-i',input,'-vn','-b:a',q,'-map','0:a:0','-map_metadata','-1',output]:['-hide_banner','-loglevel','error','-y','-i',input,'-map','0:v:0','-map','0:a:0?','-vf',`scale=-2:${q.replace('p','')}:force_original_aspect_ratio=decrease`,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart','-map_metadata','-1',output];
    const p=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']}); let err=''; let killed=false;
    p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000);});
    const timer=setTimeout(()=>{killed=true;p.kill('SIGKILL');},TIMEOUT());
    p.on('error',()=>{clearTimeout(timer);reject(new Error('FFmpeg is not installed on the server.'));});
    p.on('close',c=>{clearTimeout(timer); if(killed) reject(new Error('Conversion timed out.')); else if(c===0) resolve(); else reject(new Error(err||'Media conversion failed. The source may not contain a compatible audio/video stream.'));});
  });
}
export async function POST(req:Request){
  let dir='';
  try{
    const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown'; if(!rateLimit(`download:${ip}`,10)) return NextResponse.json({error:'Too many downloads. Please try again shortly.'},{status:429});
    const parsed=downloadSchema.safeParse(await req.json()); if(!parsed.success) return NextResponse.json({error:'Invalid download request.'},{status:400});
    const {sourceUrl,format,quality}=parsed.data;
    if(format==='mp4'&&!['360p','480p','720p','1080p'].includes(quality)) throw new Error('Invalid video quality.');
    if(format==='mp3'&&!['64kbps','128kbps','192kbps','320kbps'].includes(quality)) throw new Error('Invalid audio quality.');
    dir=await mkdtemp(path.join(os.tmpdir(),'mediaflow-')); const input=path.join(dir,'input'); const output=path.join(dir,`output.${format}`);
    await fetchToFile(sourceUrl,input); await runFfmpeg(input,output,format,quality); const info=await stat(output); if(info.size>MAX_OUT()) throw new Error('Converted file is too large.');
    const filenameBase=safeFilename(path.basename(new URL(sourceUrl).pathname).replace(/\.[^.]+$/,''))||'media';
    const headers=new Headers({'Content-Type':format==='mp3'?'audio/mpeg':'video/mp4','Content-Disposition':`attachment; filename="${filenameBase}.${format}"`,'Content-Length':String(info.size),'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'});
    const nodeStream=createReadStream(output); const webStream=Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>; const cleanup=async()=>{await rm(dir,{recursive:true,force:true}).catch(()=>{})};
    nodeStream.once('close',cleanup); nodeStream.once('error',cleanup); dir=''; return new NextResponse(webStream,{headers});
  }catch(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Download failed.'},{status:400});}finally{if(dir) await rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
