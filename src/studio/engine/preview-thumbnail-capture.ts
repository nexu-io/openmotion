/**
 * Embedded ES5 frame-capture helper for isolated preview iframes (`PREVIEW_PUBLIC_ORIGIN`).
 * Lazily loads `/api/vendor/snapdom.js` only when Studio requests client-side thumbnail frames,
 * keeping normal interactive preview loads completely untouched.
 */
export const PREVIEW_THUMBNAIL_CAPTURE = `
  var snapdomPromise=null;
  function loadSnapdom(){
    if(typeof window.snapdom==='function') return Promise.resolve(window.snapdom);
    if(snapdomPromise) return snapdomPromise;
    snapdomPromise=new Promise(function(resolve,reject){
      var s=document.createElement('script');
      s.src='/api/vendor/snapdom.js';
      s.async=true;
      s.onload=function(){
        if(typeof window.snapdom==='function') resolve(window.snapdom);
        else { snapdomPromise=null; reject(new Error('snapdom global missing')); }
      };
      s.onerror=function(){ snapdomPromise=null; reject(new Error('Failed to load snapdom')); };
      (document.head||document.documentElement).appendChild(s);
    });
    return snapdomPromise;
  }
  function waitFrames(count){
    var remaining=count>1?count:1;
    return new Promise(function(resolve){
      var settled=false;
      var timer=setTimeout(function(){
        if(settled) return;
        settled=true;
        resolve();
      },250);
      function step(){
        if(settled) return;
        if(--remaining<=0){
          settled=true;
          clearTimeout(timer);
          resolve();
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }
  function withPreviewRedirectSafeFetch(run,fetchCache){
    var origFetch=window.fetch;
    if(typeof origFetch!=='function') return run();
    window.fetch=function(input,init){
      var method=(init&&init.method?String(init.method):'GET').toUpperCase();
      var cacheKey=null;
      try {
        var rawUrl=typeof input==='string'?input:(input&&typeof input.url==='string'?input.url:'');
        if(rawUrl){
          var parsed=new URL(rawUrl,location.href);
          if(parsed.origin===location.origin&&/^\\/api\\/projects\\/[^/]+\\/preview\\//.test(parsed.pathname)){
            if(init&&init.credentials==='include'){
              init=Object.assign({},init,{credentials:'same-origin'});
            }
            if(fetchCache&&method==='GET') cacheKey=parsed.href;
          }
        }
      } catch(_){}
      if(cacheKey&&fetchCache[cacheKey]){
        return fetchCache[cacheKey].then(function(entry){
          return new Response(entry.buffer.slice(0),{status:entry.status,statusText:entry.statusText,headers:entry.headers});
        });
      }
      var resPromise=origFetch.call(this,input,init);
      if(cacheKey&&typeof Response==='function'){
        var cached=resPromise.then(function(resp){
          if(!resp||!resp.ok||typeof resp.clone!=='function'||typeof resp.arrayBuffer!=='function'){
            delete fetchCache[cacheKey];
            return null;
          }
          var headers=[];
          if(resp.headers&&typeof resp.headers.forEach==='function'){
            resp.headers.forEach(function(v,k){ headers.push([k,v]); });
          }
          return resp.clone().arrayBuffer().then(function(buf){
            return {status:resp.status,statusText:resp.statusText,headers:headers,buffer:buf};
          });
        },function(err){
          delete fetchCache[cacheKey];
          throw err;
        });
        fetchCache[cacheKey]=cached;
        return resPromise.then(function(resp){
          if(!resp||!resp.ok||typeof resp.clone!=='function') delete fetchCache[cacheKey];
          return resp;
        });
      }
      return resPromise;
    };
    function restore(){ if(window.fetch!==origFetch) window.fetch=origFetch; }
    var pending;
    try { pending=Promise.resolve(run()); }
    catch(err){ restore(); return Promise.reject(err); }
    return pending.then(
      function(val){ restore(); return val; },
      function(err){ restore(); throw err; }
    );
  }
  function inlineDecodedCaptureImages(root,maxDim){
    if(!root||typeof root.querySelectorAll!=='function') return;
    var imgs=root.querySelectorAll('img');
    if(!imgs||!imgs.length) return;
    var limit=Math.max(160,Math.min(480,Number(maxDim)||320));
    var cache={};
    var scratch=null;
    for(var i=0;i<imgs.length;i++){
      var img=imgs[i];
      if(!img||!img.complete||!(img.naturalWidth>0)||!(img.naturalHeight>0)) continue;
      var rawSrc=img.getAttribute&&img.getAttribute('src')||'';
      if(rawSrc.indexOf('data:')===0) continue;
      var key=img.currentSrc||img.src||rawSrc;
      if(!key) continue;
      var dataUrl=cache[key];
      if(dataUrl===undefined){
        try {
          var natW=img.naturalWidth, natH=img.naturalHeight;
          var scale=Math.min(1,limit/Math.max(natW,natH));
          var cw=Math.max(1,Math.round(natW*scale));
          var ch=Math.max(1,Math.round(natH*scale));
          if(!scratch) scratch=document.createElement('canvas');
          scratch.width=cw; scratch.height=ch;
          var ctx=scratch.getContext('2d');
          if(!ctx){ cache[key]=null; continue; }
          if(typeof ctx.clearRect==='function') ctx.clearRect(0,0,cw,ch);
          ctx.drawImage(img,0,0,cw,ch);
          dataUrl=scratch.toDataURL('image/png');
          cache[key]=dataUrl;
        } catch(_){
          // A tainted cross-origin image permanently taints this canvas; discard it so later images still inline.
          scratch=null;
          cache[key]=null;
          continue;
        }
      }
      if(!dataUrl) continue;
      if(!img.hasAttribute('width')&&!img.hasAttribute('height')){
        img.setAttribute('width',String(img.naturalWidth));
        img.setAttribute('height',String(img.naturalHeight));
      }
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.setAttribute('src',dataUrl);
    }
    if(scratch) releaseCanvasBacking(scratch);
  }
  function waitForCaptureMedia(timeoutMs){
    var done=false;
    var tasks=[];
    if(document.fonts&&document.fonts.ready) tasks.push(document.fonts.ready.catch(function(){}));
    var imgs=document.querySelectorAll('img');
    for(var i=0;i<imgs.length;i++){
      var img=imgs[i];
      if(img.complete) continue;
      if(!img.getAttribute('src')&&!img.getAttribute('srcset')) continue;
      if(img.loading==='lazy') img.loading='eager';
      tasks.push(new Promise(function(resolve){
        var el=img;
        function finish(){ el.removeEventListener('load',finish); el.removeEventListener('error',finish); resolve(); }
        el.addEventListener('load',finish,{once:true});
        el.addEventListener('error',finish,{once:true});
      }));
    }
    if(!tasks.length) return Promise.resolve(false);
    return Promise.race([
      Promise.all(tasks),
      new Promise(function(resolve){ setTimeout(function(){ done=true; resolve(); },timeoutMs||2000); })
    ]).then(function(){ return done; });
  }
  function hasVisibleText(node){
    if(!node) return false;
    var tag=node.tagName?String(node.tagName).toUpperCase():'';
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='TEMPLATE'||tag==='CANVAS') return false;
    if(!node.childNodes||!node.childNodes.length){
      if(node.nodeType===3) return !!((node.nodeValue||'').replace(/\\s+/g,'').trim());
      return !!((node.textContent||'').replace(/\\s+/g,'').trim());
    }
    for(var i=0;i<node.childNodes.length;i++){
      var child=node.childNodes[i];
      if(!child) continue;
      if(child.nodeType===3){
        if((child.nodeValue||'').replace(/\\s+/g,'').trim()) return true;
        continue;
      }
      if(child.nodeType===1&&hasVisibleText(child)) return true;
    }
    return false;
  }
  function findPureCanvasTarget(root,stageW,stageH){
    if(!root||root.nodeType!==1) return null;
    if(root.tagName==='CANVAS') return root;
    var canvases=root.querySelectorAll('canvas');
    if(canvases.length!==1) return null;
    if(hasVisibleText(root)) return null;
    if(root.querySelector('img,svg,video')) return null;
    var c=canvases[0];
    var rect=c.getBoundingClientRect();
    if(rect.width>=stageW*0.9&&rect.height>=stageH*0.9) return c;
    return null;
  }
  function isOrContainsDynamicVisual(el){
    if(!el) return false;
    var tag=el.tagName?String(el.tagName).toUpperCase():'';
    if(tag==='CANVAS'||tag==='VIDEO') return true;
    return Boolean(typeof el.querySelector==='function'&&el.querySelector('canvas,video'));
  }
  function canSkipUnchangedFrame(target){
    if(typeof MutationObserver!=='function') return false;
    if(!document||typeof document.getAnimations!=='function') return false;
    if(isOrContainsDynamicVisual(target)) return false;
    try {
      var anims=document.getAnimations();
      if(anims&&anims.length>0) return false;
    } catch(_){ return false; }
    return true;
  }
  function releaseCanvasBacking(canvas){
    if(!canvas) return;
    try { canvas.width=0; canvas.height=0; } catch(_){}
  }
  function canvasToJpegBuffer(source,outW,outH,reusable){
    var out=reusable||document.createElement('canvas');
    if(out.width!==outW) out.width=outW;
    if(out.height!==outH) out.height=outH;
    var ctx=out.getContext('2d');
    if(!ctx){ if(!reusable) releaseCanvasBacking(out); return Promise.reject(new Error('2D context unavailable')); }
    if(typeof ctx.clearRect==='function') ctx.clearRect(0,0,outW,outH);
    ctx.drawImage(source,0,0,outW,outH);
    return new Promise(function(resolve,reject){
      out.toBlob(function(blob){
        if(!reusable) releaseCanvasBacking(out);
        if(!blob){ reject(new Error('JPEG encode failed')); return; }
        blob.arrayBuffer().then(resolve,reject);
      },'image/jpeg',0.78);
    });
  }
  function capturePreviewFrames(message,onFrame){
    var times=Array.isArray(message.times)?message.times:[];
    if(!times.length) return Promise.resolve({frames:[],mimeType:'image/jpeg',width:160,height:90,aspect:16/9});
    var p=player();
    if(!p||typeof p.seek!=='function') return Promise.reject(new Error('Preview player is not ready'));
    if(typeof p.pause==='function') p.pause();
    var root=document.querySelector('[data-composition-id]')||document.body;
    var target=root;
    if(message.selector){
      try {
        var list=document.querySelectorAll(String(message.selector));
        var idx=Number(message.selectorIndex)||0;
        if(list[idx]) target=list[idx];
      } catch(_){}
    }
    var stageW=Number(root&&root.getAttribute&&root.getAttribute('data-width'))||(root&&root.clientWidth)||window.innerWidth||1280;
    var stageH=Number(root&&root.getAttribute&&root.getAttribute('data-height'))||(root&&root.clientHeight)||window.innerHeight||720;
    if(target!==root){
      var trect=target.getBoundingClientRect();
      if(trect.width>0&&trect.height>0){ stageW=trect.width; stageH=trect.height; }
    }
    var maxW=Math.max(48,Math.min(480,Number(message.width)||160));
    var maxH=Math.max(27,Math.min(480,Math.round(maxW*2)));
    var outW=maxW;
    var outH=Math.max(27,Math.min(maxH,Math.round(outW*stageH/Math.max(1,stageW))));
    if(outH===maxH&&stageH>0){
      outW=Math.max(48,Math.min(maxW,Math.round(outH*stageW/Math.max(1,stageH))));
    }
    var scale=Math.min(2,outW/Math.max(1,stageW));
    var aspect=stageW/Math.max(1,stageH);
    var progressive=typeof onFrame==='function';
    var order=[];
    if(progressive&&times.length>=3){
      var coverIdx=Math.floor(times.length/2);
      order.push(coverIdx);
      for(var k=0;k<times.length;k++){ if(k!==coverIdx) order.push(k); }
    } else {
      for(var m=0;m<times.length;m++) order.push(m);
    }
    // Kick off SnapDOM load concurrently with media/font readiness when DOM capture is needed.
    var snapdomReady=findPureCanvasTarget(target,stageW,stageH)?Promise.resolve(null):loadSnapdom();
    return waitForCaptureMedia(2000).then(function(){
      inlineDecodedCaptureImages(target,Math.min(320,Math.max(240,outW*2)));
      var hasAsyncVisual=isOrContainsDynamicVisual(target);
      var settleFrames=hasAsyncVisual?2:1;
      var outCanvas=document.createElement('canvas');
      var observer=null;
      var observedMutated=false;
      // Observe documentElement when available so ancestor class/style/CSS-var edits
      // invalidate selector captures too; if ancestors cannot be tracked, skip reuse.
      var observeRoot=(document&&document.documentElement)||(target===root?root:null);
      if(times.length>1&&observeRoot&&canSkipUnchangedFrame(target)){
        try {
          observer=new MutationObserver(function(){ observedMutated=true; });
          observer.observe(observeRoot,{subtree:true,attributes:true,childList:true,characterData:true});
        } catch(_){
          observer=null;
        }
      }
      var lastBuffer=null;
      var fetchCache={};
      var frames=[];
      var chain=Promise.resolve();
      for(var i=0;i<order.length;i++){
        (function(frameIdx,t){
          chain=chain.then(function(){
            if(observer){
              observer.takeRecords();
              observedMutated=false;
            }
            p.seek(Math.max(0,Number(t)||0));
            return waitFrames(settleFrames);
          }).then(function(){
            if(observer&&lastBuffer){
              var recs=observer.takeRecords();
              if(!observedMutated&&(!recs||recs.length===0)&&canSkipUnchangedFrame(target)){
                return lastBuffer.slice(0);
              }
            }
            var pureCanvas=findPureCanvasTarget(target,stageW,stageH);
            if(pureCanvas) return canvasToJpegBuffer(pureCanvas,outW,outH,outCanvas);
            return snapdomReady.then(function(fn){
              return fn||loadSnapdom();
            }).then(function(fn){
              return withPreviewRedirectSafeFetch(function(){
                return fn(target,{scale:scale,dpr:1,fast:true,embedFonts:false,exclude:'video'})
                  .then(function(res){ return res.toCanvas(); });
              },fetchCache);
            }).then(function(cv){
              return canvasToJpegBuffer(cv,outW,outH,outCanvas).then(
                function(buf){ releaseCanvasBacking(cv); return buf; },
                function(err){ releaseCanvasBacking(cv); throw err; }
              );
            });
          }).then(function(buf){
            if(observer&&buf&&typeof buf.slice==='function') lastBuffer=buf.slice(0);
            if(progressive){
              onFrame({index:frameIdx,total:times.length,frame:buf,mimeType:'image/jpeg',width:outW,height:outH,aspect:aspect},buf);
            } else {
              frames.push(buf);
            }
            return new Promise(function(r){ setTimeout(r,0); });
          });
        })(order[i],times[order[i]]);
      }
      function cleanupCapture(){
        if(observer){
          try { observer.disconnect(); } catch(_){}
          observer=null;
        }
        releaseCanvasBacking(outCanvas);
        fetchCache=null;
      }
      return chain.then(function(){
        cleanupCapture();
        if(progressive){
          return {frames:[],streamed:true,frameCount:times.length,mimeType:'image/jpeg',width:outW,height:outH,aspect:aspect};
        }
        return {frames:frames,mimeType:'image/jpeg',width:outW,height:outH,aspect:aspect};
      },function(err){
        cleanupCapture();
        throw err;
      });
    });
  }
`;
