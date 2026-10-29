'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const CATEGORY_ORDER=['Rock','Pop','R&B','Soul','Reggae','Blues','Country','Jazz','Bossa Nova','Arrocha','Axé','Latinos','Forró','Sertanejo','Piseiro','Gaúchos','Samba e Pagode','Carnaval','Guarânia','Bandinha'];
function read(k,fallback){try{return JSON.parse(localStorage.getItem(k))??fallback}catch{return fallback}}
function persist(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{msg('Não foi possível salvar neste navegador.')}}
let current=catalog.find(r=>r.id==='axe-chicabana')||catalog[0],category='Todos',onlyFav=false,variation=0,pendingVariation=null,playing=false,starting=false,timer,next=0,generation=0,barStart=0,playBpm=current.bpm,ending=false;
let ctx,master,toneNode,compressor,drumBus,dryGain,wetGain,reverbNode,reverbFilter,decoded=null,decodedId=null,prepared=null,preparedBpm=null,loadRequest=0,tempoRequest=0,tempoTimer,tempoWorker=null,tempoReject=null,tempoLoadVersion=0;
let reverbCache=new Map(),voices=new Set(),wakeLock,selectionRequest=0,queuedBuffer=null,favs=read('tcb-audio-favorites',[]),presets=read('tcb-audio-presets',[]);
let pedalKey=read('tcb-pedal-key','KeyF'),learningKey=false,midiBinding=read('tcb-pedal-midi',null),learningMidi=false,midiAccess,lastPedalAt=-Infinity,midiValues=new Map();
function msg(s){$('#message').textContent=s}
let audioModes=read('tcb-audio-modes',{}),modeSwitchToken=0,modeSwitchPlaying=false;
const samplerSettings=read('tcb-sampler12-settings',{kit:'pop',parts:{}});
let editorBar=0,editorGhost=false;
samplerSettings.notes??={};samplerSettings.editorParts??=['kick','snare','hat','tom','low','crash','conga','muted','shaker','repinique','tamborim','surdo'];
for(const r of catalog)audioModes[r.id]='modern';persist('tcb-audio-modes',audioModes);
let samplerEngine=null,sampleTick=0,sampleBar=0,sampleFillPending=false,sampleFill=null,lastSampleFill=-1,sampleFillStep=0;
function sampleMode(r=current){return false}
function classicMode(r=current){return false}
function getSampler(){ensureContext();return samplerEngine??(samplerEngine=new ChicabanaSampler(ctx,drumBus,voices,samplerSettings))}
function saveSampler(){persist('tcb-sampler12-settings',samplerSettings);samplerEngine?.update()}

