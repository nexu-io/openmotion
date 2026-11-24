import { createHash } from 'node:crypto';
import { PREVIEW_FIRST_FRAME } from './preview-first-frame.ts';
import { PREVIEW_ASSET_READINESS } from './preview-asset-readiness.ts';
import { PREVIEW_INSPECTOR } from './preview-inspector.ts';
import { PREVIEW_INSPECTOR_STYLES } from './preview-inspector-styles.ts';
import { PREVIEW_TIMELINE_MANIFEST } from './preview-timeline-manifest.ts';
import { PREVIEW_LAYERS } from './preview-layers.ts';
import { PREVIEW_INLINE_TEXT } from './preview-inline-text.ts';
import { PREVIEW_CANVAS_DRAG } from './preview-canvas-drag.ts';
import { PREVIEW_TIMELINE_CONTROLS } from './preview-timeline-controls.ts';
import { PREVIEW_PARKED_SCENE } from './preview-parked-scene.ts';
import { PREVIEW_PEER_TIMING } from './preview-peer-timing.ts';
import type { PreviewLiveEdits } from '../../../shared/preview-timing.ts';
import { PREVIEW_THUMBNAIL_CAPTURE } from './preview-thumbnail-capture.ts';
import { PREVIEW_BROWSER_EXPORT } from './preview-browser-export.ts';

function scopedScript(configuration: string, body: string): string {
  return `(function(){
  var SOURCE='openmotion-preview-bridge', PARENT='openmotion-studio', VERSION=1;
  ${configuration}
  var token=new globalThis.URL(location.href).searchParams.get('pt');
  if(!token || window.parent===window) return;
  var parentWindow=window.parent;
  var parentOrigin='*';
  try { if(document.referrer) parentOrigin=new globalThis.URL(document.referrer).origin; } catch (_) {}
  function post(type,payload,requestId,transfer,explicitOrigin){
    var message=Object.assign({source:SOURCE,version:VERSION,type:type,projectId:projectId,token:token},payload||{});
    if(requestId) message.requestId=requestId;
    var targetOrigin=explicitOrigin||(parentOrigin==='null'?'*':parentOrigin);
    if(transfer&&transfer.length) parentWindow.postMessage(message,targetOrigin,transfer);
    else parentWindow.postMessage(message,targetOrigin);
  }
  ${body}
})();`;
}

export function previewBuildBusyScript(projectId: string, retryAfterSeconds: number): string {
  return scopedScript(`var projectId=${JSON.stringify(projectId).replace(/</g, '\\u003c')};`,
    `post('preview-build-busy',{retryAfterMs:${retryAfterSeconds * 1000}});`);
}

/**
 * Install the cookie-less preview bridge used when a preview is served from
 * PREVIEW_PUBLIC_ORIGIN. The bridge is inert without a project token, so local
 * same-origin previews keep their existing DOM/runtime fast path.
 */
export const PREVIEW_SOURCE_IDENTITY = `
  function sourceIdentity(raw) {
    if (!raw) return {};
    return raw.startsWith('"patch:') ? {fileVersion:raw} : {sha256:raw, fileVersion:'"sha256:'+raw+'"'};
  }
`;

