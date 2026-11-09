const STATUSES = window.__BOOT__.statuses;
const RANK = Object.fromEntries(STATUSES.map((s,i)=>[s,i]));
let rev = -1, focusHold = false, SPAWNING = new Set(), lastSpawnKey = "", LIVE = {};

async function post(edits){
  const r = await fetch('/api/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edits})});
  const d = await r.json(); if(d && d.board){ rev = d.rev; SPAWNING = new Set(d.spawning||[]); LIVE = d.live||{}; paint(d.board); } return d;
}
function edit(e){ return post([e]); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function isSess(t){ return !!t.session || t.status==='doing' || SPAWNING.has(t.id) || (t.artifacts&&t.artifacts.length>0); }
function sidOf(t){ var s=String(t.session||t.origin_session||''); s=s.split('/').pop(); return s.length>36? s.slice(0,16)+'\u2026'+s.slice(-15): s; }
// omp accepts an id prefix for --resume; ids are UUIDv7, whose first 12 hex
// digits are the creation time in ms, so 13 chars (with the dash) stay unique.
function resumeId(t){ var m=String(t.session||'').match(/_([0-9a-f]{8}-[0-9a-f]{4})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i); return m?m[1]:''; }
function stSel(t){ return '<select class="st st-'+t.status+'" title="status">'+STATUSES.map(function(s){return '<option '+(s===t.status?'selected':'')+' value="'+s+'">'+s+'</option>';}).join('')+'</select>'; }
function prioSel(t){ return '<select class="prio" title="priority">'+[0,1,2,3].map(function(p){return '<option '+(p===t.priority?'selected':'')+' value="'+p+'">p'+p+'</option>';}).join('')+'</select>'; }

function sessCard(t){
  var run=SPAWNING.has(t.id), dn=(t.status==='done'||t.status==='dropped');
  var nart=(t.artifacts&&t.artifacts.length)||0;
  var intr=(t.interrupted&&!run);
  var wt=WAIT[t.waiting];
  return '<article class="card'+(run?' running':'')+(intr?' intr':'')+(dn?' dn':'')+(wt&&wt.urgent?' waitq':'')+'" data-id="'+t.id+'">'
    + '<div class="ctop"><span class="grip" title="drag to reorder">&#10303;</span>'+stSel(t)
      + (run?'<span class="spin" title="running">&#10227;</span>':'')
      + (intr?'<span class="ibadge" title="idle-cap interrupted; still resumable">&#9208; interrupted</span>':'')
      + (LIVE[t.id]?'<span class="tbadge" title="open in a terminal (pid '+LIVE[t.id].pid+'): reviews from the board are typed into that session">&#9000; in terminal</span>':'')
      + (wt?'<span class="wbadge w-'+t.waiting+'" title="'+esc(t.waitText||'')+' (since '+esc(t.waitSince||'')+')">'+wt.icon+' '+wt.label+'</span>':'')
      + '<span class="pchip p'+t.priority+'">p'+t.priority+'</span>'
      + '<span class="sp"></span>'
      + '<button class="icon drop" title="drop">&#215;</button></div>'
    + '<div class="title" contenteditable="plaintext-only" title="click to rename">'+esc(t.title)+'</div>'
    + '<div class="sub" title="'+esc(t.session||t.origin_session||'')+'">'+ (sidOf(t)||'&mdash;') + (nart?'  &#183; '+nart+' &#9633;':'') + '</div>'
    + (resumeId(t)?'<div class="rid"><code class="ridc" data-cmd="omp --resume '+resumeId(t)+'" title="click to copy: resume this card\'s session in a terminal">omp --resume '+resumeId(t)+'</code></div>':'')
    + '<div class="cfoot">'
      + (run?'<button class="b res" disabled>running&#8230;</button>':LIVE[t.id]?'<button class="b res" disabled title="open in a terminal: continue it there, or review from its page">in terminal</button>':'<button class="b res run">&#9654; resume</button>')
      + '<button class="b open" data-open="'+t.id+'">open &#8599;</button>'
      + '<span class="sp"></span>'
      + '<button class="icon more" title="details">&#9776;</button></div>'
    + '<div class="exp">'
      + '<label class="fl">priority '+prioSel(t)+'</label>'
      + '<input class="own" value="'+esc(t.owner)+'" placeholder="owner">'
      + '<textarea class="notes" placeholder="notes">'+esc(t.notes)+'</textarea></div>'
    + '</article>';
}
function roadItem(t){
  return '<div class="ritem p'+t.priority+'" data-id="'+t.id+'">'
    + '<span class="grip" title="drag to reorder">&#10303;</span><span class="pchip p'+t.priority+'">p'+t.priority+'</span>'
    + '<div class="rbody">'
      + '<div class="title" contenteditable="plaintext-only" title="click to rename">'+esc(t.title)+'</div>'
      + '<div class="ractions">'
        + '<button class="b go run">&#9654; start session</button>'
        + '<button class="b open" data-open="'+t.id+'">open</button>'
        + '<button class="b more">notes</button>'
        + '<span class="sp"></span>'+stSel(t)
        + '<button class="icon drop" title="drop">&#215;</button></div>'
      + '<div class="exp"><label class="fl">priority '+prioSel(t)+'</label><textarea class="notes" placeholder="notes">'+esc(t.notes)+'</textarea></div>'
    + '</div></div>';
}
function doneRow(t){
  var arc=!!t.archived && t.status==='done';
  return '<div class="drow" data-id="'+t.id+'"><span class="pill st-'+(arc?'archived':t.status)+'"'+(arc?' title="auto-archived '+esc(t.archived)+'"':'')+'>'+(arc?'archived':t.status)+'</span>'
    + '<span class="title" contenteditable="plaintext-only">'+esc(t.title)+'</span>'
    + (arc?'<a class="restore" title="move back to Current sessions">restore</a>':'')
    + '<a class="open" data-open="'+t.id+'">open</a>'
    + '<button class="icon drop" title="delete">&#215;</button></div>';
}
function setNum(id,n){ var e=document.getElementById(id); if(e) e.textContent=n; }

function paint(board){
  var tasks=board.tasks.slice();
  var live=tasks.filter(function(t){return t.status!=='done'&&t.status!=='dropped';});
  var done=tasks.filter(function(t){return t.status==='done'||t.status==='dropped';});
  var sessions=live.filter(isSess);
  var road=live.filter(function(t){return !isSess(t);});
  sessions.sort(function(a,b){ return byRank(a,b) || (SPAWNING.has(b.id)-SPAWNING.has(a.id)) || (RANK[a.status]-RANK[b.status]) || (b.priority-a.priority) || (a.order-b.order); });
  road.sort(function(a,b){ return byRank(a,b) || (a.priority-b.priority) || (a.order-b.order); });
  done.sort(function(a,b){ return (b.updated<a.updated?-1:b.updated>a.updated?1:0); });

  var running=sessions.filter(function(t){return SPAWNING.has(t.id);}).length;
  setNum('h-run',running); setNum('h-sess',sessions.length); setNum('h-road',road.length); setNum('h-done',done.length);
  setNum('sesscount',sessions.length); setNum('roadcount',road.length);

  document.getElementById('sesswrap').innerHTML = sessions.length? sessions.map(sessCard).join('')
    : '<div class="muted">No active sessions. Start one from the roadmap, or append via a session hook.</div>';
  document.getElementById('roadwrap').innerHTML = road.map(roadItem).join('');
  document.getElementById('roadempty').hidden = road.length!==0;
  document.getElementById('donewrap').innerHTML = done.map(doneRow).join('');
  document.getElementById('donebox').hidden = done.length===0;
  document.querySelector('#donebox>summary').textContent='Done / dropped / archived ('+done.length+')';
  document.getElementById('empty').hidden = tasks.length!==0;
  applyKfoc(); checkWaits(tasks);
}

/* ---- waiting-on-you alerts ----
   The omp hook writes `waiting` (approval | question | idle) + waitText +
   waitSince on the session's card. Each new wait raises an in-page toast and,
   if permitted, a desktop notification; clicking either opens that card.
   Approvals/questions stay up until answered or dismissed; turn-finished
   toasts fade. Waits already pending at page load only re-alert if they are
   approvals/questions under an hour old. Answering still happens in the
   terminal: the board can show the prompt but cannot press enter for you. */
var WAIT={ approval:{icon:'&#9888;', label:'needs approval', urgent:true},
           question:{icon:'&#10067;', label:'has a question', urgent:true},
           idle:{icon:'&#9998;', label:'your turn', urgent:false} };
var seenWait=new Set(), firstWaitPass=true;
function aPref(k, dflt){ try{ var v=localStorage.getItem('tb_alert_'+k); return v==null?dflt:v==='1'; }catch(_){ return dflt; } }
function setAPref(k, v){ try{ localStorage.setItem('tb_alert_'+k, v?'1':'0'); }catch(_){} paintAlertBtns(); }
function canNotify(){ return typeof Notification!=='undefined' && Notification.permission==='granted' && aPref('desk', true); }
function paintAlertBtns(){
  var n=document.getElementById('notifbtn'), i=document.getElementById('idlebtn');
  if(n) n.innerHTML='&#128276; desktop alerts: '+(typeof Notification==='undefined'?'unsupported':Notification.permission==='denied'?'blocked in browser':canNotify()?'on':'off');
  if(i) i.textContent='turn-finished alerts: '+(aPref('idle', true)?'on':'off');
}
document.getElementById('notifbtn').onclick=async function(){
  if(typeof Notification==='undefined') return;
  if(Notification.permission==='default'){ try{ await Notification.requestPermission(); }catch(_){} setAPref('desk', true); return; }
  if(Notification.permission==='granted') setAPref('desk', !aPref('desk', true));
};
document.getElementById('idlebtn').onclick=function(){ setAPref('idle', !aPref('idle', true)); };
paintAlertBtns();
function dismissed(key){ try{ return localStorage.getItem('tb_wd_'+key)==='1'; }catch(_){ return false; } }
function dismiss(key){ try{ localStorage.setItem('tb_wd_'+key,'1'); }catch(_){} var el=document.querySelector('#toasts .toast[data-key="'+CSS.escape(key)+'"]'); if(el) el.remove(); }
function toast(t, key){
  var w=WAIT[t.waiting], el=document.createElement('div');
  el.className='toast w-'+t.waiting; el.setAttribute('data-key', key); el.setAttribute('data-id', t.id);
  el.innerHTML='<span class="tic">'+w.icon+'</span><div class="tbd"><div class="tt">'+esc(t.title||t.id)+'</div><div class="tx">'+w.label+(t.waitText?' &middot; '+esc(t.waitText):'')+'</div></div><button class="tcl" title="dismiss">&#215;</button>';
  document.getElementById('toasts').appendChild(el);
  if(!w.urgent) setTimeout(function(){ if(el.parentNode) el.remove(); }, 12000);
}
function sysNotify(t, key){
  if(!canNotify() || (document.hasFocus() && !document.hidden)) return;
  try{
    var w=WAIT[t.waiting];
    var n=new Notification((t.title||t.id)+' '+w.label, { body:t.waitText||'', tag:key, requireInteraction:!!w.urgent });
    n.onclick=function(){ window.focus(); openOverlay(t.id); dismiss(key); n.close(); };
  }catch(_){}
}
function checkWaits(tasks){
  var live={}, urgent=0;
  tasks.forEach(function(t){
    if(!WAIT[t.waiting] || t.status==='done' || t.status==='dropped') return;
    var key=t.id+'|'+(t.waitSince||''); live[key]=1;
    if(WAIT[t.waiting].urgent) urgent++;
    if(seenWait.has(key)) return; seenWait.add(key);
    if(dismissed(key)) return;
    if(t.waiting==='idle' && !aPref('idle', true)) return;
    if(firstWaitPass && (t.waiting==='idle' || Date.now()-Date.parse(t.waitSince) > 3600e3)) return;
    toast(t, key); sysNotify(t, key);
  });
  var ts=document.querySelectorAll('#toasts .toast'); for(var n=0;n<ts.length;n++) if(!live[ts[n].getAttribute('data-key')]) ts[n].remove();
  document.title=(urgent?'('+urgent+') ':'')+'Absol';
  firstWaitPass=false;
}
document.getElementById('toasts').addEventListener('click', function(e){
  var el=e.target.closest('.toast'); if(!el) return;
  var key=el.getAttribute('data-key');
  if(e.target.closest('.tcl')){ dismiss(key); return; }
  openOverlay(el.getAttribute('data-id')); dismiss(key);
});
/* ---- drag to reorder within Current sessions or Roadmap (grab the grip) ----
   The dropped order is saved as `rank` 1..n on every card in that section.
   Ranked cards keep your order; cards never placed by hand (new sessions)
   sort ahead of them by the automatic rules, so new work stays visible. */
function byRank(a,b){ var ha=a.rank!=null, hb=b.rank!=null; if(ha&&hb) return a.rank-b.rank; if(ha!==hb) return ha?1:-1; return 0; }
var drag=null;
function wrapIds(w){ return Array.prototype.map.call(w.querySelectorAll(':scope > [data-id]'), function(x){ return x.getAttribute('data-id'); }); }
document.addEventListener('pointerdown', function(e){ var g=e.target.closest&&e.target.closest('.grip'); if(!g) return; var c=g.closest('.card,.ritem'); if(c) c.draggable=true; });
document.addEventListener('pointerup', function(){ if(drag) return; var c=document.querySelectorAll('[draggable="true"]'); for(var n=0;n<c.length;n++) c[n].draggable=false; });
document.addEventListener('dragstart', function(e){
  var c=e.target.closest&&e.target.closest('.card[draggable="true"],.ritem[draggable="true"]'); if(!c) return;
  drag={el:c, wrap:c.parentNode}; drag.before=wrapIds(drag.wrap).join(',');
  try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', c.getAttribute('data-id')); }catch(_){}
  c.classList.add('dragging');
});
document.addEventListener('dragover', function(e){
  if(!drag) return;
  if(!(e.target.closest && e.target.closest('#'+drag.wrap.id))) return;
  e.preventDefault(); e.dataTransfer.dropEffect='move';
  var over=e.target.closest('.card,.ritem'); if(!over||over===drag.el||over.parentNode!==drag.wrap) return;
  var r=over.getBoundingClientRect(), grid=drag.wrap.id==='sesswrap';
  var after = grid ? e.clientX > r.left+r.width/2 : e.clientY > r.top+r.height/2;
  var ref = after ? over.nextSibling : over; if(ref!==drag.el && ref!==drag.el.nextSibling) drag.wrap.insertBefore(drag.el, ref);
});
document.addEventListener('drop', function(e){ if(drag) e.preventDefault(); });
document.addEventListener('dragend', function(){
  if(!drag) return; var d=drag; drag=null;
  d.el.classList.remove('dragging'); d.el.draggable=false;
  var ids=wrapIds(d.wrap); if(ids.join(',')===d.before) return;
  post(ids.map(function(id,i){ return {op:'update', id:id, rank:i+1}; }));
});
function idOf(el){ var n=el.closest('[data-id]'); return n&&n.getAttribute('data-id'); }
document.addEventListener('change', function(ev){
  var el=ev.target, id=idOf(el); if(!id) return;
  if(el.classList.contains('st')) edit({op:'update',id,status:el.value});
  else if(el.classList.contains('prio')) edit({op:'update',id,priority:Number(el.value)});
});
document.addEventListener('blur', function(ev){
  var el=ev.target, id=idOf(el); if(!id) return;
  if(el.classList.contains('own')) edit({op:'update',id,owner:el.value.trim()});
  else if(el.classList.contains('notes')) edit({op:'note',id,text:el.value});
  else if(el.classList.contains('title')) edit({op:'update',id,title:el.textContent.trim()});
}, true);
document.addEventListener('click', function(ev){
  var t=ev.target;
  if(t.classList.contains('more')){ var c=t.closest('.card,.ritem'); if(c) c.classList.toggle('open-exp'); return; }
  if(t.classList.contains('drop')){ var id=idOf(t); if(id) edit({op:'drop',id}); return; }
  if(t.classList.contains('restore')){ var idr=idOf(t); if(idr) edit({op:'update',id:idr,status:'doing',archived:''}); return; }
  if(t.classList.contains('run')){ var id2=idOf(t); var node=t.closest('[data-id]'); var ttl=node&&node.querySelector('.title')?node.querySelector('.title').textContent:id2; if(id2) runTask(id2,ttl); return; }
  if(t.classList.contains('open')){ ev.preventDefault(); var id3=t.getAttribute('data-open'); if(id3) openOverlay(id3); return; }
});

function openOverlay(id){
  document.getElementById('ovframe').src='/task/'+id;
  document.getElementById('ovnew').href='/task/'+id;
  document.getElementById('ovtitle').textContent='task '+id;
  document.getElementById('ov').classList.add('on');
}
function closeOverlay(){
  document.getElementById('ov').classList.remove('on');
  document.getElementById('ovframe').src='about:blank';
}
document.getElementById('ovx').onclick=closeOverlay;
document.getElementById('ov').addEventListener('click', function(e){ if(e.target.id==='ov') closeOverlay(); });
var kid = null;
function navEls(){ return Array.prototype.slice.call(document.querySelectorAll('#sesswrap [data-id], #roadwrap [data-id]')); }
function applyKfoc(){ var f=document.querySelectorAll('.kfoc'); for(var n=0;n<f.length;n++) f[n].classList.remove('kfoc'); if(kid){ var el=document.querySelector('[data-id="'+kid+'"]'); if(el) el.classList.add('kfoc'); else kid=null; } }
function moveFoc(d){ var els=navEls(); if(!els.length) return; var idx=-1; for(var n=0;n<els.length;n++){ if(els[n].getAttribute('data-id')===kid){ idx=n; break; } } idx = idx<0 ? (d>0?0:els.length-1) : Math.max(0,Math.min(els.length-1, idx+d)); kid=els[idx].getAttribute('data-id'); applyKfoc(); els[idx].scrollIntoView({block:'nearest'}); }
document.getElementById('khbtn').onclick=function(){ document.getElementById('kh').classList.toggle('on'); };
document.getElementById('kh').addEventListener('click', function(){ this.classList.remove('on'); });
document.addEventListener('keydown', function(e){
  if(e.key==='Escape'){ document.getElementById('kh').classList.remove('on'); closeOverlay(); return; }
  var ae=document.activeElement;
  if(ae && (ae.matches('input,textarea,select') || ae.isContentEditable)) return;
  if(document.getElementById('ov').classList.contains('on')) return;
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  if(e.key==='j'||e.key==='ArrowDown'){ e.preventDefault(); moveFoc(1); }
  else if(e.key==='k'||e.key==='ArrowUp'){ e.preventDefault(); moveFoc(-1); }
  else if(e.key==='o'||e.key==='Enter'){ if(kid){ e.preventDefault(); openOverlay(kid); } }
  else if(e.key==='r'){ if(kid){ var el=document.querySelector('[data-id="'+kid+'"]'); var ttl=el&&el.querySelector('.title')?el.querySelector('.title').textContent:kid; e.preventDefault(); runTask(kid,ttl); } }
  else if(e.key==='?'){ e.preventDefault(); document.getElementById('kh').classList.toggle('on'); }
});

async function runTask(id, title){
  if(!confirm('Run an omp session for:\n\n'+title+'\n\nThis spends tokens and runs autonomously. Continue?')) return;
  try{
    var r=await fetch('/api/spawn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:id})});
    var d=await r.json();
    if(!d.ok) alert('Cannot run: '+(d.error||('HTTP '+r.status)));
    if(d.board){ rev=d.rev; SPAWNING=new Set(d.spawning||[]); paint(d.board); }
  }catch(e){ alert('spawn request failed: '+e.message); }
}

document.addEventListener('focusin', function(e){ if(e.target.matches('input,textarea,select,[contenteditable]')) focusHold=true; });
document.addEventListener('focusout', function(){ setTimeout(function(){ focusHold=!!document.querySelector('input:focus,textarea:focus,select:focus,[contenteditable]:focus'); },0); });

function addTask(){
  var i=document.getElementById('addt'); var title=i.value.trim(); if(!title) return;
  var priority=Number(document.getElementById('addp').value);
  i.value=''; edit({op:'add',title,priority});
}
document.getElementById('addb').onclick=addTask;
document.getElementById('addt').addEventListener('keydown', function(e){ if(e.key==='Enter') addTask(); });

async function poll(){
  try{
    var d=await (await fetch('/api/board')).json();
    document.getElementById('dot').style.opacity=1;
    var sk=(d.spawning||[]).join(',')+'|'+Object.keys(d.live||{}).sort().join(',');
    if((d.rev!==rev || sk!==lastSpawnKey) && !focusHold && !drag){ rev=d.rev; lastSpawnKey=sk; SPAWNING=new Set(d.spawning||[]); LIVE=d.live||{}; paint(d.board); }
    setTimeout(function(){document.getElementById('dot').style.opacity=.5;},150);
  }catch(e){ document.getElementById('dot').style.opacity=.2; }
  setTimeout(poll,1500);
}
document.addEventListener('click', function(e){
  var c=e.target.closest&&e.target.closest('.ridc'); if(!c) return;
  var cmd=c.getAttribute('data-cmd');
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(function(){ var o=c.textContent; c.textContent='copied'; setTimeout(function(){ c.textContent=o; },1100); }, function(){});
});
poll();

