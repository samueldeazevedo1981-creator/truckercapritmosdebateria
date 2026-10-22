'use strict';
importScripts('vendor/signalsmith-stretch-1.3.2.js','signalsmith-render.js?v=quality22');
self.onmessage=async e=>{const {id,channels,sampleRate,ratio}=e.data;try{const output=await renderSignalsmith(channels,sampleRate,ratio,progress=>self.postMessage({id,progress}));self.postMessage({id,...output},output.channels.map(ch=>ch.buffer))}catch(error){self.postMessage({id,error:error.message})}};