function tempoStep(r=current){return classicMode(r)?r.classic.step:1}
function updateDynamics(){if(!compressor)return;compressor.threshold.value=sampleMode()?-10:classicMode()?-8:0;compressor.ratio.value=sampleMode()?3:classicMode()?4:1}
function tempoBounds(r=current){if(sampleMode(r))return {min:50,max:180};if(classicMode(r))return {min:r.classic.minBpm,max:r.classic.maxBpm};return {min:r.minBpm??Math.max(40,Math.ceil(r.bpm*.6)),max:r.maxBpm??Math.min(240,Math.floor(r.bpm*1.6))}}
function boundedTempo(value,r=current){const {min,max}=tempoBounds(r);const step=tempoStep(r),n=Math.round((Number(value)||r.bpm)/step)*step;return Math.max(min,Math.min(max,n))}
function bpm(){return boundedTempo($('#bpm').value)}
function ensureContext(){if(ctx&&ctx.state!=='closed')return;ctx=new(window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});master=ctx.createGain();toneNode=ctx.createBiquadFilter();toneNode.type='highshelf';toneNode.frequency.value=2600;master.gain.value=+$('#volume').value/100;drumBus=ctx.createGain();dryGain=ctx.createGain();wetGain=ctx.createGain();reverbNode=ctx.createConvolver();reverbFilter=ctx.createBiquadFilter();reverbFilter.type='highpass';reverbFilter.frequency.value=180;drumBus.connect(dryGain).connect(master);drumBus.connect(reverbFilter).connect(reverbNode).connect(wetGain).connect(master);compressor=ctx.createDynamicsCompressor();master.connect(toneNode).connect(compressor).connect(ctx.destination);updateDynamics();updateReverb(true);ctx.onstatechange=()=>{if(['suspended','interrupted','closed'].includes(ctx.state)&&playing)stop('Áudio interrompido pelo aparelho. Toque em TOCAR para retomar.')}}
function updateReverb(rebuild=false){
 const amount=Math.max(0,Math.min(50,+$('#reverbMix').value||0))/100,decay=Math.max(.3,Math.min(4,+$('#reverbDecay').value||1.2));
 $('#reverbValue').textContent=Math.round(amount*100)+'%';$('#decayValue').textContent=decay.toFixed(1)+' s';
 if(!ctx)return;
 dryGain.gain.setTargetAtTime(1-amount*.35,ctx.currentTime,.02);wetGain.gain.setTargetAtTime(amount*.8,ctx.currentTime,.02);
 if(rebuild||!reverbNode.buffer){const key=ctx.sampleRate+':'+decay;let impulse=reverbCache.get(key);if(!impulse){const length=Math.ceil(ctx.sampleRate*decay);impulse=ctx.createBuffer(2,length,ctx.sampleRate);let seed=8237;for(let ch=0;ch<2;ch++){const data=impulse.getChannelData(ch);for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;data[i]=noise*Math.exp(-6.9*i/length)*(i<ctx.sampleRate*.008?0:1)}}reverbCache.set(key,impulse);if(reverbCache.size>2)reverbCache.delete(reverbCache.keys().next().value)}reverbNode.buffer=impulse}
}
function cancelTempoLoad(){tempoWorker?.terminate();tempoWorker=null;if(tempoReject){tempoReject(Error('cancelled'));tempoReject=null}tempoLoadVersion++}
function applyLoudness(buffer, gain=1){for(let c=0;c<buffer.numberOfChannels;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++)data[i]*=gain;}return buffer}
async function load(r){ensureContext();if(decodedId===r.id&&decoded)return decoded;const request=++loadRequest;$('#soundStatus').textContent='Carregando '+r.name+'…';let buffer;if(classicMode(r)){const layers=await Promise.all([r.classic.drums,r.classic.percussion].map(async url=>{const res=await fetch(url);if(!res.ok)throw Error('Áudio anterior indisponível');return ctx.decodeAudioData(await res.arrayBuffer())}));buffer=mixClassic(layers,r,r.bpm)}else{const res=await fetch(r.src);if(!res.ok)throw Error('Áudio indisponível');buffer=applyLoudness(await ctx.decodeAudioData(await res.arrayBuffer()),r.loudnessGain)}if(request!==loadRequest)throw Error('cancelled');decoded=buffer;decodedId=r.id;prepared=null;preparedBpm=null;return buffer}
function mixClassic(layers,r,tempo,paired=false){
 const rate=layers[0].sampleRate,length=Math.round(32*60/tempo*rate),out=ctx.createBuffer(2,length,rate),a=layers[0].getChannelData(0),b=paired?layers[0].getChannelData(1):layers[1].getChannelData(0);
 const sum=out.getChannelData(0);for(let i=0;i<length;i++)sum[i]=(a[i]||0)+(b[i]||0);out.copyToChannel(sum,1);return out;
}
async function prepareClassic(r,tempo){
 cancelTempoLoad();const version=tempoLoadVersion;$('#soundStatus').textContent='Carregando versão anterior · '+tempo+' BPM…';const res=await fetch(r.classic.tempoFolder+'/'+r.classic.index+'-'+tempo+'.m4a');if(!res.ok)throw Error('Andamento anterior indisponível');const decoded=await ctx.decodeAudioData(await res.arrayBuffer());if(version!==tempoLoadVersion||decodedId!==r.id)throw Error('cancelled');prepared=mixClassic([decoded],r,tempo,true);preparedBpm=tempo;$('#soundStatus').textContent='● Versão anterior · '+tempo+' BPM pronto';return prepared;
}
async function prepare(r,tempo){
 if(sampleMode(r)){if(boundedTempo(tempo,r)!==tempo)throw Error('BPM fora da faixa');const engine=await getSampler().load();$('#soundStatus').textContent='● Banco acústico pronto · '+engine.bank.count+' samples';return engine;}
 if(boundedTempo(tempo,r)!==tempo)throw Error('BPM fora da faixa desta gravação');
 const original=await load(r);if(Math.abs(tempo-r.bpm)<.01){cancelTempoLoad();return original}
 if(decodedId===r.id&&preparedBpm===tempo&&prepared)return prepared;
 if(classicMode(r))return prepareClassic(r,tempo);
 cancelTempoLoad();const version=tempoLoadVersion;
 return new Promise((resolve,reject)=>{
  tempoReject=reject;tempoWorker=new Worker('tempo-worker.js?v=quality22');
  const fail=error=>{if(version!==tempoLoadVersion)return;tempoWorker?.terminate();tempoWorker=null;tempoReject=null;reject(error)};
  tempoWorker.onerror=()=>fail(Error('Não foi possível iniciar o motor de áudio'));
  tempoWorker.onmessage=e=>{const data=e.data;if(version!==tempoLoadVersion||data.id!==version)return;
   if(data.error)return fail(Error(data.error));
   if(data.progress!==undefined){$('#soundStatus').textContent='Preparando '+tempo+' BPM · '+data.progress+'%';return}
   if(decodedId!==r.id)return fail(Error('cancelled'));
   const channels=data.channels,out=ctx.createBuffer(channels.length,channels[0].length,original.sampleRate);channels.forEach((ch,i)=>out.copyToChannel(ch,i));prepared=out;preparedBpm=tempo;tempoWorker.terminate();tempoWorker=null;tempoReject=null;$('#soundStatus').textContent='● '+tempo+' BPM pronto';resolve(out);
  };
  const channels=Array.from({length:original.numberOfChannels},(_,i)=>original.getChannelData(i).slice());tempoWorker.postMessage({id:version,channels,sampleRate:original.sampleRate,ratio:tempo/r.bpm},channels.map(ch=>ch.buffer));
 });
}
let activeBuffer=null;
let recordedFillRequest=0,recordedFillWorker=null,recordedFillReject=null,recordedFillBusy=false,recordedFillQueued=null,recordedFillPlaying=false,lastRecordedFill=-1;
const recordedFillRaw=new Map(),recordedFillCache=new Map();
function setTempo(value,prepareAudio=true){const {min,max}=tempoBounds(),n=boundedTempo(value);if(n!==playBpm)cancelRecordedFill();for(const id of ['bpm','tempoSlider']){$('#'+id).min=min;$('#'+id).max=max;$('#'+id).step=tempoStep()}$('#minus').disabled=n<=min;$('#plus').disabled=n>=max;$('#tempoRange').textContent='Faixa: '+min+'–'+max+' BPM · original '+Math.round(current.bpm)+' BPM';$('#bpm').value=n;$('#tempoSlider').value=n;$('#tempoOutput').textContent=n+' BPM';if(prepareAudio&&playing&&sampleMode()){msg('Andamento muda no próximo compasso.');return n}if(prepareAudio&&playing){const request=++tempoRequest,r=current;queuedBuffer=null;clearTimeout(tempoTimer);tempoTimer=setTimeout(async()=>{try{msg('Preparando '+n+' BPM…');const buffer=await prepare(r,n);if(request!==tempoRequest||r!==current||!playing)return;queuedBuffer={buffer,bpm:n};msg('Novo BPM pronto · entra na próxima frase.')}catch(e){if(e.message!=='cancelled'&&e.name!=='AbortError'&&request===tempoRequest){setTempo(playBpm,false);msg('Não foi possível preparar o BPM. O anterior continua tocando.')}}},180)}return n}
function normalize(s){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
function renderLibrary(){const list=catalog.filter(r=>(category==='Todos'||r.cat===category)&&(!onlyFav||favs.includes(r.id))&&normalize(r.name+' '+r.cat).includes(normalize($('#search').value)));$('#count').textContent=list.length+' modelos';$('#library').innerHTML='';for(const r of list){const b=document.createElement('button');b.className='card'+(r.id===current.id?' selected':'');const name=document.createElement('strong'),info=document.createElement('span'),family=document.createElement('div');family.className='num';family.textContent=r.cat.toUpperCase();name.textContent=r.name;info.textContent=Math.round(r.bpm)+' BPM estimado · '+r.meter;b.append(family,name,info);b.onclick=()=>select(r);$('#library').append(b)}if(!list.length)$('#library').textContent='Nenhum áudio encontrado.'}
function render(){const r=current;updateDynamics();$('#engineMode').closest('label').hidden=true;$('#engineMode').disabled=true;$('#engineMode').value='modern';$('#name').textContent=r.name;$('#genre').textContent=r.cat.toUpperCase();$('#description').textContent=r.originalFile+' · áudio gravado com BPM variável';$('#signature').textContent=r.meter;$('#fav').textContent=favs.includes(r.id)?'★':'☆';$('#beats').innerHTML=Array.from({length:r.pulses},()=>'<i class="beat"></i>').join('');$('#pulseUnit').textContent=r.meter==='6/8'?'BPM = semínima pontuada':'BPM = semínima';$('#rhythmInfo').textContent=r.meter+' · quatro trechos de 2 compassos';$('#rhythmNote').textContent='Fonte: '+r.originalFile+'. BPM estimado: '+Math.round(r.bpm)+'. Recorte e posição do primeiro tempo aguardam sua conferência.';$('#kitNote').textContent='Bateria e percussões juntas no áudio enviado.';$('#backbeatHint').textContent='Caixa e aro não podem ser separados nesta gravação.';$('#studyStatus').textContent='Gravação enviada por você. BPM, compasso e recortes provisórios.';$('#axeModeHint').textContent=classicMode(r)?'Áudio recuperado da versão anterior: mesmo recorte e mesmos andamentos preparados. BPM em passos de 5. Troque a versão acima para comparar.':'Volume percebido e equilíbrio tonal compensados automaticamente ao mudar o BPM, com proteção dos picos. Mudanças grandes ainda podem alterar ataques e ambiência.';$('#axeFillHint').textContent='Ainda sem trecho de virada identificado. O botão e o pedal estão mantidos para receber as viradas.';$('#fillLabel').textContent='Aguardando trechos de virada';$('#swingHelp').textContent='Humanização e subdivisões fazem parte da execução gravada.';$$('[data-var]').forEach((b,i)=>{b.hidden=false;b.classList.toggle('on',i===variation);b.innerHTML='ABCD'[i]+' <small>Trecho '+('ABCD'[i])+'</small>'});renderSamplerControls();renderLibrary();renderRecordedFillControls()}
async function select(r){const request=++selectionRequest,restart=playing||starting||modeSwitchPlaying;stop();recordedFillRaw.clear();recordedFillCache.clear();lastRecordedFill=-1;current=r;variation=0;pendingVariation=null;decoded=null;decodedId=null;prepared=null;preparedBpm=null;activeBuffer=null;setTempo(r.bpm,false);render();msg('Selecionado · '+Math.round(r.bpm)+' BPM estimado.');if(restart){await play();if(request!==selectionRequest)return}}
function scheduleSource(time,offset,duration,fadeOut,buffer=activeBuffer){const source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=buffer;source.connect(gain).connect(drumBus);gain.gain.setValueAtTime(0,time);gain.gain.linearRampToValueAtTime(1,time+.002);gain.gain.setValueAtTime(1,time+duration-fadeOut);gain.gain.linearRampToValueAtTime(0,time+duration);source.start(time,offset,duration);voices.add(source);source.onended=()=>{voices.delete(source);source.disconnect();gain.disconnect()}}
function schedule(){if(!playing)return;if(sampleMode())return scheduleSamples();if(next<ctx.currentTime-.2){stop('Dispositivo atrasou. Toque novamente para retomar.');return}if(next>ctx.currentTime+.12)return;if(ending){clearInterval(timer);const gen=generation;setTimeout(()=>{if(gen===generation)stop('Finalizado.')},Math.max(0,(next-ctx.currentTime)*1000));return}if(queuedBuffer){activeBuffer=queuedBuffer.buffer;playBpm=queuedBuffer.bpm;queuedBuffer=null}if(recordedFillQueued&&recordedFillQueued.bpm===playBpm){const f=recordedFillQueued;recordedFillQueued=null;recordedFillPlaying=true;scheduleSource(next,0,f.buffer.duration,.003,f.buffer);barStart=next;next+=f.buffer.duration;updateRecordedFillButton();msg('Virada · '+f.name+' · retorno à levada em seguida.');return;}recordedFillPlaying=false;updateRecordedFillButton();if(pendingVariation!==null){variation=pendingVariation;pendingVariation=null}else if(barStart>0&&$('#naturalVariation').value==='on')variation=(variation+1)%4;const length=activeBuffer.duration/4,offset=variation*length;
 if(classicMode()){for(let bar=0;bar<2;bar++)scheduleSource(next+bar*length/2,offset+bar*length/2,length/2,.003)}else scheduleSource(next,offset,length,.002);
 barStart=next;next+=length;$$('[data-var]').forEach((b,i)=>b.classList.toggle('on',i===variation));msg('Tocando · '+current.name+' · '+playBpm+' BPM');}
function position(){if(!playing)return;const elapsed=Math.max(0,ctx.currentTime-barStart),pulse=60/playBpm,beat=Math.floor(elapsed/pulse)%current.pulses;$$('.beat').forEach((b,i)=>b.classList.toggle('active',i===beat));$('#position').textContent=(recordedFillPlaying?'Virada':'Trecho '+('ABCD'[variation]))+' · tempo '+(beat+1)}
async function play(){if(starting)return;if(playing)return stop();starting=true;const request=generation;$('#play').disabled=true;try{ensureContext();await ctx.resume();const r=current,n=bpm();setTempo(n,false);activeBuffer=await prepare(r,n);if(ctx.state!=='running')throw Error('audio-suspended');if(request!==generation||r!==current)return;playBpm=n;sampleTick=0;sampleBar=0;sampleFillPending=false;sampleFill=null;samplerEngine?.reset();next=ctx.currentTime+.12;barStart=0;ending=false;playing=true;$('#play').innerHTML='Ⅱ <span>PARAR</span>';$('#soundStatus').textContent=sampleMode(r)?'● Chicabana · '+samplerEngine.bank.count+' samples prontos':'● '+r.name+' · pronto';timer=setInterval(()=>{schedule();position()},30);schedule();if(navigator.wakeLock)try{wakeLock=await navigator.wakeLock.request('screen')}catch{}}catch(e){if(e.message!=='cancelled'&&e.name!=='AbortError')msg(e.message==='audio-suspended'?'Toque em TOCAR novamente para liberar o áudio neste aparelho.':'Não foi possível carregar o áudio. Confira a conexão ou baixe os ritmos para uso offline.')}finally{if(request===generation){starting=false;$('#play').disabled=false}}}
function stop(message='Parado.'){cancelRecordedFill();recordedFillPlaying=false;updateRecordedFillButton();generation++;tempoRequest++;loadRequest++;clearTimeout(tempoTimer);cancelTempoLoad();clearInterval(timer);playing=false;starting=false;$('#play').disabled=false;ending=false;queuedBuffer=null;for(const source of voices)try{source.stop()}catch{}voices.clear();$('#play').innerHTML='▶ <span>TOCAR</span>';if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null}$$('.beat').forEach(b=>b.classList.remove('active'));msg(message)}
function requestFill(){return requestRecordedFill()}
function pedalFire(){const now=performance.now();if(now-lastPedalAt<180)return;lastPedalAt=now;requestFill()}
function handlePedalKey(e){if(learningKey){e.preventDefault();learningKey=false;if(!['Escape','Space'].includes(e.code)){pedalKey=e.code;persist('tcb-pedal-key',pedalKey)}$('#learnKey').textContent='Tecla: '+pedalKey.replace('Key','')+' · configurar';return true}if(e.code===pedalKey&&!e.repeat&&!['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)){e.preventDefault();pedalFire();return true}return false}
function handlePedalMidi(e){const [status,number,value=0]=e.data,type=status&240,channel=status&15;if(!((type===144&&value>0)||type===176))return;if(learningMidi&&value>0){midiBinding={type,number,channel};persist('tcb-pedal-midi',midiBinding);learningMidi=false;$('#pedalStatus').textContent='Pedal MIDI atribuído.';midiValues.set(channel+':'+number,value);return}if(!midiBinding||type!==midiBinding.type||number!==midiBinding.number||channel!==midiBinding.channel)return;const key=channel+':'+number,prev=midiValues.get(key)||0;midiValues.set(key,value);if(type===144||value>=64&&prev<64)pedalFire()}
function presetRender(){$('#presets').innerHTML='';if(!presets.length)$('#presets').textContent='Salve um ajuste para começar.';presets.forEach((p,i)=>{const b=document.createElement('button'),del=document.createElement('button');b.textContent=p.name+' · '+p.bpm+' BPM';b.onclick=async()=>{const r=catalog.find(r=>r.id===p.id);if(!r)return msg('Áudio não disponível neste lote.');stop();await select(r);if(r.classic&&p.audioMode){audioModes[r.id]=p.audioMode;persist('tcb-audio-modes',audioModes);decoded=null;decodedId=null;prepared=null;preparedBpm=null;}if(p.samplerSettings){Object.assign(samplerSettings,p.samplerSettings);samplerSettings.notes??={};samplerSettings.editorParts??=['kick','snare','hat','conga'];saveSampler();}variation=p.variation||0;setTempo(p.bpm,false);for(const id of ['volume','tone','reverbMix','reverbDecay','naturalVariation','backbeat','surface','human','swing','swingUnit','auxMode','auxVolume','fillMode','fillLength','fillPhrase'])if(p[id]!==undefined)$('#'+id).value=p[id];if(master)master.gain.value=+$('#volume').value/100;if(toneNode)toneNode.gain.value=+$('#tone').value;updateReverb(true);render()};del.textContent='×';del.setAttribute('aria-label','Excluir '+p.name);del.onclick=()=>{presets.splice(i,1);persist('tcb-audio-presets',presets);presetRender()};$('#presets').append(b,del)})}
// Original recording controls remain restricted; Chicabana enables the independent sampler controls.
for(const id of ['timbre','backbeat','surface','conduction','human','swing','swingUnit','auxMode','auxVolume','auxAudition','audition','grid','ghost','resetPattern','samplerVersion','axePieceLibrary','axePieceAudition','resetAxeParts','axeUseModelPerc','fillMode','fillPhrase','fillLength']){const el=$('#'+id);if(el){el.disabled=true;el.title='Indisponível no áudio mixado. Aguardando arquivos separados.'}}
$('#timbre').innerHTML='<option>Timbre da gravação</option>';$('#mixer').textContent='Áudio estéreo mixado: use o volume geral.';$('#editor').textContent='A execução está gravada no áudio. Edição por peça indisponível.';$('#gridHint').textContent='Os controles de edição foram preservados para futuras versões.';
for(const id of ['referencePanel','studyPanel','axeSamplerPanel'])$('#'+id).hidden=true;$('#axeControls').hidden=false;$('#engineMode').closest('label').hidden=true;$('#engineMode').innerHTML='<option value="modern">Áudio gravado · BPM variável</option>';$('#naturalVariation').options[0].textContent='Alternar A–D a cada 2 compassos';$('#suggestedKit').hidden=true;$('#swingValue').textContent='Gravado';$$('[data-bar]').forEach(b=>b.disabled=true);
const presentCategories=[...new Set(catalog.map(r=>r.cat).filter(cat=>typeof cat==='string'&&cat.trim()))];
const menuCategories=[...CATEGORY_ORDER.filter(cat=>presentCategories.includes(cat)),...presentCategories.filter(cat=>!CATEGORY_ORDER.includes(cat)).sort((a,b)=>a.localeCompare(b,'pt-BR'))];
for(const cat of ['Todos',...menuCategories]){const b=document.createElement('button');b.textContent=cat;b.className=cat===category?'on':'';b.onclick=()=>{category=cat;$$('#cats button').forEach(el=>el.classList.toggle('on',el===b));renderLibrary()};$('#cats').append(b)}
$('#search').oninput=renderLibrary;$('#play').onclick=play;$('#fill').onclick=requestFill;$('#ending').onclick=()=>{if(!playing)return msg('Inicie o áudio primeiro.');ending=true;msg('Finaliza ao terminar o trecho atual.')};$$('[data-var]').forEach((b,i)=>b.onclick=()=>{if(playing){pendingVariation=i;msg('Trecho '+('ABCD'[i])+' · próxima frase.')}else{variation=i;render()}});
$('#minus').onclick=()=>setTempo(bpm()-tempoStep());$('#plus').onclick=()=>setTempo(bpm()+tempoStep());$('#bpm').oninput=()=>{const n=Number($('#bpm').value),{min,max}=tempoBounds();if(Number.isFinite(n)&&n>=min&&n<=max)setTempo(n)};$('#bpm').onchange=()=>setTempo(bpm());$('#tempoSlider').oninput=()=>setTempo($('#tempoSlider').value);$('#resetTempo').onclick=()=>setTempo(current.bpm);let taps=[];$('#tap').onclick=()=>{const now=performance.now();if(taps.length&&now-taps.at(-1)>2000)taps=[];taps.push(now);taps=taps.slice(-5);if(taps.length>1)setTempo(60000/((now-taps[0])/(taps.length-1)))};
$('#volume').oninput=()=>{if(master)master.gain.setTargetAtTime(+$('#volume').value/100,ctx.currentTime,.02)};$('#tone').oninput=()=>{if(toneNode)toneNode.gain.setTargetAtTime(+$('#tone').value,ctx.currentTime,.02)};$('#reverbMix').oninput=()=>updateReverb();$('#reverbDecay').onchange=()=>updateReverb(true);$('#reverbReset').onclick=()=>{$('#reverbMix').value=0;updateReverb()};
$('#fav').onclick=()=>{favs=favs.includes(current.id)?favs.filter(id=>id!==current.id):[...favs,current.id];persist('tcb-audio-favorites',favs);render()};$('#favorites').onclick=()=>{onlyFav=!onlyFav;$('#favorites').classList.toggle('on',onlyFav);renderLibrary()};$('#stage').onclick=()=>document.body.classList.toggle('stage');
$('#save').onclick=()=>{const name=prompt('Nome do ajuste:',current.name);if(!name?.trim())return;const p={name:name.trim(),id:current.id,bpm:bpm(),variation,samplerSettings:JSON.parse(JSON.stringify(samplerSettings)),audioMode:sampleMode()?'samples':classicMode()?'classic':'modern'};for(const id of ['volume','tone','reverbMix','reverbDecay','naturalVariation','backbeat','surface','human','swing','swingUnit','auxMode','auxVolume','fillMode','fillLength','fillPhrase'])p[id]=$('#'+id).value;presets.push(p);persist('tcb-audio-presets',presets);presetRender();msg('Ajuste salvo.')};
$('#engineMode').onchange=async()=>{
 const token=++modeSwitchToken,restart=playing||starting||modeSwitchPlaying,r=current;modeSwitchPlaying=restart;stop();
 audioModes[r.id]=['samples','modern','classic'].includes($('#engineMode').value)?$('#engineMode').value:'classic';persist('tcb-audio-modes',audioModes);
 try{const selection=select(r),gen=generation;await selection;if(token!==modeSwitchToken||gen!==generation)return;if(restart&&!playing&&!starting)await play()}
 finally{if(token===modeSwitchToken)modeSwitchPlaying=false}
};

$('#learnKey').textContent='Tecla: '+pedalKey.replace('Key','')+' · configurar';$('#learnKey').onclick=()=>{learningKey=true;$('#learnKey').textContent='Pressione a tecla do pedal…'};$('#connectMidi').onclick=async()=>{if(!navigator.requestMIDIAccess)return msg('MIDI indisponível. Use pedal que envie teclas.');try{midiAccess=await navigator.requestMIDIAccess({sysex:false});const bind=()=>{for(const input of midiAccess.inputs.values())input.onmidimessage=handlePedalMidi};bind();midiAccess.onstatechange=bind;learningMidi=true;$('#pedalStatus').textContent='Pressione o pedal para atribuir a virada.'}catch{msg('Não foi possível conectar o pedal MIDI.')}};
document.addEventListener('keydown',e=>{if(handlePedalKey(e))return;if(e.repeat||['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();play()}if('1234'.includes(e.key))$$('[data-var]')[+e.key-1].click()});window.addEventListener('pagehide',()=>stop());
initSampleEditor();
$('#timbre').onchange=()=>{samplerSettings.kit=$('#timbre').value;saveSampler()};
$('#human').oninput=()=>{if(sampleMode())$('#swingHelp').textContent='Humanização: até '+(Number($('#human').value)*.2).toFixed(1)+' ms de variação suave; pulso preservado.'};
$('#swing').oninput=()=>$('#swingValue').textContent=$('#swing').value+'%';
$('#fillMode').onchange=()=>$('#fillPhrase').disabled=!current.fills?.length||$('#fillMode').value!=='fixed';
$('#audition').onclick=async()=>{if(!sampleMode())return;try{await getSampler().load();await ctx.resume();['kick','snare','hat','tom','low'].forEach((p,i)=>samplerEngine.hit(p,ctx.currentTime+.08+i*.35,.8,sampleOptions()));}catch{msg('Não foi possível carregar o banco.')}};
$('#auxAudition').onclick=async()=>{if(!sampleMode())return;try{await getSampler().load();await ctx.resume();['conga','muted','repinique','tamborim','surdo'].forEach((p,i)=>samplerEngine.hit(p,ctx.currentTime+.08+i*.35,.8,{...sampleOptions(),percussion:true}));}catch{msg('Não foi possível carregar as percussões.')}};
render();presetRender();setTempo(current.bpm,false);updateReverb();

function sampleOptions(){return {kit:samplerSettings.kit,backbeat:$('#backbeat').value,surface:$('#surface').value,percussion:$('#auxMode').value!=='none',percussionVolume:+$('#auxVolume').value/100,articulation:null}}
function chooseSampleFill(){const mode=$('#fillMode').value;let i;if(mode==='fixed')i=+$('#fillPhrase').value%CHIC_FILLS.length;else if(mode==='sequence')i=(lastSampleFill+1)%CHIC_FILLS.length;else{i=Math.floor(Math.random()*(CHIC_FILLS.length-1));if(i>=lastSampleFill&&lastSampleFill>=0)i++;}lastSampleFill=i;return $('#fillLength').value==='full'?CHIC_FULL_FILLS[i]:CHIC_FILLS[i];}
function scheduleSamples(){
 if(next<ctx.currentTime-.2){stop('Dispositivo atrasou. Toque novamente para retomar.');return;}
 while(playing&&next<ctx.currentTime+.12){
  if(sampleTick===0){
   if(ending){clearInterval(timer);const gen=generation;setTimeout(()=>{if(gen===generation)stop('Finalizado.')},Math.max(0,(next-ctx.currentTime)*1000));return;}
   playBpm=bpm();barStart=next;
   if(pendingVariation!==null){variation=pendingVariation;pendingVariation=null;}
   else if(sampleBar>0&&sampleBar%2===0&&$('#naturalVariation').value==='on')variation=(variation+1)%4;
   $$('[data-var]').forEach((b,i)=>b.classList.toggle('on',i===variation));
   if($('#editor').dataset.variation!==String(variation))renderSampleEditor();
   msg('Tocando · Chicabana com samples · '+playBpm+' BPM');
  }
  const full=$('#fillLength').value==='full';
  if(sampleFillPending&&(full?sampleTick===0:sampleTick%4===0)){
   sampleFill=chooseSampleFill();sampleFill.full=full;sampleFillStep=0;sampleFillPending=false;msg('Virada '+(lastSampleFill+1)+' · retorno à levada automático.');
  }
  const options=sampleOptions(),stepSeconds=60/playBpm/4,human=+$('#human').value/50;
  const events=editedChicabanaBar(variation,sampleBar,$('#naturalVariation').value==='on').filter(e=>Math.floor(e.step+1e-8)===sampleTick);
  if(sampleFill){
   const scale=1;
   for(const [piece,step,velocity] of sampleFill){const at=step*scale;if(Math.floor(at)===sampleFillStep)events.push({piece,step:sampleTick,velocity,sub:at-Math.floor(at),fill:true});}
  }
  for(const e of events){
   if(sampleFill&&!e.fill&&['snare','hat','tom','low'].includes(e.piece))continue;
   const odd=$('#swingUnit').value==='16'?sampleTick%2===1:sampleTick%4===2||sampleTick%4===3;
   const swing=odd?(+$('#swing').value/100-.5)*($('#swingUnit').value==='16'?2:4)*stepSeconds:0;
   const anchor=e.piece==='kick'||e.piece==='surdo',jitter=anchor?0:(Math.random()-.5)*.02*human;
   const velocity=Math.max(.08,Math.min(.99,e.velocity*(1+(Math.random()-.5)*.12*human)));
   samplerEngine.hit(e.piece,next+(e.sub??(e.step-sampleTick))*stepSeconds+swing+jitter,velocity,{...options,articulation:e.articulation});
  }
  if(sampleFill){sampleFillStep++;if(sampleFillStep>=(sampleFill.full?16:4))sampleFill=null;}
  next+=stepSeconds;sampleTick=(sampleTick+1)%16;if(sampleTick===0)sampleBar++;
 }
}
function renderSamplerControls(){
 const enabled=sampleMode();
 for(const id of ['timbre','backbeat','surface','human','swing','swingUnit','auxMode','auxVolume','auxAudition','audition','fillMode','fillLength']){$('#'+id).disabled=!enabled;$('#'+id).title=enabled?'':'Indisponível na gravação mixada.';}
 $('#fillPhrase').disabled=!enabled||$('#fillMode').value!=='fixed';$('#fillPhrase').title=enabled?'':'Indisponível na gravação mixada.';
 if(enabled){
  $('#soundStatus').textContent=samplerEngine?.buffer?'● Banco acústico pronto · '+samplerEngine.bank.count+' samples':'Chicabana · banco acústico de 1,7 MB';$('#swingValue').textContent=$('#swing').value+'%';
  $$('[data-var]').forEach((b,i)=>b.innerHTML='ABCD'[i]+' <small>Variação '+('ABCD'[i])+'</small>');
  $('#timbre').innerHTML='<option value="pop">Pop acústico · definido</option><option value="body">Pop acústico · encorpado</option>';$('#timbre').value=samplerSettings.kit;
  $('#description').textContent='Bateria e percussão com samples individuais · versão para sua conferência';
  $('#kitNote').textContent='Bateria acústica com várias intensidades e tomadas alternadas de cada peça.';
  $('#backbeatHint').textContent='Escolha caixa ou aro sem mudar a posição dos golpes.';
  $('#axeModeHint').textContent='Samples: o BPM muda o intervalo dos golpes, preservando a afinação das peças. O banco carrega uma vez e é reutilizado.';
  $('#axeFillHint').textContent='Viradas somente por botão, tecla ou pedal. Seis frases com bateria do mesmo banco.';
  $('#fillLabel').textContent='6 viradas manuais · sem repetição imediata no modo aleatório';
  $('#swingHelp').textContent='Humanização ajustável; alternância de tomadas e abertura discreta do chimbal. Sem viradas automáticas.';
  $('#rhythmNote').textContent='Arranjo de Chicabana baseado nos ataques do áudio enviado: pulso grave e acentos sincopados. A identificação de peças é uma interpretação, ainda aguardando sua aprovação. Referência complementar: Afrobook, Pracatum, seções de samba-reggae e organização dos naipes.';
  $('#rhythmInfo').textContent='4/4 · quatro variações de dois compassos';
  $('#editorPanel').open=true;$('#auxPanel').open=true;
  const auxValue=$('#auxMode').value==='none'?'none':'auto';$('#auxMode').innerHTML='<option value="auto">Percussão da levada · ligada</option><option value="none">Desligada</option>';$('#auxMode').value=auxValue;
  $('#fillPhrase').innerHTML=Array.from({length:6},(_,i)=>'<option value="'+i+'">'+(i+1)+'</option>').join('');
  renderSampleMixer();renderSampleEditor();
 }else{
  $('#timbre').innerHTML='<option>Timbre da gravação</option>';$('#mixer').textContent='Áudio estéreo mixado: use o volume geral.';renderSampleEditor();
 }
}
function renderSampleMixer(){
 const mixer=$('#mixer');mixer.innerHTML='';
 for(const [piece,[name,defaultVolume]] of Object.entries(CHIC_PARTS)){
  const setting=samplerSettings.parts[piece]??{volume:defaultVolume,mute:false},row=document.createElement('div');row.className='sample-mixer-row';
  const title=document.createElement('strong');title.textContent=name;
  const volume=document.createElement('input');volume.type='range';volume.min=0;volume.max=120;volume.value=Math.round(setting.volume*100);volume.setAttribute('aria-label','Volume de '+name);
  const output=document.createElement('output');output.textContent=volume.value+'%';
  volume.oninput=()=>{samplerSettings.parts[piece]={...setting,...samplerSettings.parts[piece],volume:+volume.value/100};output.textContent=volume.value+'%';saveSampler()};
  const mute=document.createElement('button');mute.textContent=setting.mute?'Ativar':'Silenciar';mute.setAttribute('aria-pressed',String(setting.mute));mute.setAttribute('aria-label','Silenciar '+name);
  mute.onclick=()=>{const state=samplerSettings.parts[piece]??setting;state.mute=!state.mute;samplerSettings.parts[piece]=state;mute.textContent=state.mute?'Ativar':'Silenciar';mute.setAttribute('aria-pressed',String(state.mute));saveSampler()};
  const listen=document.createElement('button');listen.textContent='▶ Ouvir';listen.setAttribute('aria-label','Ouvir '+name);listen.onclick=async()=>{try{await getSampler().load();await ctx.resume();const opts={...sampleOptions(),percussion:true,audition:true};samplerEngine.hit(piece,ctx.currentTime+.05,.8,opts)}catch{msg('Não foi possível carregar a peça.')}};
  row.append(title,listen,volume,output,mute);mixer.append(row);
 }
}

function editedChicabanaBar(v,bar,natural=true){
 const base=chicabanaBar(v,bar,natural),prefix=v+':'+(bar%2)+':',out=base.filter(e=>!Object.hasOwn(samplerSettings.notes,prefix+e.piece+':'+Math.round(e.step*6)));
 for(const [key,velocity] of Object.entries(samplerSettings.notes))if(key.startsWith(prefix)&&velocity>0){const [piece,tick]=key.slice(prefix.length).split(':');if(CHIC_PARTS[piece]){const step=Number(tick)/6,original=base.find(e=>e.piece===piece&&Math.abs(e.step-step)<.001);out.push({...original,piece,step,velocity});}}
 return out.sort((a,b)=>a.step-b.step);
}
function editNote(piece,tick,velocity){
 $('#naturalVariation').value='off';
 samplerSettings.notes[variation+':'+editorBar+':'+piece+':'+tick]=velocity;
 if(velocity>0){const state=samplerSettings.parts[piece]??{volume:CHIC_PARTS[piece][1],mute:false};state.mute=false;if(state.volume<=0)state.volume=CHIC_PARTS[piece][1]||.35;samplerSettings.parts[piece]=state;if(CHIC_PARTS[piece][3])$('#auxMode').value='auto';}
 saveSampler();renderSampleEditor();renderSampleMixer();
}
function initSampleEditor(){
 $('#mixerPanel').before($('#editorPanel'));
 for(const [piece,[label,,,percussion]] of Object.entries(CHIC_PARTS))if(percussion){const o=document.createElement('option');o.value=piece;o.textContent=label;$('#addPercussion').append(o);}
 $('#addPercussionButton').onclick=()=>{
  if(!sampleMode())return;const piece=$('#addPercussion').value;
  if(!samplerSettings.editorParts.includes(piece))samplerSettings.editorParts.push(piece);
  samplerSettings.parts[piece]={volume:CHIC_PARTS[piece][1]||.35,mute:false};$('#auxMode').value='auto';
  const events=editedChicabanaBar(variation,editorBar,false).filter(e=>e.piece===piece);
  if(!events.length)for(const step of [0,6,8,14])samplerSettings.notes[variation+':'+editorBar+':'+piece+':'+step*6]=.6;
  saveSampler();renderSampleEditor();renderSampleMixer();msg(CHIC_PARTS[piece][0]+' adicionada. Ajuste os golpes na grade.');
 };
 $$('[data-bar]').forEach((b,i)=>b.onclick=()=>{editorBar=i;renderSampleEditor()});
 $('#grid').onchange=renderSampleEditor;
 $('#ghost').onclick=()=>{editorGhost=!editorGhost;$('#ghost').setAttribute('aria-pressed',String(editorGhost));$('#ghost').textContent=editorGhost?'Nota fantasma · ligada':'Nota fantasma';};
 $('#resetPattern').onclick=()=>{const prefix=variation+':';for(const key of Object.keys(samplerSettings.notes))if(key.startsWith(prefix))delete samplerSettings.notes[key];saveSampler();renderSampleEditor();msg('Variação '+('ABCD'[variation])+' restaurada nos dois compassos.');};
}
function renderSampleEditor(){
 const enabled=sampleMode();for(const id of ['grid','ghost','resetPattern','addPercussion','addPercussionButton']){$('#'+id).disabled=!enabled;$('#'+id).title=enabled?'':'Indisponível no áudio mixado.';}
 $$('[data-bar]').forEach((b,i)=>{b.disabled=!enabled;b.classList.toggle('on',i===editorBar)});
 if(!enabled){$('#editor').textContent='Esta levada usa o áudio gravado completo. A grade não altera golpes individuais de uma gravação mixada.';$('#editorVariation').textContent='';return;}
 const units=Number($('#grid').value)||4,columns=units*4,events=editedChicabanaBar(variation,editorBar,false),editor=$('#editor');editor.innerHTML='';editor.dataset.variation=String(variation);
 $('#editorVariation').textContent='Variação '+('ABCD'[variation])+' · compasso '+(editorBar+1);
 $('#gridHint').textContent='Clique: normal → acento → fantasma → vazio. Botão direito apaga. As alterações são salvas neste navegador e valem nos próximos golpes. Trocar a grade preserva as outras notas.';
 function row(){const r=document.createElement('div');r.className='groove-grid-row';r.style.gridTemplateColumns='150px repeat('+columns+', minmax(28px, 1fr))';return r;}
 const header=row(),title=document.createElement('strong');title.textContent='PEÇA / TEMPO';header.append(title);
 for(let c=0;c<columns;c++){const label=document.createElement('span');label.textContent=c%units===0?String(Math.floor(c/units)+1):units===4?['','e','&','a'][c%units]:units===2?'&':String(c%units+1);header.append(label);}editor.append(header);
 for(const piece of samplerSettings.editorParts){if(!CHIC_PARTS[piece])continue;const r=row(),label=document.createElement('strong');label.textContent=CHIC_PARTS[piece][0];r.append(label);
  for(let c=0;c<columns;c++){const tick=c*(96/columns),note=events.find(e=>e.piece===piece&&Math.abs(e.step*6-tick)<.001),velocity=note?.velocity||0,button=document.createElement('button');button.type='button';button.className='groove-cell'+(c%units===0?' downbeat':'')+(velocity>0?(velocity<.4?' ghost':velocity>=.85?' accent':' note'):'');button.textContent=velocity>0?(velocity<.4?'·':velocity>=.85?'◆':'●'):'';button.setAttribute('aria-label',CHIC_PARTS[piece][0]+', variação '+('ABCD'[variation])+', compasso '+(editorBar+1)+', posição '+(c+1)+': '+(velocity?velocity<.4?'fantasma':velocity>=.85?'acento':'normal':'vazio'));button.setAttribute('aria-pressed',String(velocity>0));button.onclick=()=>editNote(piece,tick,editorGhost?(velocity>0?0:.24):velocity===0?.62:velocity<.4?0:velocity>=.85?.24:.95);button.oncontextmenu=e=>{e.preventDefault();editNote(piece,tick,0)};r.append(button);
  }editor.append(r);
 }
 const hidden=events.filter(e=>Math.abs(e.step/(4/units)-Math.round(e.step/(4/units)))>.001).length;
 if(hidden)$('#gridHint').textContent+=' '+hidden+' golpes estão em outras subdivisões e continuam tocando.';
}

function updateRecordedFillButton(){if(!$('#fill'))return;$('#fill').textContent=recordedFillBusy?'⏳ Preparando virada…':recordedFillQueued?'↗ Virada armada':recordedFillPlaying?'↗ Virada tocando':'↗ Virada';$('#fill').setAttribute('aria-busy',String(recordedFillBusy));}
function cancelRecordedFill(){recordedFillRequest++;recordedFillWorker?.terminate();recordedFillWorker=null;recordedFillReject?.(Error('cancelled'));recordedFillReject=null;recordedFillBusy=false;recordedFillQueued=null;recordedFillCache.clear();updateRecordedFillButton();}
function renderRecordedFillControls(){
 const fills=current.fills||[],enabled=fills.length>0;$('#fill').disabled=!enabled;$('#fillMode').disabled=!enabled;$('#fillMode').title='';
 const value=$('#fillPhrase').value;$('#fillPhrase').innerHTML=fills.map((f,i)=>'<option value="'+i+'">'+(i+1)+' · em revisão</option>').join('');$('#fillPhrase').value=String(Math.min(+value||0,Math.max(0,fills.length-1)));$('#fillPhrase').disabled=!enabled||$('#fillMode').value!=='fixed';$('#fillPhrase').title='';
 $('#fillLength').innerHTML='<option value="full">Trecho gravado · um compasso</option>';
 $('#fillLabel').textContent=enabled?fills.length+' trechos da gravação · seleção em revisão':'Sem trecho de virada disponível';
 $('#axeFillHint').textContent=enabled?'Virada manual: prepara um trecho da própria gravação no BPM atual, entra no fim da frase e volta à levada. Os recortes são candidatos e precisam da sua conferência musical.':'Nenhum recorte de virada está disponível neste modelo.';updateRecordedFillButton();
}
async function prepareRecordedFill(r,index,tempo,request){
 const definition=r.fills[index],key=r.id+':'+index+':'+tempo;
 if(recordedFillCache.has(key))return recordedFillCache.get(key);
 let original=recordedFillRaw.get(r.id+':'+index);
 if(!original){const res=await fetch(definition.src);if(!res.ok)throw Error('Trecho indisponível');original=applyLoudness(await ctx.decodeAudioData(await res.arrayBuffer()),definition.loudnessGain);if(request!==recordedFillRequest)throw Error('cancelled');recordedFillRaw.set(r.id+':'+index,original);}
 if(tempo===r.bpm)return original;
 const result=await new Promise((resolve,reject)=>{
  recordedFillReject=reject;const worker=recordedFillWorker=new Worker('tempo-worker.js?v=quality22');
  const finish=(err,value)=>{worker.terminate();if(recordedFillWorker===worker){recordedFillWorker=null;recordedFillReject=null;}err?reject(err):resolve(value)};
  worker.onerror=()=>finish(Error('Falha ao preparar virada'));
  worker.onmessage=e=>{const data=e.data;if(request!==recordedFillRequest||data.id!==request)return;if(data.error)return finish(Error(data.error));if(data.progress!==undefined)return;const b=ctx.createBuffer(data.channels.length,data.channels[0].length,original.sampleRate);data.channels.forEach((ch,i)=>b.copyToChannel(ch,i));finish(null,b);};
  const channels=Array.from({length:original.numberOfChannels},(_,i)=>original.getChannelData(i).slice());worker.postMessage({id:request,channels,sampleRate:original.sampleRate,ratio:tempo/r.bpm},channels.map(ch=>ch.buffer));
 });
 if(request!==recordedFillRequest)throw Error('cancelled');recordedFillCache.set(key,result);return result;
}
async function requestRecordedFill(){
 if(!playing)return msg('Inicie a levada antes de acionar a virada.');
 if(!current.fills?.length)return msg('Este modelo ainda não tem recortes de virada.');
 if(recordedFillBusy||recordedFillQueued)return msg(recordedFillBusy?'Preparando a virada. A levada continua tocando.':'Virada já armada para o fim da frase.');
 if(bpm()!==playBpm)return msg('Aguarde a mudança de BPM terminar e acione a virada.');
 const r=current,tempo=playBpm,request=++recordedFillRequest,gen=generation,count=r.fills.length,mode=$('#fillMode').value;
 let index=0;if(mode==='fixed')index=(+$('#fillPhrase').value||0)%count;else if(mode==='sequence')index=(lastRecordedFill+1)%count;else{index=Math.floor(Math.random()*(lastRecordedFill>=0&&count>1?count-1:count));if(lastRecordedFill>=0&&count>1&&index>=lastRecordedFill)index++;}
 recordedFillBusy=true;updateRecordedFillButton();msg('Preparando virada da própria gravação…');
 try{const buffer=await prepareRecordedFill(r,index,tempo,request);if(request!==recordedFillRequest||gen!==generation||r!==current||!playing||tempo!==playBpm)return;lastRecordedFill=index;recordedFillQueued={buffer,bpm:tempo,name:r.fills[index].name};msg('Virada armada · entra no fim da frase atual.');}
 catch(e){if(e.message!=='cancelled'&&request===recordedFillRequest)msg('Não foi possível carregar a virada. A levada continua tocando.');}
 finally{if(request===recordedFillRequest){recordedFillBusy=false;updateRecordedFillButton();}}
}

// Screen locks may be released by the OS when visibility changes.
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&playing&&ctx?.state==='running'&&navigator.wakeLock){try{wakeLock=await navigator.wakeLock.request('screen')}catch{}}});
