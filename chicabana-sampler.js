'use strict';
// Single compact atlas of independently recorded one-shots; never a groove recording.
const CHIC_PARTS={kick:['Bumbo',.92,0,false],snare:['Caixa / aro',.8,0,false],hat:['Chimbal',.48,-.18,false],tom:['Tom',.65,-.28,false],low:['Surdo da bateria',.65,.3,false],crash:['Crash',.48,-.3,false],ride:['Condução',.4,.25,false],conga:['Conga aberta',.38,.18,true],muted:['Conga abafada',.32,.2,true],shaker:['Shaker',.25,-.22,true],repinique:['Repinique',.28,-.12,true],tamborim:['Tamborim',.18,.28,true],surdo:['Surdo brasileiro',.28,0,true],agogoLow:['Agogô grave',0,-.3,true],agogoHigh:['Agogô agudo',0,-.3,true]};
// Original arrangement based on the supplied Chicabana excerpt. Grid: 16 sixteenths/bar.
// Reference attack families: low quarter pulse; syncopated middle attacks at 3,5,11;
// complementary percussion at 0,6,8,14. Instrument assignment remains a musical interpretation.
function chicabanaBar(variant,bar,natural=true){
 const events=[],put=(piece,steps,velocities)=>steps.forEach((step,i)=>events.push({piece,step,velocity:Array.isArray(velocities)?velocities[i%velocities.length]:velocities}));
 const v=((variant%4)+4)%4,b=bar%2;
 const kick=[[.56,.94,.56,.97],[.59,.98,.57,.93],[.6,.95,.57,.99],[.58,.98,.59,.96]][v];
 put('kick',[0,4,8,12],kick);put('snare',[3,5,11],[[.86,.78,.84],[.73,.96,.86],[.9,.74,.88],[.87,.91,.82]][v]);
 put('hat',[0,4,8,12],b?[.47,.76,.5,.8]:[.58,.79,.51,.72]);
 put('conga',[0,6,8,14],b?[.64,.7,.6,.76]:[.6,.72,.67,.73]);put('muted',[2,10,13],[.37,.34,.32]);
 put('shaker',[0,2,4,6,8,10,12,14],[.62,.38,.63,.43,.6,.37,.65,.46]);
 put('surdo',[4,12],[.65,.7]);put('repinique',[6,14],[.46,.51]);put('tamborim',[3,6,11,14],[.48,.4,.47,.42]);
 // Agogo is available in the mixer, initially silent: it is not asserted to be in this recording.
 put('agogoLow',[0,6,10],[.6,.48,.53]);put('agogoHigh',[3,8,14],[.51,.6,.5]);
 if(natural&&b&&(v===1||v===3)){const h=events.find(e=>e.piece==='hat'&&e.step===12);h.articulation='semi';}
 if(natural&&v===2&&b)put('snare',[15],.23);
 return events.sort((a,b)=>a.step-b.step);
}
const CHIC_FILLS=[
 [['snare',0,.68],['snare',1,.43],['tom',2,.74],['low',3,.82]],
 [['snare',0,.75],['tom',1,.7],['tom',2,.52],['low',3,.86]],
 [['tom',0,.72],['snare',1,.51],['low',2,.84],['snare',3,.68]],
 [['snare',0,.55],['snare',.5,.4],['snare',1,.7],['tom',2,.76],['low',3,.85]],
 [['tom',0,.7],['tom',1,.47],['low',2,.8],['low',3,.61]],
 [['snare',0,.72],['tom',1,.68],['low',2,.82],['snare',3,.62]]
];
class ChicabanaSampler{
 constructor(context,bus,voices,settings){this.ctx=context;this.bus=bus;this.voices=voices;this.settings=settings;this.round={};this.openHats=[];this.partBuses={};this.ready=null;this.epoch=0;}
 async load(){if(this.buffer)return this;if(this.ready)return this.ready;this.ready=(async()=>{const response=await fetch('assets/chicabana/bank.json');if(!response.ok)throw Error('Banco indisponível');this.bank=await response.json();const audio=await fetch(this.bank.src);if(!audio.ok)throw Error('Samples indisponíveis');this.buffer=await this.ctx.decodeAudioData(await audio.arrayBuffer());return this})().catch(e=>{this.ready=null;throw e});return this.ready;}
 part(piece){if(!this.partBuses[piece]){const n=this.ctx.createGain();n.connect(this.bus);this.partBuses[piece]=n;}this.partBuses[piece].gain.value=this.settings.parts[piece]?.mute?0:(this.settings.parts[piece]?.volume??CHIC_PARTS[piece][1]);return this.partBuses[piece];}
 update(){for(const p of Object.keys(this.partBuses))this.part(p);}
 hit(piece,time,velocity,options={}){
  if(!this.buffer||!CHIC_PARTS[piece])return;const setting=this.settings.parts[piece];if(!options.audition&&(setting?.mute||(setting?.volume??CHIC_PARTS[piece][1])<=0))return;
  if(CHIC_PARTS[piece][3]&&options.percussion===false)return;
  let art=options.articulation||piece;
  if(piece==='snare')art=options.backbeat==='rim'?'rim':options.kit==='body'?'snareBody':'snare';
  if(piece==='kick'&&options.kit==='body')art='kickBody';
  if(piece==='hat'&&options.surface==='ride')art='ride';
  const candidates=this.bank.pieces[art];if(!candidates?.length)return;
  const layerCount=Math.max(...candidates.map(s=>s.layer))+1,layer=Math.min(layerCount-1,Math.floor(Math.max(0,Math.min(.999,velocity))*layerCount));
  const group=candidates.filter(s=>s.layer===layer),key=art+':'+layer,i=this.round[key]||0,sample=group[i%group.length];this.round[key]=i+1;
  const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();source.buffer=this.buffer;source.playbackRate.value=1;
  const perGain=CHIC_PARTS[piece][3]?(options.percussionVolume??1):1;
  gain.gain.value=.43*Math.max(.12,velocity)*perGain;
  source.connect(gain);let pan;if(this.ctx.createStereoPanner){pan=this.ctx.createStereoPanner();pan.pan.value=CHIC_PARTS[piece][2];gain.connect(pan).connect(options.audition?this.bus:this.part(piece));}else gain.connect(options.audition?this.bus:this.part(piece));
  const t=Math.max(this.ctx.currentTime+.002,time),end=t+sample.duration;
  if(piece==='hat'&&art!=='ride'){
   for(const h of this.openHats)if(h.start<t&&h.end>t){h.gain.gain.cancelScheduledValues(t);h.gain.gain.setValueAtTime(h.level,t);h.gain.gain.linearRampToValueAtTime(0,t+.018);try{h.source.stop(t+.02)}catch{}}
   this.openHats=this.openHats.filter(h=>h.end>t);
   if(art==='open'||art==='semi')this.openHats.push({source,gain,start:t,end,level:gain.gain.value});
  }
  gain.gain.setValueAtTime(gain.gain.value,t);gain.gain.setValueAtTime(gain.gain.value,Math.max(t,end-.012));gain.gain.linearRampToValueAtTime(0,end);
  if(this.voices.size>=64){const first=this.voices.values().next().value;try{first.stop()}catch{}this.voices.delete(first);}
  this.voices.add(source);source.onended=()=>{this.voices.delete(source);source.disconnect();gain.disconnect();pan?.disconnect();};source.start(t,sample.offset,sample.duration);
 }
 reset(){this.openHats=[];this.round={};}
}
const CHIC_FULL_FILLS=[
 [['snare',0,.7],['snare',2,.48],['snare',4,.78],['tom',6,.7],['tom',8,.75],['tom',10,.5],['low',12,.85],['low',14,.64]],
 [['snare',0,.7],['snare',1,.42],['snare',2,.57],['tom',4,.72],['tom',6,.5],['low',8,.8],['snare',10,.64],['tom',12,.78],['low',14,.86]],
 [['tom',0,.72],['snare',2,.52],['tom',4,.76],['low',6,.69],['snare',8,.8],['snare',9,.44],['snare',10,.62],['tom',12,.78],['low',14,.88]],
 [['snare',0,.64],['snare',2,.46],['tom',4,.7],['tom',5,.46],['tom',6,.59],['low',8,.8],['low',10,.6],['snare',12,.75],['tom',14,.72],['low',15,.85]],
 [['tom',0,.7],['tom',2,.49],['low',4,.78],['snare',6,.61],['tom',8,.73],['tom',10,.5],['low',12,.86],['low',14,.61]],
 [['snare',0,.7],['snare',2,.47],['tom',4,.72],['low',6,.76],['snare',8,.8],['snare',10,.5],['tom',12,.76],['low',14,.88]]
];
