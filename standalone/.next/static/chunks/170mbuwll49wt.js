(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,27642,e=>{"use strict";let t=["claude","codex","copilot","goose","droid","gemini","qwen","opencode","amp","cursor","kimi","crush","antigravity","muse","jev"],r="claude";function n(e){return"string"==typeof e&&t.includes(e)}let i=new Set,o={claude:"Task",codex:"multi_agent",copilot:null,goose:"summon",droid:"task-cli",gemini:"invoke_agent",qwen:"agent",opencode:"task",amp:"Task",cursor:null,kimi:"Agent",crush:"agent",antigravity:"invoke_subagent",muse:null};e.s(["DEFAULT_ENGINE",0,r,"ENGINES",0,t,"ENGINE_LABELS",0,{claude:"Claude Code",codex:"Codex",copilot:"GitHub Copilot CLI",goose:"Goose",droid:"Droid (Factory)",gemini:"Gemini CLI",qwen:"Qwen Code",opencode:"OpenCode",amp:"Amp",cursor:"Cursor CLI",kimi:"Kimi Code (motor)",crush:"Crush",antigravity:"Antigravity CLI",muse:"Muse Code"},"engineToCommand",0,function(e){switch(e){case"claude":return"claude";case"codex":return"codex";case"copilot":return"copilot";case"goose":return"goose";case"droid":return"droid";case"gemini":return"gemini";case"qwen":return"qwen";case"opencode":return"opencode";case"amp":return"amp";case"cursor":return"cursor";case"kimi":return"kimi";case"crush":return"crush";case"antigravity":return"antigravity";case"muse":return"muse"}},"isEngine",0,n,"subagentToolName",0,function(e){return n(e)?o[e]:null},"toEngine",0,function(e,t){var o,a;let l;return n(e)?e:("string"==typeof e&&e.trim()&&(o=e.trim(),a=t,l=`${a??""}::${o}`,!i.has(l)&&(i.add(l),"u">typeof console&&"function"==typeof console.warn&&console.warn(`[engines] tanınmayan motor "${o}"${a?` (${a})`:""} → "${r}" ile koşuluyor. ENGINES listesine ekle + migration CHECK'lerini g\xfcncelle.`))),r)}])},979370,e=>{"use strict";e.s(["getFileApi",0,function(){return window.fileApi??null}])},523386,33993,471296,e=>{"use strict";var t=e.i(9856),r=e.i(406967),n=e.i(185338);function i(){return window.paneViewApi??null}e.s(["getPaneViewApi",0,i],33993);let o="crewpane:reader-attach";function a(e,t){e&&t&&window.dispatchEvent(new CustomEvent(o,{detail:{paneId:e,text:t}}))}async function l(e,n,i,o={}){let a=o.sleep??c,s=o.submitDelayMs??400,u="system"===o.origin?{origin:"system"}:void 0;if(s>0)e.write(n,(0,t.bracketIfMultiline)((0,t.stripTrailingEol)((0,t.normalizeEol)(i))),u),await a(s),e.write(n,"\r",u),!1!==o.verifySubmit&&"function"==typeof e.attach&&await (0,r.verifyAndRetrySubmit)(n,{readPane:async t=>{let r=await e.attach(t);return r?.ok&&r.buffer||""},write:(t,r)=>e.write(t,r,u),sleep:a,log:e=>console.info(e)}).then(o.onVerify??(()=>{}));else{var d;e.write(n,(d=(0,t.normalizeEol)(i),/[\r\n]$/.test(d)?d:d+"\r"),u)}}function s(e,r,n){e.write(r,(0,t.bracketIfMultiline)((0,t.stripTrailingEol)((0,t.normalizeEol)(n))))}async function u(e,t,o){let l=i();if(l)try{if((await l.get(t))?.readable)return a(t,o),"reader"}catch{}let u=!1;if("function"==typeof e.attach)try{var c;let i=await e.attach(t);c=i?.ok&&i.buffer||"",u="string"==typeof c&&!!c&&("text"===(0,n.composerScan)(c)||(0,r.unsentPasteChip)(c))}catch{}return s(e,t,u?`
${o}`:o),u?"appended":"inserted"}function c(e){return new Promise(t=>setTimeout(t,e))}async function d(e,t,r,n){let i=[];try{i=await e.list(r)}catch{return{pane:null,liveCount:0}}return{pane:n?i.find(e=>e.paneId===n&&e.agentId===t)??null:i.find(e=>e.agentId===t)??null,liveCount:i.length}}async function p(e,t,n={}){let i,o;if(!e)return{ok:!1,paneId:null,spawned:!1,reason:"no-agent"};let a=t.trim();if(!a)return{ok:!1,paneId:null,spawned:!1,reason:"empty"};let s=n.api??window.ptyApi??null;if(!s)return{ok:!1,paneId:null,spawned:!1,reason:"no-pty"};let g=n.sleep??c,f=n.signal??null,y=f?e=>{var t,r,n;return t=g,r=e,(n=f).aborted?Promise.resolve():new Promise(e=>{let i=()=>e();n.addEventListener("abort",i,{once:!0}),t(r).then(()=>{n.removeEventListener("abort",i),e()},()=>{n.removeEventListener("abort",i),e()})})}:g,h=n.now??Date.now,w=n.waitForPaneMs??1500,v=Math.max(1,n.pollIntervalMs??150),b=(n.command??"claude")!=="shell",k=n.engineReadyMs??9e3,S=n.submitDelayMs??400*!!b,C=await d(s,e,n.department,n.paneId),L=0;for(;!C.pane&&L<w;)await y(v),L+=v,C=await d(s,e,n.department,n.paneId);let x=C.pane,P=C.liveCount;if(f&&f.aborted)return{ok:!1,paneId:null,spawned:!1,reason:"cancelled"};if(!x&&n.paneId)return{ok:!1,paneId:null,spawned:!1,reason:"pane-gone",detail:n.paneId};let I=!1;if(x)i=x.paneId,o=x.startedAt;else try{i=(await s.spawn({command:n.command??"claude",...b&&n.model?{model:n.model}:{},...b&&n.effort?{effort:n.effort}:{},...b&&n.provider&&n.model?{provider:n.provider}:{},agentId:e,department:n.department,label:n.label??e,cwd:n.cwd,...b&&n.systemPrompt?{systemPrompt:n.systemPrompt}:{},...b&&n.role?{role:n.role}:{},...b&&n.plain?{plain:!0}:{},...n.images&&n.images.length?{images:n.images}:{}})).paneId,I=!0,o=h()}catch(e){return{ok:!1,paneId:null,spawned:!1,reason:"spawn-failed",detail:m(e)}}if(b&&k>0){let e=k-(h()-o);e>0&&await y(e)}if(f&&f.aborted)return{ok:!1,paneId:i,spawned:I,reason:"cancelled"};try{if(!1===n.submit)return await u(s,i,a),{ok:!0,paneId:i,spawned:I};await l(s,i,a,{submitDelayMs:(0,r.submitGapForLoad)(P,S),sleep:y,origin:n.origin})}catch(e){return{ok:!1,paneId:i,spawned:I,reason:"write-failed",detail:m(e)}}return{ok:!0,paneId:i,spawned:I}}function m(e){return String(e?.message??e)}e.s(["emitReaderAttach",0,a,"onReaderAttach",0,function(e,t){if(!e)return()=>{};let r=r=>{let n=r.detail;n&&n.paneId===e&&n.text&&t(n.text)};return window.addEventListener(o,r),()=>window.removeEventListener(o,r)}],471296),e.s(["pasteToPane",0,s,"sendCommandToAgent",0,p,"submitToPane",0,l],523386)},549358,e=>{"use strict";function t(){return window.ptyApi??null}e.s(["getPtyApi",0,t,"hasPtySupport",0,function(){return null!==t()}])},283267,109720,e=>{"use strict";var t=e.i(27642);let r="application/x-crewpane-screenshot";function n(e){return/\.(png|jpe?g|gif|webp|bmp)$/i.test((e||"").trim())}async function i(e,t={}){if(!e)return[];try{let t=e.getData(r);if(t&&t.trim())return[t.trim()]}catch{}let o=e.files;if(o&&o.length){let e=[],r=Math.min(o.length,25);for(let i=0;i<r;i++){let r=o[i];if(!r)continue;if(t.isRealFile){let e=!0;try{e=await t.isRealFile(r)}catch{e=!0}if(!e)continue}let a=null;if("string"==typeof r.path&&r.path.trim()&&(a=r.path.trim()),!a&&t.getPath)try{let e=t.getPath(r);e&&e.trim()&&(a=e.trim())}catch{a=null}if(!a&&t.saveImage&&r&&("string"==typeof r.type&&r.type.startsWith("image/")||"string"==typeof r.name&&n(r.name)))try{let e=await t.saveImage(r);e&&e.trim()&&(a=e.trim())}catch{}a&&!e.includes(a)&&e.push(a)}if(e.length)return e}try{let t=e.getData("text/plain");if(t&&t.trim()&&n(t))return[t.trim()]}catch{}return[]}function o(e){return e.map(e=>e.trim()).filter(Boolean).map(e=>/\s/.test(e)?`"${e.replace(/"/g,'\\"')}"`:e).join(" ")}e.s(["formatPathsForPrompt",0,o,"isImagePath",0,n,"isScreenshotDragType",0,function(e){return!!e&&(e.includes(r)||e.includes("Files"))},"resolveDroppedPaths",0,i],109720);let a={claude:{imageSupport:!0},codex:{imageSupport:!0},copilot:{imageSupport:!1},goose:{imageSupport:!1},droid:{imageSupport:!1},gemini:{imageSupport:!1},qwen:{imageSupport:!1},opencode:{imageSupport:!1},amp:{imageSupport:!1},cursor:{imageSupport:!1},kimi:{imageSupport:!1},crush:{imageSupport:!1},antigravity:{imageSupport:!1},muse:{imageSupport:!1}};function l(e){return a[e]?.imageSupport??!1}function s(e){return!!e&&"string"==typeof e.type&&e.type.startsWith("image/")}async function u(e,t={}){let r=e.filter(e=>"string"==typeof e&&e.trim());if(!r.length)return{missing:[]};let n=c(t.api);if(!n||"function"!=typeof n.verify)return{missing:[]};try{let e=await n.verify(r);return{missing:Array.isArray(e?.missing)?e.missing:[]}}catch{return{missing:[]}}}function c(e){return e||(window.imageApi??null)}async function d(e,t={}){let r,n,i;if(!s(e))return{ok:!1,reason:"not-an-image"};let o=c(t.api);if(!o)return{ok:!1,reason:"no-bridge"};try{r=await e.arrayBuffer()}catch(e){return{ok:!1,reason:"save-failed",detail:String(e?.message??e)}}if(0===r.byteLength)return{ok:!1,reason:"empty"};let a=e.name&&e.name.trim()||"pasted-image";try{n=await o.saveTemp({data:r,type:e.type,name:a})}catch(e){return{ok:!1,reason:"save-failed",detail:String(e?.message??e)}}if(!n?.ok||!n.path)return{ok:!1,reason:"save-failed",detail:n?.reason??n?.detail};if(!1!==t.makePreview&&"u">typeof URL&&"function"==typeof URL.createObjectURL)try{i=URL.createObjectURL(e)}catch{}return{ok:!0,image:{path:n.path,name:a,previewUrl:i,bytes:n.bytes}}}e.s(["composePromptWithImages",0,function(e,t){let r=o(t);return[e.trim(),r].filter(Boolean).join(" ")},"imageSupportedForCommand",0,function(e){return!(0,t.isEngine)(e)||l(e)},"imageSupportedForEngine",0,l,"isImageFile",0,s,"saveImageToTemp",0,d,"verifyImagePaths",0,u],283267)},752010,e=>{"use strict";e.s(["getDesignWindowApi",0,function(){return window.designApi??null}])},417041,e=>{"use strict";let t="__ADP094_PICK__";function r(e){return e.replace(/\s+/g," ").trim()}function n(e,t){return e.length>t?e.slice(0,t)+"…":e}e.s(["PICK_PREFIX",0,t,"buildPickerPrompt",0,function(e,t){return r([`Bu sayfa elementiyle ilgilen — se\xe7ici: ${e.cssSelector}`,e.tag?`etiket: <${e.tag}>`:"",e.textContent?`metin: "${e.textContent}"`:"",`konum: ${Math.round(e.box.x)},${Math.round(e.box.y)} ${Math.round(e.box.width)}\xd7${Math.round(e.box.height)}`,e.outerHTML?`html: ${e.outerHTML}`:"",e.url?`sayfa: ${e.url}`:""].filter(Boolean).join(" | "))+(t&&t.trim()?" "+t.trim():"")},"parsePickMessage",0,function(e){let i;if("string"!=typeof e)return null;let o=e.indexOf(t);if(o<0)return null;let a=e.slice(o+t.length).trim();try{i=JSON.parse(a)}catch{return null}if(!i||"object"!=typeof i)return null;let l=i,s=l.box??{},u=e=>"number"==typeof e&&isFinite(e)?e:0,c=e=>"string"==typeof e?e:"",d=c(l.cssSelector);return d?{cssSelector:d,outerHTML:n(r(c(l.outerHTML)),400),textContent:n(r(c(l.textContent)),160),box:{x:u(s.x),y:u(s.y),width:u(s.width),height:u(s.height)},url:c(l.url),tag:c(l.tag).toLowerCase(),region:r(c(l.region)),regionTag:c(l.regionTag).toLowerCase(),regionOuterHTML:n(r(c(l.regionOuterHTML)),1200),loc:r(c(l.loc)),regionLoc:r(c(l.regionLoc))}:null},"pickerScript",0,function(e){let r=e?.borderColor?.trim()||"#38bdf8",n=e?.bgColor?.trim()||"rgba(56,189,248,0.15)";return`(() => {
  var PREFIX = ${JSON.stringify(t)};
  var FLAG = ${JSON.stringify("__adp094PickerOn")};
  var HTML_CAP = 400;
  var TEXT_CAP = 160;
  var REGION_HTML_CAP = 1200;
  if (window[FLAG]) return 'already-armed';
  window[FLAG] = true;

  var overlay = document.createElement('div');
  overlay.setAttribute('data-adp094-overlay', '');
  var s = overlay.style;
  s.position = 'fixed'; s.zIndex = '2147483647'; s.pointerEvents = 'none';
  s.border = '2px solid ' + ${JSON.stringify(r)}; s.background = ${JSON.stringify(n)};
  s.borderRadius = '2px'; s.boxShadow = '0 0 0 1px rgba(0,0,0,0.4)';
  s.transition = 'all 40ms linear'; s.display = 'none';
  s.top = '0'; s.left = '0'; s.width = '0'; s.height = '0';
  (document.body || document.documentElement).appendChild(overlay);

  function place(el) {
    if (!el || el === overlay) { s.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    s.display = 'block';
    s.top = r.top + 'px'; s.left = r.left + 'px';
    s.width = r.width + 'px'; s.height = r.height + 'px';
  }

  // Best-effort unique CSS selector: prefer #id, else an nth-of-type path up to <body>.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id)); break; }
      var idx = 1, sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx++;
      }
      var nth = ':nth-of-type(' + idx + ')';
      parts.unshift(tag + nth);
      node = node.parentElement;
      if (parts.length > 6) break;
    }
    return parts.join(' > ');
  }

  function onMove(e) {
    var el = e.target;
    if (el && el !== overlay) place(el);
  }

  function onClick(e) {
    var el = e.target;
    if (!el || el === overlay) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    var r = el.getBoundingClientRect();
    var html = '';
    try { html = (el.outerHTML || '').slice(0, HTML_CAP); } catch (_) {}
    var text = '';
    try { text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, TEXT_CAP); } catch (_) {}
    // AUID-M1 — artboard modu: tıklanan elementi KAPSAYAN data-region bloğunu bul.
    // Normal bir sayfada closest() null d\xf6ner → alanlar boş kalır, akış değişmez.
    var region = '', regionTag = '', regionHtml = '';
    try {
      var host = el.closest ? el.closest('[data-region]') : null;
      if (host) {
        region = (host.getAttribute('data-region') || '').trim();
        regionTag = (host.tagName || '').toLowerCase();
        regionHtml = (host.outerHTML || '').slice(0, REGION_HTML_CAP);
      }
    } catch (_) {}
    // AUID-M2 — ADRES (dosya:satır:s\xfctun). Yalnız ENSTR\xdcMANLI y\xfczeyde vardır;
    // normal bir sayfada \xf6znitelik yoktur, alanlar boş kalır ve akış değişmez.
    var loc = '', regionLoc = '';
    try {
      var locHost = el.closest ? el.closest('[data-loc]') : null;
      if (locHost) loc = (locHost.getAttribute('data-loc') || '').trim();
      var regionLocHost = el.closest ? el.closest('[data-region][data-loc]') : null;
      if (regionLocHost) regionLoc = (regionLocHost.getAttribute('data-loc') || '').trim();
    } catch (_) {}
    var payload = {
      cssSelector: selectorFor(el),
      outerHTML: html,
      textContent: text,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      url: location.href,
      tag: (el.tagName || '').toLowerCase(),
      region: region,
      regionTag: regionTag,
      regionOuterHTML: regionHtml,
      loc: loc,
      regionLoc: regionLoc
    };
    try { console.log(PREFIX + JSON.stringify(payload)); } catch (_) {}
    stop();
  }

  function stop() {
    try { document.removeEventListener('mousemove', onMove, true); } catch (_) {}
    try { document.removeEventListener('click', onClick, true); } catch (_) {}
    try { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (_) {}
    window[FLAG] = false;
    try { delete window.__adp094PickerStop; } catch (_) {}
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  window.__adp094PickerStop = stop;
  return 'armed';
})();`},"pickerStopScript",0,function(){return"(() => { try { if (window.__adp094PickerStop) window.__adp094PickerStop(); } catch (e) {} return 'stopped'; })();"}])}]);

//# sourceMappingURL=0ro45rdborq62.js.map