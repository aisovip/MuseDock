// HyperFrames-compatible HTML composition: local images and a paused GSAP timeline.
function imageOpeningComposition({ count, canvas, fps }) {
  const { width, height } = canvas;
  const columns = Math.min(count, Math.ceil(Math.sqrt(count * width / height)));
  const rows = Math.ceil(count / columns);
  const image = i => `<img src="https://opening.invalid/image/${i}" alt="">`;
  const shots = Array.from({ length: count }, (_, i) => `<div id="shot-${i}" class="shot">${image(i)}</div>`).join('');
  const tiles = Array.from({ length: count }, (_, i) => `<div class="tile" data-image-index="${i}">${image(i)}</div>`).join('');
  const gap = Math.max(2, Math.round(Math.min(width, height) / 180));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}
#opening,.scene,.shot{position:absolute;inset:0;overflow:hidden}#opening{background:#F6EBD5}
.shot{opacity:0}.shot img{width:100%;height:100%;object-fit:cover}
.bar{position:absolute;left:0;width:100%;height:50%;background:#000;z-index:25}.top{top:0}.bottom{bottom:0}
#wall{opacity:0;background:#F6EBD5;z-index:30;padding:${gap * 4}px}
.grid{display:grid;grid-template-columns:repeat(${columns},1fr);grid-template-rows:repeat(${rows},1fr);width:100%;height:100%;gap:${gap}px}
.tile{overflow:hidden;background:#F6EBD5}.tile img{display:block;width:100%;height:100%;object-fit:contain}
#flash{position:absolute;inset:0;background:#F6EBD5;opacity:0;z-index:40;pointer-events:none}
</style></head><body><div id="opening" data-composition-id="opening" data-width="${width}" data-height="${height}" data-start="0" data-duration="3">
<div class="scene">${shots}<div class="bar top"></div><div class="bar bottom"></div></div>
<div id="wall" class="scene"><div class="grid">${tiles}</div></div><div id="flash"></div></div></body></html>`;
  // Each rapid shot gets at least one frame. The final wall always contains every image.
  const shotCount = Math.min(count, Math.floor(1.38 * fps));
  const script = `const tl=gsap.timeline({paused:true});
tl.to('.top',{y:-${height / 2},duration:.64,ease:'power2.inOut'},.22);
tl.to('.bottom',{y:${height / 2},duration:.64,ease:'power2.inOut'},.22);
for(let i=0;i<${shotCount};i++){
 const t=.26+i*(1.38/${shotCount});
 const index=Math.floor(i*${count}/${shotCount});
 tl.fromTo('#shot-'+index,{opacity:0},{opacity:1,duration:Math.min(.035,1/${fps}),ease:'none'},t);
 tl.from('#shot-'+index+' img',{scale:1.45,x:i%2?${width / 40}:-${width / 40},duration:.19,ease:i%3===0?'expo.out':i%3===1?'power3.out':'sine.out'},t);
}
tl.fromTo('#wall',{opacity:0},{opacity:1,duration:.17,ease:'power2.inOut'},1.68);
tl.from('.tile',{scale:1.2,opacity:0,duration:.24,stagger:{amount:.24,from:'center'},ease:'power3.out'},1.68);
tl.fromTo('#flash',{opacity:.26},{opacity:0,duration:.12,ease:'power1.out',immediateRender:false},1.68);
for(let i=0;i<4;i++){const t=1.9+i*.11;tl.to('#wall',{x:i%2?-${width / 288}:${width / 288},duration:.027,ease:'none'},t);tl.to('#wall',{x:0,duration:.06,ease:'power2.out'},t+.03);}
tl.to('.grid',{scale:1.004,duration:.6,ease:'sine.inOut'},2.4);
window.__timelines={opening:tl};window.__mpSetTimelineTime=t=>{tl.pause().seek(Math.max(0,Math.min(3,t)),false);return tl.time();};`;
  return { html, script, columns, rows, shotCount };
}

module.exports = { imageOpeningComposition };
