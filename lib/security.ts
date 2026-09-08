import dns from 'node:dns/promises';
import net from 'node:net';

function privateV4(ip:string){ const p=ip.split('.').map(Number); return p.length===4 && (p[0]===10 || p[0]===127 || (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168) || (p[0]===169&&p[1]===254) || (p[0]===0)); }
function privateV6(ip:string){ const x=ip.toLowerCase(); return x==='::1' || x==='::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.'); }
export async function assertPublicHttpUrl(raw:string){
  let u: URL;
  try { u=new URL(raw); } catch { throw new Error('Invalid URL.'); }
  if(!['http:','https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  if(u.username || u.password) throw new Error('URLs with embedded credentials are not allowed.');
  const host=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private/local URLs are not allowed.');
  if(net.isIP(host) && (net.isIPv4(host)?privateV4(host):privateV6(host))) throw new Error('Private network URLs are not allowed.');
  const records=await dns.lookup(host,{all:true,verbatim:true});
  if(!records.length) throw new Error('Unable to resolve source host.');
  for(const r of records){ if(net.isIPv4(r.address)?privateV4(r.address):privateV6(r.address)) throw new Error('Private network URLs are not allowed.'); }
  return u;
}
