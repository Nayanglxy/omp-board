var ID = location.pathname.split('/').pop();
var BT = String.fromCharCode(96);
var comments = new Map();        // cid -> {turn, quote|null, ref, text}
var seenArt = new Set();
var turnsLen = -1, running = false, sess = null, pendingSel = null, qid = 0;
var figs=[], figMap={}, figSig=''; var IMGX=/^(png|webp|jpg|jpeg|gif|svg)$/;
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function when(ts){ try{ return new Date(ts).toLocaleString(); }catch(e){ return ts||''; } }
function kfmt(n){ return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }

/* ---- rich rendering helpers: KaTeX math, highlighted code, inline SVG, file chips ---- */
var _texCache=new Map(), _hlCache=new Map();
function tex(src, display){
  var key=(display?'D':'I')+src, hit=_texCache.get(key); if(hit!==undefined) return hit;
  var h;
  try{ h = window.katex ? katex.renderToString(src,{displayMode:display,throwOnError:false,strict:'ignore',trust:false,output:'htmlAndMathml'}) : null; }catch(e){ h=null; }
  if(h===null) h = display ? '<pre class="code"><code>'+esc(src)+'</code></pre>' : '<code>'+esc(src)+'</code>';
  if(display) h='<div class="mathd">'+h+'</div>';
  _texCache.set(key,h); return h;
}
var EXT_LANG={py:'python',js:'javascript',mjs:'javascript',ts:'typescript',tsx:'typescript',sh:'bash',yml:'yaml',yaml:'yaml',json:'json',jsonl:'json',sql:'sql',toml:'ini',ini:'ini',css:'css',html:'xml',diff:'diff',patch:'diff',go:'go',rs:'rust',r:'r',md:'markdown'};
function hl(code, lang){
  var key=lang+'\u0001'+code, hit=_hlCache.get(key); if(hit) return hit;
  var out={html:esc(code), lang:lang||''};
  try{
    if(window.hljs){
      if(lang && hljs.getLanguage(lang)) out.html=hljs.highlight(code,{language:lang,ignoreIllegals:true}).value;
      else if(!lang && code.length<5000){ var r=hljs.highlightAuto(code); if(r.language && r.relevance>=5){ out.html=r.value; out.lang=r.language; } }
    }
  }catch(e){}
  _hlCache.set(key,out); return out;
}
function codeBlock(code, lang){
  var h=hl(code, lang);
  return '<div class="cblk"><div class="chd"><span class="clang">'+esc(h.lang||'text')+'</span><button class="ccopy" type="button">copy</button></div>'
    + '<pre class="code"><code class="hljs">'+h.html+'</code></pre></div>';
}
// agent-drawn ```svg: parsed + stripped of anything active, then inlined so it
// inherits the theme vars (--fg, --accent, --c1..) like the omp terminal render
function svgSafe(src){
  try{
    var doc=new DOMParser().parseFromString(src,'image/svg+xml'), root=doc.documentElement;
    if(!root || root.nodeName.toLowerCase()!=='svg' || doc.getElementsByTagName('parsererror').length) return null;
    root.querySelectorAll('script,foreignObject,iframe,object,embed,animate,set,animateTransform,animateMotion,a').forEach(function(n){ n.remove(); });
    var extUrl=/url\(\s*['"]?(?!#)|@import|javascript:/i;
    root.querySelectorAll('style').forEach(function(s){ if(extUrl.test(s.textContent)) s.remove(); });
    [root].concat([].slice.call(root.querySelectorAll('*'))).forEach(function(el){
      [].slice.call(el.attributes).forEach(function(a){ var n=a.name.toLowerCase(), v=String(a.value).trim();
        if(n.indexOf('on')===0 || ((n==='href'||n==='xlink:href'||n==='src') && v.charAt(0)!=='#') || extUrl.test(v)) el.removeAttribute(a.name); }); });
    return new XMLSerializer().serializeToString(root);
  }catch(e){ return null; }
}
// local files the agent mentions: images become inline figures, everything else a chip
var FILE_EXT='png|webp|jpe?g|gif|svg|md|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|sql|py|sh|m?js|tsx?|css|html|diff|patch|r|go|rs';
var reFilePath=new RegExp('^(?:~\\/|\\/|\\.{1,2}\\/)?[\\w.@+\\-]+(?:\\/[\\w.@+\\-]+)*\\.(?:'+FILE_EXT+')$','i');
var reBarePath=new RegExp('(^|[\\s(\\[])((?:~\\/|\\/)[\\w.@+\\-\\/]*[\\w@+\\-]\\.(?:'+FILE_EXT+'))(?=$|[\\s),.;:!?\\]])','gi');
var mdImgs=[];  // image paths seen while rendering the current response (shown as a figure strip)
function isImgPath(p){ return IMGX.test((String(p).split('.').pop()||'').toLowerCase()); }
function fileUrl(p){ return '/api/file/'+ID+'?path='+encodeURIComponent(p); }
function fileChip(p, label){
  var name=label||String(p).split('/').pop(); var img=isImgPath(p);
  if(img && mdImgs.indexOf(p)<0) mdImgs.push(p);
  return '<a class="fchip'+(img?' img':'')+'" href="#" data-fpath="'+esc(p)+'" title="'+esc(p)+'"><span class="fic">'+(img?'&#128444;':'&#128196;')+'</span>'+esc(name)+'</a>';
}
function figTag(src, cap){ return '<figure class="fig"><img loading="lazy" src="'+esc(src)+'" alt="'+esc(cap)+'" onerror="this.closest(\'.fig\').classList.add(\'broken\')"><figcaption><span class="fcap">'+esc(cap)+'</span></figcaption></figure>'; }
function takeImgs(){ var a=mdImgs; mdImgs=[]; return a.length ? '<div class="figs">'+a.map(function(p){ return figTag(fileUrl(p), String(p).split('/').pop()); }).join('')+'</div>' : ''; }
function imgSrc(b){ return b.hash ? '/api/blob/'+ID+'/'+b.hash : 'data:'+b.mime+';base64,'+b.data; }

/* ---- markdown -> html (headings, lists, tables, code, math, links, images, files, quotes, rules) ---- */
var reMathEnv=/^\s*\\begin\{(equation|align|gather|multline|eqnarray|split|cases|aligned|matrix|pmatrix|bmatrix)\*?\}/;
function md(src){
  var lines = String(src==null?'':src).replace(/\r\n?/g,'\n').split('\n');
  var out=[], i=0, FENCE=BT+BT+BT;
  function splitRow(r){ var x=r.trim(); if(x.charAt(0)==='|')x=x.slice(1); if(x.charAt(x.length-1)==='|')x=x.slice(0,-1); return x.split('|').map(function(c){return c.trim();}); }
  function isSep(r){ return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(r) && r.indexOf('-')>=0; }
  function inl(x, br){
    // stash everything that must not see markdown/escaping (code, math, media), restore last
    var stash=[]; function put(h){ stash.push(h); return '\u0000'+(stash.length-1)+'\u0000'; }
    x = String(x).replace(/\u0000/g,'');
    x = x.replace(new RegExp(BT+'([^'+BT+'\\n]+)'+BT,'g'), function(_,c){ return put(reFilePath.test(c.trim()) && c.indexOf('/')>=0 ? fileChip(c.trim()) : '<code>'+esc(c)+'</code>'); });
    x = x.replace(/\\\$/g, function(){ return put('$'); });
    x = x.replace(/\$\$([\s\S]+?)\$\$/g, function(_,m){ return put(tex(m.trim(),true)); });
    x = x.replace(/\\\[([\s\S]+?)\\\]/g, function(_,m){ return put(tex(m.trim(),true)); });
    x = x.replace(/\\\(([\s\S]+?)\\\)/g, function(_,m){ return put(tex(m.trim(),false)); });
    // $...$: no space just inside the delimiters and no digit/word right after the
    // closing one, so prices like "$5 and $10" stay text
    x = x.replace(/(^|[^\w$\\])\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?![\w$])/g, function(_,p,m){ return p+put(tex(m,false)); });
    x = x.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function(_,alt,u){ if(/^https?:\/\//.test(u)) return put('<img class="mdimg" loading="lazy" src="'+esc(u)+'" alt="'+esc(alt)+'">'); if(isImgPath(u)){ if(mdImgs.indexOf(u)<0) mdImgs.push(u); return put(fileChip(u, alt||null)); } return _; });
    x = x.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(_,t,u){ return (!/^[a-z]+:/i.test(u) && reFilePath.test(u)) ? put(fileChip(u, t)) : _; });
    x = x.replace(reBarePath, function(_,p,path){ return p+put(fileChip(path)); });
    x = esc(x);
    x = x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    x = x.replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
    x = x.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g,'$1<em>$2</em>');
    x = x.replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>');
    x = x.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    x = x.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, function(m,p,u){ return p+'<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>'; });
    if(br) x = x.replace(/\n/g,'<br>');
    return x.replace(/\u0000(\d+)\u0000/g, function(_,n){ return stash[+n]; });
  }
  var reItem=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  function indentOf(s){ return s.length - s.replace(/^\s+/,'').length; }
  function buildList(region){
    var frames=[], roots=[];
    function cur(){ return frames[frames.length-1]; }
    region.forEach(function(raw){
      if(raw.trim()==='') return;
      var mi=reItem.exec(raw);
      if(mi){
        var indent=mi[1].length, ord=/\d/.test(mi[2]), text=mi[3];
        while(frames.length && indent<cur().indent) frames.pop();
        if(!frames.length){ var f={indent:indent,ord:ord,items:[]}; frames.push(f); roots.push(f); }
        else if(indent>cur().indent){ var parent=cur().items[cur().items.length-1]; var nf={indent:indent,ord:ord,items:[]}; parent.children.push(nf); frames.push(nf); }
        cur().items.push({text:text, children:[]});
      } else { var it=cur()&&cur().items[cur().items.length-1]; if(it) it.text += ' '+raw.trim(); }
    });
    function item(t){ var tm=/^\[( |x|X)\]\s+/.exec(t); return tm ? '<span class="tick">'+(tm[1]===' '?'&#9744;':'&#9745;')+'</span> '+inl(t.slice(tm[0].length)) : inl(t); }
    function render(frame){ var tag=frame.ord?'ol':'ul';
      return '<'+tag+'>'+frame.items.map(function(it){ return '<li>'+item(it.text)+it.children.map(render).join('')+'</li>'; }).join('')+'</'+tag+'>'; }
    return roots.map(render).join('');
  }
  function parseList(start){
    var m0=reItem.exec(lines[start]), base=m0[1].length, j=start, region=[];
    while(j<lines.length){
      var ln2=lines[j];
      if(ln2.trim()===''){ var k=j; while(k<lines.length && lines[k].trim()==='') k++;
        if(k<lines.length){ var mm=reItem.exec(lines[k]);
          if((mm && mm[1].length>=base) || (indentOf(lines[k])>base && !/^#{1,6}\s/.test(lines[k].trim()))){ region.push(''); j++; continue; } }
        break; }
      var mi=reItem.exec(ln2);
      if(mi){ if(mi[1].length<base) break; region.push(ln2); j++; continue; }
      if(indentOf(ln2)>base){ region.push(ln2); j++; continue; }
      break;
    }
    return { html: buildList(region), next:j };
  }
  function isMathOpen(s){ var t=s.trim(); return t.slice(0,2)==='$$' || t.slice(0,2)==='\\[' || reMathEnv.test(t); }
  // display math block: $$…$$ / \[…\] / \begin{env}…\end{env}, possibly multi-line
  function parseMath(start){
    var t=lines[start].trim(), j=start, buf=[];
    var env=reMathEnv.exec(t), close = env ? null : (t.slice(0,2)==='$$' ? '$$' : '\\]');
    if(env){ var endRe=new RegExp('\\\\end\\{'+env[1]+'\\*?\\}');
      while(j<lines.length){ buf.push(lines[j]); if(endRe.test(lines[j])){ j++; break; } j++; }
      return { html: tex(buf.join('\n'), true), next:j }; }
    var first=t.slice(2);
    if(first.indexOf(close)>=0){ var body=first.slice(0, first.indexOf(close)); var after=first.slice(first.indexOf(close)+2).trim(); return { html: tex(body.trim(), true)+(after?'<p>'+inl(after)+'</p>':''), next:start+1 }; }
    buf.push(first); j++;
    while(j<lines.length){ var L=lines[j]; var k=L.indexOf(close); if(k>=0){ buf.push(L.slice(0,k)); j++; break; } buf.push(L); j++; }
    return { html: tex(buf.join('\n').trim(), true), next:j };
  }
  while(i<lines.length){
    var ln=lines[i];
    if(ln.trim().slice(0,3)===FENCE){
      var lang=ln.trim().slice(3).trim().split(/\s+/)[0].toLowerCase(), buf=[]; i++;
      while(i<lines.length && lines[i].trim().slice(0,3)!==FENCE){ buf.push(lines[i]); i++; } i++;
      var code=buf.join('\n');
      if(lang==='math') out.push(tex(code, true));
      else if(lang==='svg'){ var sv=svgSafe(code); out.push(sv ? '<div class="svgw">'+sv+'</div>' : codeBlock(code,'xml')); }
      else out.push(codeBlock(code, lang));
      continue;
    }
    if(isMathOpen(ln)){ var mb=parseMath(i); out.push(mb.html); i=mb.next; continue; }
    if(ln.indexOf('|')>=0 && i+1<lines.length && isSep(lines[i+1])){
      var head=splitRow(ln);
      var al=splitRow(lines[i+1]).map(function(c){ var L=c.charAt(0)===':', R=c.charAt(c.length-1)===':'; return (L&&R)?'center':R?'right':L?'left':''; });
      i+=2; var rows=[];
      while(i<lines.length && lines[i].indexOf('|')>=0 && lines[i].trim()!==''){ rows.push(splitRow(lines[i])); i++; }
      var th='<tr>'+head.map(function(c,k){ return '<th'+(al[k]?' style="text-align:'+al[k]+'"':'')+'>'+inl(c)+'</th>'; }).join('')+'</tr>';
      var tb=rows.map(function(r){ return '<tr>'+head.map(function(_,k){ return '<td'+(al[k]?' style="text-align:'+al[k]+'"':'')+'>'+inl(r[k]||'')+'</td>'; }).join('')+'</tr>'; }).join('');
      out.push('<table><thead>'+th+'</thead><tbody>'+tb+'</tbody></table>'); continue;
    }
    var hm=/^(#{1,6})\s+(.*)$/.exec(ln); if(hm){ var lv=hm[1].length; out.push('<h'+lv+' class="mdh">'+inl(hm[2])+'</h'+lv+'>'); i++; continue; }
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)){ out.push('<hr>'); i++; continue; }
    if(/^\s*>\s?/.test(ln)){ var qb=[]; while(i<lines.length && /^\s*>\s?/.test(lines[i])){ qb.push(lines[i].replace(/^\s*>\s?/,'')); i++; } out.push('<blockquote>'+md(qb.join('\n'))+'</blockquote>'); continue; }
    if(reItem.test(ln)){ var lb=parseList(i); out.push(lb.html); i=lb.next; continue; }
    if(ln.trim()===''){ i++; continue; }
    var para=[ln]; i++;
    while(i<lines.length){ var nx=lines[i];
      if(nx.trim()==='') break;
      if(nx.trim().slice(0,3)===FENCE) break;
      if(isMathOpen(nx)) break;
      if(/^#{1,6}\s/.test(nx)) break;
      if(/^\s*>\s?/.test(nx)) break;
      if(/^\s*([-*+]|\d+[.)])\s+/.test(nx)) break;
      if(nx.indexOf('|')>=0 && i+1<lines.length && isSep(lines[i+1])) break;
      para.push(nx); i++; }
    out.push('<p>'+inl(para.join('\n'), true)+'</p>');
  }
  return out.join('');
}
function hasTable(s){ var L=String(s).split('\n'); for(var i=0;i+1<L.length;i++){ if(L[i].indexOf('|')>=0 && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(L[i+1]) && L[i+1].indexOf('-')>=0) return true; } return false; }

function header(task){
  document.title = task.title || 'task';
  var h1=document.getElementById('title');
  if(document.activeElement!==h1) h1.textContent = task.title || '(untitled)';
  h1.dataset.saved = task.title || '';
  if(!h1.dataset.wired){ h1.dataset.wired='1'; h1.contentEditable='plaintext-only'; h1.title='click to rename';
    h1.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); h1.blur(); } if(e.key==='Escape'){ h1.textContent=h1.dataset.saved; h1.blur(); } });
    h1.addEventListener('blur',function(){ var v=h1.textContent.trim(); if(!v){ h1.textContent=h1.dataset.saved; return; } if(v===h1.dataset.saved) return; h1.dataset.saved=v; document.title=v; fetch('/api/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edits:[{op:'update',id:ID,title:v}]})}).catch(function(){}); });
  }
  var extra = '';
  if(sess && sess.hasSession){ extra = '<span>ctx ~'+kfmt(sess.promptTokens||sess.tokens||0)+' tok</span>'
    + (sess.cost?'<span>$'+sess.cost.toFixed(2)+' so far</span>':'')
    + '<span>'+ (sess.turns?sess.turns.length:0) +' turns</span>'; }
  document.getElementById('meta').innerHTML =
      '<span class="badge st-'+task.status+'">'+task.status+'</span>'
    + (running?'<span class="badge run">&#9211; running</span>':'')
    + (task.interrupted&&!running?'<span class="badge intr">&#9208; interrupted</span>':'')
    + '<span>p'+task.priority+'</span><span>owner: '+esc(task.owner||'-')+'</span>'+extra
    + '<span>updated '+when(task.updated)+'</span>';
  document.getElementById('notes').innerHTML = task.notes ? '<div class="notes">'+esc(task.notes)+'</div>' : '';
  var log = task.log||[];
  document.getElementById('logbox').innerHTML = log.length ? log.map(function(e){ return '<div class="logline"><span class="lt">'+when(e.ts)+'</span>'+esc(e.text)+(e.sess?' <span class="lt">('+esc(e.sess)+')</span>':'')+'</div>'; }).join('') : '';
}

function blockHtml(b){
  if(b.t==='text') return '<div class="prose">'+md(b.text)+'</div>';
  if(b.t==='thinking') return '<details class="think"><summary>thinking</summary><div class="prose">'+md(b.text)+'</div></details>';
  if(b.t==='tool') return '<details class="tool"><summary>&rarr; '+esc(b.name)+(b.intent?' <span class="intent">'+esc(b.intent)+'</span>':'')+'</summary><pre class="args">'+esc(b.args||'')+'</pre></details>';
  if(b.t==='result'){ var tx=b.text||'';
    if(hasTable(tx)) return '<div class="prose">'+md(tx)+'</div>';
    var long=tx.length>1400;
    return long ? '<pre class="tx">'+esc(tx.slice(0,1400))+'</pre><details class="tool"><summary>show '+(tx.length-1400)+' more chars</summary><pre class="args">'+esc(tx.slice(1400))+'</pre></details>' : '<pre class="tx">'+esc(tx)+'</pre>';
  }
  if(b.t==='image') return '<div class="figs">'+figTag(imgSrc(b), 'image')+'</div>';
  return '';
}
function refOf(t){
  if(!t) return 'exchange';
  if(t.role==='toolResult') return 'tool result: '+(t.blocks[0]&&t.blocks[0].toolName||'');
  if(t.role==='user') return 'your message';
  var tx=t.blocks.find(function(x){return x.t==='text' && String(x.text||'').trim();}); if(tx) return 'says: '+tx.text.replace(/\s+/g,' ').slice(0,44);
  var tc=t.blocks.find(function(x){return x.t==='tool';}); if(tc) return 'called '+tc.name;
  return 'agent';
}
function selCards(i){
  var cards='';
  comments.forEach(function(c,cid){ if(c.quote!=null && c.turn===i){
    cards += '<div class="qc" data-cid="'+cid+'"><div class="qtxt">'+esc(c.quote)+'</div>'
      + '<textarea class="cmt show" data-q="'+cid+'" placeholder="comment on this passage — sent to the agent">'+esc(c.text)+'</textarea>'
      + '<span class="qcx" data-x="'+cid+'">&times; remove</span></div>';
  } });
  return cards;
}
function turnHtml(t){
  var i=t.i, roleCls=t.role, isTR=(t.role==='toolResult');
  var err = (isTR && t.blocks[0] && t.blocks[0].isError) ? ' err':'';
  var label = isTR ? (t.blocks[0]&&t.blocks[0].isError?'tool error':'tool result') : t.role;
  var meta = isTR ? (t.blocks[0]&&t.blocks[0].toolName||'') : (t.model||'');
  var wc = comments.get('w'+i); var hasSel=false; comments.forEach(function(c){ if(c.quote!=null && c.turn===i) hasSel=true; });
  var has = !!wc || hasSel;
  // conversation-first: the turn leads with its OUTPUT; the agent's reasoning is
  // consolidated behind ONE per-turn reveal instead of spilling inline.
  var think = t.blocks.filter(function(b){ return b.t==='thinking' && String(b.text||'').trim(); });
  var rest = t.blocks.filter(function(b){ return b.t!=='thinking'; });
  mdImgs=[]; var body = rest.map(blockHtml).join('') + takeImgs();
  if(think.length){
    var rz = think.map(function(b){ return md(b.text); }).join('<hr style="border:0;border-top:1px solid var(--ui2);margin:9px 0">');
    body = '<details class="think"><summary>&#129504; reasoning'+(think.length>1?' &middot; '+think.length+' steps':'')+'</summary><div class="prose">'+rz+'</div></details>' + body;
  }
  if(isTR){ var sz=(t.blocks[0]&&t.blocks[0].text)?t.blocks[0].text.length:0; var szl=sz>999?((Math.round(sz/100)/10)+'k chars'):(sz+' chars'); body='<details class="tres"'+(err?' open':'')+'><summary>&#9656; output <span class="tsz">'+szl+'</span></summary>'+body+'</details>'; }
  return '<div class="turn '+roleCls+(has?' hascmt':'')+(isTR?' tr':'')+'" data-i="'+i+'">'
    + '<div class="rh"><span class="role '+roleCls+err+'">'+esc(label)+'</span><span class="ts">'+esc(meta)+'</span>'
    + '<span class="sp"></span><span class="cbtn'+(wc?' on':'')+'" data-c="'+i+'">'+(wc?'&#9998; note':'+ note')+'</span></div>'
    + '<div class="bd">'+body+selCards(i)+figHtml(i)
    + '<textarea class="cmt'+(wc?' show':'')+'" data-ta="'+i+'" placeholder="note on this whole turn — sent to the agent as feedback">'+(wc?esc(wc.text):'')+'</textarea></div></div>';
}
var curGroups=[];
function buildGroups(){
  var g=[], cur=null;
  (sess&&sess.turns?sess.turns:[]).forEach(function(t){
    if(t.role==='user'){ g.push({kind:'user', i:t.i, ts:t.ts||'', turn:t}); cur=null; return; }
    if(!cur){ cur={kind:'resp', i:t.i, _last:t.i, ts:t.ts||'', model:'', outputs:[], steps:[], images:[]}; g.push(cur); }
    cur._last=t.i;
    if(t.role==='toolResult'){ var b=(t.blocks&&t.blocks[0])||{}; cur.steps.push({t:'result', name:b.toolName||'', text:b.text||'', isError:!!b.isError});
      (t.blocks||[]).forEach(function(x){ if(x.t==='image') cur.images.push({src:imgSrc(x), cap:(b.toolName||'tool')+' image'}); }); }
    else { if(t.model) cur.model=t.model; (t.blocks||[]).forEach(function(b){
        if(b.t==='thinking'){ if(String(b.text||'').trim()) cur.steps.push({t:'thinking', text:b.text}); }
        else if(b.t==='tool'){ cur.steps.push({t:'tool', name:b.name||'', intent:b.intent||'', args:b.args||''}); }
        else if(b.t==='text'){ if(String(b.text||'').trim()){ cur.outputs.push(b.text); cur.i=t.i; } }
        else cur.steps.push({t:'other', block:b});
      }); }
  });
  g.forEach(function(n){ if(n.kind==='resp' && !n.outputs.length) n.i=n._last; });
  return g;
}
function stepHtml(s){
  if(s.t==='thinking') return '<div class="prose rzt">'+md(s.text)+'</div>';
  if(s.t==='tool'){ var a=String(s.args||'').trim(); var al=a.length>600?a.slice(0,600)+'…':a;
    return '<div class="rzc">&rarr; <b>'+esc(s.name)+'</b>'+(s.intent?' <span class="intent">'+esc(s.intent)+'</span>':'')+'</div>'+(a?'<pre class="rza">'+esc(al)+'</pre>':''); }
  if(s.t==='result'){ var tx=s.text||''; var n=tx.length; var szl=n>999?((Math.round(n/100)/10)+'k'):(''+n);
    var head='<div class="rzr'+(s.isError?' err':'')+'">&#9656; '+esc(s.name||'result')+' <span class="tsz">'+szl+' chars</span></div>';
    if(!tx) return head;
    if(hasTable(tx)) return head+'<div class="prose">'+md(tx)+'</div>';
    var cut=tx.length>700;
    return head+'<pre class="rzp">'+esc(cut?tx.slice(0,700):tx)+'</pre>'+(cut?'<details class="rzmore"><summary>show '+(tx.length-700)+' more chars</summary><pre class="rzp">'+esc(tx.slice(700))+'</pre></details>':''); }
  if(s.t==='other') return blockHtml(s.block);
  return '';
}
function respHtml(g){
  var i=g.i;
  var wc=comments.get('w'+i); var hasSel=false; comments.forEach(function(c){ if(c.quote!=null && c.turn===i) hasSel=true; });
  var has=!!wc||hasSel;
  mdImgs=[];
  var out=g.outputs.map(function(tx){ return '<div class="prose">'+md(tx)+'</div>'; }).join('') + takeImgs();
  if(g.images && g.images.length) out += '<div class="figs">'+g.images.map(function(im){ return figTag(im.src, im.cap); }).join('')+'</div>';
  var steps='';
  if(g.steps.length){ var inner=g.steps.map(stepHtml).join(''); steps='<details class="think rz"><summary>&#129504; reasoning <span class="rzn">'+g.steps.length+' step'+(g.steps.length===1?'':'s')+'</span></summary><div class="rzbody">'+inner+'</div></details>'; }
  var body=steps+out; if(!out&&!steps) body='<div class="prose" style="color:var(--tx3)">(no textual output)</div>';
  return '<div class="turn assistant'+(has?' hascmt':'')+'" data-i="'+i+'">'
    + '<div class="rh"><span class="role assistant">agent</span><span class="ts">'+esc(g.model||'')+'</span>'
    + '<span class="sp"></span><span class="cbtn'+(wc?' on':'')+'" data-c="'+i+'">'+(wc?'&#9998; note':'+ note')+'</span></div>'
    + '<div class="bd">'+body+selCards(i)+figHtml(i)
    + '<textarea class="cmt'+(wc?' show':'')+'" data-ta="'+i+'" placeholder="note on this exchange — sent to the agent as feedback">'+(wc?esc(wc.text):'')+'</textarea></div></div>';
}

function renderTranscript(){
  var r = document.getElementById('review');
  if(!sess || !sess.hasSession){
    r.innerHTML = '<h2 class="sec">session</h2><div id="imp">No omp session attached to this task.'
      + '<input id="imppath" placeholder="~/.omp/agent/sessions/&lt;dir&gt;/&lt;session&gt;.jsonl (absolute path)" spellcheck="false">'
      + '<button id="impgo">Attach &amp; review</button> <span id="impmsg"></span></div>';
    document.getElementById('impgo').onclick = doImport;
    return;
  }
  curGroups = buildGroups();
  figMap = assignFigs(curGroups);
  r.innerHTML = '<h2 class="sec">transcript <span class="hint">select any text to comment on a passage, or + note a whole exchange &middot; then Done</span></h2>'
    + curGroups.map(function(g){ return g.kind==='user' ? turnHtml(g.turn) : respHtml(g); }).join('');
  applyKfoc(); renderRail(); applyTools();
  var fim=document.querySelectorAll('.fig img'); for(var n=0;n<fim.length;n++) fim[n].onerror=function(){ var f=this.closest('.fig'); if(f) f.classList.add('broken'); };
}

async function doImport(){
  var p = document.getElementById('imppath').value.trim();
  var msg = document.getElementById('impmsg'); msg.textContent='attaching…';
  try{ var res = await (await fetch('/api/import-session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,path:p})})).json();
    if(res.ok){ await loadSession(); renderTranscript(); toBottom(); } else msg.textContent = res.error||'failed';
  }catch(e){ msg.textContent='error: '+e.message; }
}

/* ---- comment interactions ---- */
function liveComments(){ var a=[]; comments.forEach(function(c){ if(String(c.text||'').trim()) a.push(c); }); return a; }

document.addEventListener('click', function(e){
  var x = e.target.closest && e.target.closest('.qcx');
  if(x){ var cid=x.getAttribute('data-x'); comments.delete(cid); var card=x.closest('.qc'); if(card) card.remove(); updateBar(); return; }
  var c = e.target.closest && e.target.closest('.cbtn'); if(!c) return;
  var i = c.getAttribute('data-c');
  var ta = document.querySelector('textarea[data-ta="'+i+'"]');
  ta.classList.toggle('show'); if(ta.classList.contains('show')) ta.focus();
});
document.addEventListener('input', function(e){
  if(!e.target.matches || !e.target.matches('textarea.cmt')) return;
  var val = e.target.value, v = val.trim();
  if(e.target.hasAttribute('data-q')){
    var cid = e.target.getAttribute('data-q'); var c = comments.get(cid); if(c) c.text = val;
  } else {
    var i = +e.target.getAttribute('data-ta'), key='w'+i;
    if(v) comments.set(key, {turn:i, quote:null, ref:refOf(sess.turns[i]), text:val}); else comments.delete(key);
    var card = e.target.closest('.turn'), btn = card.querySelector('.cbtn');
    if(v){ card.classList.add('hascmt'); btn.classList.add('on'); btn.innerHTML='&#9998; note'; }
    else { card.classList.remove('hascmt'); btn.classList.remove('on'); btn.innerHTML='+ note'; }
  }
  updateBar();
});

/* ---- selection -> inline quoted comment ---- */
document.addEventListener('mouseup', function(e){
  var selbtn = document.getElementById('selbtn');
  if(selbtn.contains(e.target)) return;
  setTimeout(function(){
    var s = window.getSelection(); var txt = String(s).replace(/\s+/g,' ').trim();
    if(!txt || txt.length<2){ selbtn.style.display='none'; return; }
    var a = s.anchorNode; var el = a ? (a.nodeType===1?a:a.parentElement) : null;
    var turn = el && el.closest ? el.closest('.turn') : null;
    var bd = turn ? turn.querySelector('.bd') : null;
    if(!turn || !bd || !bd.contains(el) || el.closest('textarea') || el.closest('.qc')){ selbtn.style.display='none'; return; }
    pendingSel = { turn:+turn.getAttribute('data-i'), quote: txt.slice(0,300) };
    selbtn.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth-130))+'px';
    selbtn.style.top = (e.clientY+14)+'px';
    selbtn.style.display='block';
  },1);
});
document.getElementById('selbtn').onclick = function(){
  if(!pendingSel) return;
  var cid = 'q'+(++qid);
  comments.set(cid, { turn:pendingSel.turn, quote:pendingSel.quote, ref:refOf(sess.turns[pendingSel.turn]), text:'' });
  this.style.display='none'; try{ window.getSelection().removeAllRanges(); }catch(e){}
  renderTranscript(); updateBar();
  var ta = document.querySelector('textarea[data-q="'+cid+'"]'); if(ta){ ta.scrollIntoView({block:'center'}); ta.focus(); }
};

function updateBar(){
  var n = liveComments().length;
  var bar = document.getElementById('bar');
  bar.classList.toggle('show', n>0);
  document.getElementById('barn').textContent = n+' comment'+(n===1?'':'s');
  var compact = document.getElementById('compact').checked;
  var tok = (sess && (sess.promptTokens||sess.tokens)) || 0;
  document.getElementById('barest').textContent = compact
    ? 'compact resume — small prefill (summary + comments)'
    : 'full resume — re-prefills ~'+kfmt(tok)+' tokens (cold)';
}
document.getElementById('compact').addEventListener('change', updateBar);

document.getElementById('send').onclick = async function(){
  var live = liveComments(); if(!live.length) return;
  var btn=this; btn.disabled=true; var msg=document.getElementById('barmsg'); msg.textContent='sending…';
  var list = live.map(function(c){ return {turn:c.turn, ref:c.ref, text:c.text, quote:c.quote||undefined}; });
  var compact = document.getElementById('compact').checked;
  try{
    var res = await (await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,comments:list,compact:compact})})).json();
    if(res.ok){ comments.clear(); renderTranscript(); updateBar(); msg.textContent = res.delivered==='terminal' ? 'sent into your terminal session (pid '+res.pid+'); the reply lands here as it streams' : res.queued ? 'queued — runs after the current session finishes' : 'sent — agent is resuming…'; }
    else { msg.textContent = res.error || 'failed'; }
  }catch(e){ msg.textContent='error: '+e.message; }
  btn.disabled=false;
};

