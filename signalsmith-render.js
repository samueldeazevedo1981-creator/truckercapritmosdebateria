/* Offline rendering adapter for the pinned Signalsmith Stretch 1.3.2 WASM.
   Buffer layout and seek/process timing follow the upstream Web Audio processor. */
(function(root){
async function renderSignalsmith(channels,sampleRate,ratio,progress=()=>{}){
 if(!channels.length||!Number.isFinite(ratio)||ratio<.5||ratio>2)throw Error('Velocidade inválida');
 const inputLength=channels[0].length;if(!inputLength||channels.some(ch=>ch.length!==inputLength))throw Error('Canais incompatíveis');for(const ch of channels)for(const x of ch)if(!Number.isFinite(x))throw Error('Áudio inválido');
 const engine=await root.SignalsmithStretch.createEngine();engine._presetDefault(channels.length,sampleRate);engine._setTransposeSemitones(0,8000/sampleRate);
 const latencyIn=engine._inputLatency(),latencyOut=engine._outputLatency(),length=latencyIn+latencyOut,block=512;
 const pointer=engine._setBuffers(channels.length,length),outputLength=Math.round(inputLength/ratio),output=channels.map(()=>new Float32Array(outputLength));
 const warmup=Math.ceil((length/ratio+length)/block)*block;
 let lastProgress=-1;
 for(let pos=-warmup;pos<outputLength;pos+=block){
  const inputEnd=Math.round((pos+latencyOut)*ratio+latencyIn);
  let memory=engine.HEAP8.buffer;
  for(let ch=0;ch<channels.length;ch++){
   const target=new Float32Array(memory,pointer+ch*length*4,length),source=channels[ch];let at=((inputEnd-length)%inputLength+inputLength)%inputLength,done=0;
   while(done<length){const n=Math.min(length-done,inputLength-at);target.set(source.subarray(at,at+n),done);done+=n;at=0}
  }
  engine._seek(length,ratio);engine._process(0,block);memory=engine.HEAP8.buffer;
  if(pos>=0){const n=Math.min(block,outputLength-pos);for(let ch=0;ch<channels.length;ch++)output[ch].set(new Float32Array(memory,pointer+(ch+channels.length)*length*4,n),pos)}
  const percent=Math.floor(Math.max(0,pos)/outputLength*100);if(percent>lastProgress&&percent%5===0){lastProgress=percent;progress(percent)}
 }
 // Reference-relative tone correction followed by gated K-weighted loudness matching.
 // Interpolated peak protection uses one envelope for the stereo pair.
 const tone=matchTempoTone(channels,output,sampleRate);
 const level=matchTempoLevel(channels,output,sampleRate);
 progress(100);return {channels:output,gain:level.gain,level,tone};
}
function averagePower(channels){let energy=0,count=0;for(const ch of channels){count+=ch.length;for(let i=0;i<ch.length;i++)energy+=ch[i]*ch[i]}return count?energy/count:0;}
// Biquads run through a circular warm-up before measuring/processing loops.
function filterLoop(input,c,cyclic=true){
 const out=new Float32Array(input.length),warm=cyclic?Math.min(input.length,4096):0;let z1=0,z2=0;
 for(let i=-warm;i<input.length;i++){const x=input[i<0?i+input.length:i],y=c[0]*x+z1;z1=c[1]*x-c[3]*y+z2;z2=c[2]*x-c[4]*y;if(i>=0)out[i]=y;}return out;
}
function kFilters(sr){
 let K=Math.tan(Math.PI*1681.974450955533/sr),Q=.7071752369554196,Vh=10**(3.999843853973347/20),Vb=Vh**.4996667741545416,d=1+K/Q+K*K;
 const shelf=[(Vh+Vb*K/Q+K*K)/d,2*(K*K-Vh)/d,(Vh-Vb*K/Q+K*K)/d,2*(K*K-1)/d,(1-K/Q+K*K)/d];
 K=Math.tan(Math.PI*38.13547087602444/sr);Q=.5003270373238773;d=1+K/Q+K*K;
 return [shelf,[1,-2,1,2*(K*K-1)/d,(1-K/Q+K*K)/d]];
}
function integratedLoudness(channels,sr){
 const filters=kFilters(sr),length=channels[0].length,block=Math.min(length,Math.round(sr*.4)),hop=Math.max(1,Math.round(sr*.1));
 if(!length)return -Infinity;const energy=new Float64Array(length);
 for(const ch of channels){let a=ch;for(const f of filters)a=filterLoop(a,f,false);for(let i=0;i<length;i++)energy[i]+=a[i]*a[i];}
 const values=[];let sum=0;for(let i=0;i<block;i++)sum+=energy[i];values.push(sum/block);
 for(let start=hop;start+block<=length;start+=hop){for(let i=start-hop;i<start;i++)sum-=energy[i];for(let i=start+block-hop;i<start+block;i++)sum+=energy[i];values.push(Math.max(0,sum/block));}
 const db=p=>-.691+10*Math.log10(Math.max(1e-30,p)),absolute=values.filter(p=>db(p)>-70);if(!absolute.length)return -Infinity;
 const gate=db(absolute.reduce((s,p)=>s+p,0)/absolute.length)-10,relative=absolute.filter(p=>db(p)>gate);
 return db(relative.reduce((s,p)=>s+p,0)/relative.length);
}
function bandFilter(freq,sr,gain=null){
 const w=2*Math.PI*Math.min(freq,sr*.44)/sr,s=Math.sin(w),co=Math.cos(w),alpha=s/(2*.7);
 if(gain===null){const a=1+alpha;return [alpha/a,0,-alpha/a,-2*co/a,(1-alpha)/a];}
 const A=10**(gain/40),a=1+alpha/A;return [(1+alpha*A)/a,-2*co/a,(1-alpha*A)/a,-2*co/a,(1-alpha/A)/a];
}
const toneCenters=[80,250,1000,4000,10000];
function spectralProfile(channels,sr){
 const values=toneCenters.map(f=>averagePower(channels.map(ch=>filterLoop(ch,bandFilter(f,sr))))),sum=values.reduce((s,x)=>s+x,0);
 return values.map(x=>10*Math.log10(Math.max(1e-12,x/Math.max(sum,1e-20))));
}
function toneDistance(a,b){return Math.sqrt(a.reduce((s,x,i)=>s+(x-b[i])**2,0)/a.length);}
function matchTempoTone(reference,output,sr){
 const source=spectralProfile(reference,sr),before=spectralProfile(output,sr),error=toneDistance(source,before);
 const gains=source.map((x,i)=>Math.max(-1.5,Math.min(1.5,(x-before[i])*.65)));
 if(error<.15)return {beforeDb:error,afterDb:error,gains:gains.map(()=>0),applied:false};
 let candidate=output.map(ch=>ch.slice());for(let i=0;i<gains.length;i++)if(Math.abs(gains[i])>.04)candidate=candidate.map(ch=>filterLoop(ch,bandFilter(toneCenters[i],sr,gains[i])));
 const after=toneDistance(source,spectralProfile(candidate,sr));
 // Never accept a correction which worsens measured spectral balance.
 if(after>=error-.01)return {beforeDb:error,afterDb:error,gains:gains.map(()=>0),applied:false};
 candidate.forEach((ch,i)=>output[i].set(ch));return {beforeDb:error,afterDb:after,gains,applied:true};
}
function oversampledPeaks(channels,threshold=0){
 const length=channels[0].length,peaks=new Float32Array(length),kernels=[];
 for(const phase of [.25,.5,.75]){const weights=[];for(let k=-7;k<=8;k++){const t=phase-k,sinc=Math.abs(t)<1e-12?1:Math.sin(Math.PI*t)/(Math.PI*t),window=.42+.5*Math.cos(Math.PI*t/8)+.08*Math.cos(2*Math.PI*t/8);weights.push(sinc*window);}const sum=weights.reduce((s,x)=>s+x,0);kernels.push(weights.map(x=>x/sum));}
 const bound=Math.max(...kernels.map(w=>w.reduce((s,x)=>s+Math.abs(x),0)));
 for(const ch of channels){
  const queue=new Int32Array(length+16);let head=0,tail=0;
  for(let j=-7;j<length+8;j++){
   const index=(j+length)%length,value=Math.abs(ch[index]);
   while(tail>head&&Math.abs(ch[(queue[tail-1]+length)%length])<=value)tail--;
   queue[tail++]=j;while(tail>head&&queue[head]<j-15)head++;
   if(j<8)continue;const i=j-8;peaks[i]=Math.max(peaks[i],Math.abs(ch[i]));
   if(Math.abs(ch[(queue[head]+length)%length])*bound<threshold)continue;
   for(const w of kernels){let x=0;for(let k=0;k<16;k++)x+=w[k]*ch[(i+k-7+length)%length];peaks[i]=Math.max(peaks[i],Math.abs(x));}
  }
 }
 return peaks;
}
function matchTempoLevel(reference,output,sampleRate){
 if(!Number.isFinite(averagePower(output)))throw Error('Falha no processamento');
 const target=integratedLoudness(reference,sampleRate),raw=integratedLoudness(output,sampleRate),length=output[0].length;
 if(!Number.isFinite(target)||!Number.isFinite(raw))return {gain:1,deltaDb:0,deltaLu:0,limited:false,minimumGain:1};
 let gain=Math.min(2,10**((target-raw)/20)),minimum=1,delta=0;
 const ceiling=10**(-1.5/20),peaks=oversampledPeaks(output,ceiling/Math.max(gain,1)),envelope=new Float32Array(length),candidate=output.map(ch=>new Float32Array(length));
 const attack=Math.exp(-1/(sampleRate*.001)),release=Math.exp(-1/(sampleRate*.05));
 for(let iteration=0;iteration<4;iteration++){
  let env=1;for(let pass=0;pass<2;pass++)for(let i=length-1;i>=0;i--){const safe=Math.min(1,ceiling/(peaks[i]*gain||1));env=Math.min(safe,1-(1-env)*attack);envelope[i]=env;}
  env=1;minimum=1;for(let pass=0;pass<2;pass++)for(let i=0;i<length;i++){env=Math.min(envelope[i],1-(1-env)*release);if(pass===1){envelope[i]=env;minimum=Math.min(minimum,env);}}
  output.forEach((ch,c)=>{for(let i=0;i<length;i++)candidate[c][i]=ch[i]*gain*envelope[i];});
  delta=integratedLoudness(candidate,sampleRate)-target;if(Math.abs(delta)<.08||iteration===3)break;const next=Math.min(2,gain*10**(-delta/20));if(Math.abs(next-gain)<1e-6)break;gain=next;
 }
 candidate.forEach((ch,c)=>output[c].set(ch));
 // Recheck interpolated peaks after the linked gain envelope has been applied.
 const finalPeaks=oversampledPeaks(output,ceiling);let peak=0;for(const p of finalPeaks)peak=Math.max(peak,p);
 if(peak>ceiling){const safe=ceiling/peak;output.forEach(ch=>{for(let i=0;i<length;i++)ch[i]*=safe;});gain*=safe;delta+=20*Math.log10(safe);peak=ceiling;}
 return {gain,deltaDb:delta,deltaLu:delta,referenceLufs:target,rawLufs:raw,limited:minimum<.999,minimumGain:minimum,estimatedTruePeakDbtp:20*Math.log10(Math.max(peak,1e-20))};
}
root.integratedLoudness=integratedLoudness;
root.matchTempoTone=matchTempoTone;
root.oversampledPeaks=oversampledPeaks;
root.matchTempoLevel=matchTempoLevel;
root.renderSignalsmith=renderSignalsmith;
})(typeof globalThis!=='undefined'?globalThis:self);
