module.exports=[3798364,2016118,a=>{"use strict";let b="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'",c=["camera","microphone","geolocation","display-capture","usb","serial","hid","bluetooth","payment","midi","clipboard-read","fullscreen","publickey-credentials-get","screen-wake-lock"].map(a=>`${a} 'none'`).join("; "),d="agentspace-sayfa",e=Object.freeze({anahtar:64,degerBayt:8192,anahtarSayisi:64}),f=Object.freeze({min:60,max:4e4}),g=Object.freeze({panoBayt:65536,href:2048,kanitAd:200}),h=/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,i=a=>new TextEncoder().encode(a).length;function j(a){return JSON.stringify(a).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029")}a.s(["BRIDGE_CHANNEL",0,d,"CAGE_ALLOW",0,c,"CAGE_CSP",0,b,"CAGE_SANDBOX",0,"allow-scripts","DEFAULT_HEIGHT",0,520,"STATE_LIMITS",0,e,"cageDocument",0,function(a,c={},e={}){let f=String(a??"").replace(/^\uFEFF?(\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i,""),g=e.kit??null;return`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${b}"><meta name="referrer" content="no-referrer"><style>html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}</style>`+(g?`<style id="agentspace-kit">${g.css.replace(/<\/style/gi,"<\\/style")}</style>`:"")+`<script>${function(a,b=null,c={}){let e=b?`try{api.kit=Object.freeze((${b.js})({durum:api.durum,on:onMsg,send:send,st:st,data:${j(b.data)}}))}catch(e){try{console.warn("[agentspace] kit kurulamadı:",e&&e.message)}catch(_){}}`:"";return`(function(){"use strict";
var CH=${j(d)},st=${j(a)},seq=0,wait={},hs={},own=Object.prototype.hasOwnProperty;
function send(m){m.kanal=CH;try{parent.postMessage(m,"*")}catch(e){}}
function onMsg(t,fn){(hs[t]=hs[t]||[]).push(fn)}
addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.kanal!==CH)return;
 if(typeof d.istek!=="string"||!own.call(wait,d.istek)){if(typeof d.tur==="string"&&own.call(hs,d.tur))hs[d.tur].forEach(function(f){try{f(d)}catch(x){}});return}
 var w=wait[d.istek];delete wait[d.istek];if(d.ok){if(d.durum&&typeof d.durum==="object"&&d.anahtar==null)st=d.durum;w[0](d)}else w[1](new Error(d.hata||"durum"))});
var hq=0,hl=0;function hOlc(){hq=0;var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(document.body){var b=document.body,cs=getComputedStyle(b);h=Math.max(h,Math.ceil(b.getBoundingClientRect().bottom+(parseFloat(cs.marginBottom)||0)+scrollY))}if(Math.abs(h-hl)>1){hl=h;send({tur:"yukseklik",px:h})}}
function hPlan(){if(!hq)hq=requestAnimationFrame(hOlc)}
try{new ResizeObserver(hPlan).observe(document.documentElement)}catch(e){}
function kOlc(){if(!document.body)return;var all=document.body.getElementsByTagName("*"),n=Math.min(all.length,8000),W=innerWidth,H=Math.min(innerHeight,1200);for(var i=0;i<n;i++){var e=all[i],s=getComputedStyle(e);if(s.position!=="fixed"||s.display==="none"||s.visibility==="hidden"||+s.opacity===0)continue;var r=e.getBoundingClientRect();if(r.width<4||r.height<4||r.width*r.height>W*H*0.5)continue;if(r.top<=40||r.bottom>=innerHeight-40){send({tur:"yukseklik",px:hl||Math.ceil(document.documentElement.getBoundingClientRect().height),kenar:true});return}}}
addEventListener("DOMContentLoaded",function(){try{new ResizeObserver(hPlan).observe(document.body)}catch(e){}hPlan()});addEventListener("load",function(){hPlan();setTimeout(kOlc,300)});
function req(m){return new Promise(function(res,rej){var id="r"+(++seq);wait[id]=[res,rej];m.istek=id;send(m)})}
var durum={
 oku:function(k){return req({tur:"durum-oku",anahtar:k==null?null:String(k)}).then(function(d){return k==null?d.durum:(d.deger==null?null:d.deger)})},
 yaz:function(k,v){k=String(k);v=v==null?null:String(v);if(v===null)delete st[k];else st[k]=v;return req({tur:"durum-yaz",anahtar:k,deger:v}).then(function(){return true})}
};
function quiet(p){p.catch(function(e){try{console.warn("[agentspace] durum yazılamadı:",e.message)}catch(_){}})}
var sm={
 getItem:function(k){k=String(k);return own.call(st,k)?st[k]:null},
 setItem:function(k,v){quiet(durum.yaz(k,v))},
 removeItem:function(k){quiet(durum.yaz(k,null))},
 clear:function(){Object.keys(st).forEach(function(k){quiet(durum.yaz(k,null))})},
 key:function(i){var ks=Object.keys(st);return i>=0&&i<ks.length?ks[i]:null}
};
/* RPT-CAGE-FULL-01 — tarayıcı deposu gibi: y\xf6ntemler sayılmaz, ANAHTARLAR sayılır (Object.keys, for…in, depo[k]). */
var store=typeof Proxy==="function"?new Proxy({},{
 get:function(t,k){if(k==="length")return Object.keys(st).length;if(own.call(sm,k))return sm[k];return typeof k==="string"&&own.call(st,k)?st[k]:undefined},
 set:function(t,k,v){if(typeof k==="string"&&!own.call(sm,k)&&k!=="length")sm.setItem(k,v);return true},
 deleteProperty:function(t,k){if(typeof k==="string")sm.removeItem(k);return true},
 has:function(t,k){return k==="length"||own.call(sm,k)||(typeof k==="string"&&own.call(st,k))},
 ownKeys:function(){return Object.keys(st)},
 getOwnPropertyDescriptor:function(t,k){return typeof k==="string"&&own.call(st,k)?{value:st[k],writable:true,enumerable:true,configurable:true}:undefined}
}):sm;
var mem={},sess={getItem:function(k){k=String(k);return own.call(mem,k)?mem[k]:null},setItem:function(k,v){mem[String(k)]=String(v)},removeItem:function(k){delete mem[String(k)]},clear:function(){mem={}},key:function(i){var ks=Object.keys(mem);return i>=0&&i<ks.length?ks[i]:null}};
Object.defineProperty(sess,"length",{get:function(){return Object.keys(mem).length}});
try{Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return store}})}catch(e){}
try{Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return sess}})}catch(e){}
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCRtpSender","RTCRtpReceiver"].forEach(function(n){try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}});
var api={durum:Object.freeze(durum)};
${String.raw`var MT=${j(c.metin??{})},SQ=${j(c.sorgu??"")},CP=${j(c.capa??"")},KN=${c.kanit?"true":"false"},fh=CP?"#"+CP:"";
function hashGo(id){var el=id?(document.getElementById(id)||document.getElementsByName(id)[0]):null;if(id&&!el)return false;var old=fh;fh=id?"#"+id:"";
 if(el){try{el.scrollIntoView({block:"start"})}catch(e){el.scrollIntoView()}}else scrollTo(0,0);
 try{history.replaceState(history.state,"","#"+id)}catch(e){}try{dispatchEvent(new HashChangeEvent("hashchange",{oldURL:old,newURL:fh}))}catch(e){}return true}
addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var t=e.target;if(t&&t.nodeType!==1)t=t.parentElement;var a=t&&t.closest?t.closest("a[href],area[href]"):null;if(!a)return;
 var h=String(a.getAttribute("href")||"").trim();if(!h||/^javascript:/i.test(h))return;
 if(h.charAt(0)==="#"){e.preventDefault();var id=h.slice(1);try{id=decodeURIComponent(id)}catch(x){}hashGo(id);return}
 e.preventDefault();if(!e.isTrusted)return;
 if(/^https?:\/\//i.test(h))send({tur:"dis-ac",url:h});else if(!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(h))send({tur:"sayfa-bag",href:h})},false);
if(SQ){try{var USP=URLSearchParams,P=function(i){if(i===undefined||i===null||i===""||i===location.search)i=SQ;return new USP(i)};P.prototype=USP.prototype;Object.defineProperty(window,"URLSearchParams",{value:P,configurable:true,writable:true})}catch(e){}}
function goCapa(){if(CP)hashGo(CP)}
try{var wt=function(x){x=String(x);var ua=navigator.userActivation;if(ua&&!ua.isActive)return Promise.reject(new DOMException("Document is not focused.","NotAllowedError"));return req({tur:"pano-yaz",metin:x}).then(function(){})};
 if(navigator.clipboard)Object.defineProperty(navigator.clipboard,"writeText",{value:wt,configurable:true});else Object.defineProperty(navigator,"clipboard",{value:{writeText:wt},configurable:true})}catch(e){}
var BU={},IQ={},nq=0;
function kad(v){v=String(v==null?"":v).trim();if(!v||/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(v))return null;v=v.replace(/[?#].*$/,"").replace(/^(?:\.\/)+/,"");try{v=decodeURIComponent(v)}catch(e){}
 return v.length<=200&&/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(v)&&/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(v)?v:null}
function iste(n){if(BU[n]){uyg(n);return}if(IQ[n]||nq>=2000)return;IQ[n]=1;nq++;send({tur:"kanit-iste",ad:n})}
function uyg(n){var u=BU[n];if(!u)return;Array.prototype.forEach.call(document.querySelectorAll("img[data-kanit]"),function(im){if(im.getAttribute("data-kanit")===n&&im.getAttribute("src")!==u){IS.call(im,u);im.classList.add("kanit-hazir")}});
 Array.prototype.forEach.call(document.querySelectorAll("[data-as-bg]"),function(el){if(el.getAttribute("data-as-bg")===n)el.style.backgroundImage='url("'+u+'")'})}
var ID=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src"),IS=ID&&ID.set?function(u){ID.set.call(this,u)}:function(u){SA.call(this,"src",u)},SA=Element.prototype.setAttribute;
onMsg("kanit",function(d){if(!d||typeof d.ad!=="string")return;if(d.blob&&typeof Blob!=="undefined"&&d.blob instanceof Blob&&!BU[d.ad]){BU[d.ad]=URL.createObjectURL(d.blob);uyg(d.ad)}});
if(KN){
 if(ID&&ID.set)Object.defineProperty(HTMLImageElement.prototype,"src",{configurable:true,enumerable:ID.enumerable,get:function(){return ID.get.call(this)},set:function(v){var n=kad(v);if(n){SA.call(this,"data-kanit",n);iste(n);return}ID.set.call(this,v)}});
 Element.prototype.setAttribute=function(k,v){if(this instanceof HTMLImageElement&&String(k).toLowerCase()==="src"){var n=kad(v);if(n){SA.call(this,"data-kanit",n);iste(n);return}}return SA.call(this,k,v)};
 var RX=/(<img\b[^>]*?\s)src\s*=\s*(["'])([^"']*)\2/gi;function rw(h){if(typeof h!=="string"||h.indexOf("<img")<0&&h.indexOf("<IMG")<0&&h.indexOf("url(")<0)return h;return h.replace(RX,function(m,pre,q,v){var n=kad(v);if(!n)return m;setTimeout(function(){iste(n)},0);return pre+'data-kanit="'+n+'"'}).replace(/\sstyle\s*=\s*(["'])([^"']*?url\([^"']*?)\1/gi,function(m,q,css){var ns=[];var c2=css.replace(/url\(\s*([^)'"]+)\s*\)/gi,function(u,v){var n=kad(v);if(!n)return u;ns.push(n);return"none"});if(!ns.length)return m;setTimeout(function(){iste(ns[0])},0);return' data-as-bg="'+ns[0]+'" style='+q+c2+q})}
 ["innerHTML","outerHTML"].forEach(function(p){var d=Object.getOwnPropertyDescriptor(Element.prototype,p);if(d&&d.set)Object.defineProperty(Element.prototype,p,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(h){d.set.call(this,rw(h))}})});
 var IAH=Element.prototype.insertAdjacentHTML;Element.prototype.insertAdjacentHTML=function(w,h){return IAH.call(this,w,rw(h))};
}
var io=null;try{io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){var n=en.target.getAttribute("data-kanit")||en.target.getAttribute("data-as-bg");if(n)iste(n);io.unobserve(en.target)}})},{rootMargin:"1500px 0px"})}catch(e){}
function gozle(r){if(!KN)return;var ims=r.querySelectorAll?r.querySelectorAll("img[data-kanit],[data-as-bg]"):[];Array.prototype.forEach.call(ims,function(im){var n=im.getAttribute("data-kanit")||im.getAttribute("data-as-bg");if(BU[n])uyg(n);else if(io)io.observe(im);else iste(n)});if(r.hasAttribute&&(r.hasAttribute("data-kanit")||r.hasAttribute("data-as-bg"))){var n=r.getAttribute("data-kanit")||r.getAttribute("data-as-bg");if(BU[n])uyg(n);else if(io)io.observe(r)}}
function cerceve(f){if(f.__as)return;f.__as=1;var s=String(f.getAttribute("src")||"").trim();if(!s)return;var d=document.createElement("div");d.setAttribute("data-as-cerceve",s.slice(0,300));d.setAttribute("role","note");
 var hh=f.getAttribute("height"),cs=f.style;d.style.cssText="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;width:"+(cs.width||"100%")+";min-height:"+(cs.height||(hh?hh+(/^\d+$/.test(hh)?"px":""):"160px"))+";padding:16px;border:1px dashed rgba(128,128,128,.6);border-radius:10px;font:14px/1.5 system-ui,sans-serif;text-align:center";
 var p=document.createElement("div");p.textContent=MT.cerceve||"";d.appendChild(p);
 if(MT.cerceveAc&&(/^https?:\/\//i.test(s)||!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(s))){var b=document.createElement("button");b.type="button";b.textContent=MT.cerceveAc;b.style.cssText="font:inherit;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.6);background:transparent;color:inherit;cursor:pointer";
  b.addEventListener("click",function(ev){if(!ev.isTrusted)return;if(/^https?:\/\//i.test(s))send({tur:"dis-ac",url:s});else send({tur:"sayfa-bag",href:s})});d.appendChild(b)}
 if(f.parentNode)f.parentNode.replaceChild(d,f)}
function tara(r){if(!r||r.nodeType!==1)return;if(r.tagName==="IFRAME")cerceve(r);else Array.prototype.forEach.call(r.querySelectorAll("iframe"),cerceve);gozle(r)}
try{new MutationObserver(function(ms){ms.forEach(function(m){Array.prototype.forEach.call(m.addedNodes,tara)})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}
addEventListener("DOMContentLoaded",function(){tara(document.documentElement);setTimeout(goCapa,0)});addEventListener("load",function(){setTimeout(goCapa,50)});
onMsg("yazitipi",function(d){if(!d||typeof d.aile!=="string"||!(d.blob instanceof Blob)||typeof FontFace!=="function")return;d.blob.arrayBuffer().then(function(b){var f=new FontFace(d.aile,b,{weight:typeof d.agirlik==="string"?d.agirlik:"100 900",style:"normal"});return f.load().then(function(){document.fonts.add(f)})}).catch(function(e){try{console.warn("[agentspace] yazı tipi kurulamadı:",e&&e.message)}catch(_){}})});`}
${e}
Object.defineProperty(window,"agentspace",{value:Object.freeze(api)});
})();`}(c,g?{js:g.js,data:g.data}:null,e.extras??{})}</script>`+f},"parseBridgeMessage",0,function(a){if(!a||"object"!=typeof a)return{ok:!1,neden:"şekil"};if(a.kanal!==d)return{ok:!1,neden:"kanal"};if("yukseklik"===a.tur){let b=a.px;if("number"!=typeof b||!Number.isFinite(b))return{ok:!1,neden:"yükseklik"};let c=Math.round(Math.min(f.max,Math.max(f.min,b)));return!0===a.kenar?{ok:!0,req:{kanal:d,tur:"yukseklik",px:c,kenar:!0}}:{ok:!0,req:{kanal:d,tur:"yukseklik",px:c}}}if("tasarim-ac"===a.tur)return"string"!=typeof a.anahtar||a.anahtar.length>200?{ok:!1,neden:"anahtar"}:{ok:!0,req:{kanal:d,tur:"tasarim-ac",anahtar:a.anahtar}};if("sayfa-bag"===a.tur){let b=a.href;return"string"!=typeof b||!b||b.length>g.href||/[\u0000-\u001f]/.test(b)||/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\\)/i.test(b.trim())?{ok:!1,neden:"href"}:{ok:!0,req:{kanal:d,tur:"sayfa-bag",href:b.trim()}}}if("dis-ac"===a.tur){let b=a.url;return"string"!=typeof b||b.length>g.href||!/^https?:\/\/[^\s]+$/i.test(b)?{ok:!1,neden:"url"}:{ok:!0,req:{kanal:d,tur:"dis-ac",url:b}}}if("kanit-iste"===a.tur){let b=a.ad;return"string"!=typeof b||b.length>g.kanitAd||!h.test(b)?{ok:!1,neden:"ad"}:{ok:!0,req:{kanal:d,tur:"kanit-iste",ad:b}}}if("string"!=typeof a.istek||!/^[A-Za-z0-9_-]{1,32}$/.test(a.istek))return{ok:!1,neden:"istek"};let b=a=>"string"==typeof a&&a.length>0&&a.length<=e.anahtar&&!/[\u0000-\u001f]/.test(a);return"pano-yaz"===a.tur?"string"!=typeof a.metin||i(a.metin)>g.panoBayt?{ok:!1,neden:"boyut"}:{ok:!0,req:{kanal:d,tur:"pano-yaz",istek:a.istek,metin:a.metin}}:"durum-oku"===a.tur?null==a.anahtar||b(a.anahtar)?{ok:!0,req:{kanal:d,tur:"durum-oku",istek:a.istek,anahtar:a.anahtar??null}}:{ok:!1,neden:"anahtar"}:"durum-yaz"===a.tur?b(a.anahtar)?null!==a.deger&&"string"!=typeof a.deger?{ok:!1,neden:"değer"}:"string"==typeof a.deger&&i(a.deger)>e.degerBayt?{ok:!1,neden:"boyut"}:{ok:!0,req:{kanal:d,tur:"durum-yaz",istek:a.istek,anahtar:a.anahtar,deger:a.deger}}:{ok:!1,neden:"anahtar"}:{ok:!1,neden:"tür"}}],3798364);let k=["surface-0","surface-1","surface-2","border-1","border-2","text-1","text-2","text-3","accent","on-accent","ok","warn","err","info","lead","term-bg","term-fg"],l=/^[#a-zA-Z0-9(),.%\s-]{1,80}$/,m=/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,n=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,o=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;function p(a,b){let c=RegExp(`\\s${b}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`,"i").exec(a);return c?(c[1]??c[2]??c[3]??"").trim():null}let q=`
:root{color-scheme:dark;--surface-0:#262b36;--surface-1:#2e333d;--surface-2:#373d49;--border-1:#49505d;--border-2:#3c414c;--text-1:#d8dde8;--text-2:#a9acb3;--text-3:#9da0a5;--accent:#7fcdd6;--on-accent:#000000;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--info:#38bdf8;--lead:#d4af37;--term-bg:#262d3a;--term-fg:#c6ccd6}
:root{--surface-3:color-mix(in srgb,var(--surface-2),var(--border-1) 45%);--term:var(--term-bg);--accent-soft:color-mix(in srgb,var(--accent) 16%,transparent);--ok-soft:color-mix(in srgb,var(--ok) 14%,transparent);--warn-soft:color-mix(in srgb,var(--warn) 14%,transparent);--err-soft:color-mix(in srgb,var(--err) 14%,transparent);--info-soft:color-mix(in srgb,var(--info) 14%,transparent);--lead-soft:color-mix(in srgb,var(--lead) 16%,transparent);--kit-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@layer agentspace-kit{
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:16px 18px 28px;background:var(--surface-0);color:var(--text-1);font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
button{font:inherit;color:inherit;cursor:pointer;background:none;border:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
img,svg,video{max-width:100%}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:28px;line-height:1.2;margin:10px 0 8px;letter-spacing:-.3px}
h2{font-size:21px;line-height:1.25;margin:40px 0 6px}
h3{font-size:16px;margin:20px 0 6px}
p.lead,.lead{color:var(--text-2);max-width:780px;margin-top:0}
.meta{color:var(--text-3);font-size:13px}
.kicker,.verdict small{display:block;color:var(--text-3);font-size:12px;text-transform:uppercase/* type-ok: report document design (contract v3), not app UI */;letter-spacing:.8px;margin-bottom:4px}
.hint{font-size:13px;color:var(--text-3)}
.new{color:var(--lead);font-weight:600}
.verdict{border-left:4px solid var(--ok);background:var(--ok-soft);border-radius:10px;padding:14px 18px;max-width:900px;font-size:16px}
.verdict.warn{border-left-color:var(--warn);background:var(--warn-soft)}
.verdict.err{border-left-color:var(--err);background:var(--err-soft)}
.verdict.info{border-left-color:var(--info);background:var(--info-soft)}
.grid2,.grid3,.grid4{display:grid;gap:12px;margin-top:16px}
.grid2{grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:14px}
.grid3{grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))}
.grid4{grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}
.card{background:var(--surface-1);border:1px solid var(--border-2);border-radius:12px;padding:16px;min-width:0}
.card>h3:first-child{margin-top:0}
.stat{font-size:30px;font-weight:700;line-height:1.1}
.stat-l{color:var(--text-2);font-size:13px;margin-top:4px}
.pill{display:inline-block;font-size:11.5px;padding:1px 9px;border-radius:999px;border:1px solid var(--border-1);color:var(--text-2);white-space:nowrap}
.pill.ok{border-color:transparent;background:var(--ok-soft);color:var(--ok)}
.pill.warn{border-color:transparent;background:var(--warn-soft);color:var(--warn)}
.pill.err{border-color:transparent;background:var(--err-soft);color:var(--err)}
.pill.info{border-color:transparent;background:var(--info-soft);color:var(--info)}
.pill.lead{border-color:transparent;background:var(--lead-soft);color:var(--lead)}
table{border-collapse:collapse;width:100%;font-size:14px}
.tw{overflow-x:auto;border:1px solid var(--border-2);border-radius:12px;background:var(--surface-1);margin-top:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border-2);vertical-align:top}
th{font-size:12px;color:var(--text-3);text-transform:uppercase/* type-ok: report document design (contract v3), not app UI */;letter-spacing:.5px;font-weight:600;background:var(--surface-2)}
tr:last-child td{border-bottom:0}
blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid var(--lead);background:var(--lead-soft);border-radius:8px;max-width:900px}
code{font:12.5px var(--kit-mono);background:var(--surface-2);padding:1px 5px;border-radius:5px}
pre{font:12.5px/1.55 var(--kit-mono);background:var(--surface-2);padding:10px 12px;border-radius:8px;overflow-x:auto}
details{background:var(--surface-1);border:1px solid var(--border-2);border-radius:12px;padding:12px 16px;margin-top:14px}
details summary{cursor:pointer;font-weight:600}
.stage{border:1px solid var(--border-1);border-radius:14px;overflow:hidden;background:var(--surface-0);margin-top:16px;position:relative}
.stage-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--surface-2);border-bottom:1px solid var(--border-2);font-size:12.5px;color:var(--text-2);flex-wrap:wrap}
.tab{padding:3px 11px;border-radius:7px;cursor:pointer;color:var(--text-2)}
.tab:hover{color:var(--text-1)}
.tab.on{background:var(--accent-soft);color:var(--text-1);font-weight:600}
.stage-body{min-height:300px;position:relative}
.view{display:none;padding:14px}
.view.on{display:block}
.pane{border:1px solid var(--border-2);border-radius:10px;background:var(--term);max-width:760px;position:relative;transition:opacity .3s}
.pane.kapali{opacity:.25;pointer-events:none}
.pane-hdr{display:flex;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border-2);background:var(--surface-1);border-radius:10px 10px 0 0;flex-wrap:wrap;position:relative}
.pane-name{font-weight:700;font-size:13px}
.pane-x{margin-left:auto;color:var(--text-3);font-size:13px;padding:0 6px;border-radius:5px}
.pane-x:hover{background:var(--err-soft);color:var(--err)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}
.chip{font:11.5px var(--kit-mono);padding:1px 8px;border-radius:6px;border:1px solid var(--border-1);color:var(--text-2);white-space:nowrap}
.chip.on,.chip.rep{border-color:var(--accent);color:var(--accent);font-weight:600}
button.chip:hover{background:var(--accent-soft)}
.term{font:12.5px/1.55 var(--kit-mono);color:var(--term-fg);padding:10px 12px;min-height:120px}
.term .l{color:var(--accent)}
.toastbox{position:absolute;top:10px;right:10px;z-index:8;width:320px;max-width:calc(100% - 20px);display:flex;flex-direction:column;gap:8px}
.toast{display:block;width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border-1);border-left:4px solid var(--accent);border-radius:10px;padding:10px 12px;box-shadow:0 10px 28px rgba(0,0,0,.3);cursor:pointer;animation:kit-in .35s ease}
.toast:hover{border-color:var(--accent)}
.toast .t1{display:block;font-size:12px;color:var(--text-3)}
.toast .t2{display:block;font-weight:700;font-size:13.5px;margin:2px 0}
.toast .t3{display:block;font-size:12.5px;color:var(--text-2)}
.toast .t4{display:block;font-size:12px;color:var(--accent);margin-top:4px}
@keyframes kit-in{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}
.ctl{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}
.btn{border:1px solid var(--border-1);border-radius:8px;padding:5px 12px;font-size:13px;background:var(--surface-2);min-height:32px}
.btn:hover{border-color:var(--accent)}
.btn.pri{background:var(--accent);color:var(--on-accent);border-color:var(--accent);font-weight:600}
.btn.done{opacity:.72}
.btn.done::after{content:" ✓"}
.narr{font-size:13px;color:var(--text-2);background:var(--info-soft);border-radius:8px;padding:8px 12px;margin-top:10px;max-width:760px}
.phases{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:12px;margin-top:16px}
.ph{background:var(--surface-1);border:1px solid var(--border-2);border-radius:12px;padding:14px;position:relative}
.ph .n{font-size:12px;color:var(--text-3);text-transform:uppercase/* type-ok: report document design (contract v3), not app UI */;letter-spacing:.6px}
.ph .v{font-size:19px;font-weight:700;margin:2px 0 6px}
.ph ul{margin:6px 0 0;padding-left:18px;font-size:13.5px;color:var(--text-2)}
.ph.done{border-top:4px solid var(--ok)}
.ph.now{border-top:4px solid var(--lead)}
.ph.next{border-top:4px solid var(--accent)}
.ph.later{border-top:4px solid var(--border-1)}
.dec{background:var(--surface-1);border:1px solid var(--border-2);border-radius:12px;padding:14px 16px;margin-top:12px}
.dec h3{margin:0 0 4px}
.opt{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border-2);border-radius:9px;margin-top:7px;cursor:pointer}
.opt:hover{border-color:var(--border-1)}
.opt.sel{border-color:var(--accent);background:var(--accent-soft)}
.opt input{margin-top:5px;accent-color:var(--accent)}
.opt .rec{font-size:11px;color:var(--ok);font-weight:700;margin-left:6px;text-transform:uppercase/* type-ok: report document design (contract v3), not app UI */}
.opt .def{font-size:11px;color:var(--text-3);font-weight:700;margin-left:6px;text-transform:uppercase/* type-ok: report document design (contract v3), not app UI */}
.dec-note{font-size:12.5px;color:var(--text-2);margin-top:8px;min-height:1em}
.dec-note.err{color:var(--err);font-weight:600}
.kit-kararlar{margin-top:40px}
ul.chk{list-style:none;padding:0;margin:10px 0}
ul.chk li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border-2)}
ul.chk li:last-child{border-bottom:0}
ul.chk li.ok{color:var(--text-3);text-decoration:line-through}
ul.chk input{margin-top:5px;accent-color:var(--ok)}
figure.kanit{margin:14px 0;border:1px solid var(--border-2);border-radius:12px;overflow:hidden;background:var(--surface-1)}
figure.kanit img{display:block;width:100%}
figure.kanit figcaption{font-size:12.5px;color:var(--text-2);padding:8px 12px;border-top:1px solid var(--border-2)}
img[data-kanit]:not(.kanit-hazir){min-height:80px;background:var(--surface-2)}
img.kanit-yok{outline:1px dashed var(--warn)}
@media (max-width:640px){h1{font-size:23px}h2{font-size:19px}body{padding:12px 12px 24px}.toastbox{width:auto;left:10px}}
}
`,r=`function(api){"use strict";
var D=document,data=api.data||{},M=data.metinler||{},KB={},kanitlar={};
(data.kararlar||[]).forEach(function(k){if(k&&k.kimlik)KB[k.kimlik]=k});
function all(r,s){return Array.prototype.slice.call((r||D).querySelectorAll(s))}
function up(el,s){while(el&&el.nodeType===1){if(el.matches(s))return el;el=el.parentElement}return null}
function on(root,type,sel,fn){root=root||D;root.addEventListener(type,function(e){var t=up(e.target,sel);if(t&&(root===D||root.contains(t)))fn.call(t,e,t)})}
function mk(tag,cls,txt){var e=D.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
var temaEl=mk("style");temaEl.id="agentspace-kit-tema";(D.head||D.documentElement).appendChild(temaEl);
function tema(t){if(!t||typeof t!=="object"||!t.degisken)return;var css=":root{";Object.keys(t.degisken).forEach(function(k){var v=String(t.degisken[k]);if(/^--[a-z0-9-]{1,40}$/.test(k)&&/^[#a-zA-Z0-9(),.%\\s-]{1,80}$/.test(v))css+=k+":"+v+" !important;"});temaEl.textContent=css+"color-scheme:"+(t.koyu?"dark":"light")+"}";D.documentElement.setAttribute("data-theme",t.koyu?"dark":"light")}
tema(data.tema);api.on("tema",tema);
/* sekme */
function rootOf(el){return up(el,"[data-kit~=sahne],.stage")||D}
function sekme(root,v){root=root||D;var ps=all(root,"[data-view]");all(root,".tab[data-v]").forEach(function(t){var s=t.getAttribute("data-v")===v;t.classList.toggle("on",s);t.setAttribute("aria-selected",s?"true":"false")});
 if(ps.length)ps.forEach(function(p){p.classList.toggle("on",p.getAttribute("data-view")===v)});else all(root,".view[id^=v-]").forEach(function(p){p.classList.toggle("on",p.id==="v-"+v)});
 root.dispatchEvent(new CustomEvent("kit:sekme",{bubbles:true,detail:{sekme:v}}))}
function tabs(r){all(r,".tab[data-v]").forEach(function(t){t.setAttribute("role","tab");if(!t.hasAttribute("tabindex"))t.setAttribute("tabindex","0");t.setAttribute("aria-selected",t.classList.contains("on")?"true":"false")})}
on(D,"click",".tab[data-v]",function(e,t){sekme(rootOf(t),t.getAttribute("data-v"))});
on(D,"keydown",".tab[data-v],.opt,[data-kit-tik]",function(e,t){if((e.key==="Enter"||e.key===" ")&&e.target===t){e.preventDefault();t.click()}});
/* adım + anlatım */
function adimRoot(el){return up(el,"[data-kit~=adimlar]")||rootOf(el)}
function anlat(root,metin,html){var n=(root||D).querySelector(".narr");if(!n)return;if(html)n.innerHTML=String(metin);else n.textContent=String(metin)}
on(D,"click","[data-adim]",function(e,b){var r=adimRoot(b),t=b.getAttribute("data-anlat");if(t!=null)anlat(r,t);b.classList.add("done");
 var bs=all(r,"[data-adim]"),i=bs.indexOf(b);bs.forEach(function(x){x.classList.remove("pri")});var nx=bs.slice(i+1).filter(function(x){return!x.classList.contains("done")})[0];if(nx)nx.classList.add("pri");
 b.dispatchEvent(new CustomEvent("kit:adim",{bubbles:true,detail:{adim:b.getAttribute("data-adim")}}))});
var snaps=[];
on(D,"click","[data-kit-bastan]",function(e,b){var r=up(b,"[data-kit]");if(!r)return;for(var i=0;i<snaps.length;i++)if(snaps[i][0]===r){r.innerHTML=snaps[i][1];dekor(r);r.dispatchEvent(new CustomEvent("kit:bastan",{bubbles:true}));return}});
/* karar */
function not(box,metin,hata){var n=box.querySelector(".dec-note");if(!n){n=mk("div","dec-note");n.setAttribute("role","status");box.appendChild(n)}n.textContent=metin||"";n.classList.toggle("err",!!hata)}
function isaretle(box,v){all(box,".opt").forEach(function(o){var i=o.querySelector("input[type=radio]");var s=!!i&&i.value===v;o.classList.toggle("sel",s);if(i)i.checked=s})}
function kararCiz(box){var id=box.getAttribute("data-karar")||box.getAttribute("data-k");if(!id||box.hasAttribute("data-kit-karar"))return;box.setAttribute("data-kit-karar",id);box.classList.add("dec");var k=KB[id];
 if(k&&!box.querySelector("input[type=radio]")){if(!box.querySelector("h1,h2,h3,h4"))box.appendChild(mk("h3",null,k.soru));
  k.secenekler.forEach(function(s){var l=mk("label","opt"),i=mk("input"),d=mk("div"),b=mk("b",null,s.anahtar.length<=3?s.anahtar+" \\u00b7 ":""),p=String(s.metin),c=p.indexOf(" \\u2014 ");i.type="radio";i.name="karar-"+id;i.value=s.anahtar;
   b.appendChild(D.createTextNode(c>0?p.slice(0,c):p));d.appendChild(b);if(k.oneri===s.anahtar)d.appendChild(mk("span","rec",M.oneri||""));if(k.varsayilan===s.anahtar&&k.oneri!==s.anahtar)d.appendChild(mk("span","def",M.varsayilan||""));
   if(c>0)d.appendChild(mk("div","hint",p.slice(c+3)));l.appendChild(i);l.appendChild(d);box.appendChild(l)})}
 all(box,"input[type=radio]").forEach(function(i){i.name="karar-"+id});
 var v=k?k.secim:(own(api.st,"karar:"+id)?api.st["karar:"+id]:null);if(v)isaretle(box,v);not(box,v&&k?(M.secimin||"")+" "+v:"")}
function own(o,k){return Object.prototype.hasOwnProperty.call(o,k)}
on(D,"change","[data-kit-karar] input[type=radio]",function(e,i){var box=up(i,"[data-kit-karar]"),id=box.getAttribute("data-kit-karar");isaretle(box,i.value);not(box,M.kaydediliyor);
 api.durum.yaz("karar:"+id,i.value).then(function(){if(!KB[id])not(box,M.kaydedildi)},function(){not(box,M.kaydedilemedi,true)})});
api.on("karar-durum",function(d){if(!d||typeof d!=="object")return;var ks=d.kararlar||{};Object.keys(ks).forEach(function(id){if(!KB[id])return;KB[id].secim=ks[id];all(D,"[data-kit-karar]").forEach(function(b){if(b.getAttribute("data-kit-karar")===id)isaretle(b,ks[id])})});
 if(d.not&&typeof d.not.kimlik==="string")all(D,"[data-kit-karar]").forEach(function(b){if(b.getAttribute("data-kit-karar")===d.not.kimlik)not(b,String(d.not.metin||""),!!d.not.hata)})});
function eksikKararlar(){var bagli={};all(D,"[data-kit-karar]").forEach(function(b){bagli[b.getAttribute("data-kit-karar")]=1});var ek=Object.keys(KB).filter(function(id){return!bagli[id]});if(!ek.length||!D.body)return;
 var s=mk("section","kit-kararlar");s.setAttribute("data-kit-ek","kararlar");s.appendChild(mk("h2",null,M.kararlar||""));ek.forEach(function(id){var b=mk("div","dec");b.setAttribute("data-karar",id);s.appendChild(b);kararCiz(b)});(D.querySelector(".wrap")||D.body).appendChild(s)}
/* kontrol listesi */
function sayac(list,id){var cs=all(list,"input[type=checkbox]"),n=cs.filter(function(c){return c.checked}).length;all(D,"[data-kit-sayac]").forEach(function(e){if(e.getAttribute("data-kit-sayac")===id)e.textContent=n+"/"+cs.length})}
function kontrol(list,li){if(list.hasAttribute("data-kit-hazir"))return;list.setAttribute("data-kit-hazir","1");list.classList.add("chk");var id=list.getAttribute("data-kimlik")||("liste"+(li+1));
 all(list,"li").forEach(function(item,i){var cb=item.querySelector("input[type=checkbox]");if(!cb){cb=mk("input");cb.type="checkbox";item.insertBefore(cb,item.firstChild)}var key="kontrol:"+id+":"+(i+1);
  if(own(api.st,key))cb.checked=api.st[key]==="1";item.classList.toggle("ok",cb.checked);
  cb.addEventListener("change",function(){item.classList.toggle("ok",cb.checked);api.durum.yaz(key,cb.checked?"1":null).catch(function(){});sayac(list,id)})});sayac(list,id)}
/* kanıt karesi */
function kareUygula(ad){var u=kanitlar[ad];all(D,"img[data-kanit]").forEach(function(im){if(im.getAttribute("data-kanit")!==ad)return;if(u===false){im.classList.add("kanit-yok");if(!im.alt)im.alt=M.kanitYok||ad}else if(u){im.src=u;im.classList.add("kanit-hazir")}})}
api.on("kanit",function(d){if(!d||typeof d.ad!=="string")return;if(d.yok){kanitlar[d.ad]=false}else if(d.blob&&typeof Blob!=="undefined"&&d.blob instanceof Blob){if(kanitlar[d.ad])return;kanitlar[d.ad]=URL.createObjectURL(d.blob)}else return;kareUygula(d.ad)});
/* kurulum */
function dekor(r){tabs(r);all(r,"[data-karar],.dec[data-k]").forEach(kararCiz);all(r,"[data-kit~=kontrol]").forEach(kontrol);Object.keys(kanitlar).forEach(kareUygula)}
function kur(){all(D,"[data-kit~=adimlar],[data-kit~=sahne]").forEach(function(r){snaps.push([r,r.innerHTML])});dekor(D);eksikKararlar()}
if(D.readyState==="loading")D.addEventListener("DOMContentLoaded",kur);else kur();
return{surum:1,on:on,sekme:sekme,anlat:anlat,tema:function(){return D.documentElement.getAttribute("data-theme")},kanit:function(ad){return kanitlar[ad]||null}};
}`,s=`
@layer agentspace-kit{
.tasarim{display:block;margin:16px 0;max-width:760px}
.tasarim-kart{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:14px;align-items:start;background:var(--surface-1);border:1px solid var(--border-2);border-radius:12px;padding:12px}
.tasarim-gorsel{display:block;width:100%;aspect-ratio:16/10;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border-2);position:relative}
.tasarim[data-acilir] .tasarim-gorsel{cursor:pointer}
.tasarim[data-acilir] .tasarim-gorsel:hover{border-color:var(--accent)}
.tasarim-gorsel img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
.tasarim-yok{display:flex;align-items:center;justify-content:center;height:100%;padding:12px;text-align:center;font-size:12.5px;color:var(--text-3)}
.tasarim-bilgi{min-width:0;display:flex;flex-direction:column;gap:6px}
.tasarim-baslik{font-weight:700;font-size:15px;line-height:1.3}
.tasarim-rozetler{display:flex;gap:6px;flex-wrap:wrap}
.tasarim-bayat{font-size:12.5px;color:var(--warn);background:var(--warn-soft);border-radius:8px;padding:6px 10px}
.tasarim-ac{align-self:flex-start}
.tasarim-not{font-size:12.5px;color:var(--text-2);min-height:1em}
.tasarim-not.err{color:var(--err);font-weight:600}
.tasarim-alt{grid-column:1/-1;font-size:13px;color:var(--text-2)}
.tasarim-alt:empty{display:none}
@media (max-width:640px){.tasarim-kart{grid-template-columns:1fr}}
}
`,t=`function(api){"use strict";
var k=(${r})(api),D=document,M=(api.data||{}).metinler||{},T={},U={};
function all(s){return Array.prototype.slice.call(D.querySelectorAll(s))}
function mk(tag,cls,txt){var e=D.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function str(v,n){return typeof v==="string"?v.slice(0,n||200):""}
function anahtar(el){var g=(el.getAttribute("data-gorev")||"").trim(),s=(el.getAttribute("data-surum")||"").trim(),b=(el.getAttribute("data-bolge")||"").trim();return g+"@"+(s||"son")+"#"+b}
function kur(el){if(el.hasAttribute("data-kit-tasarim"))return;el.setAttribute("data-kit-tasarim",anahtar(el));el.classList.add("tasarim");
 var alt=mk("div","tasarim-alt");while(el.firstChild)alt.appendChild(el.firstChild);var kart=mk("div","tasarim-kart");
 var g=mk("div","tasarim-gorsel"),bi=mk("div","tasarim-bilgi");kart.appendChild(g);kart.appendChild(bi);kart.appendChild(alt);el.appendChild(kart);ciz(el)}
function ciz(el){var d=T[el.getAttribute("data-kit-tasarim")],kart=el.querySelector(".tasarim-kart");if(!kart)return;var g=kart.querySelector(".tasarim-gorsel"),bi=kart.querySelector(".tasarim-bilgi");
 g.textContent="";bi.textContent="";el.removeAttribute("data-acilir");
 if(!d){el.setAttribute("data-tasarim-durum","bekliyor");g.appendChild(mk("div","tasarim-yok",M.tasarimYukleniyor||""));return}
 el.setAttribute("data-tasarim-durum",d.durum==="hazir"?"hazir":"yok");el.setAttribute("data-tasarim-surum",String(d.surum||""));el.setAttribute("data-tasarim-bayat",d.bayat?"1":"0");
 if(d.url){var im=mk("img");im.alt="";im.src=d.url;g.appendChild(im);el.setAttribute("data-tasarim-kare","1")}else{g.appendChild(mk("div","tasarim-yok",str(d.kareYok,300)));el.setAttribute("data-tasarim-kare","0")}
 bi.appendChild(mk("div","tasarim-baslik",str(d.baslik,160)));var r=mk("div","tasarim-rozetler");(d.rozetler||[]).slice(0,6).forEach(function(x){if(x&&typeof x.metin==="string")r.appendChild(mk("span","pill"+(/^(ok|warn|info|lead)$/.test(x.ton)?" "+x.ton:""),str(x.metin,80)))});bi.appendChild(r);
 if(d.bayat){var b=mk("div","tasarim-bayat",str(d.bayat,200));b.setAttribute("role","note");bi.appendChild(b)}
 if(d.ac){el.setAttribute("data-acilir","1");var btn=mk("button","btn tasarim-ac",str(d.ac,80));btn.type="button";if(d.acAria)btn.setAttribute("aria-label",str(d.acAria,240));bi.appendChild(btn)}
 var n=mk("div","tasarim-not");n.setAttribute("role","status");bi.appendChild(n)}
api.on("tasarim",function(d){if(!d||typeof d.anahtar!=="string")return;var eski=U[d.anahtar];if(d.blob&&typeof Blob!=="undefined"&&d.blob instanceof Blob){d.url=URL.createObjectURL(d.blob)}else d.url=null;
 if(eski)try{URL.revokeObjectURL(eski)}catch(e){}U[d.anahtar]=d.url;T[d.anahtar]=d;all("[data-kit-tasarim]").forEach(function(el){if(el.getAttribute("data-kit-tasarim")===d.anahtar)ciz(el)})});
api.on("tasarim-sonuc",function(d){if(!d||typeof d.anahtar!=="string")return;all("[data-kit-tasarim]").forEach(function(el){if(el.getAttribute("data-kit-tasarim")!==d.anahtar)return;var n=el.querySelector(".tasarim-not");if(n){n.textContent=str(d.metin,200);n.classList.toggle("err",!!d.hata)}})});
function ac(el){if(el&&el.hasAttribute("data-acilir"))api.send({tur:"tasarim-ac",anahtar:el.getAttribute("data-kit-tasarim")})}
D.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;var b=t.closest(".tasarim-ac,.tasarim-gorsel");if(!b)return;ac(b.closest("[data-kit-tasarim]"))});
function kurHepsi(){all("[data-kit~=tasarim]").forEach(kur)}
if(D.readyState==="loading")D.addEventListener("DOMContentLoaded",kurHepsi);else kurHepsi();
var o={};Object.keys(k).forEach(function(n){o[n]=k[n]});o.surum=2;return o;
}`,u="[data-as-kit]",v=`:where(${u})`;function w(a){let b,c=a.trim();if(":root"===c)return v;if("html"===c)return`html${v}`;let d=/^[*:]/.test(c)&&!c.startsWith("*")?`*${c}`:c;return!function(a){let b=0;for(let c of a.trim())if("("===c||"["===c)b++;else if(")"===c||"]"===c)b--;else if(0===b&&/[\s>+~]/.test(c))return!0;return!1}(c)?`${v} ${c}, ${(b=d.indexOf("::"))<0?`${d}${v}`:`${d.slice(0,b)}${v}${d.slice(b)}`}`:`${v} ${c}`}let x=[['var css=":root{";',`var css=${JSON.stringify(u+"{")};`],['D.documentElement.setAttribute("data-theme",','D.documentElement.setAttribute("data-as-tema",'],['return D.documentElement.getAttribute("data-theme")','return D.documentElement.getAttribute("data-as-tema")'],['on(D,"click",".tab[data-v]",',`on(D,"click","${u} .tab[data-v]",`],['on(D,"keydown",".tab[data-v],.opt,[data-kit-tik]",',`on(D,"keydown","${u} .tab[data-v],${u} .opt,[data-kit-tik]",`],['all(r,"[data-karar],.dec[data-k]").forEach(kararCiz)',`all(r,"[data-karar],${u} .dec[data-k]").forEach(kararCiz)`],['box.setAttribute("data-kit-karar",id);','box.setAttribute("data-kit-karar",id);box.setAttribute("data-as-kit","");'],['list.setAttribute("data-kit-hazir","1");','list.setAttribute("data-kit-hazir","1");list.setAttribute("data-as-kit","");'],['s.setAttribute("data-kit-ek","kararlar");','s.setAttribute("data-kit-ek","kararlar");s.setAttribute("data-as-kit","");'],['el.setAttribute("data-kit-tasarim",anahtar(el));','el.setAttribute("data-kit-tasarim",anahtar(el));el.setAttribute("data-as-kit","");'],["o.surum=2;return o;","o.surum=3;return o;"]],y=function a(b){let c="",d=0;for(;d<b.length;){let e=b.indexOf("{",d);if(e<0){c+=b.slice(d);break}let f=b.slice(d,e),g=1,h=e+1;for(;h<b.length&&g;)"{"===b[h]?g++:"}"===b[h]&&g--,h++;let i=b.slice(e+1,h-1),j=f.trim();/^@(layer|media|supports)\b/.test(j)?c+=`${f.replace(/^\s+/,"\n")}{${a(i)}}`:j.startsWith("@")?c+=`${f}{${i}}`:c+=`
${(function(a){let b=[],c=0,d="";for(let e of a)"("===e?c++:")"===e&&c--,","===e&&0===c?(b.push(d),d=""):d+=e;return d.trim()&&b.push(d),b})(f).map(w).join(", ")}{${i}}`,d=h}return c}(q+s),z=function(a){let b=a;for(let[a,c]of x){if(!b.includes(a))throw Error(`kit v3: kaynak değişti (${a.slice(0,40)})`);b=b.split(a).join(c)}return b}(t),A={1:{css:q,js:r},2:{css:q+s,js:t},3:{css:y,js:z}};a.s(["KIT_DEFAULT_PRIMARY",0,2,"KIT_LATEST",0,3,"designRefsOf",0,function(a){let b=new Map;for(let c of String(a??"").matchAll(/<[a-z][a-z0-9-]*\s[^>]*>/gi)){if(b.size>=12)break;let a=c[0],d=p(a,"data-kit");if(!d||!d.split(/\s+/).includes("tasarim"))continue;let e=p(a,"data-gorev")??"",f=p(a,"data-surum"),g=p(a,"data-bolge"),h=f?Number(f):null;if(!n.test(e)||e.includes("..")||null!==h&&!(Number.isInteger(h)&&h>=1&&h<=99999))continue;let i=g&&o.test(g)?g:null;if(g&&!i)continue;let j=`${e}@${h??"son"}#${i??""}`;b.has(j)||b.set(j,{anahtar:j,gorev:e,surum:h,bolge:i})}return[...b.values()]},"kitFor",0,function(a){return A[a]??null},"kitVersionOf",0,function(a,b){let c=/<meta\s+[^>]*name\s*=\s*["']agentspace-kit["'][^>]*>/i.exec(String(a??""));if(!c)return{surum:b,beyan:null};let d=/content\s*=\s*["']?\s*([^"'\s>]*)/i.exec(c[0]),e=d?d[1]:"";if("0"===e||/^(yok|none|off)$/i.test(e))return{surum:0,beyan:e};let f=Number(e);return Number.isInteger(f)&&f>=1&&f<=3?{surum:f,beyan:e}:{surum:3,beyan:e}},"rewriteEvidenceRefs",0,function(a){let b=new Set,c=a=>{let c=a.trim();m.test(c)&&b.size<40&&b.add(c)},d=String(a??"").replace(/\bsrc\s*=\s*(["'])kan[ıi]t:([^"']{1,200})\1/gi,(a,b,d)=>(c(d),`data-kanit="${d.replace(/"/g,"")}"`));for(let a of d.matchAll(/\bdata-kanit\s*=\s*(["'])([^"']{1,200})\1/gi))c(a[2]);return{html:d,adlar:[...b]}},"themeCss",0,function(a){if(!a)return"";let b=":root{";for(let[c,d]of Object.entries(a.degisken))/^--[a-z0-9-]{1,40}$/.test(c)&&l.test(d)&&(b+=`${c}:${d} !important;`);return`${b}color-scheme:${a.koyu?"dark":"light"}}`},"themeFromTokens",0,function(a,b){let c={};for(let b of k){let d=String(a(`--${b}`)??"").trim();d&&l.test(d)&&(c[`--${b}`]=d)}return{koyu:b,degisken:c}}],2016118)}];

//# sourceMappingURL=src_components_rich_blocks_cage_ts_0-z0v93._.js.map