/* ---- review focus, keyboard nav, turn-index rail ---- */
var kidx = -1, railRaf = 0;
function turnEls(){ return Array.prototype.slice.call(document.querySelectorAll('.turn')); }
function idxList(){ return turnEls().map(function(el){ return +el.getAttribute('data-i'); }); }
function applyKfoc(){ var els=turnEls(); for(var n=0;n<els.length;n++) els[n].classList.remove('kfoc'); if(kidx>=0){ var el=document.querySelector('.turn[data-i="'+kidx+'"]'); if(el) el.classList.add('kfoc'); } }
function activeTurn(){ var els=turnEls(); if(!els.length) return -1; var ref=window.innerHeight*0.35, best=-1, bd=1e9; for(var n=0;n<els.length;n++){ var r=els[n].getBoundingClientRect(); var d=Math.abs(r.top-ref); if(d<bd){ bd=d; best=+els[n].getAttribute('data-i'); } } return best; }
function railSync(){ var list=document.getElementById('raillist'); if(!list) return; var c=list.querySelector('.rrow.cur'); if(c) c.classList.remove('cur'); var row=list.querySelector('.rrow[data-j="'+kidx+'"]'); if(row){ row.classList.add('cur'); list.scrollTop=Math.max(0, row.offsetTop - list.clientHeight/2 + row.offsetHeight/2); } }
function nearestId(i){ var ids=idxList(); if(!ids.length) return -1; if(ids.indexOf(i)>=0) return i; var best=ids[0]; for(var n=1;n<ids.length;n++) if(Math.abs(ids[n]-i)<Math.abs(best-i)) best=ids[n]; return best; }
function setFocus(i, scroll){ var ids=idxList(); if(!ids.length){ kidx=-1; return; } i=nearestId(i); kidx=i; applyKfoc(); railSync(); if(scroll){ var el=document.querySelector('.turn[data-i="'+kidx+'"]'); if(el) el.scrollIntoView({block:'center'}); } }
function focusTurn(i){ setFocus(i, true); }
function stepFocus(dir){ var ids=idxList(); if(!ids.length) return; var cur=kidx<0?activeTurn():kidx; cur=nearestId(cur); var pos=ids.indexOf(cur); if(pos<0) pos=0; pos=Math.max(0,Math.min(ids.length-1,pos+dir)); focusTurn(ids[pos]); }
function renderRail(){ var list=document.getElementById('raillist'); if(!list) return; if(!curGroups.length){ list.innerHTML=''; return; } list.innerHTML = curGroups.map(function(g){ var cls,ref,er=''; if(g.kind==='user'){ cls='user'; ref=refOf(g.turn); } else { cls='assistant'; er=g.steps.some(function(s){return s.t==='result'&&s.isError;})?' err':''; ref=g.outputs.length?('says: '+String(g.outputs[0]).replace(/\s+/g,' ').slice(0,44)):(g.steps.length?('worked · '+g.steps.length+' steps'):'agent'); } return '<button class="rrow '+cls+er+'" data-j="'+g.i+'" title="'+esc(ref)+'"><span class="rdot"></span><span class="rnum">'+g.i+'</span><span class="rref">'+esc(ref)+'</span></button>'; }).join(''); railSync(); }
function assignFigs(groups){ var map={}; if(!groups||!groups.length||!figs.length) return map; for(var k=0;k<figs.length;k++){ var f=figs[k]; var idx=groups.length-1; if(f.ts){ for(var n=0;n<groups.length;n++){ if(groups[n].ts && groups[n].ts<=f.ts) idx=n; } } var node=groups[idx]; if(!node) continue; (map[node.i]=map[node.i]||[]).push(f); } return map; }
function figHtml(i){ var fs=figMap[i]; if(!fs||!fs.length) return ''; return '<div class="figs">'+fs.map(function(f){ var u='/artifact/'+ID+'/'+f.art; var cap=esc(f.title||'figure'); return '<figure class="fig" data-fa="'+f.art+'"><img loading="lazy" src="'+u+'" alt="'+cap+'"><figcaption><span class="fcap">'+cap+'</span><button class="figc" data-ff="'+i+'" data-fart="'+f.art+'" data-fn="'+cap+'">&#128172; comment</button></figcaption></figure>'; }).join('')+'</div>'; }
function commentFigure(turn, art, name){ var cid='fig_'+art; if(!comments.get(cid)) comments.set(cid, { turn:turn, quote:'figure: '+name, ref:(sess.turns[turn]?refOf(sess.turns[turn]):'figure'), text:'' }); renderTranscript(); updateBar(); var ta=document.querySelector('textarea[data-q="'+cid+'"]'); if(ta){ ta.scrollIntoView({block:'center'}); ta.focus(); } }
document.addEventListener('click', function(e){
  if(e.target && e.target.matches && e.target.matches('.fig img')){ document.getElementById('lbimg').src=e.target.src; document.getElementById('lb').classList.add('on'); return; }
  var fc=e.target.closest?e.target.closest('.figc'):null; if(fc){ e.preventDefault(); commentFigure(+fc.getAttribute('data-ff'), fc.getAttribute('data-fart'), fc.getAttribute('data-fn')); }
});
document.getElementById('lb').addEventListener('click', function(){ this.classList.remove('on'); });
/* keep focus on the turn you are actually looking at, so c never jumps elsewhere */
window.addEventListener('scroll', function(){ if(railRaf) return; railRaf=requestAnimationFrame(function(){ railRaf=0; var a=activeTurn(); if(a>=0 && a!==kidx){ kidx=a; applyKfoc(); railSync(); } }); }, {passive:true});
/* clicking anywhere in a turn focuses it */
document.addEventListener('click', function(e){ var tn=e.target.closest?e.target.closest('.turn'):null; if(tn){ var i=+tn.getAttribute('data-i'); if(i>=0){ kidx=i; applyKfoc(); railSync(); } } });
document.getElementById('raillist').addEventListener('click', function(e){ var b=e.target.closest?e.target.closest('.rrow'):null; if(b) focusTurn(+b.getAttribute('data-j')); });
function railMin(v){ document.body.classList.toggle('rail-min', v); document.getElementById('railtog').innerHTML = v?'&#187;':'&#171;'; try{ localStorage.setItem('tb_railmin', v?'1':'0'); }catch(_){} }
document.getElementById('railtog').onclick=function(){ railMin(!document.body.classList.contains('rail-min')); };
function positionRail(){ var h=document.querySelector('header'); if(h) document.getElementById('rail').style.top=h.offsetHeight+'px'; }
window.addEventListener('resize', positionRail);
try{ if(localStorage.getItem('tb_railmin')==='1') railMin(true); }catch(_){}
(function(){
  var rail=document.getElementById('rail'), h=document.getElementById('railresize');
  var MIN=150, MAX=560;
  try{ var sv=+localStorage.getItem('tb_railw'); if(sv>=MIN&&sv<=MAX) document.body.style.setProperty('--railw', sv+'px'); }catch(_){}
  function apply(px){ var w=Math.max(MIN,Math.min(MAX,Math.round(px))); document.body.style.setProperty('--railw', w+'px'); try{ localStorage.setItem('tb_railw', String(w)); }catch(_){} }
  if(h){ h.addEventListener('pointerdown', function(e){ if(document.body.classList.contains('rail-min')) return; e.preventDefault(); document.body.classList.add('resizing'); try{ h.setPointerCapture(e.pointerId); }catch(_){}
    function mv(ev){ apply(ev.clientX - rail.getBoundingClientRect().left); }
    function up(){ document.body.classList.remove('resizing'); h.removeEventListener('pointermove',mv); document.removeEventListener('pointerup',up); }
    h.addEventListener('pointermove',mv); document.addEventListener('pointerup',up);
  }); }
})();
positionRail();
// keep the rail top flush under the sticky header: its height grows after the
// async session load (title/meta/notes fill in) and on meta wrap, so a one-shot
// call would leave #railtog hidden behind the z-index:5 header. Track it live.
try{ if(window.ResizeObserver){ var _hbar=document.querySelector('header'); if(_hbar) new ResizeObserver(positionRail).observe(_hbar); } }catch(_){}
var toolsOpen=false;
function applyTools(){ var ds=document.querySelectorAll('details.rz'); for(var n=0;n<ds.length;n++) ds[n].open=toolsOpen; var b=document.getElementById('toolstog'); if(b) b.textContent='reasoning: '+(toolsOpen?'shown':'hidden'); }
function setTools(v){ toolsOpen=v; applyTools(); try{ localStorage.setItem('tb_tools', v?'1':'0'); }catch(_){} }
document.getElementById('toolstog').onclick=function(){ setTools(!toolsOpen); };
try{ if(localStorage.getItem('tb_tools')==='1') toolsOpen=true; }catch(_){}
document.getElementById('khbtn').onclick=function(){ document.getElementById('kh').classList.toggle('on'); };
document.getElementById('kh').addEventListener('click', function(){ this.classList.remove('on'); });
document.addEventListener('keydown', function(e){
  if((e.metaKey||e.ctrlKey) && e.key==='Enter'){ if(document.getElementById('bar').classList.contains('show')){ e.preventDefault(); document.getElementById('send').click(); } return; }
  var ae=document.activeElement;
  if(ae && (ae.matches('textarea,input') || ae.isContentEditable)){ if(e.key==='Escape') ae.blur(); return; }
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  if(e.key==='j'||e.key==='ArrowDown'){ e.preventDefault(); stepFocus(1); }
  else if(e.key==='k'||e.key==='ArrowUp'){ e.preventDefault(); stepFocus(-1); }
  else if(e.key==='g'){ e.preventDefault(); var gi=idxList(); if(gi.length) focusTurn(gi[0]); }
  else if(e.key==='G'){ e.preventDefault(); var gL=idxList(); if(gL.length) focusTurn(gL[gL.length-1]); }
  else if(e.key==='c'){ e.preventDefault(); if(kidx<0) kidx=activeTurn(); if(kidx>=0){ applyKfoc(); railSync(); var ta=document.querySelector('textarea[data-ta="'+kidx+'"]'); if(ta){ ta.classList.add('show'); ta.scrollIntoView({block:'center'}); ta.focus({preventScroll:true}); } } }
  else if(e.key==='m'){ e.preventDefault(); railMin(!document.body.classList.contains('rail-min')); }
  else if(e.key==='t'){ e.preventDefault(); setTools(!toolsOpen); }
  else if(e.key==='Escape'){ document.getElementById('kh').classList.remove('on'); document.getElementById('lb').classList.remove('on'); }
  else if(e.key==='?'){ e.preventDefault(); document.getElementById('kh').classList.toggle('on'); }
});