export const PREVIEW_BRIDGE_SCRIPT = scopedScript(`
  var settings=JSON.parse(document.currentScript.getAttribute('data-openmotion-preview'));
  var projectId=settings.projectId, compositionPath=settings.compositionPath, sourceVersions=settings.sourceVersions;`, `
  ${PREVIEW_SOURCE_IDENTITY}
  var pickMode=false, picked=null;
  var isCaptureMode=new globalThis.URL(location.href).searchParams.get('capture')==='1';
  var durationBootAnnounced=false;
  var bootPoll=null;
  function player(){ return window.__player || null; }
  ${PREVIEW_FIRST_FRAME}
  ${PREVIEW_ASSET_READINESS}
  function assetState(duration){
    if(isCaptureMode) return {status:'ready',completed:0,total:0,failed:[]};
    if(!(duration>0)) return {status:'loading',completed:0,total:0,failed:[]};
    return ensureAssetTracker(function(snapshot){ post('asset-readiness',snapshot); }).snapshot();
  }
  function timeline(includeManifest){
    var p=player();
    var currentTime=p&&typeof p.getTime==='function'?Number(p.getTime())||0:0;
    var duration=p&&typeof p.getDuration==='function'?Number(p.getDuration())||0:0;
    return {currentTime:currentTime,duration:duration,firstFrame:isCaptureMode?'ready':(duration>0?visualFrameStatus(currentTime):'loading'),
      assets:assetState(duration),
      isPlaying:p&&typeof p.isPlaying==='function'?p.isPlaying()===true:false,
      width:window.__clipManifest&&window.__clipManifest.compositionWidth, height:window.__clipManifest&&window.__clipManifest.compositionHeight,
      fps:window.__clipManifest&&window.__clipManifest.fps,
      durationInFrames:window.__clipManifest&&Number(window.__clipManifest.durationInFrames)||0,
      timelinePath:includeManifest?compositionPath:undefined,
      timelineVersion:includeManifest?sourceIdentity(sourceVersions?.[compositionPath]).fileVersion:undefined,
      clips:includeManifest&&window.__clipManifest&&Array.isArray(window.__clipManifest.clips)?authoredTimelineClips(window.__clipManifest.clips):undefined};
  }
  function sourceFileForElement(element){
    var owner=element.parentElement&&element.parentElement.closest('[data-composition-file],[data-composition-src]');
    return (owner&&(owner.getAttribute('data-composition-file')||owner.getAttribute('data-composition-src'))) || compositionPath;
  }
  function describe(element){
    if(!element || element.nodeType!==1) return null;
    var rect=element.getBoundingClientRect();
    var text=(element.innerText||element.textContent||'').replace(/\\s+/g,' ').trim().slice(0,240);
    var hfId=element.getAttribute('data-hf-id');
    return {elementId:element.id||null,hfId:hfId,sourceFile:sourceFileForElement(element),
      selector:element.id?'#'+CSS.escape(element.id):hfId?'[data-hf-id="'+CSS.escape(hfId)+'"]':null,
      tagName:element.tagName.toLowerCase(),text:text||null,textContent:element.textContent,
      geometry:{x:rect.left,y:rect.top,width:rect.width,height:rect.height},
      viewport:{width:innerWidth,height:innerHeight}};
  }
  ${PREVIEW_TIMELINE_MANIFEST}
  ${PREVIEW_CANVAS_DRAG}
  ${PREVIEW_INLINE_TEXT}
  ${PREVIEW_TIMELINE_CONTROLS}
  ${PREVIEW_PEER_TIMING}
  ${PREVIEW_PARKED_SCENE}
  ${PREVIEW_INSPECTOR}
  ${PREVIEW_INSPECTOR_STYLES}
  ${PREVIEW_LAYERS}
  ${PREVIEW_THUMBNAIL_CAPTURE}
  function waitPaintFrames(count){
    return new Promise(function(resolve){
      var done=false, remaining=count||2;
      var timer=null;
      var finish=function(){
        if(done) return;
        done=true;
        if(timer!==null && typeof clearTimeout==='function') clearTimeout(timer);
        resolve();
      };
      if(typeof setTimeout==='function') timer=setTimeout(finish,250);
      function step(){
        if(done) return;
        if(--remaining<=0) finish();
        else if(typeof requestAnimationFrame==='function') requestAnimationFrame(step);
        else finish();
      }
      if(typeof requestAnimationFrame==='function') requestAnimationFrame(step);
      else finish();
    });
  }
  function waitVisibleImagesAt(time){
    if(typeof document==='undefined' || typeof document.querySelectorAll!=='function') return Promise.resolve();
    var pending=[];
    Array.from(document.querySelectorAll('img[src],img[srcset]')).forEach(function(node){
      if(node.complete) return;
      if(node.checkVisibility && !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return;
      var rect=node.getBoundingClientRect&&node.getBoundingClientRect();
      if(rect && (!rect.width || !rect.height || rect.right<=0 || rect.bottom<=0 || rect.top>=innerHeight || rect.left>=innerWidth)) return;
      var start=0, end=Infinity, chain=[], owner=node;
      while(owner){ if(owner.hasAttribute&&owner.hasAttribute('data-start')) chain.push(owner); owner=owner.parentElement; }
      for(var i=chain.length-1;i>=0;i--){
        start+=Number(chain[i].getAttribute('data-start'))||0;
        var dur=Number(chain[i].getAttribute('data-duration'));
        if(dur>0) end=Math.min(end,start+dur);
      }
      if(time<start || time>=end) return;
      if(node.loading==='lazy') node.loading='eager';
      if(typeof node.decode==='function') pending.push(node.decode().catch(function(){}));
    });
    if(!pending.length) return Promise.resolve();
    var all=Promise.all(pending);
    if(typeof setTimeout!=='function') return all;
    return Promise.race([all,new Promise(function(resolve){ setTimeout(resolve,500); })]);
  }
  function waitSeekPainted(time){
    var seekDone=typeof window.__hfWaitForSeekCompletion==='function'
      ? (function(){
          var pending=Promise.resolve().then(function(){ return window.__hfWaitForSeekCompletion(); }).catch(function(){});
          return typeof setTimeout==='function'
            ? Promise.race([pending,new Promise(function(resolve){ setTimeout(resolve,3000); })])
            : pending;
        })()
      : Promise.resolve();
    return seekDone.then(function(){ return waitVisibleImagesAt(time); }).then(function(){ return waitPaintFrames(2); });
  }
  ${PREVIEW_BROWSER_EXPORT}
  function respond(requestId,result,error,transfer,explicitOrigin){
    var message=Object.assign({source:SOURCE,version:VERSION,type:'response',projectId:projectId,token:token},error?{ok:false,error:String(error)}:{ok:true,result:result});
    if(requestId) message.requestId=requestId;
    var targetOrigin=explicitOrigin||(parentOrigin==='null'?'*':parentOrigin);
    if(transfer&&transfer.length) parentWindow.postMessage(message,targetOrigin,transfer);
    else parentWindow.postMessage(message,targetOrigin);
  }
  function ready(){
    var mountedVersions=settings.smallMountedSources&&Object.fromEntries(settings.smallMountedSources.map(function(path){return [path,sourceIdentity(sourceVersions[path]).fileVersion];}));
    post('preview-ready',{timingDocumentId:timingDocumentId,styleDocumentId:styleDocumentId,liveEdits:settings.liveEdits,mountedVersions:mountedVersions,htmlSources:settings.htmlSources,capabilities:['selection','selection-geometry','edit-element','timeline','playback-control','pick-mode','refresh-parked-scene','layer-tree','layer-select','layer-family','inspect-element','canvas-framing','canvas-drag','inline-text','asset-readiness','thumbnail-capture','browser-export']});
    var state=timeline(true);
    if(state.duration>0){
      durationBootAnnounced=true;
      if(bootPoll){ clearInterval(bootPoll); bootPoll=null; }
    }
    post('timeline-state',state);
  }
  function announceDurationIfReady(){
    if(durationBootAnnounced) return true;
    if(document.readyState==='loading') return false;
    var p=player();
    var d=p&&typeof p.getDuration==='function'?Number(p.getDuration())||0:0;
    if(!(d>0)) return false;
    durationBootAnnounced=true;
    if(bootPoll){ clearInterval(bootPoll); bootPoll=null; }
    post('timeline-state',timeline(true));
    return true;
  }
  window.addEventListener('message',function(event){
    if(event.source!==parentWindow) return;
    var message=event.data;
    if(!message || message.source!==PARENT || message.version!==VERSION || message.projectId!==projectId || message.token!==token) return;
    var requestId=message.requestId;
    try {
      if(message.type==='peer-timing' || message.type==='peer-presentation'){
        if (!settings.studioOrigin || settings.studioOrigin !== event.origin) return;
        respond(requestId,applyPeerTiming(message)); return;
      }
      if(message.type==='refresh-parked-scene'){
        if (!settings.studioOrigin || settings.studioOrigin !== event.origin) return;
        refreshParkedScene(message).then(value => respond(requestId,value), () => respond(requestId,false));
        return;
      }
      if(message.type==='timeline-controls'){
        if(settings.studioOrigin && settings.studioOrigin === event.origin) previewTimelineControls(message);
        return;
      }
      if(message.type==='handshake'){
        if(message.timelineOnly) post('timeline-state',timeline(true));
        else { ready(); respond(requestId,{ready:true}); }
        return;
      }
      if(message.type==='retry-failed-assets'){
        var tracker=ensureAssetTracker(function(snapshot){ post('asset-readiness',snapshot); });
        tracker.retryFailed(function(snapshot){ post('asset-readiness',snapshot); respond(requestId,snapshot); });
        return;
      }
      if(message.type==='capture-frames'){
        var onFrame=message.progressive===true?function(frameEvent,buf){
          post('capture-frame',frameEvent,requestId,buf?[buf]:undefined);
        }:null;
        capturePreviewFrames(message,onFrame).then(function(result){
          respond(requestId,result,null,result&&Array.isArray(result.frames)&&result.frames.length?result.frames:undefined);
        },function(error){
          respond(requestId,null,error);
        });
        return;
      }
      if(message.type==='browser-export-start'){
        if(!settings.studioOrigin || settings.studioOrigin !== event.origin) return;
        var exportTargetOrigin=settings.studioOrigin;
        startBridgeBrowserExport(message,function(update){
          post('browser-export-progress',update,requestId,undefined,exportTargetOrigin);
        }).then(function(result){
          respond(requestId,result,null,result&&result.buffer?[result.buffer]:undefined,exportTargetOrigin);
        },function(error){
          respond(requestId,null,error,undefined,exportTargetOrigin);
        });
        return;
      }
      if(message.type==='browser-export-cancel'){
        if(!settings.studioOrigin || settings.studioOrigin !== event.origin) return;
        respond(requestId,{cancelled:cancelBridgeBrowserExport(message)},null,undefined,settings.studioOrigin);
        return;
      }
      if(message.type==='playback-control'){
        var p=player(), action=message.action;
        if(!p) throw new Error('Preview player is not ready');
        if(action==='play' && typeof p.play==='function') p.play();
        else if(action==='pause' && typeof p.pause==='function') p.pause();
        else if(action==='seek' && typeof p.seek==='function'){
          var target=Math.max(0,Number(message.time)||0);
          if(message.reseek===true) p.seek(target>0.001?Math.max(0,target-0.001):0.001);
          p.seek(target);
          if(message.waitForPaint===true){
            waitSeekPainted(target).then(function(){
              var state=timeline();
              post('timeline-state',state);
              respond(requestId,state);
            },function(){
              var state=timeline();
              post('timeline-state',state);
              respond(requestId,state);
            });
            return;
          }
        }
        else throw new Error('Unsupported playback action');
        post('timeline-state',timeline()); respond(requestId,timeline()); return;
      }
      if(message.type==='canvas-framing'){
        var canvas=document.querySelector('[data-composition-id]');
        respond(requestId,canvas?{sourceFile:compositionPath,fit:canvas.getAttribute('data-canvas-fit')==='cover'?'cover':'contain'}:null); return;
      }
      if(message.type==='inspect-element'){ respond(requestId,inspectPreviewElement(message)); return; }
      if(message.type==='inspector-styles'){
        if(settings.studioOrigin && settings.studioOrigin === event.origin) previewInspectorStyles(message);
        return;
      }
      if(message.type==='layer-tree'){ previewLayerTree(message); return; }
      if(message.type==='layer-family'){ respond(requestId,previewLayerFamily(message)); return; }
      if(message.type==='layer-select'){ respond(requestId,selectPreviewLayer(message)); return; }
      if(message.type==='inline-text'){
        var textTarget=editInlineText(message);
        if(message.phase==='pick') respond(requestId,textTarget);
        return;
      }
      if(message.type==='canvas-drag'){
        var result=canvasDrag(message);
        if(message.phase==='start'){
          const started=drag?.id===message.gestureId ? drag : null;
          const hit=started?.element || (!message.corner && document.elementFromPoint(message.x * innerWidth,message.y * innerHeight)?.closest('[data-hf-id],[id]'));
          if(hit && hit!==document.body && hit!==document.documentElement) reportLayerSelection(hit, started?.selection || describe(hit));
        }
        if(message.phase==='start' || message.phase==='finish') respond(requestId,result);
        return;
      }
      if(message.type==='pick-mode'){
        pickMode=message.enabled===true;
        respond(requestId,{enabled:pickMode}); return;
      }
      if(message.type==='selection-geometry'){
        var target=message.elementId?document.getElementById(String(message.elementId)):null;
        respond(requestId,target?describe(target):null); if(target) post('selection-geometry',{selection:describe(target)}); return;
      }
      if(message.type==='edit-element'){
        if(!message.operation){
          window.dispatchEvent(new CustomEvent('openmotion:edit-element',{detail:message}));
          respond(requestId,{accepted:true}); return;
        }
        if(!picked || !picked.isConnected || describe(picked).selector!==message.selector)
          throw new Error('Preview selection changed');
        var op=message.operation;
        if(!op || typeof op.value!=='string' || typeof op.property!=='string') throw new Error('Invalid edit');
        if(op.type==='inline-style') picked.style.setProperty(op.property,op.value);
        else if(op.type==='text-content') picked.textContent=op.value;
        else if(op.type==='attribute') picked.setAttribute('data-'+op.property,op.value);
        else throw new Error('Unsupported edit');
        respond(requestId,{accepted:true}); return;
      }
      respond(requestId,{accepted:false},'Unsupported preview message');
    } catch(error) { respond(requestId,null,error); post('runtime-error',{message:String(error&&error.message||error),sourceType:'bridge'}); }
  });
  document.addEventListener('click',function(event){
    if(!pickMode) return;
    var target=event.target;
    var detail=describe(target);
    if(detail && detail.selector){ picked=target; pickMode=false; post('select-element',{selection:detail}); }
  },true);
  window.addEventListener('error',function(event){ post('runtime-error',{message:String(event.message||'Preview runtime error'),filename:event.filename||null,line:event.lineno||null}); });
  window.addEventListener('unhandledrejection',function(event){ post('runtime-error',{message:String(event.reason&&event.reason.message||event.reason||'Unhandled preview rejection')}); });
  window.addEventListener('load',ready);
  document.addEventListener('DOMContentLoaded',announceDurationIfReady);
  if(isCaptureMode) loadSnapdom().catch(function(){});
  if(!announceDurationIfReady()){
    var bootPollTicks=0;
    bootPoll=setInterval(function(){
      if(announceDurationIfReady() || ++bootPollTicks>=160){
        clearInterval(bootPoll);
        bootPoll=null;
      }
    },25);
  }
  setInterval(function(){ if(document.visibilityState!=='hidden' && !(isCaptureMode && durationBootAnnounced)) post('timeline-state',timeline()); },500);
`);

