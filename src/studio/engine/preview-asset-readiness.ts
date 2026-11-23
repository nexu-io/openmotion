/**
 * Embedded in the isolated preview bridge. Tracks readiness of all external
 * assets referenced by the active composition (fonts, images, audio,
 * concurrency-limited video, and Lottie animations) with bounded retry and
 * per-asset timeout so a single failure never blocks editor unlock.
 */
export const PREVIEW_ASSET_READINESS = `
  var ASSET_TIMEOUT_MS=10000, ASSET_RETRY_DELAYS=[500,1500], MAX_VIDEO_PRELOADS=3;
  var assetTracker=null;
  function assetBase(){ return (document.baseURI && document.baseURI!=='about:blank') ? document.baseURI : location.href; }
  function assetLabel(raw,fallback){
    if(!raw || /^(?:data|blob):/i.test(raw)) return fallback;
    try {
      var seg=new URL(raw,assetBase()).pathname.split('/').filter(Boolean).pop();
      if(!seg) return fallback;
      var dec=decodeURIComponent(seg);
      return dec.length>48?dec.slice(0,45)+'...':dec;
    } catch(_){ return fallback; }
  }
  function withAssetRetry(raw,attempt){
    if(!raw || /^(?:data|blob|javascript):/i.test(raw)) return null;
    try {
      var u=new URL(raw,assetBase());
      if(u.protocol!=='http:' && u.protocol!=='https:') return null;
      u.searchParams.set('_omRetry',String(attempt));
      return u.href;
    } catch(_){ return null; }
  }
  function assetSource(el){
    if(el.tagName==='IMG') return el.getAttribute('src')||el.currentSrc||'';
    var d=el.getAttribute('src');
    if(d) return d;
    var s=el.querySelector && el.querySelector('source[src]');
    return (s && s.getAttribute('src')) || el.currentSrc || '';
  }
  function applyAssetSource(el,url){
    if(el.tagName==='IMG'){ el.src=url; return; }
    if(el.getAttribute('src')!==null) el.src=url;
    else {
      var s=el.querySelector && el.querySelector('source[src]');
      if(s) s.setAttribute('src',url); else el.src=url;
    }
    try { el.load(); } catch(_){}
  }
  function checkRetryable(raw,signal,cb){
    if(!raw || typeof fetch!=='function'){ cb(false); return; }
    var u;
    try { u=new URL(raw,assetBase()); } catch(_){ cb(false); return; }
    if(u.protocol!=='http:' && u.protocol!=='https:'){ cb(false); return; }
    if(u.origin!==location.origin){ cb(true); return; }
    var opts={method:'HEAD',redirect:'manual'};
    if(signal) opts.signal=signal;
    fetch(u.href,opts).then(function(r){
      if(r.type==='opaqueredirect'||r.status===0){ cb(true); return; }
      var nonRetryable=r.status>=400 && r.status<500 && r.status!==408 && r.status!==429;
      cb(!nonRetryable);
    },function(){ cb(!(signal && signal.aborted)); });
  }
  function lottieReady(anim){
    if(!anim || typeof anim!=='object') return true;
    if(anim.isLoaded===true) return true;
    if(anim.isLoaded===false) return false;
    return true;
  }
  function createAssetTracker(onChange){
    var items=[], cleanups=[], videoQueue=[], activeVideos=0, manualRetry=ASSET_RETRY_DELAYS.length, lastSig='', disposed=false;
    function snapshot(){
      var completed=0, failed=[];
      for(var i=0;i<items.length;i++){
        var it=items[i];
        if(it.settled) completed++;
        if(it.failedReason) failed.push({id:it.id,label:it.label,kind:it.kind,reason:it.failedReason});
      }
      return {status:(items.length===0 || completed>=items.length)?'ready':'loading',completed:completed,total:items.length,failed:failed};
    }
    function emit(force){
      if(disposed) return;
      var s=snapshot();
      var sig=s.status+':'+s.completed+':'+s.total+':'+s.failed.map(function(f){return f.id+':'+f.reason;}).join(',');
      if(!force && sig===lastSig) return;
      lastSig=sig;
      if(onChange) onChange(s);
    }
    function settle(it,reason){ if(disposed) return; it.settled=true; it.failedReason=reason; emit(); }
    function later(ms,fn){ var t=setTimeout(fn,ms); var c=function(){clearTimeout(t);}; cleanups.push(c); return c; }
    function pumpVideos(){
      while(!disposed && activeVideos<MAX_VIDEO_PRELOADS && videoQueue.length){
        activeVideos++;
        videoQueue.shift()();
      }
    }
    if(document.fonts && document.fonts.size>0){
      var fItem={id:'fonts',label:'Fonts',kind:'font',settled:document.fonts.status==='loaded',failedReason:null};
      items.push(fItem);
      if(!fItem.settled){
        var cancelF=later(ASSET_TIMEOUT_MS,function(){ if(!fItem.settled) settle(fItem,'timeout'); });
        Promise.resolve(document.fonts.ready).then(
          function(){ cancelF(); if(!fItem.settled) settle(fItem,null); },
          function(){ cancelF(); if(!fItem.settled) settle(fItem,'error'); }
        );
      }
    }
    Array.from(document.querySelectorAll('img[src],img[srcset]')).filter(function(n){
      return !(n.closest && n.closest('[data-hyperframes-ignore]'));
    }).forEach(function(img,idx){
      var orig=assetSource(img);
      if(img.loading==='lazy') img.loading='eager';
      var ok=img.complete && img.naturalWidth>0;
      var it={id:'img-'+idx,label:assetLabel(orig,'image-'+(idx+1)),kind:'image',settled:ok,failedReason:null,retry:null};
      items.push(it);
      if(ok) return;
      function watch(retryIdx,auto,checkExisting,doneCb){
        var finished=false, probing=false, cancelT=null, cancelRetry=null, probeCtrl=null;
        function detachListeners(){ img.removeEventListener('load',onLoad); img.removeEventListener('error',onErr); }
        function detach(){
          detachListeners();
          if(cancelT){ cancelT(); cancelT=null; }
          if(cancelRetry){ cancelRetry(); cancelRetry=null; }
          if(probeCtrl){ try{ probeCtrl.abort(); }catch(_){} probeCtrl=null; }
        }
        function finish(good,reason){ if(finished||disposed) return; finished=true; detach(); doneCb(good,reason); }
        function onLoad(){ finish(true,null); }
        function onErr(){
          if(finished||probing||disposed) return;
          probing=true;
          detachListeners();
          if(!auto || retryIdx>=ASSET_RETRY_DELAYS.length || !orig){ finish(false,'error'); return; }
          probeCtrl=(typeof AbortController==='function') ? new AbortController() : null;
          checkRetryable(orig,probeCtrl?probeCtrl.signal:null,function(can){
            if(disposed||finished) return;
            probeCtrl=null;
            if(!can){ finish(false,'error'); return; }
            var next=withAssetRetry(orig,retryIdx+1);
            if(!next){ finish(false,'error'); return; }
            if(cancelT){ cancelT(); cancelT=null; }
            cancelRetry=later(ASSET_RETRY_DELAYS[retryIdx]||500,function(){
              if(disposed||finished) return;
              finished=true;
              cancelRetry=null;
              watch(retryIdx+1,true,false,doneCb);
              applyAssetSource(img,next);
            });
          });
        }
        img.addEventListener('load',onLoad); img.addEventListener('error',onErr); cleanups.push(detach);
        cancelT=later(ASSET_TIMEOUT_MS,function(){ if(!probing&&img.complete&&img.naturalWidth>0) finish(true,null); else finish(false,'timeout'); });
        if(checkExisting && img.complete){ if(img.naturalWidth>0) finish(true,null); else onErr(); }
      }
      it.retry=function(attempt,cb){
        if(disposed || img.isConnected===false){ cb(false); return; }
        var next=withAssetRetry(orig,attempt);
        if(!next){ cb(false); return; }
        watch(ASSET_RETRY_DELAYS.length,false,false,function(good,reason){ settle(it,good?null:reason); cb(good); });
        applyAssetSource(img,next);
      };
      watch(0,true,true,function(good,reason){ settle(it,good?null:reason); });
    });
    function watchMedia(el,it,orig,targetState,onDone){
      function start(retryIdx,auto,kick,doneCb){
        var finished=false, probing=false, cancelT=null, cancelRetry=null, probeCtrl=null;
        function detachListeners(){
          el.removeEventListener('loadeddata',onProg);
          el.removeEventListener('canplay',onProg);
          el.removeEventListener('canplaythrough',onProg);
          el.removeEventListener('error',onErr);
        }
        function detach(){
          detachListeners();
          if(cancelT){ cancelT(); cancelT=null; }
          if(cancelRetry){ cancelRetry(); cancelRetry=null; }
          if(probeCtrl){ try{ probeCtrl.abort(); }catch(_){} probeCtrl=null; }
        }
        function finish(good,reason){ if(finished||disposed) return; finished=true; detach(); doneCb(good,reason); }
        function onProg(){ if(el.readyState>=targetState || (it.kind==='video' && el.readyState>=2)) finish(true,null); }
        function onErr(){
          if(finished||probing||disposed) return;
          probing=true;
          detachListeners();
          if(!auto || retryIdx>=ASSET_RETRY_DELAYS.length || !orig){ finish(false,'error'); return; }
          probeCtrl=(typeof AbortController==='function') ? new AbortController() : null;
          checkRetryable(orig,probeCtrl?probeCtrl.signal:null,function(can){
            if(disposed||finished) return;
            probeCtrl=null;
            if(!can){ finish(false,'error'); return; }
            var next=withAssetRetry(orig,retryIdx+1);
            if(!next){ finish(false,'error'); return; }
            if(cancelT){ cancelT(); cancelT=null; }
            cancelRetry=later(ASSET_RETRY_DELAYS[retryIdx]||500,function(){
              if(disposed||finished) return;
              finished=true;
              cancelRetry=null;
              start(retryIdx+1,true,false,doneCb);
              applyAssetSource(el,next);
            });
          });
        }
        el.addEventListener('loadeddata',onProg); el.addEventListener('canplay',onProg);
        el.addEventListener('canplaythrough',onProg); el.addEventListener('error',onErr);
        cleanups.push(detach);
        cancelT=later(ASSET_TIMEOUT_MS,function(){ if(!probing&&el.readyState>=2) finish(true,null); else finish(false,'timeout'); });
        if(kick){
          if(el.error){ onErr(); return; }
          if(el.readyState>=targetState){ finish(true,null); return; }
        }
        if(el.preload!=='auto') el.preload='auto';
        if(kick && (el.networkState===0 || (el.readyState===0 && el.networkState===1))){ try{ el.load(); }catch(_){} }
      }
      it.retry=function(attempt,cb){
        if(disposed || el.isConnected===false){ cb(false); return; }
        var next=withAssetRetry(orig,attempt);
        if(!next){ cb(false); return; }
        start(ASSET_RETRY_DELAYS.length,false,false,function(good,reason){ settle(it,good?null:reason); cb(good); });
        applyAssetSource(el,next);
      };
      start(0,true,true,function(good,reason){ settle(it,good?null:reason); if(onDone) onDone(); });
    }
    Array.from(document.querySelectorAll('audio')).filter(function(el){
      return !el.hasAttribute('data-hf-clip-hidden') && !(el.closest && el.closest('[data-hyperframes-ignore]')) && Boolean(assetSource(el));
    }).forEach(function(el,idx){
      var orig=assetSource(el), ok=!el.error && el.readyState>=3;
      var it={id:'audio-'+idx,label:assetLabel(orig,'audio-'+(idx+1)),kind:'audio',settled:ok,failedReason:null,retry:null};
      items.push(it);
      if(!ok) watchMedia(el,it,orig,3);
    });
    Array.from(document.querySelectorAll('video')).filter(function(el){
      return !el.hasAttribute('data-hf-clip-hidden') && !(el.closest && el.closest('[data-hyperframes-ignore]')) && Boolean(assetSource(el));
    }).forEach(function(el,idx){
      var orig=assetSource(el), ok=!el.error && el.readyState>=2;
      var it={id:'video-'+idx,label:assetLabel(orig,'video-'+(idx+1)),kind:'video',settled:ok,failedReason:null,retry:null};
      items.push(it);
      if(!ok) videoQueue.push(function(){ watchMedia(el,it,orig,2,function(){ activeVideos=Math.max(0,activeVideos-1); pumpVideos(); }); });
    });
    var lotties=window.__hfLottie;
    if(Array.isArray(lotties)){
      lotties.forEach(function(anim,idx){
        var ok=lottieReady(anim);
        var it={id:'lottie-'+idx,label:'lottie-'+(idx+1),kind:'lottie',settled:ok,failedReason:null};
        items.push(it);
        if(ok) return;
        var done=false;
        var poll=setInterval(function(){
          if(done||disposed) return;
          if(lottieReady(anim)){ done=true; clearInterval(poll); cancelT(); settle(it,null); }
        },100);
        var stopPoll=function(){ clearInterval(poll); };
        cleanups.push(stopPoll);
        var cancelT=later(ASSET_TIMEOUT_MS,function(){ if(done||disposed) return; done=true; stopPoll(); settle(it,lottieReady(anim)?null:'timeout'); });
      });
    }
    emit(true);
    pumpVideos();
    return {
      snapshot: snapshot,
      retryFailed: function(cb){
        var targets=items.filter(function(it){ return it.failedReason!==null && it.retry; });
        if(!targets.length){ cb(snapshot()); return; }
        manualRetry++;
        var pending=targets.length, attempt=manualRetry;
        targets.forEach(function(it){
          it.retry(attempt,function(){
            pending--;
            if(pending<=0) cb(snapshot());
          });
        });
      },
      dispose: function(){ disposed=true; while(cleanups.length) cleanups.pop()(); videoQueue.length=0; }
    };
  }
  function ensureAssetTracker(onChange){
    if(!assetTracker) assetTracker=createAssetTracker(onChange);
    return assetTracker;
  }
`;