async function loadSession(){
  try{ sess = await (await fetch('/api/session/'+ID)).json(); running = !!sess.running; }
  catch(e){ sess = {hasSession:false}; }
}

/* ---- captured responses (modal) ---- */
document.getElementById('capbtn').onclick = function(){ document.getElementById('artdlg').showModal(); };
document.getElementById('artclose').onclick = function(){ document.getElementById('artdlg').close(); };
var artMeta = {};
async function addArtifact(a){
  if(seenArt.has(a.art)) return; seenArt.add(a.art);
  artMeta[a.art]={title:a.title||a.format,format:a.format};
  var btn=document.getElementById('capbtn'); btn.hidden=false; document.getElementById('capn').textContent=seenArt.size;
  var actions='<button class="amini aopen" data-art="'+esc(a.art)+'">open &#8599;</button>'
    + '<button class="amini areply" data-art="'+esc(a.art)+'">&#128172; reply</button>'
    + '<a class="amini" href="/artifact/'+ID+'/'+a.art+'" target="_blank">raw</a>';
  var head='<div class="h"><span class="k '+esc(a.kind)+'">'+esc(a.kind)+'</span>'
    + '<span class="t">'+esc(a.title||a.format)+'</span>'
    + '<span class="s">'+when(a.ts)+' &middot; '+a.bytes+'b</span>'+actions+'</div>';
  var isMd=(a.format==='md'||a.format==='markdown');
  var wrap=document.createElement('div'); wrap.className='art'; wrap.setAttribute('data-art',a.art);
  wrap.innerHTML=head;
  if(a.format==='html'){ var f=document.createElement('iframe'); f.className='body'; f.setAttribute('sandbox',''); f.src='/artifact/'+ID+'/'+a.art; wrap.appendChild(f); }
  else if(isMd){ var host=document.createElement('div'); host.className='body prose'; host.innerHTML='loading&#8230;'; wrap.appendChild(host); try{ host.innerHTML=md(await (await fetch('/artifact/'+ID+'/'+a.art)).text()); }catch(e){ host.textContent='[unreadable]'; } }
  else { var pre=document.createElement('pre'); pre.className='body'; pre.textContent='loading…'; wrap.appendChild(pre); try{ pre.textContent=await (await fetch('/artifact/'+ID+'/'+a.art)).text(); }catch(e){ pre.textContent='[unreadable]'; } }
  var rep=document.createElement('div'); rep.className='artreply'; rep.hidden=true; rep.setAttribute('data-art',a.art);
  rep.innerHTML='<textarea placeholder="respond to this artifact &mdash; sent to the agent as a prompt to resume"></textarea><div class="arrow"><button class="arsend">reply to agent &rarr;</button><span class="armsg"></span></div>';
  wrap.appendChild(rep);
  document.getElementById('arts').appendChild(wrap);
}
document.getElementById('arts').addEventListener('click', function(e){
  var t=e.target; if(!t.classList) return;
  if(t.classList.contains('aopen')){ openArt(t.getAttribute('data-art')); }
  else if(t.classList.contains('areply')){ var w=t.closest('.art'); var r=w&&w.querySelector('.artreply'); if(r){ r.hidden=!r.hidden; if(!r.hidden){ var ta=r.querySelector('textarea'); if(ta) ta.focus(); } } }
  else if(t.classList.contains('arsend')){ sendArtReply(t); }
});
async function openArt(art){
  var m=artMeta[art]||{}; var ov=document.getElementById('docov'); var body=document.getElementById('docbody');
  document.getElementById('doct').textContent=m.title||'artifact';
  body.className=''; body.innerHTML='loading&#8230;'; if(!ov.open) ov.showModal();
  try{
    if(m.format==='html'){ body.innerHTML=''; var f=document.createElement('iframe'); f.setAttribute('sandbox',''); f.src='/artifact/'+ID+'/'+art; body.appendChild(f); }
    else { var txt=await (await fetch('/artifact/'+ID+'/'+art)).text();
      if(m.format==='md'||m.format==='markdown'){ body.className='prose'; body.innerHTML=md(txt); }
      else { body.innerHTML=''; var pre=document.createElement('pre'); pre.className='tx'; pre.textContent=txt; body.appendChild(pre); } }
  }catch(e){ body.textContent='[unreadable]'; }
}
async function sendArtReply(btn){
  var box=btn.closest('.artreply'); if(!box) return; var art=box.getAttribute('data-art');
  var ta=box.querySelector('textarea'); var msg=box.querySelector('.armsg');
  var text=String(ta.value||'').trim(); if(!text){ msg.textContent='write a reply first'; return; }
  var m=artMeta[art]||{}; var lastTurn=(sess&&sess.turns&&sess.turns.length)?sess.turns.length-1:0;
  var comment={turn:lastTurn, ref:'re: '+(m.title||'artifact'), quote:'artifact: '+(m.title||art), text:text};
  var compact=document.getElementById('compact').checked;
  btn.disabled=true; msg.textContent='sending&#8230;';
  try{
    var res=await (await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,comments:[comment],compact:compact})})).json();
    if(res.ok){ ta.value=''; box.hidden=true; msg.textContent = res.delivered==='terminal' ? 'sent into your terminal session' : 'sent — agent resuming…'; }
    else { msg.textContent=res.error||'failed'; }
  }catch(e){ msg.textContent='error: '+e.message; }
  btn.disabled=false;
}
document.getElementById('docx').onclick=function(){ document.getElementById('docov').close(); };
document.getElementById('docov').addEventListener('click', function(e){ if(e.target.id==='docov') e.currentTarget.close(); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var ov=document.getElementById('docov'); if(ov&&ov.open){ e.stopPropagation(); ov.close(); } } }, true);