export const PREVIEW_BRIDGE_PATH = '/api/preview-bridge.js';
export const PREVIEW_BRIDGE_VERSION = createHash('sha256').update(PREVIEW_BRIDGE_SCRIPT).digest('hex');
export const PREVIEW_BRIDGE_ASSET = '/api/preview-bridge/' + PREVIEW_BRIDGE_VERSION + '.js';
export const PREVIEW_BRIDGE_ASSET_RE = /^\/api\/preview-bridge\/([a-f0-9]{64})\.js$/;
const bridgeIntegrity = 'sha256-' + Buffer.from(PREVIEW_BRIDGE_VERSION, 'hex').toString('base64');

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function bridgeDocumentTags(origin: string, projectId: string, compositionPath: string, sourceVersions: Record<string, string>, options: {
  studioOrigin?: string; canRebindTiming?: boolean; htmlSources?: string[]; liveEdits?: PreviewLiveEdits; smallMountedSources?: string[];
} = {}) {
  const { studioOrigin, canRebindTiming, htmlSources, liveEdits, smallMountedSources } = options;
  const src = new URL(PREVIEW_BRIDGE_ASSET, origin);
  const settings = htmlAttribute(JSON.stringify({ projectId, compositionPath, sourceVersions, studioOrigin, htmlSources, liveEdits, smallMountedSources, ...(canRebindTiming && { canRebindTiming }) }));
  // A pod from before this route existed may still serve an asset request
  // during rollout. Reuse the player's bounded preview retry if loading fails.
  const retry = htmlAttribute(previewBuildBusyScript(projectId, 1));
  return {
    preload: `<link rel="preload" as="script" href="${src.href}" integrity="${bridgeIntegrity}">`,
    script: `<script src="${src.href}" data-openmotion-preview="${settings}" integrity="${bridgeIntegrity}" onerror="${retry}"></script>\n`,
  };
}
