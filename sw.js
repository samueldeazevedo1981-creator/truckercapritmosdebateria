'use strict';
importScripts('./offline-assets.js');
const config=self.TCB_OFFLINE,scope=new URL('./',self.location.href),shellName='tcb-shell-'+config.version,audioName='tcb-recordings-v1';
const media=new Map(config.audio.map(file=>[new URL(file.path,scope).pathname,file]));
const shell=new Set(config.shell.map(path=>new URL(path,scope).pathname));
function cacheKey(file){const url=new URL(file.path,scope);url.search='rev='+file.hash;return url.href;}
function canonical(url){return new URL(new URL(url).pathname,scope).href;}
function cacheable(response){return response.ok&&response.status===200&&!response.redirected&&['basic','default'].includes(response.type);}
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(shellName);
 for(const path of config.shell){
  const url=new URL(path,scope),fetchUrl=path==='index.html'?scope:url,response=await fetch(fetchUrl,{cache:'reload',credentials:'same-origin'});
  const actual=new URL(response.url||fetchUrl),normalize=path=>path.replace(/index\.html$/,'').replace(/\.html$/,'').replace(/\/$/,'');
  const localRedirect=response.redirected&&actual.origin===scope.origin&&normalize(actual.pathname)===normalize(fetchUrl.pathname);
  if(!cacheable(response)&&!(response.ok&&response.status===200&&localRedirect))throw Error('App indisponível para salvar offline');
  if(path==='./'||path==='index.html'){const html=await response.clone().text();if(!html.includes('id="play"'))throw Error('Abra o app autenticado para salvar offline');}
  await cache.put(canonical(url),response);
 }
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if(name.startsWith('tcb-shell-')&&name!==shellName)await caches.delete(name);
 const cache=await caches.open(audioName),valid=new Set(config.audio.map(cacheKey));for(const request of await cache.keys())if(!valid.has(request.url))await cache.delete(request);
 await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
 const appNavigation=url.pathname===scope.pathname||url.pathname===new URL('index.html',scope).pathname;
 if(request.mode==='navigate'&&!appNavigation&&!shell.has(url.pathname))return;
 const file=media.get(url.pathname);
 if(file){event.respondWith((async()=>{
  const cache=await caches.open(audioName),key=cacheKey(file),saved=await cache.match(key);if(saved)return saved;
  const response=await fetch(request);if(cacheable(response)){try{await cache.put(key,response.clone());}catch{/* Playback can continue if storage is full; the download UI checks persistence. */}}return response;
 })());return;}
 if(request.mode==='navigate'||shell.has(url.pathname))event.respondWith((async()=>{
  const cache=await caches.open(shellName),key=appNavigation?canonical(new URL('index.html',scope)):canonical(url),saved=await cache.match(key);if(saved)return saved;
  try{return await fetch(request);}catch{return new Response('Abra o aplicativo com internet uma vez para preparar o uso offline.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
 })());
});
