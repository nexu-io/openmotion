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
  function waitForCaptureMedia(timeoutMs){
    var done=false;
    var tasks=[];
    if(document.fonts&&document.fonts.ready) tasks.push(document.fonts.ready.catch(function(){}));
    var imgs=document.querySelectorAll('img');
    for(var i=0;i<imgs.length;i++){
      var img=imgs[i];
      if(img.complete) continue;
      tasks.push(new Promise(function(resolve){
        var el=img;
        function finish(){ el.removeEventListener('load',finish); el.removeEventListener('error',finish); resolve(); }
        el.addEventListener('load',finish,{once:true});
        el.addEventListener('error',finish,{once:true});
      }));
    }
    return Promise.race([
      Promise.all(tasks),
      new Promise(function(resolve){ setTimeout(function(){ done=true; resolve(); },timeoutMs||4000); })
    ]).then(function(){ return done; });
  }
  function findPureCanvasTarget(root,stageW,stageH){
    if(!root||root.nodeType!==1) return null;
    if(root.tagName==='CANVAS') return root;
    var canvases=root.querySelectorAll('canvas');
    if(canvases.length!==1) return null;
    var text=(root.textContent||'').replace(/\\s+/g,'').trim();
    if(text.length>0) return null;
    if(root.querySelector('img,svg,video')) return null;
    var c=canvases[0];
    var rect=c.getBoundingClientRect();
    if(rect.width>=stageW*0.9&&rect.height>=stageH*0.9) return c;
    return null;
  }
  function canvasToJpegBuffer(source,outW,outH){
    var out=document.createElement('canvas');
    out.width=outW; out.height=outH;
    var ctx=out.getContext('2d');
    if(!ctx) return Promise.reject(new Error('2D context unavailable'));
    ctx.drawImage(source,0,0,outW,outH);
    return new Promise(function(resolve,reject){
      out.toBlob(function(blob){
        if(!blob){ reject(new Error('JPEG encode failed')); return; }
        blob.arrayBuffer().then(resolve,reject);
      },'image/jpeg',0.78);
    });
  }
  function capturePreviewFrames(message){
    var times=Array.isArray(message.times)?message.times:[];
    if(!times.length) return Promise.resolve({frames:[],mimeType:'image/jpeg',width:240,height:135,aspect:16/9});
    var p=player();
    if(!p||typeof p.seek!=='function') return Promise.reject(new Error('Preview player is not ready'));
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
    var maxW=Math.max(48,Math.min(480,Number(message.width)||240));
    var outW=maxW;
    var outH=Math.max(27,Math.round(outW*stageH/Math.max(1,stageW)));
    var scale=outW/Math.max(1,stageW);
    return waitForCaptureMedia(4000).then(function(){
      var frames=[];
      var chain=Promise.resolve();
      for(var i=0;i<times.length;i++){
        (function(t){
          chain=chain.then(function(){
            p.seek(Math.max(0,Number(t)||0));
            return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
          }).then(function(){
            var pureCanvas=findPureCanvasTarget(target,stageW,stageH);
            if(pureCanvas) return canvasToJpegBuffer(pureCanvas,outW,outH);
            return loadSnapdom().then(function(fn){
              return fn(target,{scale:scale,fast:true,embedFonts:false,exclude:'video'});
            }).then(function(res){ return res.toCanvas(); })
              .then(function(cv){ return canvasToJpegBuffer(cv,outW,outH); });
          }).then(function(buf){
            frames.push(buf);
            return new Promise(function(r){ setTimeout(r,0); });
          });
        })(times[i]);
      }
      return chain.then(function(){
        return {frames:frames,mimeType:'image/jpeg',width:outW,height:outH,aspect:stageW/Math.max(1,stageH)};
      });
    });
  }
`;
