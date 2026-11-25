/** Embedded in the isolated preview. Timeline metadata may be ready before the visible media paints. */
export const PREVIEW_FIRST_FRAME = `
  var firstFrameMedia, firstFrameStatus, firstFrameTime;
  function visualFrameStatus(time) {
    if(firstFrameStatus) return firstFrameStatus;
    // A script may replace a loading media node, or a restore seek may move the playhead to another scene.
    if(firstFrameMedia && (firstFrameTime!==time || firstFrameMedia.some(function(node){ return node.isConnected===false; }))) firstFrameMedia=undefined;
    firstFrameTime=time;
    if(!firstFrameMedia) {
      firstFrameMedia=Array.from(document.querySelectorAll('img[src],img[srcset],video')).filter(function(node){
        if(node.checkVisibility && !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
        var rect=node.getBoundingClientRect();
        if(!rect.width || !rect.height || rect.right<=0 || rect.bottom<=0 || rect.top>=innerHeight || rect.left>=innerWidth) return false;
        var start=0, end=Infinity;
        var chain=[], owner=node;
        while(owner){ if(owner.hasAttribute('data-start')) chain.push(owner); owner=owner.parentElement; }
        for(var i=chain.length-1;i>=0;i--) {
          start+=Number(chain[i].getAttribute('data-start'))||0;
          var duration=Number(chain[i].getAttribute('data-duration'));
          if(duration>0) end=Math.min(end,start+duration);
        }
        if(time<start || time>=end) return false;
        if(node.tagName==='VIDEO') {
          if(!node.currentSrc && !node.getAttribute('src') && !node.querySelector('source[src]')) return false;
          if(node.readyState<2 && node.preload!=='auto') node.preload='auto';
        } else if(node.loading==='lazy') node.loading='eager';
        return true;
      });
    }
    if(firstFrameMedia.some(function(node){ return node.tagName==='VIDEO' ? node.error : node.complete && !node.naturalWidth; })) firstFrameStatus='error';
    else if(firstFrameMedia.every(function(node){ return node.tagName==='VIDEO' ? node.readyState>=2 : node.complete && node.naturalWidth; })) firstFrameStatus='ready';
    if(firstFrameStatus) firstFrameMedia=undefined;
    return firstFrameStatus||'loading';
  }
`;