/* ---- file chips (open in the doc viewer) + code-block copy ---- */
async function openFile(p){
  var ov=document.getElementById('docov'), body=document.getElementById('docbody');
  document.getElementById('doct').textContent=p; body.className=''; body.innerHTML='loading&#8230;'; if(!ov.open) ov.showModal();
  var ext=(String(p).split('.').pop()||'').toLowerCase();
  if(IMGX.test(ext)){ body.innerHTML='<img class="docimg" src="'+esc(fileUrl(p))+'" alt="">'; return; }
  try{
    var r=await fetch(fileUrl(p)), txt=await r.text();
    if(!r.ok){ var er='HTTP '+r.status; try{ er=JSON.parse(txt).error||er; }catch(e){} body.textContent='cannot open: '+er; return; }
    body.className='prose';
    if(ext==='md'){ body.innerHTML=md(txt); mdImgs=[]; return; }
    var big=txt.length>200000, plain=/^(txt|log|csv|tsv)$/.test(ext);
    body.innerHTML=codeBlock(big?txt.slice(0,200000)+'\n… (truncated at 200k chars)':txt, (big||plain)?'plaintext':(EXT_LANG[ext]||''));
  }catch(e){ body.textContent='cannot open: '+e.message; }
}
document.addEventListener('click', function(e){
  var t=e.target; if(!t.closest) return;
  var fc=t.closest('.fchip'); if(fc){ e.preventDefault(); openFile(fc.getAttribute('data-fpath')); return; }
  var cp=t.closest('.ccopy'); if(cp){ var pre=cp.closest('.cblk').querySelector('pre'); var txt=pre?pre.textContent:'';
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function(){ cp.textContent='copied'; setTimeout(function(){ cp.textContent='copy'; },1200); }, function(){ cp.textContent='copy failed'; });
    return; }
});

