'use strict';
(()=>{
 const config=globalThis.TCB_OFFLINE,$=id=>document.getElementById(id),button=$('installApp'),download=$('downloadOffline'),status=$('offlineStatus'),panel=$('installationPanel');
 let installPrompt=null,registration=null,busy=false,abort=null;
 const standalone=()=>window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true;
 const ios=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
 const key=file=>{const url=new URL(file.path,location.href);url.search='rev='+file.hash;return url.href;};
 const openPanel=()=>{panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});};
 function installState(){if(standalone()){button.textContent='Aplicativo instalado';button.disabled=true;$('installState').textContent='Aberto em janela de aplicativo';}else{button.textContent='↓ Instalar aplicativo';}}
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;button.textContent='↓ Instalar aplicativo';});
 window.addEventListener('appinstalled',()=>{installPrompt=null;installState();button.textContent='Instalação concluída';});
 button.onclick=async()=>{
  if(installPrompt){const prompt=installPrompt;installPrompt=null;await prompt.prompt();const choice=await prompt.userChoice;if(choice.outcome==='accepted')button.textContent='Instalação solicitada';return;}
  openPanel();$('installHelp').textContent=ios()?'No Safari, toque em Compartilhar → Adicionar à Tela de Início. Ative “Abrir como App da Web”, se aparecer. Abra pelo novo ícone e baixe os ritmos dentro dele.':'Use a opção de instalação do navegador. No Windows/Android, procure “Instalar aplicativo” no menu ou na barra de endereços. No Safari do Mac, use Arquivo → Adicionar ao Dock.';
 };
 $('offlineShortcut').onclick=openPanel;
 async function inventory(){const cache=await caches.open('tcb-recordings-v1');let count=0,bytes=0;for(const file of config.audio){if(await cache.match(key(file))){count++;bytes+=file.bytes;}}$('offlineProgress').max=config.audio.length;$('offlineProgress').value=count;return {count,bytes};}
 function showCount(result){const complete=result.count===config.audio.length;status.textContent=complete?'Biblioteca offline completa · '+config.models+' levadas e viradas disponíveis neste aparelho.':result.count+'/'+config.audio.length+' trechos salvos · download completo de aproximadamente '+Math.ceil(config.bytes/1048576)+' MB.';download.textContent=complete?'Verificar biblioteca offline':'Baixar todos os ritmos ('+Math.ceil(config.bytes/1048576)+' MB)';}
 function exposeUpdate(worker){$('updateApp').hidden=false;$('updateApp').onclick=()=>{if(typeof playing!=='undefined'&&playing){status.textContent='Pare a reprodução antes de aplicar a atualização.';return;}worker.postMessage({type:'ACTIVATE_UPDATE'});navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});};}
 async function prepareOffline(){
  if(!('serviceWorker' in navigator)||!('caches' in window)||!window.isSecureContext){status.textContent='Para instalar e salvar offline, abra o link em um navegador atualizado, com conexão segura.';return;}
  try{
   const existing=await navigator.serviceWorker.getRegistration('./');
   try{registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});}catch(error){if(existing?.active)registration=existing;else throw error;}
   if(registration.waiting)exposeUpdate(registration.waiting);
   registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)exposeUpdate(worker);});});
   await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),30000))]);
   if(!navigator.serviceWorker.controller)await Promise.race([new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true})),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),15000))]);
   download.disabled=false;showCount(await inventory());
  }catch{status.textContent='Não foi possível preparar o modo offline. Abra o app com internet no Safari, Chrome ou Edge e tente recarregar.';}
 }
 download.onclick=async()=>{
  if(busy)return;busy=true;abort=new AbortController();download.disabled=true;$('cancelOffline').hidden=false;
  try{
   const result=await inventory();if(result.count===config.audio.length){showCount(result);return;}
   const estimate=await navigator.storage?.estimate?.();const remaining=config.bytes-result.bytes;if(estimate?.quota&&estimate.quota-(estimate.usage||0)<remaining*1.15)throw Error('space');
   try{await navigator.storage?.persist?.();}catch{}
   const cache=await caches.open('tcb-recordings-v1');let count=result.count;
   for(const file of config.audio){
    if(abort.signal.aborted)throw new DOMException('Cancelado','AbortError');if(await cache.match(key(file)))continue;
    status.textContent='Baixando ritmos e viradas · '+count+'/'+config.audio.length+'. Mantenha o aplicativo aberto.';
    const response=await fetch(file.path,{signal:abort.signal,cache:'reload',credentials:'same-origin'});if(!response.ok||response.redirected)throw Error('network');
    if(!await cache.match(key(file)))throw Error('space');count++;$('offlineProgress').value=count;
   }
   showCount(await inventory());
  }catch(error){const saved=await inventory().catch(()=>({count:0}));status.textContent=error.name==='AbortError'?'Download pausado · '+saved.count+' trechos preservados. Toque em baixar para continuar.':error.message==='space'?'Espaço insuficiente para concluir o download. Libere espaço no aparelho e tente novamente.':navigator.onLine?'Não foi possível concluir. Os trechos já salvos foram preservados; tente novamente.':'Sem conexão. Os trechos já salvos estão disponíveis; conecte para continuar o download.';}
  finally{busy=false;abort=null;download.disabled=false;$('cancelOffline').hidden=true;}
 };
 $('cancelOffline').onclick=()=>abort?.abort();
 const capabilities=[typeof (window.AudioContext||window.webkitAudioContext)==='function',typeof Worker==='function',typeof WebAssembly==='object'];$('platformStatus').textContent=capabilities.every(Boolean)?'Motor de áudio disponível. O som é liberado ao tocar em TOCAR. Pedais que enviam teclas usam o atalho configurado.':'Este navegador não oferece todos os recursos de áudio. Atualize o Safari, Chrome ou Edge para usar o aplicativo.';
 if(typeof navigator.requestMIDIAccess!=='function'){const midi=$('connectMidi');midi.disabled=true;midi.textContent='MIDI indisponível neste navegador';$('pedalStatus').textContent='Use um pedal no modo teclado para acionar as viradas.';}
 installState();prepareOffline();
})();