/* ---- auto-scroll: land at newest; follow while running if pinned ---- */
function atBottom(){ return (window.innerHeight+window.scrollY) >= document.body.scrollHeight-160; }
function toBottom(){ window.scrollTo(0, document.body.scrollHeight); }
var firstScroll=false;

var lastRunning=false, loadedOnce=false;
async function tick(){
  try{
    var r = await fetch('/api/task/'+ID);
    if(r.status===404){ document.getElementById('title').textContent='(no such task)'; return; }
    var d = await r.json();
    running = !!d.running;
    if(!loadedOnce || running || lastRunning || d.terminal){ await loadSession(); loadedOnce = true; }
    header(d.task);
    var len = sess && sess.hasSession ? sess.turns.length : -1;
    if(len !== turnsLen){
      var pinned = atBottom();
      turnsLen = len; renderTranscript(); updateBar();
      if(!firstScroll || (running && pinned)){ toBottom(); firstScroll = true; }
    }
    lastRunning = running;
    var arts = d.task.artifacts||[];
    var imgs = arts.filter(function(a){ return IMGX.test(a.format||''); });
    var fsig = imgs.map(function(a){ return a.art; }).join(',');
    if(fsig!==figSig){ figs=imgs; figSig=fsig; if(sess&&sess.hasSession) renderTranscript(); }
    for(var i=0;i<arts.length;i++){ if(!IMGX.test(arts[i].format||'')) await addArtifact(arts[i]); }
  }catch(e){}
  setTimeout(tick, running ? 1500 : 2500);
}
tick();

