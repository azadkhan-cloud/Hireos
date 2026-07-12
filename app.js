// ============================================================
// HireOS — WorkSource Recruitment Operating System
// ============================================================
// TABLE OF CONTENTS
//   1. CONFIG                — Supabase/API endpoints, shared constants
//   2. LOW-LEVEL HELPERS     — toast, authFetch, rest() — every data call goes through these
//   3. AUTH                  — login, logout, role-based routing (enterApp)
//   4. BD DASHBOARD          — Dashboard, Clients, Requisitions, sourcing toolkit, candidate CSV
//   5. RECRUITER DASHBOARD   — Dashboard, Open Jobs, Candidate Search, interviews, messaging
//   6. ADMIN                 — Overview, Team Management, Full Oversight, Placements & Billing
//   7. LEADS (BD Growth)     — Pipeline CRM: research, pitch drafts, CSV import/export
//   8. CLIENT PORTAL         — Dashboard, candidate review/feedback, requirement submission
//   9. CANDIDATE PORTAL      — Application status, self-scheduling, interview prep, resume refresh
//
// Every role in enterApp() (section 3) routes to exactly one of sections 4-9.
// AI calls all go through AI_PROXY_URL (section 1) — never api.anthropic.com directly.
// ============================================================

// ============================================================
// 1. CONFIG
// ============================================================
const SUPABASE_URL = "https://xrargvfdummasvaacfko.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyYXJndmZkdW1tYXN2YWFjZmtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MTQyODksImV4cCI6MjA5OTE5MDI4OX0.PUtlBsf_WAWWmB_3BkvLACPPJYcKimap0JXjxSTrZSY";

let session = null;   // {access_token, user}
let profile = null;   // {id, role, segments, full_name}
const SEGMENTS = ["Construction/EPC","BFSI","Manufacturing","Healthcare","Pharma","Logistics","Other"];
const CATEGORIES = ["Corporate Hiring","Executive Hiring","RPO Model","Bulk Hiring","IT Hiring"];
const STAGES = ["Sourced","Screened","Submitted to Client","Client Interview R1","Client Interview R2","Offer Stage","Offer Accepted","Joined","Placed","Rejected","On Hold"];
const EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/admin-create-user";
const AI_PROXY_URL = SUPABASE_URL + "/functions/v1/ai-proxy";

// ============================================================
// 2. LOW-LEVEL HELPERS
// ============================================================
function toast(msg){
  const el = document.createElement('div');
  el.className='toast'; el.textContent = msg;
  document.getElementById('toastHolder').appendChild(el);
  setTimeout(()=>el.remove(), 3200);
}

async function authFetch(path, opts={}){
  // keep the access token alive before every call
  if(session && typeof ensureFreshSession === 'function'){ await ensureFreshSession(); }
  const headers = Object.assign({
    'apikey': ANON_KEY,
    'Authorization': 'Bearer ' + (session ? session.access_token : ANON_KEY),
    'Content-Type': 'application/json'
  }, opts.headers || {});
  const res = await fetch(SUPABASE_URL + path, Object.assign({}, opts, {headers}));
  if(!res.ok){
    const t = await res.text();
    throw new Error('API error ' + res.status + ': ' + t);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function rest(table, {method='GET', query='', body=null, prefer=''}={}){
  const opts = {method, headers:{}};
  if(prefer) opts.headers['Prefer'] = prefer;
  if(body) opts.body = JSON.stringify(body);
  return authFetch('/rest/v1/' + table + (query?('?'+query):''), opts);
}

// ============================================================
// 3. AUTH
// ============================================================
// ---------- session persistence + token refresh ----------
function saveSession(){
  try{
    if(!session) return;
    localStorage.setItem('hireos_session', JSON.stringify({
      refresh_token: session.refresh_token,
      access_token: session.access_token,
      expires_at: session.expires_at
    }));
  }catch(e){}
}

// Exchange the refresh token for a fresh access token.
async function refreshSession(){
  let stored = null;
  try{ stored = JSON.parse(localStorage.getItem('hireos_session') || 'null'); }catch(e){}
  const rt = (session && session.refresh_token) || (stored && stored.refresh_token);
  if(!rt) return false;
  try{
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method:'POST',
      headers:{'apikey':ANON_KEY,'Content-Type':'application/json'},
      body: JSON.stringify({refresh_token: rt})
    });
    if(!res.ok) throw new Error('refresh failed');
    const data = await res.json();
    if(!data.access_token) throw new Error('no token');
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || rt,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      user: data.user || (session && session.user)
    };
    saveSession();
    return true;
  }catch(e){
    try{ localStorage.removeItem('hireos_session'); }catch(_){}
    session = null;
    return false;
  }
}

// Refresh a couple of minutes before the token actually dies.
async function ensureFreshSession(){
  if(!session) return false;
  if(session.expires_at && Date.now() < session.expires_at - 120000) return true;
  return await refreshSession();
}
setInterval(function(){ if(session) ensureFreshSession(); }, 4 * 60 * 1000);

// On page load: if a valid refresh token is stored, sign the user straight back in.
async function restoreSession(){
  let stored = null;
  try{ stored = JSON.parse(localStorage.getItem('hireos_session') || 'null'); }catch(e){}
  if(!stored || !stored.refresh_token) return;
  const ok = await refreshSession();
  if(!ok) return;
  try{
    const profiles = await rest('users', {query:`auth_id=eq.${session.user.id}&select=*`});
    if(!profiles || !profiles.length){ logout(); return; }
    profile = profiles[0];
    enterApp();
  }catch(e){
    session = null;
    try{ localStorage.removeItem('hireos_session'); }catch(_){}
  }
}
document.addEventListener('DOMContentLoaded', restoreSession);
if(document.readyState !== 'loading') restoreSession();

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginErr');
  errEl.textContent = '';
  try{
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method:'POST',
      headers:{'apikey':ANON_KEY,'Content-Type':'application/json'},
      body: JSON.stringify({email, password})
    });
    const rawText = await res.text();
    let data;
    try{ data = JSON.parse(rawText); }catch(parseErr){
      throw new Error(`HTTP ${res.status} — non-JSON response: ${rawText.slice(0,200)}`);
    }
    if(!res.ok) throw new Error(`HTTP ${res.status} — ${data.error_description || data.msg || data.error || JSON.stringify(data)}`);
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      user: data.user
    };
    saveSession();
    const profiles = await rest('users', {query:`auth_id=eq.${data.user.id}&select=*`});
    if(!profiles || !profiles.length) throw new Error('No HireOS profile linked to this login. Contact admin.');
    profile = profiles[0];
    enterApp();
  }catch(e){
    errEl.textContent = e.message;
    console.error('Login error detail:', e);
  }
}

function logout(){
  session = null; profile = null;
  try{ localStorage.removeItem('hireos_session'); }catch(e){}
  document.getElementById('app').classList.remove('active');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginEmail').value=''; document.getElementById('loginPassword').value='';
}

function enterApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').classList.add('active');
  document.getElementById('rolePill').textContent = profile.role;
  const catLabel = profile.hiring_categories?.length ? ' · ' + profile.hiring_categories.join(', ') : '';
  document.getElementById('whoAmI').textContent = profile.full_name + catLabel;
  if(profile.role === 'bd') renderBD();
  else if(profile.role === 'recruiter') renderRecruiter();
  else if(profile.role === 'client') renderClient();
  else if(profile.role === 'candidate') renderCandidatePortal();
  else renderAdmin();
}

// ============================================================
// 4. BD DASHBOARD
// ============================================================
async function renderBD(){
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="tabbar">
      <button id="tabDash" class="active" onclick="bdTab('dash')">Dashboard</button>
      <button id="tabClients" onclick="bdTab('clients')">Clients</button>
      <button id="tabReqs" onclick="bdTab('reqs')">Requisitions</button>
      <button id="tabLeads" onclick="bdTab('leads')">Leads</button>
    </div><div id="bdBody"></div>`;
  window.bdTab = async function(which){
    document.getElementById('tabDash').classList.toggle('active', which==='dash');
    document.getElementById('tabClients').classList.toggle('active', which==='clients');
    document.getElementById('tabReqs').classList.toggle('active', which==='reqs');
    document.getElementById('tabLeads').classList.toggle('active', which==='leads');
    if(which==='dash') await renderBDDashboard();
    else if(which==='clients') await renderClientsTab();
    else if(which==='reqs') await renderReqsTab();
    else await renderLeadsTab();
  };
  await renderBDDashboard();
}

async function renderBDDashboard(){
  const body = document.getElementById('bdBody');
  body.innerHTML = `<div class="empty">Loading…</div>`;
  const [reqs, clients, leads, activities] = await Promise.all([
    rest('requisitions', {query:'select=status'}),
    rest('clients', {query:'select=status'}),
    rest('leads', {query:'select=stage,estimated_deal_value,win_probability,last_interaction_at'}),
    rest('activities', {query:`actor_id=eq.${profile.id}&select=*&order=created_at.desc&limit=15`})
  ]);
  const reqCounts = {}; reqs.forEach(r=>{ reqCounts[r.status]=(reqCounts[r.status]||0)+1; });
  const clientCounts = {}; clients.forEach(c=>{ clientCounts[c.status]=(clientCounts[c.status]||0)+1; });
  const openLeads = leads.filter(l=>!['Won','Lost'].includes(l.stage));
  const weighted = openLeads.reduce((s,l)=> s + ((l.estimated_deal_value||0)*(l.win_probability||0)/100), 0);
  const won = leads.filter(l=>l.stage==='Won').length;
  const lost = leads.filter(l=>l.stage==='Lost').length;
  const convRate = (won+lost) ? Math.round(won/(won+lost)*100) : null;
  const staleCount = openLeads.filter(l=> (new Date() - new Date(l.last_interaction_at)) > 7*864e5).length;

  body.innerHTML = `
    <div class="section-title"><h2>Dashboard</h2></div>
    <div class="grid" style="margin-bottom:14px;">
      <div class="card"><div class="meta-row">Requisitions open</div><div class="req-title" style="font-size:22px;">${reqCounts.open||0}</div></div>
      <div class="card"><div class="meta-row">Active clients</div><div class="req-title" style="font-size:22px;">${clientCounts.active||0}</div></div>
      <div class="card"><div class="meta-row">Weighted pipeline</div><div class="req-title" style="font-size:19px;">₹${Math.round(weighted).toLocaleString('en-IN')}</div></div>
      <div class="card"><div class="meta-row">Lead conversion rate</div><div class="req-title" style="font-size:22px;">${convRate===null?'—':convRate+'%'}</div></div>
    </div>
    ${staleCount>0 ? `<div class="card" style="border-color:var(--warn);margin-bottom:14px;"><div class="meta-row" style="color:var(--warn);font-weight:600;">${staleCount} lead(s) need follow-up — check the Leads tab</div></div>` : ''}
    <div class="section-title"><h2>Breakdown</h2></div>
    <div class="meta-row" style="margin-bottom:14px;">Requisitions: ${Object.entries(reqCounts).map(([s,n])=>`${n} ${s}`).join(' · ')||'None yet'}<br/>Clients: ${Object.entries(clientCounts).map(([s,n])=>`${n} ${s}`).join(' · ')||'None yet'}</div>
    <div class="section-title"><h2>My recent activity</h2></div>
    <div>${activities.length ? activities.map(a=>`<div class="meta-row" style="padding:6px 0;border-bottom:1px solid var(--line);">${a.action.replace(/_/g,' ')} ${a.detail?('— '+a.detail):''} <span style="opacity:.6;">· ${new Date(a.created_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span></div>`).join('') : `<div class="empty">No activity logged yet.</div>`}</div>`;
}

let clientStatusFilter = 'active';
function setClientFilter(f){ clientStatusFilter = f; renderClientsTab(); }
async function renderClientsTab(){
  const clients = await rest('clients', {query:'select=*&order=created_at.desc'});
  const body = document.getElementById('bdBody');
  body.innerHTML = `
    <div class="section-title"><h2>Clients</h2><button class="btn-secondary" onclick="openClientModal()">+ Add client</button></div>
    <div class="tabbar" style="margin-bottom:10px;">
      <button class="${clientStatusFilter==='active'?'active':''}" onclick="setClientFilter('active')">Active</button>
      <button class="${clientStatusFilter==='prospect'?'active':''}" onclick="setClientFilter('prospect')">Prospect</button>
      <button class="${clientStatusFilter==='inactive'?'active':''}" onclick="setClientFilter('inactive')">Inactive</button>
      <button class="${clientStatusFilter==='all'?'active':''}" onclick="setClientFilter('all')">All</button>
    </div>
    <div class="grid" id="clientGrid"></div>`;
  const filtered = clientStatusFilter==='all' ? clients : clients.filter(c=>c.status===clientStatusFilter);
  const grid = document.getElementById('clientGrid');
  grid.innerHTML = filtered.length ? filtered.map(c => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div class="req-title">${c.company_name}</div>
        <span class="badge ${c.status==='active'?'open':(c.status==='prospect'?'draft':'closed')}">${c.status}</span>
      </div>
      <div class="meta-row">${c.segment} · Fee ${c.fee_pct}% + ${c.gst_pct}% GST</div>
      <div class="meta-row">${c.contact_name||''} ${c.contact_email? '· '+c.contact_email:''} ${c.contact_phone? '· '+c.contact_phone:''}</div>
      <div class="meta-row">Replacement guarantee: ${c.replacement_guarantee_days} days</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="icon-btn" onclick='openClientModal(${JSON.stringify(c)})'>Edit</button>
        <button class="icon-btn" onclick="openInteractionModal('${c.id}')">Log interaction</button>
        <button class="icon-btn" onclick="toggleInteractions('${c.id}')">History</button>
      </div>
      <div id="interactions_${c.id}" class="hidden" style="margin-top:8px;"></div>
    </div>`).join('') : `<div class="empty">No ${clientStatusFilter==='all'?'':clientStatusFilter+' '}clients${clientStatusFilter==='all'?' yet. Add your first client to start raising requisitions.':' — try the All tab, or add a new client.'}</div>`;
}

function openInteractionModal(clientId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Log interaction</h3>
    <label>Type</label><select id="in_type"><option value="call">Call</option><option value="meeting">Meeting</option><option value="email">Email</option><option value="other">Other</option></select>
    <label>Notes</label><textarea id="in_notes" rows="3"></textarea>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveInteraction('${clientId}')">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveInteraction(clientId){
  await rest('client_interactions', {method:'POST', body:{
    client_id: clientId, logged_by: profile.id,
    interaction_type: document.getElementById('in_type').value,
    notes: document.getElementById('in_notes').value
  }});
  closeModal(); toast('Interaction logged');
  const histEl = document.getElementById('interactions_'+clientId);
  if(!histEl.classList.contains('hidden')) loadInteractions(clientId);
}
async function toggleInteractions(clientId){
  const el = document.getElementById('interactions_'+clientId);
  if(!el.classList.contains('hidden')){ el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  await loadInteractions(clientId);
}
async function loadInteractions(clientId){
  const el = document.getElementById('interactions_'+clientId);
  el.innerHTML = `<div class="empty">Loading…</div>`;
  const rows = await rest('client_interactions', {query:`client_id=eq.${clientId}&select=*,users(full_name)&order=occurred_at.desc`});
  el.innerHTML = rows.length ? rows.map(r=>`
    <div class="meta-row" style="padding:6px 0;border-bottom:1px solid var(--line);">
      <span class="stage-pill">${r.interaction_type}</span> ${r.notes||''} — <span style="opacity:.7;">${r.users?.full_name||''} · ${new Date(r.occurred_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
    </div>`).join('') : `<div class="empty">No interactions logged yet.</div>`;
}

function openClientModal(existing){
  const c = existing || {};
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>${existing ? 'Edit client' : 'Add client'}</h3>
    <input type="hidden" id="c_id" value="${c.id||''}" />
    <label>Company name *</label><input id="c_name" value="${c.company_name||''}" />
    <label>Segment *</label><select id="c_segment">${SEGMENTS.map(s=>`<option ${s===c.segment?'selected':''}>${s}</option>`).join('')}</select>
    <label>Status</label><select id="c_status">
      <option value="prospect" ${c.status==='prospect'||!existing?'selected':''}>Prospect</option>
      <option value="active" ${c.status==='active'?'selected':''}>Active</option>
      <option value="inactive" ${c.status==='inactive'?'selected':''}>Inactive</option>
    </select>
    <div class="row2">
      <div><label>Contact name</label><input id="c_contact" value="${c.contact_name||''}" /></div>
      <div><label>Contact email</label><input id="c_email" value="${c.contact_email||''}" /></div>
    </div>
    <label>Contact phone</label><input id="c_phone" value="${c.contact_phone||''}" />
    <div class="row2">
      <div><label>Fee % *</label><input id="c_fee" value="${c.fee_pct??8.33}" /></div>
      <div><label>GST % *</label><input id="c_gst" value="${c.gst_pct??18}" /></div>
    </div>
    <label>Replacement guarantee (days)</label><input id="c_guarantee" value="${c.replacement_guarantee_days??90}" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveClient()">Save client</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
function closeModal(){ const m = document.getElementById('modalBg'); if(m) m.remove(); }

async function saveClient(){
  const id = document.getElementById('c_id').value;
  const body = {
    company_name: document.getElementById('c_name').value,
    segment: document.getElementById('c_segment').value,
    status: document.getElementById('c_status').value,
    contact_name: document.getElementById('c_contact').value,
    contact_email: document.getElementById('c_email').value,
    contact_phone: document.getElementById('c_phone').value,
    fee_pct: parseFloat(document.getElementById('c_fee').value)||8.33,
    gst_pct: parseFloat(document.getElementById('c_gst').value)||18,
    replacement_guarantee_days: parseInt(document.getElementById('c_guarantee').value)||90
  };
  if(!body.company_name){ toast('Company name required'); return; }
  if(id){
    await rest('clients', {method:'PATCH', query:`id=eq.${id}`, body});
  } else {
    body.created_by = profile.id;
    await rest('clients', {method:'POST', body});
  }
  closeModal(); toast(id?'Client updated':'Client added'); renderClientsTab();
}

async function renderReqsTab(){
  const [reqs, clients, recruiters, bdUsers] = await Promise.all([
    rest('requisitions', {query:'select=*&order=created_at.desc'}),
    rest('clients', {query:'select=id,company_name,segment'}),
    rest('users', {query:'role=eq.recruiter&select=id,full_name,hiring_categories'}),
    rest('users', {query:'role=eq.bd&select=id,full_name'})
  ]);
  const body = document.getElementById('bdBody');
  body.innerHTML = `
    <div class="section-title"><h2>Requisitions</h2><button class="btn-secondary" onclick='openReqModal(${JSON.stringify(clients)})'>+ New requisition</button></div>
    <div id="reqList"></div>`;
  const list = document.getElementById('reqList');
  if(!reqs.length){ list.innerHTML = `<div class="empty">No requisitions yet. Add one and assign it to a recruiter to get it moving.</div>`; return; }
  const isAdmin = profile.role === 'admin';
  list.innerHTML = reqs.map(r => {
    const eligible = recruiters.filter(rc => (rc.hiring_categories||[]).includes(r.hiring_category));
    const assignedName = recruiters.find(rc=>rc.id===r.assigned_recruiter_id)?.full_name || '';
    const bdOwnerName = bdUsers.find(b=>b.id===r.bd_owner_id)?.full_name || '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="req-title">${r.title} ${r.source==='client_submitted'?'<span class="badge on_hold">Client submitted</span>':''}</div>
          <div class="meta-row"><span class="stage-pill">${r.hiring_category||'No category'}</span> · ${r.segment} · CTC ${r.ctc_min||'?'}–${r.ctc_max||'?'} · ${r.openings} opening(s)</div>
        </div>
        <span class="badge ${r.status}">${r.status.replace('_',' ')}</span>
      </div>
      <hr class="divider"/>
      <div class="meta-row">Assigned recruiter: <b>${assignedName || 'Not assigned'}</b> · BD owner: <b>${bdOwnerName || 'Unclaimed'}</b></div>
      ${!r.bd_owner_id && r.source==='client_submitted' ? `<button class="icon-btn" style="margin-top:8px;" onclick="claimRequisition('${r.id}')">Claim this requirement</button>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        ${!r.assigned_recruiter_id ? `<select id="assign_${r.id}" style="width:auto;padding:6px 8px;font-size:12.5px;">
            <option value="">Assign recruiter…</option>
            ${eligible.map(rc=>`<option value="${rc.id}">${rc.full_name}</option>`).join('')}
          </select><button class="icon-btn" onclick="assignRecruiter('${r.id}')">Assign</button>` : ''}
        ${r.status==='draft' ? `<button class="icon-btn" onclick="publishReq('${r.id}')">Publish job</button>` : ''}
        ${r.status==='open' ? `<button class="icon-btn" onclick="setReqStatus('${r.id}','on_hold')">Put on hold</button>` : ''}
        ${r.status==='on_hold' ? `<button class="icon-btn" onclick="setReqStatus('${r.id}','open')">Reopen</button>` : ''}
        <button class="icon-btn" onclick='openReqModal(${JSON.stringify(clients)}, ${JSON.stringify(r)})'>Edit</button>
        <button class="icon-btn" onclick="togglePipeline('${r.id}')">Pipeline</button>
      </div>
      <div id="pipeline_${r.id}" class="hidden" style="margin-top:8px;"></div>
      ${isAdmin ? `
      <hr class="divider"/>
      <div class="meta-row" style="font-weight:600;">Admin oversight</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <select id="reassignBD_${r.id}" style="width:auto;padding:6px 8px;font-size:12.5px;">
          <option value="">Reassign BD owner…</option>
          ${bdUsers.map(b=>`<option value="${b.id}" ${b.id===r.bd_owner_id?'selected':''}>${b.full_name}</option>`).join('')}
        </select><button class="icon-btn" onclick="reassignBD('${r.id}')">Reassign</button>
        <select id="reassignRec_${r.id}" style="width:auto;padding:6px 8px;font-size:12.5px;">
          <option value="">Reassign recruiter…</option>
          ${eligible.map(rc=>`<option value="${rc.id}" ${rc.id===r.assigned_recruiter_id?'selected':''}>${rc.full_name}</option>`).join('')}
        </select><button class="icon-btn" onclick="reassignRecruiter('${r.id}')">Reassign</button>
        <select id="overrideStatus_${r.id}" style="width:auto;padding:6px 8px;font-size:12.5px;">
          ${['draft','open','on_hold','closed','cancelled'].map(s=>`<option value="${s}" ${s===r.status?'selected':''}>${s}</option>`).join('')}
        </select><button class="icon-btn" onclick="overrideStatus('${r.id}')">Override status</button>
      </div>` : ''}
    </div>`;
  }).join('');
}
async function reassignRecruiter(reqId){
  const sel = document.getElementById('reassignRec_'+reqId);
  if(!sel.value){ toast('Choose a recruiter'); return; }
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{assigned_recruiter_id: sel.value}});
  toast('Recruiter reassigned'); renderReqsTab();
}

function openReqModal(clients, existing){
  const r = existing || {};
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>${existing ? 'Edit requisition' : 'New requisition'}</h3>
    <input type="hidden" id="r_id" value="${r.id||''}" />
    <label>Client *</label><select id="r_client">${clients.map(c=>`<option value="${c.id}" ${c.id===r.client_id?'selected':''}>${c.company_name}</option>`).join('')}</select>
    <label>Job title *</label><input id="r_title" placeholder="e.g. Site Engineer - Civil" value="${r.title||''}" />
    <label>Hiring category *</label><select id="r_category">${CATEGORIES.map(c=>`<option ${c===r.hiring_category?'selected':''}>${c}</option>`).join('')}</select>
    <label>Industry (context only)</label><select id="r_segment">${SEGMENTS.map(s=>`<option ${s===r.segment?'selected':''}>${s}</option>`).join('')}</select>
    <div class="row2"><div><label>CTC min (LPA) *</label><input id="r_ctcmin" value="${r.ctc_min||''}" /></div><div><label>CTC max (LPA) *</label><input id="r_ctcmax" value="${r.ctc_max||''}" /></div></div>
    <div class="row2"><div><label>Experience min (yrs)</label><input id="r_expmin" value="${r.experience_min||''}" /></div><div><label>Experience max (yrs)</label><input id="r_expmax" value="${r.experience_max||''}" /></div></div>
    <div class="row2"><div><label>Openings *</label><input id="r_openings" value="${r.openings||1}" /></div><div><label>Priority</label>
      <select id="r_priority">${['medium','high','urgent','low'].map(p=>`<option ${p===r.priority?'selected':''}>${p}</option>`).join('')}</select></div></div>
    <label>Attach JD file (optional — PDF, DOCX, or TXT)</label>
    <div style="display:flex;gap:8px;align-items:center;">
      <input type="file" id="r_jd_file" accept=".pdf,.doc,.docx,.txt" style="flex:1;padding:8px;font-size:12.5px;" />
      <button class="btn-secondary" id="extractBtn" style="white-space:nowrap;" onclick="extractJDFile(this)">📎 Extract</button>
    </div>
    <label>Quick brief for AI (optional — what the client told you)</label>
    <div style="display:flex;gap:8px;">
      <input id="r_brief" placeholder="e.g. Client needs 3 Site Engineers for their new EPC project in Pune, budget up to 9 LPA, immediate joiners preferred" style="flex:1;" />
      <button class="btn-secondary" style="white-space:nowrap;" onclick="aiGenerateJD(this)">✨ Generate JD</button>
    </div>
    <label>Job description / requirements *</label><textarea id="r_jd" rows="4">${r.jd_text||''}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;">
      ${existing ? `
        <button class="btn-primary" style="margin-top:0;" onclick="saveReq()">Save changes</button>
      ` : `
        <button class="btn-primary" style="margin-top:0;background:var(--ink-soft);" onclick="saveReq('draft')">Save as draft</button>
        <button class="btn-primary" style="margin-top:0;" onclick="saveReq('open')">Save &amp; publish</button>
      `}
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}

// ---------- JD file upload + AI extraction ----------
function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
let mammothLoaded = false;
function ensureMammothLoaded(){
  return new Promise((resolve,reject)=>{
    if(mammothLoaded || window.mammoth){ mammothLoaded = true; resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    script.onload = () => { mammothLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Could not load DOCX parser'));
    document.head.appendChild(script);
  });
}
async function extractFieldsFromText(text){
  const res = await fetch(AI_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
    body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:600, messages:[{role:'user', content:
      `Extract structured fields from this job description. Respond ONLY with valid JSON, no markdown fences: {"title":"...", "ctc_min": <number or null, LPA>, "ctc_max": <number or null, LPA>, "experience_min": <number or null, years>, "experience_max": <number or null, years>, "jd_summary": "cleaned up 4-6 line description covering must-have and good-to-have skills"}

JOB DESCRIPTION TEXT:
${text.slice(0,6000)}`}]})
  });
  const data = await res.json();
  return JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
}
async function extractFieldsFromPDF(base64){
  const res = await fetch(AI_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
    body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:600, messages:[{role:'user', content:[
      {type:'document', source:{type:'base64', media_type:'application/pdf', data: base64}},
      {type:'text', text:`Extract structured fields from this job description PDF. Respond ONLY with valid JSON, no markdown fences: {"title":"...", "ctc_min": <number or null, LPA>, "ctc_max": <number or null, LPA>, "experience_min": <number or null, years>, "experience_max": <number or null, years>, "jd_summary": "cleaned up 4-6 line description covering must-have and good-to-have skills"}`}
    ]}]})
  });
  const data = await res.json();
  return JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
}
async function extractJDFile(btn){
  const file = document.getElementById('r_jd_file').files[0];
  if(!file){ toast('Choose a file first'); return; }
  const orig = btn.textContent; btn.textContent = 'Extracting…'; btn.disabled = true;
  try{
    const ext = file.name.split('.').pop().toLowerCase();
    let fields;
    if(ext === 'pdf'){
      fields = await extractFieldsFromPDF(await fileToBase64(file));
    } else if(ext === 'docx' || ext === 'doc'){
      await ensureMammothLoaded();
      const result = await mammoth.extractRawText({arrayBuffer: await file.arrayBuffer()});
      fields = await extractFieldsFromText(result.value);
    } else {
      fields = await extractFieldsFromText(await file.text());
    }
    if(fields.title) document.getElementById('r_title').value = fields.title;
    if(fields.ctc_min) document.getElementById('r_ctcmin').value = fields.ctc_min;
    if(fields.ctc_max) document.getElementById('r_ctcmax').value = fields.ctc_max;
    if(fields.experience_min) document.getElementById('r_expmin').value = fields.experience_min;
    if(fields.experience_max) document.getElementById('r_expmax').value = fields.experience_max;
    if(fields.jd_summary) document.getElementById('r_jd').value = fields.jd_summary;
    toast('Fields extracted — review before saving');
  }catch(e){ toast('Extraction failed: ' + e.message); }
  btn.textContent = orig; btn.disabled = false;
}

async function aiGenerateJD(btn){
  const origText = btn.textContent; btn.textContent = 'Generating…'; btn.disabled = true;
  const title = document.getElementById('r_title').value;
  const category = document.getElementById('r_category').value;
  const segment = document.getElementById('r_segment').value;
  const ctcMin = document.getElementById('r_ctcmin').value;
  const ctcMax = document.getElementById('r_ctcmax').value;
  const brief = document.getElementById('r_brief').value;
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:
        `Write a structured job description for a recruitment agency. Respond with plain text only, no markdown headers, using this shape: a 1-2 sentence role summary, then "Must-have skills:" with a short list, then "Good-to-have skills:" with a short list, then "Experience:" with a range.

Job title: ${title||'Not specified'}
Hiring category: ${category}
Industry context: ${segment}
CTC band: ${ctcMin||'?'}-${ctcMax||'?'} LPA
Recruiter's brief: ${brief||'Not provided — infer reasonably from the title and category.'}`}]})
    });
    const data = await res.json();
    const text = data.content.find(b=>b.type==='text').text;
    document.getElementById('r_jd').value = text;
  }catch(e){ toast('AI generation failed: ' + e.message); }
  btn.textContent = origText; btn.disabled = false;
}

async function saveReq(explicitStatus){
  const id = document.getElementById('r_id').value;
  const title = document.getElementById('r_title').value;
  const ctcMin = document.getElementById('r_ctcmin').value;
  const ctcMax = document.getElementById('r_ctcmax').value;
  const openings = document.getElementById('r_openings').value;
  const jd = document.getElementById('r_jd').value;
  if(!title || !ctcMin || !ctcMax || !openings || !jd){ toast('Please fill all required (*) fields'); return; }
  const body = {
    client_id: document.getElementById('r_client').value,
    title,
    hiring_category: document.getElementById('r_category').value,
    segment: document.getElementById('r_segment').value,
    ctc_min: parseFloat(ctcMin)||null,
    ctc_max: parseFloat(ctcMax)||null,
    experience_min: parseInt(document.getElementById('r_expmin').value)||null,
    experience_max: parseInt(document.getElementById('r_expmax').value)||null,
    openings: parseInt(openings)||1,
    priority: document.getElementById('r_priority').value,
    jd_text: jd
  };
  if(id){
    await rest('requisitions', {method:'PATCH', query:`id=eq.${id}`, body});
    closeModal(); toast('Requisition updated'); renderReqsTab();
  } else {
    body.status = explicitStatus || 'draft';
    body.bd_owner_id = profile.id;
    await rest('requisitions', {method:'POST', body});
    closeModal(); toast(explicitStatus==='open' ? 'Published — recruiter will see it now' : 'Saved as draft'); renderReqsTab();
  }
}

async function togglePipeline(reqId){
  const el = document.getElementById('pipeline_'+reqId);
  if(!el.classList.contains('hidden')){ el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="empty">Loading…</div>`;
  const apps = await rest('applications', {query:`requisition_id=eq.${reqId}&select=*,candidates(id,full_name,experience_yrs,current_ctc,expected_ctc,notice_period_days)`});
  if(!apps.length){ el.innerHTML = `<div class="empty">No candidates in the pipeline yet.</div>`; return; }
  const counts = {};
  apps.forEach(a=>{ counts[a.current_stage] = (counts[a.current_stage]||0)+1; });
  const summary = Object.entries(counts).map(([s,n])=>`${n} ${s}`).join(' · ');
  el.innerHTML = `<div class="meta-row" style="font-weight:600;margin-bottom:8px;">${summary}</div>` +
    apps.map(a=>`<div class="app-row">
      <div><div class="name">${a.candidates.full_name}</div><div class="sub"><span class="stage-pill">${a.current_stage}</span></div></div>
      <button class="icon-btn" onclick='generateClientSummary(${JSON.stringify(a)})'>Client summary</button>
    </div>`).join('');
}

async function generateClientSummary(app){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Client-ready summary — ${app.candidates.full_name}</h3><div id="summaryBox" class="ai-box">Generating…</div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
  const c = app.candidates;
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:400, messages:[{role:'user', content:
        `Write a client-ready candidate summary a recruiter can paste directly into an email to a client. Plain text, professional, 4-6 short lines covering: experience level, current/expected CTC, notice period, and a brief note on career direction. Do NOT include family background, marital status, or anything like that — those fields are deliberately excluded.

Candidate: ${c.full_name}
Experience: ${c.experience_yrs||'?'} yrs
Current CTC: ${c.current_ctc||'?'} LPA, Expected: ${c.expected_ctc||'?'} LPA
Notice period: ${c.notice_period_days||'?'} days
AI match notes: ${app.ai_match_detail ? JSON.stringify(app.ai_match_detail) : 'Not available'}`}]})
    });
    const data = await res.json();
    const text = data.content.find(b=>b.type==='text').text;
    document.getElementById('summaryBox').innerHTML = text.replace(/\n/g,'<br/>');
  }catch(e){ document.getElementById('summaryBox').textContent = 'Failed: ' + e.message; }
}

async function claimRequisition(reqId){
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{bd_owner_id: profile.id}});
  toast('Requirement claimed — now visible only in your list'); renderReqsTab();
}

async function assignRecruiter(reqId){
  const sel = document.getElementById('assign_'+reqId);
  if(!sel.value){ toast('Choose a recruiter first'); return; }
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{assigned_recruiter_id: sel.value}});
  toast('Recruiter assigned'); renderReqsTab();
}
async function publishReq(reqId){
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{status:'open'}});
  await rest('activities', {method:'POST', body:{entity_type:'requisition', entity_id:reqId, actor_id:profile.id, action:'published', detail:'Job published to recruiter queue'}});
  toast('Job published — recruiter will now see it'); renderReqsTab();
}
async function setReqStatus(reqId, status){
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{status}});
  toast('Status updated'); renderReqsTab();
}

// ============================================================
// 5. RECRUITER DASHBOARD
// ============================================================
async function renderRecruiter(){
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="tabbar">
      <button id="tabRecDash" class="active" onclick="recTab('dash')">Dashboard</button>
      <button id="tabRecJobs" onclick="recTab('jobs')">Open Jobs</button>
      <button id="tabRecSearch" onclick="recTab('search')">Candidate Search</button>
    </div><div id="recBody"></div>`;
  window.recTab = async function(which){
    document.getElementById('tabRecDash').classList.toggle('active', which==='dash');
    document.getElementById('tabRecJobs').classList.toggle('active', which==='jobs');
    document.getElementById('tabRecSearch').classList.toggle('active', which==='search');
    const holder = document.getElementById('recBody');
    holder.innerHTML = `<div class="empty">Loading…</div>`;
    if(which==='dash') await renderRecruiterDashboard(holder);
    else if(which==='jobs') await renderRecruiterJobs(holder);
    else await renderCandidateSearch(holder);
  };
  await renderRecruiterDashboard(document.getElementById('recBody'));
}

async function renderRecruiterDashboard(container){
  const reqs = await rest('requisitions', {query:`status=eq.open&assigned_recruiter_id=eq.${profile.id}&select=id`});
  const reqIds = reqs.map(r=>r.id);
  if(!reqIds.length){
    container.innerHTML = `<div class="section-title"><h2>Dashboard</h2></div><div class="empty">No open jobs assigned yet.</div>`;
    return;
  }
  const filter = `requisition_id=in.(${reqIds.join(',')})`;
  const apps = await rest('applications', {query:`${filter}&select=*,candidates(full_name),requisitions(title)`});
  const activePipeline = apps.filter(a=>!['Placed','Rejected'].includes(a.current_stage));
  const now = new Date();
  const breaches = [];
  const slaMap = {}; (await rest('pipeline_stage_master', {query:'select=stage_name,sla_hours'})).forEach(s=>slaMap[s.stage_name]=s.sla_hours);
  const staleCandidates = [];
  activePipeline.forEach(a=>{
    const hrsInStage = (now - new Date(a.stage_entered_at))/36e5;
    if(slaMap[a.current_stage] && hrsInStage > slaMap[a.current_stage]) breaches.push({...a, hrsInStage});
    if(hrsInStage > 5*24) staleCandidates.push({...a, hrsInStage});
  });
  const today = now.toISOString().slice(0,10);
  const weekAhead = new Date(now.getTime()+7*864e5).toISOString().slice(0,10);
  const appIds = apps.map(a=>a.id);
  const interviews = appIds.length ? await rest('interviews', {query:`application_id=in.(${appIds.join(',')})&status=eq.scheduled&select=*`}) : [];
  const upcomingInterviews = interviews.filter(iv=>iv.scheduled_at && iv.scheduled_at.slice(0,10)>=today && iv.scheduled_at.slice(0,10)<=weekAhead);

  container.innerHTML = `
    <div class="section-title"><h2>Dashboard</h2></div>
    <div class="grid" style="margin-bottom:14px;">
      <div class="card"><div class="meta-row">Candidates in active pipeline</div><div class="req-title" style="font-size:22px;">${activePipeline.length}</div></div>
      <div class="card"><div class="meta-row">Interviews this week</div><div class="req-title" style="font-size:22px;">${upcomingInterviews.length}</div></div>
      <div class="card"><div class="meta-row">SLA breaches</div><div class="req-title" style="font-size:22px;">${breaches.length}</div></div>
    </div>
    ${staleCandidates.length ? `<div class="card" style="border-color:var(--warn);margin-bottom:14px;">
      <div class="meta-row" style="color:var(--warn);font-weight:600;margin-bottom:6px;">${staleCandidates.length} candidate(s) untouched for 5+ days:</div>
      ${staleCandidates.map(a=>`<div class="meta-row">${a.candidates.full_name} — ${a.requisitions.title} (${a.current_stage}, ${Math.round(a.hrsInStage/24)}d)</div>`).join('')}
    </div>` : ''}
    ${breaches.length ? `<div class="section-title"><h2>SLA breaches</h2></div>
      <div>${breaches.map(a=>`<div class="app-row"><div><div class="name">${a.candidates.full_name} — ${a.requisitions.title}</div><div class="sub">Stuck in "${a.current_stage}" — ${Math.round(a.hrsInStage)}h</div></div><span class="badge on_hold">breach</span></div>`).join('')}</div>` : ''}
  `;
}

function toggleJD(reqId){ document.getElementById('jd_'+reqId).classList.toggle('hidden'); }

async function toggleClientReveal(reqId, newValue){
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{client_name_revealed: newValue}});
  toast(newValue ? 'Client name now visible to candidates on this job' : 'Client name hidden from candidates again');
  const container = document.getElementById('recBody') || document.getElementById('adminBody');
  renderRecruiterJobs(container);
}

async function renderRecruiterJobs(container){
  const reqs = await rest('requisitions', {query:'status=eq.open&select=*&order=priority.desc'});
  container.innerHTML = `<div class="section-title"><h2>Your open jobs</h2></div><div id="reqList"></div>`;
  const list = document.getElementById('reqList');
  if(!reqs.length){ list.innerHTML = `<div class="empty">No open jobs assigned to your segment yet. Once BD publishes a requisition matching your segments, it'll appear here.</div>`; return; }
  list.innerHTML = reqs.map(r => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="req-title">${r.title}</div>
          <div class="meta-row"><span class="stage-pill">${r.hiring_category||''}</span> · ${r.segment} · CTC ${r.ctc_min||'?'}–${r.ctc_max||'?'} · ${r.openings} opening(s) · Priority: ${r.priority}</div>
        </div>
        <span class="badge open">open</span>
      </div>
      <div id="apps_${r.id}" class="app-list"></div>
      <div id="bulkBar_${r.id}" class="hidden" style="margin-top:8px;padding:8px;background:var(--orange-light);border-radius:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="meta-row" style="margin:0;">Move selected to:</span>
        <select id="bulkStage_${r.id}" style="width:auto;padding:5px 6px;font-size:12px;">${STAGES.map(s=>`<option>${s}</option>`).join('')}</select>
        <button class="icon-btn" onclick="bulkMoveStage('${r.id}')">Apply</button>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="icon-btn" onclick='openCandidateModal(${JSON.stringify(r)})'>+ Add candidate</button>
        <button class="icon-btn" onclick="exportCandidatesCSV('${r.id}','${(r.title||'job').replace(/[^a-z0-9]/gi,'_')}')">⬇ Export CSV</button>
        <button class="icon-btn" onclick='openImportCandidatesModal(${JSON.stringify(r.id)})'>⬆ Import CSV</button>
        <button class="icon-btn" onclick="toggleJD('${r.id}')">View JD</button>
        <button class="icon-btn" onclick='openSourcingToolkit(${JSON.stringify(r)})'>🔍 Sourcing toolkit</button>
        <button class="icon-btn" onclick="toggleClientReveal('${r.id}', ${!r.client_name_revealed})">${r.client_name_revealed ? '🔓 Client name shown to candidates' : '🔒 Client name hidden from candidates'}</button>
      </div>
      <div id="jd_${r.id}" class="hidden meta-row" style="margin-top:8px;white-space:pre-wrap;">${(r.jd_text||'No JD text provided.')}</div>
    </div>`).join('');
  reqs.forEach(r => loadApplications(r.id));
}

// ---------- Candidate search across whole database ----------
async function renderCandidateSearch(container){
  container.innerHTML = `
    <div class="section-title"><h2>Candidate Search</h2></div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <input id="cand_search_q" placeholder="Search by skill, name, or current company" style="flex:1;" />
      <button class="btn-primary" style="margin-top:0;white-space:nowrap;" onclick="runCandidateSearch()">Search</button>
    </div>
    <div id="candSearchResults"></div>`;
}
async function runCandidateSearch(){
  const q = document.getElementById('cand_search_q').value.trim();
  const box = document.getElementById('candSearchResults');
  if(!q){ toast('Type something to search'); return; }
  box.innerHTML = `<div class="empty">Searching…</div>`;
  const results = await rest('candidates', {query:`or=(full_name.ilike.*${encodeURIComponent(q)}*,current_company.ilike.*${encodeURIComponent(q)}*,skills.cs.{${encodeURIComponent(q)}})&select=*&limit=30`});
  box.innerHTML = results.length ? results.map(c=>`
    <div class="card">
      <div class="req-title">${c.full_name}</div>
      <div class="meta-row">${c.current_company||'?'} · Exp ${c.experience_yrs||'?'} yrs · Current ${c.current_ctc||'?'} → Exp ${c.expected_ctc||'?'} LPA</div>
      <div class="meta-row">Skills: ${(c.skills||[]).join(', ')||'Not specified'}</div>
    </div>`).join('') : `<div class="empty">No matches found in the candidate database. Try the Sourcing toolkit on a specific job to search externally instead.</div>`;
}

// ---------- Sourcing toolkit (Boolean, X-ray, ad copy) ----------
function openSourcingToolkit(req){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Sourcing toolkit — ${req.title}</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
      <button class="btn-secondary" onclick='genPortals(${JSON.stringify(req)})'>Suggest portals</button>
      <button class="btn-secondary" onclick='genBoolean(${JSON.stringify(req)})'>Boolean string</button>
      <button class="btn-secondary" onclick='genXray(${JSON.stringify(req)})'>Google X-ray</button>
      <button class="btn-secondary" onclick='genAdCopy(${JSON.stringify(req)})'>Ad copy</button>
    </div>
    <div id="sourcingBox" class="ai-box" style="display:none;"></div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div>
  </div>`;
  document.body.appendChild(bg);
}
const PORTAL_MAP = {
  'Corporate Hiring': ['Naukri', 'LinkedIn', 'Shine'],
  'Executive Hiring': ['LinkedIn', 'iimjobs', 'Direct network/referral'],
  'RPO Model': ['Depends on client\'s existing channels — confirm with client before assuming'],
  'Bulk Hiring': ['Apna', 'WorkIndia', 'Naukri', 'Indeed'],
  'IT Hiring': ['Naukri', 'LinkedIn', 'Instahyre', 'Cutshort', 'Hirect']
};
async function genPortals(req){
  sourcingBoxShow('Generating…');
  const portals = PORTAL_MAP[req.hiring_category] || ['Naukri', 'LinkedIn'];
  const text = await callClaudeSimple(`For this exact role, give a one-line specific rationale (not generic) for why each of these portals would or wouldn't work well, considering the segment, CTC band, and location if mentioned in the JD. Plain text, no markdown, format as "Portal — rationale" one per line.

Candidate portals to assess: ${portals.join(', ')}

Title: ${req.title}
Hiring category: ${req.hiring_category}
Segment: ${req.segment}
CTC: ${req.ctc_min||'?'}-${req.ctc_max||'?'} LPA
JD: ${(req.jd_text||'').slice(0,1000)}`, 400);
  sourcingBoxShow(text);
}
function sourcingBoxShow(text){
  const box = document.getElementById('sourcingBox');
  box.style.display = 'block'; box.innerHTML = text.replace(/\n/g,'<br/>');
}
async function genBoolean(req){
  sourcingBoxShow('Generating…');
  const text = await callClaudeSimple(`Build a Boolean search string (using AND, OR, NOT, quotes for phrases) for sourcing candidates for this role. Include synonym expansion for title/skills. Give just the string plus a one-line note on what it targets, no markdown.

Title: ${req.title}
Segment: ${req.segment}
JD: ${(req.jd_text||'').slice(0,1000)}`, 300);
  sourcingBoxShow(text);
}
async function genXray(req){
  sourcingBoxShow('Generating…');
  const text = await callClaudeSimple(`Build a Google X-ray search string (site:linkedin.com/in operator, Boolean operators, exclusion terms like -jobs -recruiter -hiring) for sourcing candidates for this role. Give the raw string only, plus a one-line note, no markdown.

Title: ${req.title}
Segment: ${req.segment}
JD: ${(req.jd_text||'').slice(0,1000)}`, 300);
  sourcingBoxShow(text);
}
async function genAdCopy(req){
  sourcingBoxShow('Generating…');
  const text = await callClaudeSimple(`Write job ad copy for this role, in two short versions: one for LinkedIn (professional, slightly conversational tone) and one for Naukri (direct, keyword-forward tone for Indian job seekers). Plain text, no markdown headers, clearly label each version.

Title: ${req.title}
Segment: ${req.segment}
CTC: ${req.ctc_min||'?'}-${req.ctc_max||'?'} LPA
JD: ${(req.jd_text||'').slice(0,1500)}`, 600);
  sourcingBoxShow(text);
}
async function callClaudeSimple(prompt, maxTokens){
  const res = await fetch(AI_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
    body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:maxTokens||400, messages:[{role:'user', content:prompt}]})
  });
  const data = await res.json();
  return data.content.find(b=>b.type==='text').text;
}

// ---------- CSV export/import for candidates ----------
async function exportCandidatesCSV(reqId, filenameHint){
  const apps = await rest('applications', {query:`requisition_id=eq.${reqId}&select=*,candidates(*)`});
  const headers = ['full_name','email','phone','current_company','current_ctc','expected_ctc','experience_yrs','notice_period_days','skills','current_stage'];
  const rows = apps.map(a=>({...a.candidates, skills:(a.candidates.skills||[]).join('; '), current_stage:a.current_stage}));
  const csv = [headers.join(',')].concat(rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))).join('\n');
  downloadFile(csv, `candidates_${filenameHint}_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
  toast(`Exported ${rows.length} candidate(s)`);
}
function openImportCandidatesModal(reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Import candidates from CSV</h3>
    <p class="meta-row">Expected columns: full_name, email, phone, current_company, current_ctc, expected_ctc, experience_yrs, notice_period_days, skills (semicolon-separated). Only full_name is required.</p>
    <input type="file" id="import_cand_file" accept=".csv" style="margin-top:10px;" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="importCandidatesCSV(this,'${reqId}')">Import</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function importCandidatesCSV(btn, reqId){
  const file = document.getElementById('import_cand_file').files[0];
  if(!file){ toast('Choose a CSV file'); return; }
  const orig = btn.textContent; btn.textContent = 'Importing…'; btn.disabled = true;
  try{
    await ensurePapaLoaded();
    const text = await file.text();
    const parsed = Papa.parse(text, {header:true, skipEmptyLines:true});
    const rows = parsed.data.filter(r=>r.full_name && r.full_name.trim());
    if(!rows.length){ toast('No valid rows — full_name is required'); btn.textContent=orig; btn.disabled=false; return; }
    for(const r of rows){
      const candidateBody = {
        full_name: r.full_name.trim(),
        email: r.email||null, phone: r.phone||null, current_company: r.current_company||null,
        current_ctc: parseFloat(r.current_ctc)||null, expected_ctc: parseFloat(r.expected_ctc)||null,
        experience_yrs: parseFloat(r.experience_yrs)||null, notice_period_days: parseInt(r.notice_period_days)||null,
        skills: r.skills ? r.skills.split(';').map(s=>s.trim()).filter(Boolean) : []
      };
      await createCandidateAndApply(candidateBody, reqId, true);
    }
    closeModal(); toast(`Imported ${rows.length} candidate(s)`); loadApplications(reqId);
  }catch(e){ toast('Import failed: ' + e.message); btn.textContent=orig; btn.disabled=false; }
}

// ---------- Bulk stage actions ----------
function toggleBulkSelect(appId, reqId){
  const anyChecked = Array.from(document.querySelectorAll(`[data-req="${reqId}"].bulk-cb`)).some(el=>el.checked);
  document.getElementById('bulkBar_'+reqId).classList.toggle('hidden', !anyChecked);
}
async function bulkMoveStage(reqId){
  const newStage = document.getElementById('bulkStage_'+reqId).value;
  const checked = Array.from(document.querySelectorAll(`[data-req="${reqId}"].bulk-cb:checked`)).map(el=>el.dataset.app);
  if(!checked.length){ toast('Select at least one candidate'); return; }
  for(const appId of checked){
    await rest('applications', {method:'PATCH', query:`id=eq.${appId}`, body:{current_stage:newStage, stage_entered_at:new Date().toISOString()}});
  }
  toast(`Moved ${checked.length} candidate(s) to ${newStage}`); loadApplications(reqId);
}

async function loadApplications(reqId){
  const apps = await rest('applications', {query:`requisition_id=eq.${reqId}&select=*,candidates(*)&order=created_at.desc`});
  const el = document.getElementById('apps_'+reqId);
  if(!apps.length){ el.innerHTML = `<div class="meta-row" style="margin-top:8px;">No candidates added yet.</div>`; return; }
  const feedbackLabel = {interested:'Client: Interested', not_interested:'Client: Not interested', request_interview:'Client: Requested interview'};
  const feedbackBadgeClass = {interested:'open', not_interested:'closed', request_interview:'on_hold'};
  el.innerHTML = apps.map(a => `
    <div class="app-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <input type="checkbox" class="bulk-cb" data-req="${reqId}" data-app="${a.id}" id="bulkcb_${a.id}" onchange="toggleBulkSelect('${a.id}','${reqId}')" style="width:auto;margin-top:4px;" />
          <div>
            <div class="name">${a.candidates.full_name}</div>
            <div class="sub">Exp ${a.candidates.experience_yrs||'?'} yrs · Current ${a.candidates.current_ctc||'?'} → Exp ${a.candidates.expected_ctc||'?'} LPA · Notice ${a.candidates.notice_period_days||'?'}d</div>
            ${a.ai_match_score ? `<div class="sub">AI match: <b>${a.ai_match_score}/100</b></div>` : ''}
            ${a.current_stage!=='Sourced' && a.current_stage!=='Screened' ? `<div class="sub">${a.client_viewed_at ? `Client viewed ${new Date(a.client_viewed_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}${!a.client_feedback?' — no response yet':''}` : 'Client hasn\'t viewed yet'}</div>` : ''}
            ${a.client_feedback ? `<div class="sub" style="margin-top:3px;"><span class="badge ${feedbackBadgeClass[a.client_feedback]}">${feedbackLabel[a.client_feedback]}</span> ${a.client_feedback_note?' — '+a.client_feedback_note:''} ${a.client_feedback==='request_interview'?' — schedule one below':''}</div>` : ''}
            ${a.candidates.pending_resume_update ? `<div class="sub" style="margin-top:3px;"><span class="badge on_hold">Resume update pending review</span> <button class="icon-btn" style="padding:2px 8px;font-size:11px;" onclick='reviewResumeUpdate(${JSON.stringify(a.candidates)})'>Review</button></div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <select id="stage_${a.id}" style="width:auto;padding:5px 6px;font-size:12px;">
            ${STAGES.map(s=>`<option ${s===a.current_stage?'selected':''}>${s}</option>`).join('')}
          </select>
          <button class="icon-btn" onclick="moveStage('${a.id}','${reqId}')">Move</button>
          <button class="icon-btn" onclick='aiMatch(${JSON.stringify(a.id)}, ${JSON.stringify(reqId)})'>AI match</button>
          <button class="icon-btn" onclick='openCandidateModal(null, ${JSON.stringify(a.candidates)})'>Edit</button>
          <button class="icon-btn" onclick="toggleInterviews('${a.id}','${reqId}')">Interviews</button>
          <button class="icon-btn" onclick='draftStatusUpdate(${JSON.stringify(a)})'>✉ Draft update</button>
          <button class="icon-btn" onclick="viewMessageThreadReadOnly('${a.id}','${a.candidates.full_name}')">👁 View messages</button>
        </div>
      </div>
      <div id="interviews_${a.id}" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);"></div>
    </div>`).join('');
}

// ---------- A. Candidate status update drafts ----------
function reviewResumeUpdate(candidate){
  const diff = candidate.pending_resume_update;
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Resume update — ${candidate.full_name}</h3>
    <p class="meta-row">Candidate uploaded an updated resume. Suggested changes below — approve to apply, or dismiss to ignore.</p>
    <div class="ai-box">${Object.entries(diff).map(([field,val])=>`<div><b>${field}:</b> ${Array.isArray(val)?val.join(', '):val}</div>`).join('')}</div>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick='approveResumeUpdate(${JSON.stringify(candidate.id)})'>Approve &amp; apply</button>
      <button class="btn-ghost" onclick='dismissResumeUpdate(${JSON.stringify(candidate.id)})'>Dismiss</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function approveResumeUpdate(candidateId){
  const rows = await rest('candidates', {query:`id=eq.${candidateId}&select=pending_resume_update`});
  const diff = rows[0].pending_resume_update;
  const body = {...diff, pending_resume_update: null};
  await rest('candidates', {method:'PATCH', query:`id=eq.${candidateId}`, body});
  closeModal(); toast('Resume update applied');
  document.querySelectorAll('[id^="apps_"]').forEach(el=>{ const rid=el.id.replace('apps_',''); loadApplications(rid); });
}
async function dismissResumeUpdate(candidateId){
  await rest('candidates', {method:'PATCH', query:`id=eq.${candidateId}`, body:{pending_resume_update:null}});
  closeModal(); toast('Update dismissed');
  document.querySelectorAll('[id^="apps_"]').forEach(el=>{ const rid=el.id.replace('apps_',''); loadApplications(rid); });
}

async function viewMessageThreadReadOnly(appId, candidateName){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Messages — ${candidateName}</h3>
    <p class="meta-row">Read-only — this is the direct client-candidate thread, visible to you for oversight.</p>
    <div id="roMsgThread"></div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div>
  </div>`;
  document.body.appendChild(bg);
  const msgs = await rest('messages', {query:`application_id=eq.${appId}&select=*&order=sent_at`});
  document.getElementById('roMsgThread').innerHTML = msgs.length ? msgs.map(m=>`
    <div style="padding:6px 0;border-bottom:1px solid var(--line);">
      <span class="stage-pill">${m.sender_role==='client'?'Client':'Candidate'}</span>
      <span class="meta-row" style="display:inline;">${m.message_text}</span>
      <div style="font-size:11px;color:var(--ink-soft);">${new Date(m.sent_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`).join('') : `<div class="empty">No messages yet.</div>`;
}

async function draftStatusUpdate(app){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Status update — ${app.candidates.full_name}</h3><div id="updateBox" class="ai-box">Drafting…</div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
  const text = await callClaudeSimple(`Draft a short, warm, professional WhatsApp/SMS-style message to a job candidate updating them on their status. Plain text, under 60 words, no markdown. Match the tone to the stage — don't oversell, don't be cold.

Candidate: ${app.candidates.full_name}
Current stage: ${app.current_stage}

Write an appropriate update for exactly this stage (e.g. if "Submitted to Client", say their profile has been shared and next steps will follow soon; if "Client Interview R1", confirm interest and next-step framing; if "Offer Stage", congratulate and set expectation of details coming; if "Rejected", be respectful and brief).`, 250);
  document.getElementById('updateBox').innerHTML = text.replace(/\n/g,'<br/>');
}

// ---------- C. Smart scheduling assist ----------
async function draftSchedulingMessageFor(appId, reqId){
  const appRows = await rest('applications', {query:`id=eq.${appId}&select=*,candidates(full_name)`});
  await draftSchedulingMessage(appRows[0], reqId);
}
async function draftSchedulingMessage(app, reqId){
  const box = document.getElementById('prepBox_'+app.id) || (()=>{ const d=document.createElement('div'); d.id='prepBox_'+app.id; document.getElementById('interviews_'+app.id).appendChild(d); return d; })();
  box.innerHTML = `<div class="ai-box">Drafting…</div>`;
  const text = await callClaudeSimple(`Draft a short message to a candidate proposing 2-3 interview time-slot options (use generic placeholders like "Monday 11am / Tuesday 3pm / Wednesday 5pm" since exact times aren't set yet — the recruiter will fill in real times before sending). Plain text, under 60 words, professional but warm.

Candidate: ${app.candidates.full_name}`, 200);
  box.innerHTML = `<div class="ai-box">${text.replace(/\n/g,'<br/>')}</div>`;
}

function openCandidateModal(req, existing){
  const c = existing || {};
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>${existing ? 'Edit candidate — '+c.full_name : 'Add candidate — '+req.title}</h3>
    <input type="hidden" id="cd_id" value="${c.id||''}" />
    <input type="hidden" id="cd_reqid" value="${req?req.id:''}" />
    ${!existing ? `
      <label>Upload resume (PDF, DOCX, or TXT — optional)</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="file" id="cd_resume_file" accept=".pdf,.doc,.docx,.txt" style="flex:1;padding:8px;font-size:12.5px;" />
        <button class="btn-secondary" style="white-space:nowrap;" onclick="aiAutoFillResumeFile(this)">📎 Parse file</button>
      </div>
      <label style="margin-top:10px;">Or paste resume text</label>
      <textarea id="cd_resume_text" rows="3" placeholder="Paste the candidate's resume text here, then hit Auto-fill"></textarea>
      <button class="btn-secondary" style="margin-top:8px;" onclick="aiAutoFillResume(this)">✨ Auto-fill from pasted text</button>
      <hr class="divider"/>
    ` : ''}
    <label>Full name *</label><input id="cd_name" value="${c.full_name||''}" />
    <div class="row2"><div><label>Email</label><input id="cd_email" value="${c.email||''}" /></div><div><label>Phone</label><input id="cd_phone" value="${c.phone||''}" /></div></div>
    <div class="row2"><div><label>Current CTC (LPA)</label><input id="cd_cctc" value="${c.current_ctc||''}" /></div><div><label>Expected CTC (LPA)</label><input id="cd_ectc" value="${c.expected_ctc||''}" /></div></div>
    <div class="row2"><div><label>Experience (yrs)</label><input id="cd_exp" value="${c.experience_yrs||''}" /></div><div><label>Notice period (days)</label><input id="cd_notice" value="${c.notice_period_days||''}" /></div></div>
    <label>Current company</label><input id="cd_company" value="${c.current_company||''}" />
    <label>Resume URL</label><input id="cd_resume" value="${c.resume_url||''}" placeholder="Drive/Sheet link" />
    <label>Key skills (comma separated)</label><input id="cd_skills" value="${(c.skills||[]).join(', ')}" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveCandidate()">${existing?'Save changes':'Add to pipeline'}</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}

async function aiAutoFillResume(btn){
  const text = document.getElementById('cd_resume_text').value;
  if(!text.trim()){ toast('Paste some resume text first'); return; }
  const orig = btn.textContent; btn.textContent = 'Extracting…'; btn.disabled = true;
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:
        `Extract candidate fields from this resume text. Respond ONLY with valid JSON, no markdown fences: {"full_name":"...", "email": "... or null", "phone": "... or null", "current_company": "... or null", "experience_yrs": <number or null>, "skills": ["...", "..."]}

RESUME TEXT:
${text.slice(0,6000)}`}]})
    });
    const data = await res.json();
    const fields = JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
    if(fields.full_name) document.getElementById('cd_name').value = fields.full_name;
    if(fields.email) document.getElementById('cd_email').value = fields.email;
    if(fields.phone) document.getElementById('cd_phone').value = fields.phone;
    if(fields.current_company) document.getElementById('cd_company').value = fields.current_company;
    if(fields.experience_yrs) document.getElementById('cd_exp').value = fields.experience_yrs;
    if(fields.skills && fields.skills.length) document.getElementById('cd_skills').value = fields.skills.join(', ');
    toast('Fields extracted — review before saving');
  }catch(e){ toast('Extraction failed: ' + e.message); }
  btn.textContent = orig; btn.disabled = false;
}

async function aiAutoFillResumeFile(btn){
  const file = document.getElementById('cd_resume_file').files[0];
  if(!file){ toast('Choose a resume file first'); return; }
  const orig = btn.textContent; btn.textContent = 'Parsing…'; btn.disabled = true;
  try{
    const ext = file.name.split('.').pop().toLowerCase();
    let fields;
    if(ext === 'pdf'){
      const base64 = await fileToBase64(file);
      const res = await fetch(AI_PROXY_URL, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
        body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:[
          {type:'document', source:{type:'base64', media_type:'application/pdf', data: base64}},
          {type:'text', text:`Extract candidate fields from this resume PDF. Respond ONLY with valid JSON, no markdown fences: {"full_name":"...", "email": "... or null", "phone": "... or null", "current_company": "... or null", "experience_yrs": <number or null>, "skills": ["...", "..."]}`}
        ]}]})
      });
      const data = await res.json();
      fields = JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
    } else if(ext === 'docx' || ext === 'doc'){
      await ensureMammothLoaded();
      const result = await mammoth.extractRawText({arrayBuffer: await file.arrayBuffer()});
      fields = await extractResumeFieldsFromText(result.value);
    } else {
      fields = await extractResumeFieldsFromText(await file.text());
    }
    if(fields.full_name) document.getElementById('cd_name').value = fields.full_name;
    if(fields.email) document.getElementById('cd_email').value = fields.email;
    if(fields.phone) document.getElementById('cd_phone').value = fields.phone;
    if(fields.current_company) document.getElementById('cd_company').value = fields.current_company;
    if(fields.experience_yrs) document.getElementById('cd_exp').value = fields.experience_yrs;
    if(fields.skills && fields.skills.length) document.getElementById('cd_skills').value = fields.skills.join(', ');
    toast('Resume parsed — review before saving');
  }catch(e){ toast('Parsing failed: ' + e.message); }
  btn.textContent = orig; btn.disabled = false;
}
async function extractResumeFieldsFromText(text){
  const res = await fetch(AI_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
    body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:
      `Extract candidate fields from this resume text. Respond ONLY with valid JSON, no markdown fences: {"full_name":"...", "email": "... or null", "phone": "... or null", "current_company": "... or null", "experience_yrs": <number or null>, "skills": ["...", "..."]}

RESUME TEXT:
${text.slice(0,6000)}`}]})
  });
  const data = await res.json();
  return JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
}

async function saveCandidate(){
  const id = document.getElementById('cd_id').value;
  const reqId = document.getElementById('cd_reqid').value;
  const name = document.getElementById('cd_name').value;
  if(!name){ toast('Candidate name required'); return; }
  const candidateBody = {
    full_name: name,
    email: document.getElementById('cd_email').value,
    phone: document.getElementById('cd_phone').value,
    current_company: document.getElementById('cd_company').value,
    current_ctc: parseFloat(document.getElementById('cd_cctc').value)||null,
    expected_ctc: parseFloat(document.getElementById('cd_ectc').value)||null,
    experience_yrs: parseFloat(document.getElementById('cd_exp').value)||null,
    notice_period_days: parseInt(document.getElementById('cd_notice').value)||null,
    resume_url: document.getElementById('cd_resume').value,
    skills: document.getElementById('cd_skills').value.split(',').map(s=>s.trim()).filter(Boolean)
  };

  if(id){
    await rest('candidates', {method:'PATCH', query:`id=eq.${id}`, body:candidateBody});
    closeModal(); toast('Candidate updated');
    document.querySelectorAll('[id^="apps_"]').forEach(el=>{ const rid=el.id.replace('apps_',''); loadApplications(rid); });
    return;
  }

  // Duplicate check before creating a new candidate
  const email = candidateBody.email, phone = candidateBody.phone;
  if(email || phone){
    const orFilters = [];
    if(phone) orFilters.push(`phone.eq.${encodeURIComponent(phone)}`);
    if(email) orFilters.push(`email.eq.${encodeURIComponent(email)}`);
    const dupes = await rest('candidates', {query:`or=(${orFilters.join(',')})&select=id,full_name,phone,email,current_company`});
    if(dupes.length){
      showDuplicateWarning(dupes, candidateBody, reqId);
      return;
    }
  }
  await createCandidateAndApply(candidateBody, reqId);
}

async function createCandidateAndApply(candidateBody, reqId, silent){
  const created = await rest('candidates', {method:'POST', body:candidateBody, prefer:'return=representation'});
  const candidateId = created[0].id;
  const createdApp = await rest('applications', {method:'POST', prefer:'return=representation', body:{
    candidate_id: candidateId, requisition_id: reqId, current_stage:'Sourced', added_by: profile.id
  }});
  await rest('activities', {method:'POST', body:{entity_type:'candidate', entity_id:candidateId, actor_id:profile.id, action:'added_to_pipeline'}});
  // Auto-run AI match scoring immediately — no separate manual click needed for the common case
  try{ await aiMatch(createdApp[0].id, reqId, true); }catch(e){ /* non-fatal — recruiter can still run it manually */ }
  if(!silent){ closeModal(); toast('Candidate added to pipeline — auto-scored'); loadApplications(reqId); }
}

function showDuplicateWarning(dupes, candidateBody, reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Possible duplicate</h3>
    <p class="meta-row">Found ${dupes.length} existing candidate(s) with matching phone/email:</p>
    ${dupes.map(d=>`<div class="app-row"><div><div class="name">${d.full_name}</div><div class="sub">${d.current_company||''} ${d.phone?'· '+d.phone:''} ${d.email?'· '+d.email:''}</div></div>
      <button class="icon-btn" onclick='useExistingCandidate(${JSON.stringify(d.id)}, ${JSON.stringify(reqId)})'>Use this one</button></div>`).join('')}
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick='forceCreateCandidate(${JSON.stringify(candidateBody)}, ${JSON.stringify(reqId)})'>Create as new anyway</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function useExistingCandidate(candidateId, reqId){
  const existingApp = await rest('applications', {query:`candidate_id=eq.${candidateId}&requisition_id=eq.${reqId}&select=id`});
  if(existingApp.length){ toast('This candidate is already in this pipeline'); closeModal(); return; }
  await rest('applications', {method:'POST', body:{candidate_id: candidateId, requisition_id: reqId, current_stage:'Sourced', added_by: profile.id}});
  closeModal(); toast('Existing candidate added to pipeline'); loadApplications(reqId);
}
async function forceCreateCandidate(candidateBody, reqId){
  closeModal();
  await createCandidateAndApply(candidateBody, reqId);
}

// ---------- Interviews ----------
async function toggleInterviews(appId, reqId){
  const el = document.getElementById('interviews_'+appId);
  if(!el.classList.contains('hidden')){ el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  await loadInterviews(appId, reqId);
}
async function loadInterviews(appId, reqId){
  const el = document.getElementById('interviews_'+appId);
  el.innerHTML = `<div class="empty">Loading…</div>`;
  const interviews = await rest('interviews', {query:`application_id=eq.${appId}&select=*&order=scheduled_at`});
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <button class="icon-btn" onclick="openScheduleInterviewModal('${appId}','${reqId}')">+ Schedule interview</button>
      <button class="icon-btn" onclick="openProposeSlotsModal('${appId}','${reqId}')">📅 Propose time slots</button>
      <button class="icon-btn" onclick="aiInterviewPrep('${appId}','${reqId}')">✨ AI prep</button>
      <button class="icon-btn" onclick="draftSchedulingMessageFor('${appId}','${reqId}')">✉ Draft scheduling message</button>
    </div>
    ${interviews.length ? interviews.map(iv=>`
      <div class="app-row">
        <div>
          <div class="name">Round ${iv.round} — ${iv.round_type}</div>
          ${iv.status==='pending_candidate_selection' ? `
            <div class="sub">Awaiting candidate's choice of: ${(iv.proposed_slots||[]).map(s=>new Date(s).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})).join(' / ')}</div>
          ` : `<div class="sub">${iv.scheduled_at?new Date(iv.scheduled_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'No time set'} · ${iv.mode} ${iv.interviewer_name?'· '+iv.interviewer_name:''}</div>`}
          ${iv.status==='completed' ? `<div class="sub">Rating: ${iv.rating||'?'}/5 · ${iv.recommendation||''} ${iv.feedback?'— '+iv.feedback:''}</div>` : ''}
        </div>
        <span class="badge ${iv.status==='completed'?'open':(iv.status==='cancelled'?'closed':(iv.status==='pending_candidate_selection'?'on_hold':'draft'))}">${iv.status.replace(/_/g,' ')}</span>
        ${iv.status==='scheduled' ? `<button class="icon-btn" onclick='openRecordOutcomeModal(${JSON.stringify(iv)}, ${JSON.stringify(appId)}, ${JSON.stringify(reqId)})'>Record outcome</button>` : ''}
      </div>`).join('') : `<div class="empty">No interviews scheduled yet.</div>`}
    <div id="prepBox_${appId}"></div>`;
}
function openProposeSlotsModal(appId, reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Propose time slots</h3>
    <p class="meta-row">Candidate will pick one of these in their own portal — no back-and-forth needed.</p>
    <div class="row2"><div><label>Round</label><input id="ps_round" type="number" value="1" /></div><div><label>Round type</label><input id="ps_type" value="Client Interview" /></div></div>
    <label>Option 1</label><input id="ps_slot1" type="datetime-local" />
    <label>Option 2</label><input id="ps_slot2" type="datetime-local" />
    <label>Option 3 (optional)</label><input id="ps_slot3" type="datetime-local" />
    <div class="row2"><div><label>Mode</label><select id="ps_mode"><option>Video</option><option>Phone</option><option>In-Person</option></select></div><div><label>Interviewer name</label><input id="ps_interviewer" /></div></div>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveProposedSlots('${appId}','${reqId}')">Send to candidate</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveProposedSlots(appId, reqId){
  const slots = ['ps_slot1','ps_slot2','ps_slot3'].map(id=>document.getElementById(id).value).filter(Boolean).map(dt=>new Date(dt).toISOString());
  if(slots.length<2){ toast('Enter at least 2 time options'); return; }
  await rest('interviews', {method:'POST', body:{
    application_id: appId,
    round: parseInt(document.getElementById('ps_round').value)||1,
    round_type: document.getElementById('ps_type').value,
    mode: document.getElementById('ps_mode').value,
    interviewer_name: document.getElementById('ps_interviewer').value,
    status: 'pending_candidate_selection',
    proposed_slots: slots
  }});
  closeModal(); toast('Slots sent — candidate can now pick one'); loadInterviews(appId, reqId);
}
function openScheduleInterviewModal(appId, reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Schedule interview</h3>
    <div class="row2"><div><label>Round</label><input id="iv_round" type="number" value="1" /></div><div><label>Round type</label><input id="iv_type" value="Client Interview" /></div></div>
    <label>Scheduled date & time</label><input id="iv_datetime" type="datetime-local" />
    <div class="row2"><div><label>Mode</label><select id="iv_mode"><option>Video</option><option>Phone</option><option>In-Person</option></select></div><div><label>Interviewer name</label><input id="iv_interviewer" /></div></div>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveInterview('${appId}','${reqId}')">Schedule</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveInterview(appId, reqId){
  const dt = document.getElementById('iv_datetime').value;
  await rest('interviews', {method:'POST', body:{
    application_id: appId,
    round: parseInt(document.getElementById('iv_round').value)||1,
    round_type: document.getElementById('iv_type').value,
    scheduled_at: dt ? new Date(dt).toISOString() : null,
    mode: document.getElementById('iv_mode').value,
    interviewer_name: document.getElementById('iv_interviewer').value,
    status: 'scheduled'
  }});
  closeModal(); toast('Interview scheduled'); loadInterviews(appId, reqId);
}
function openRecordOutcomeModal(iv, appId, reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Record outcome — Round ${iv.round}</h3>
    <label>Rating (1-5)</label><input id="iv_rating" type="number" min="1" max="5" />
    <label>Recommendation</label><select id="iv_rec"><option value="proceed">Proceed</option><option value="hold">Hold</option><option value="reject">Reject</option></select>
    <label>Feedback</label><textarea id="iv_feedback" rows="3"></textarea>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveInterviewOutcome('${iv.id}','${appId}','${reqId}')">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveInterviewOutcome(interviewId, appId, reqId){
  await rest('interviews', {method:'PATCH', query:`id=eq.${interviewId}`, body:{
    status: 'completed',
    rating: parseInt(document.getElementById('iv_rating').value)||null,
    recommendation: document.getElementById('iv_rec').value,
    feedback: document.getElementById('iv_feedback').value
  }});
  closeModal(); toast('Outcome recorded'); loadInterviews(appId, reqId);
}
async function aiInterviewPrep(appId, reqId){
  const box = document.getElementById('prepBox_'+appId);
  box.innerHTML = `<div class="ai-box">Generating prep notes…</div>`;
  const [appRows, reqRows] = await Promise.all([
    rest('applications', {query:`id=eq.${appId}&select=*,candidates(*)`}),
    rest('requisitions', {query:`id=eq.${reqId}&select=*`})
  ]);
  const cand = appRows[0].candidates, req = reqRows[0];
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:400, messages:[{role:'user', content:
        `Prepare short interview prep notes for a recruiter about to interview this candidate. Give: a 2-3 line candidate summary, then 3-4 suggested questions tied specifically to this job's requirements. Plain text, no markdown headers.

JOB: ${req.title}
JD: ${req.jd_text||'Not specified'}

CANDIDATE: ${cand.full_name}
Experience: ${cand.experience_yrs||'?'} yrs at ${cand.current_company||'?'}
Skills: ${(cand.skills||[]).join(', ')||'Not specified'}`}]})
    });
    const data = await res.json();
    const text = data.content.find(b=>b.type==='text').text;
    box.innerHTML = `<div class="ai-box">${text.replace(/\n/g,'<br/>')}</div>`;
  }catch(e){ box.innerHTML = `<div class="ai-box">Failed: ${e.message}</div>`; }
}

async function moveStage(appId, reqId){
  const newStage = document.getElementById('stage_'+appId).value;
  const current = await rest('applications', {query:`id=eq.${appId}&select=stage_history`});
  const history = (current[0].stage_history||[]);
  history.push({stage:newStage, moved_by:profile.id, at:new Date().toISOString()});
  await rest('applications', {method:'PATCH', query:`id=eq.${appId}`, body:{current_stage:newStage, stage_entered_at:new Date().toISOString(), stage_history:history}});
  await rest('activities', {method:'POST', body:{entity_type:'application', entity_id:appId, actor_id:profile.id, action:'stage_changed', detail:newStage}});
  toast('Stage updated'); loadApplications(reqId);
}

async function aiMatch(appId, reqId, silent){
  if(!silent) toast('Running AI match…');
  const [appRows, reqRows] = await Promise.all([
    rest('applications', {query:`id=eq.${appId}&select=*,candidates(*)`}),
    rest('requisitions', {query:`id=eq.${reqId}&select=*`})
  ]);
  const cand = appRows[0].candidates;
  const req = reqRows[0];
  const prompt = `You are a recruitment analyst. Score how well this candidate matches this job. Respond ONLY with valid JSON, no markdown fences: {"score": <0-100 integer>, "strengths": ["..."], "gaps": ["..."], "recommendation": "one short sentence"}

JOB: ${req.title} (${req.segment})
JD/Requirements: ${req.jd_text || 'Not specified'}
CTC band: ${req.ctc_min||'?'}-${req.ctc_max||'?'} LPA

CANDIDATE: ${cand.full_name}
Experience: ${cand.experience_yrs||'?'} yrs
Current CTC: ${cand.current_ctc||'?'} LPA, Expected: ${cand.expected_ctc||'?'} LPA
Notice period: ${cand.notice_period_days||'?'} days
Skills: ${(cand.skills||[]).join(', ')||'Not specified'}`;

  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:prompt}]})
    });
    const data = await res.json();
    const textBlock = data.content.find(b=>b.type==='text');
    const parsed = JSON.parse(textBlock.text.replace(/```json|```/g,'').trim());
    await rest('applications', {method:'PATCH', query:`id=eq.${appId}`, body:{ai_match_score: parsed.score, ai_match_detail: parsed}});
    if(!silent){ toast(`AI match: ${parsed.score}/100`); loadApplications(reqId); }
  }catch(e){
    if(!silent) toast('AI match failed: ' + e.message);
    else throw e;
  }
}

// ============================================================
// 6. ADMIN (Azad) — Overview | Team | BD | Recruiter | Placements
// ============================================================
let adminView = 'overview';
async function renderAdmin(){
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="tabbar">
      <button id="tabOverview" class="active" onclick="adminTab('overview')">Overview</button>
      <button id="tabTeam" onclick="adminTab('team')">Team</button>
      <button id="tabBD" onclick="adminTab('bd')">BD view</button>
      <button id="tabRec" onclick="adminTab('rec')">Recruiter view</button>
      <button id="tabPlacements" onclick="adminTab('placements')">Placements</button>
    </div><div id="adminBody"></div>`;
  await adminTab('overview');
}
window.adminTab = async function(which){
  adminView = which;
  ['Overview','Team','BD','Rec','Placements'].forEach(t=>{
    const el = document.getElementById('tab'+t);
    if(el) el.classList.toggle('active', t.toLowerCase()===which);
  });
  const holder = document.getElementById('adminBody');
  holder.innerHTML = `<div class="empty">Loading…</div>`;
  try{
    if(which==='overview') await renderOverviewInto(holder);
    else if(which==='team') await renderTeamInto(holder);
    else if(which==='bd') await renderBDInto(holder);
    else if(which==='rec') await renderRecruiterInto(holder);
    else if(which==='placements') await renderPlacementsInto(holder);
  }catch(e){
    holder.innerHTML = `<div class="empty">Couldn't load this tab: ${e.message}</div>`;
    console.error('adminTab error:', e);
  }
};

// ---------- A. OVERVIEW ----------
async function renderOverviewInto(container){
  container.innerHTML = `<div class="section-title"><h2>Overview</h2><button class="btn-secondary" id="digestBtn" onclick="generateDigest()">Generate weekly digest</button></div>
    <div id="digestBox"></div>
    <div class="grid" id="numbersGrid"></div>
    <div class="section-title"><h2>SLA breaches</h2></div>
    <div id="slaList"></div>
    <div class="section-title"><h2>Recent activity</h2></div>
    <div id="activityList"></div>`;

  const [openReqs, allApps, placementsThisMonth, activities, stages] = await Promise.all([
    rest('requisitions', {query:'status=eq.open&select=id,ctc_min,ctc_max,client_id'}),
    rest('applications', {query:'select=id,current_stage,stage_entered_at,requisition_id,candidates(full_name),requisitions(title,assigned_recruiter_id)&current_stage=not.in.(Placed,Rejected,On Hold)'}),
    rest('placements', {query:`select=id,fee_amount,created_at&created_at=gte.${new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString()}`}),
    rest('activities', {query:'select=*,users(full_name)&order=created_at.desc&limit=30'}),
    rest('pipeline_stage_master', {query:'select=stage_name,sla_hours'})
  ]);

  const slaMap = Object.fromEntries(stages.map(s=>[s.stage_name, s.sla_hours]));
  const now = new Date();
  const breaches = allApps.filter(a=>{
    const sla = slaMap[a.current_stage];
    if(!sla || sla===0) return false;
    const hoursIn = (now - new Date(a.stage_entered_at)) / 36e5;
    return hoursIn > sla;
  });

  const feeValue = placementsThisMonth.reduce((s,p)=>s+(p.fee_amount||0),0);

  document.getElementById('numbersGrid').innerHTML = `
    <div class="card"><div class="meta-row">Open requisitions</div><div class="req-title" style="font-size:28px;">${openReqs.length}</div></div>
    <div class="card"><div class="meta-row">Candidates in active pipeline</div><div class="req-title" style="font-size:28px;">${allApps.length}</div></div>
    <div class="card"><div class="meta-row">Placements this month</div><div class="req-title" style="font-size:28px;">${placementsThisMonth.length}</div></div>
    <div class="card"><div class="meta-row">Fee value this month</div><div class="req-title" style="font-size:22px;">₹${feeValue.toLocaleString('en-IN')}</div></div>`;

  document.getElementById('slaList').innerHTML = breaches.length ? breaches.map(a=>`
    <div class="app-row"><div>
      <div class="name">${a.candidates?.full_name||'Unknown'} — ${a.requisitions?.title||''}</div>
      <div class="sub">Stuck in "${a.current_stage}" — ${Math.round((now-new Date(a.stage_entered_at))/36e5)}h (SLA ${slaMap[a.current_stage]}h)</div>
    </div><span class="badge on_hold">breach</span></div>`).join('')
    : `<div class="empty">No SLA breaches right now.</div>`;

  document.getElementById('activityList').innerHTML = activities.length ? activities.map(a=>`
    <div class="meta-row" style="padding:6px 0;border-bottom:1px solid var(--line);">${a.users?.full_name||'Someone'} ${a.action.replace('_',' ')} ${a.detail?('— '+a.detail):''} <span style="opacity:.6;">· ${new Date(a.created_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span></div>`).join('')
    : `<div class="empty">No recent activity.</div>`;

  window._overviewSnapshot = {openReqs: openReqs.length, activePipeline: allApps.length, placements: placementsThisMonth.length, feeValue, breaches: breaches.length};
}

async function generateDigest(){
  const box = document.getElementById('digestBox');
  box.innerHTML = `<div class="ai-box">Generating…</div>`;
  const s = window._overviewSnapshot || {};
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:200, messages:[{role:'user', content:
        `Write a 2-3 sentence plain-English weekly digest for a recruitment agency owner, in a direct professional tone, no fluff. Data: ${s.openReqs} open requisitions, ${s.activePipeline} candidates in active pipeline, ${s.placements} placements this month worth ₹${s.feeValue} in fees, ${s.breaches} SLA breaches needing attention. Respond with only the digest text, no preamble.`}]})
    });
    const data = await res.json();
    const text = data.content.find(b=>b.type==='text').text;
    box.innerHTML = `<div class="ai-box">${text}</div>`;
  }catch(e){ box.innerHTML = `<div class="ai-box">Digest failed: ${e.message}</div>`; }
}

// ---------- B. TEAM MANAGEMENT ----------
async function renderTeamInto(container){
  const [users, clients] = await Promise.all([
    rest('users', {query:'select=*&order=role'}),
    rest('clients', {query:'select=id,company_name'})
  ]);
  container.innerHTML = `<div class="section-title"><h2>Team logins</h2><button class="btn-secondary" onclick="openAddLoginModal()">+ Add login</button></div><div id="teamList"></div>`;
  document.getElementById('teamList').innerHTML = users.map(u=>`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="req-title">${u.full_name} ${!u.active?'<span class="badge closed">inactive</span>':''}</div>
          <div class="meta-row">${u.email} · <span class="stage-pill">${u.role}</span></div>
          ${(u.role==='recruiter'||u.role==='bd') ? `<div class="meta-row">Categories: ${(u.hiring_categories||[]).join(', ')||'none assigned'}</div>` : ''}
          ${u.role==='client' ? `<div class="meta-row">Client company: ${clients.find(c=>c.id===u.client_id)?.company_name || 'Not linked'}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        ${(u.role==='recruiter'||u.role==='bd') ? `<button class="icon-btn" onclick='openEditCategoriesModal(${JSON.stringify(u)})'>Edit categories</button>` : ''}
        ${u.active ? `<button class="icon-btn" onclick="toggleActive('${u.id}', false)">Deactivate</button>` : `<button class="icon-btn" onclick="toggleActive('${u.id}', true)">Reactivate</button>`}
      </div>
    </div>`).join('');
}

async function openAddLoginModal(){
  const [clients, candidates] = await Promise.all([
    rest('clients', {query:'select=id,company_name&order=company_name'}),
    rest('candidates', {query:'select=id,full_name&order=full_name'})
  ]);
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Add login</h3>
    <label>Full name</label><input id="nl_name" />
    <label>Email</label><input id="nl_email" type="email" />
    <label>Role</label><select id="nl_role" onchange="
      document.getElementById('nl_catwrap').classList.toggle('hidden', this.value!=='recruiter' && this.value!=='bd');
      document.getElementById('nl_clientwrap').classList.toggle('hidden', this.value!=='client');
      document.getElementById('nl_candwrap').classList.toggle('hidden', this.value!=='candidate');
    ">
      <option value="bd">Business Development</option>
      <option value="recruiter">Recruiter</option>
      <option value="admin">Admin</option>
      <option value="client">Client Contact</option>
      <option value="candidate">Candidate</option>
    </select>
    <div id="nl_catwrap">
      <label>Hiring categories</label>
      ${CATEGORIES.map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;font-size:13px;"><input type="checkbox" value="${c}" class="nl_cat" style="width:auto;" checked>${c}</label>`).join('')}
    </div>
    <div id="nl_clientwrap" class="hidden">
      <label>Client company</label>
      <select id="nl_client_id">${clients.map(c=>`<option value="${c.id}">${c.company_name}</option>`).join('')}</select>
    </div>
    <div id="nl_candwrap" class="hidden">
      <label>Candidate</label>
      <select id="nl_candidate_id">${candidates.map(c=>`<option value="${c.id}">${c.full_name}</option>`).join('')}</select>
      <label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;font-size:13px;margin-top:10px;">
        <input type="checkbox" id="nl_consent" style="width:auto;">Candidate has agreed to portal access
      </label>
    </div>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="submitAddLogin()">Create login</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}

async function submitAddLogin(){
  const full_name = document.getElementById('nl_name').value;
  const email = document.getElementById('nl_email').value;
  const role = document.getElementById('nl_role').value;
  const hiring_categories = Array.from(document.querySelectorAll('.nl_cat:checked')).map(el=>el.value);
  const client_id = role==='client' ? document.getElementById('nl_client_id').value : undefined;
  const candidate_id = role==='candidate' ? document.getElementById('nl_candidate_id').value : undefined;
  const consent_logged = role==='candidate' ? document.getElementById('nl_consent').checked : undefined;
  if(!full_name || !email){ toast('Name and email required'); return; }
  if(role==='client' && !client_id){ toast('Choose a client company'); return; }
  if(role==='candidate' && !candidate_id){ toast('Choose a candidate'); return; }
  if(role==='candidate' && !consent_logged){ toast('Confirm the candidate has agreed to portal access first'); return; }
  try{
    const res = await fetch(EDGE_FUNCTION_URL, {
      method:'POST',
      headers:{'Authorization':'Bearer '+session.access_token, 'Content-Type':'application/json'},
      body: JSON.stringify({full_name, email, role, hiring_categories, client_id, candidate_id, consent_logged})
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Failed to create login');
    closeModal();
    toast(`Login created. Temp password: ${data.temp_password} — share this with them directly, it will not be shown again.`);
    renderTeamInto(document.getElementById('adminBody'));
  }catch(e){ toast('Error: ' + e.message); }
}

function openEditCategoriesModal(user){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Edit categories — ${user.full_name}</h3>
    ${CATEGORIES.map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;font-size:13px;margin:6px 0;"><input type="checkbox" value="${c}" class="ec_cat" style="width:auto;" ${(user.hiring_categories||[]).includes(c)?'checked':''}>${c}</label>`).join('')}
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveCategories('${user.id}')">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveCategories(userId){
  const cats = Array.from(document.querySelectorAll('.ec_cat:checked')).map(el=>el.value);
  await rest('users', {method:'PATCH', query:`id=eq.${userId}`, body:{hiring_categories:cats}});
  closeModal(); toast('Categories updated'); renderTeamInto(document.getElementById('adminBody'));
}
async function toggleActive(userId, makeActive){
  await rest('users', {method:'PATCH', query:`id=eq.${userId}`, body:{active:makeActive}});
  toast(makeActive?'Reactivated':'Deactivated'); renderTeamInto(document.getElementById('adminBody'));
}

// ---------- C. FULL OVERSIGHT (reassignment added to requisitions in BD view when admin) ----------
async function reassignBD(reqId){
  const sel = document.getElementById('reassignBD_'+reqId);
  if(!sel.value){ toast('Choose a BD owner'); return; }
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{bd_owner_id: sel.value}});
  toast('BD owner reassigned'); renderReqsTab();
}
async function overrideStatus(reqId){
  const sel = document.getElementById('overrideStatus_'+reqId);
  await rest('requisitions', {method:'PATCH', query:`id=eq.${reqId}`, body:{status: sel.value}});
  toast('Status overridden'); renderReqsTab();
}

// ---------- D. PLACEMENTS & BILLING ----------
async function renderPlacementsInto(container){
  const [joinedApps, placements] = await Promise.all([
    rest('applications', {query:'current_stage=eq.Joined&select=*,candidates(full_name),requisitions(title,client_id,clients(company_name,fee_pct,gst_pct,replacement_guarantee_days))'}),
    rest('placements', {query:'select=*,candidates(full_name),clients(company_name)&order=created_at.desc'})
  ]);
  const placedAppIds = new Set(placements.map(p=>p.application_id));
  const toConvert = joinedApps.filter(a=>!placedAppIds.has(a.id));

  container.innerHTML = `
    <div class="section-title"><h2>Ready to convert</h2></div>
    <div id="convertList"></div>
    <div class="section-title"><h2>Placements</h2></div>
    <div id="placementsList"></div>`;

  document.getElementById('convertList').innerHTML = toConvert.length ? toConvert.map(a=>`
    <div class="card">
      <div class="req-title">${a.candidates.full_name} — ${a.requisitions.title}</div>
      <div class="meta-row">${a.requisitions.clients.company_name} · Fee ${a.requisitions.clients.fee_pct}% + ${a.requisitions.clients.gst_pct}% GST</div>
      <button class="icon-btn" style="margin-top:8px;" onclick='openConvertModal(${JSON.stringify(a)})'>Convert to placement</button>
    </div>`).join('') : `<div class="empty">Nothing waiting — candidates show up here once marked "Joined".</div>`;

  document.getElementById('placementsList').innerHTML = placements.length ? await Promise.all(placements.map(async p=>{
    const followups = await rest('guarantee_followups', {query:`placement_id=eq.${p.id}&order=due_date`});
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;">
        <div>
          <div class="req-title">${p.candidates.full_name} — ${p.clients.company_name}</div>
          <div class="meta-row">CTC ₹${p.ctc_annual} · Fee ₹${p.fee_amount} + GST ₹${p.gst_amount} = ₹${p.total_invoice_amount}</div>
          <div class="meta-row">Joined ${p.joining_date} · Status: ${p.status}</div>
        </div>
        <button class="icon-btn" onclick='generateInvoice(${JSON.stringify(p)})'>Invoice</button>
      </div>
      <hr class="divider"/>
      <div class="meta-row">Guarantee follow-ups:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
        ${followups.map(f=>`<span class="badge ${f.status==='completed'?'open':(new Date(f.due_date)<new Date()?'on_hold':'draft')}" style="cursor:pointer;" onclick="completeFollowup('${f.id}','${p.id}')">${f.followup_type.replace('_',' ')}: ${f.due_date} ${f.status==='completed'?'✓':''}</span>`).join('')}
      </div>
    </div>`;
  })).then(arr=>arr.join('')) : `<div class="empty">No placements yet.</div>`;
}

function openConvertModal(app){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Convert to placement</h3>
    <p class="meta-row">${app.candidates.full_name} — ${app.requisitions.title}</p>
    <label>Joining date</label><input id="pl_joindate" type="date" />
    <label>Final CTC (annual, ₹)</label><input id="pl_ctc" type="number" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick='savePlacement(${JSON.stringify(app)})'>Confirm placement</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function savePlacement(app){
  const joining_date = document.getElementById('pl_joindate').value;
  const ctc_annual = parseFloat(document.getElementById('pl_ctc').value);
  if(!joining_date || !ctc_annual){ toast('Joining date and CTC required'); return; }
  const c = app.requisitions.clients;
  const created = await rest('placements', {method:'POST', prefer:'return=representation', body:{
    application_id: app.id, candidate_id: app.candidate_id, requisition_id: app.requisition_id,
    client_id: app.requisitions.client_id, joining_date, ctc_annual,
    fee_pct: c.fee_pct, gst_pct: c.gst_pct,
    replacement_guarantee_end_date: new Date(new Date(joining_date).getTime() + c.replacement_guarantee_days*864e5).toISOString().slice(0,10),
    recruiter_id: app.requisitions.assigned_recruiter_id, bd_owner_id: profile.id
  }});
  const placementId = created[0].id;
  const joinMs = new Date(joining_date).getTime();
  const followups = [
    {placement_id: placementId, followup_type:'30_day', due_date: new Date(joinMs + 30*864e5).toISOString().slice(0,10)},
    {placement_id: placementId, followup_type:'90_day', due_date: new Date(joinMs + 90*864e5).toISOString().slice(0,10)},
    {placement_id: placementId, followup_type:'180_day', due_date: new Date(joinMs + 180*864e5).toISOString().slice(0,10)}
  ];
  await rest('guarantee_followups', {method:'POST', body:followups});
  await rest('applications', {method:'PATCH', query:`id=eq.${app.id}`, body:{current_stage:'Placed'}});
  closeModal(); toast('Placement confirmed — 30/90/180-day follow-ups scheduled'); renderPlacementsInto(document.getElementById('adminBody'));
}
async function completeFollowup(followupId, placementId){
  await rest('guarantee_followups', {method:'PATCH', query:`id=eq.${followupId}`, body:{status:'completed', completed_by:profile.id, completed_at:new Date().toISOString()}});
  toast('Follow-up marked done'); renderPlacementsInto(document.getElementById('adminBody'));
}
function generateInvoice(p){
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Invoice — ${p.clients.company_name}</title>
    <style>body{font-family:Georgia,serif;padding:40px;color:#1C1F26;} h1{color:#1B3A6B;} table{width:100%;border-collapse:collapse;margin-top:20px;} td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left;} .total{font-weight:bold;font-size:18px;}</style>
    </head><body>
    <h1>WorkSource</h1>
    <p>GSTIN: 27AWFPK8180J1Z3</p>
    <hr/>
    <h2>Invoice</h2>
    <p><b>Client:</b> ${p.clients.company_name}<br/><b>Candidate placed:</b> ${p.candidates.full_name}<br/><b>Joining date:</b> ${p.joining_date}</p>
    <table>
      <tr><th>Description</th><th>Amount (₹)</th></tr>
      <tr><td>Placement fee (${p.fee_pct}% of CTC ₹${p.ctc_annual})</td><td>₹${p.fee_amount}</td></tr>
      <tr><td>GST (${p.gst_pct}%)</td><td>₹${p.gst_amount}</td></tr>
      <tr class="total"><td>Total</td><td>₹${p.total_invoice_amount}</td></tr>
    </table>
    <p style="margin-top:30px;font-size:13px;color:#555;">Replacement guarantee valid until ${p.replacement_guarantee_end_date}. Standard terms apply.</p>
    </body></html>`);
  w.document.close();
  setTimeout(()=>w.print(), 400);
}

// ============================================================
// 7. LEADS (BD Growth Tools)
// ============================================================
const LEAD_STAGES = ['Prospecting','Contacted','Qualified','Proposal Sent','Negotiation'];

async function callClaudeWithSearch(promptText, maxTokens){
  const res = await fetch(AI_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
    body: JSON.stringify({
      model:'claude-sonnet-4-6', max_tokens: maxTokens||700,
      messages:[{role:'user', content:promptText}],
      tools:[{type:'web_search_20250305', name:'web_search'}]
    })
  });
  const data = await res.json();
  return data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
}

async function renderLeadsTab(){
  const leads = await rest('leads', {query:'select=*&order=created_at.desc'});
  const body = document.getElementById('bdBody');
  const open = leads.filter(l=>!['Won','Lost'].includes(l.stage));
  const weighted = open.reduce((s,l)=> s + ((l.estimated_deal_value||0) * (l.win_probability||0)/100), 0);
  const won = leads.filter(l=>l.stage==='Won').length;
  const lost = leads.filter(l=>l.stage==='Lost').length;
  const convRate = (won+lost) ? Math.round(won/(won+lost)*100) : null;
  const stageCounts = {};
  open.forEach(l=>{ stageCounts[l.stage] = (stageCounts[l.stage]||0)+1; });

  body.innerHTML = `
    <div class="section-title"><h2>Leads</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-ghost" style="font-size:12.5px;padding:8px 12px;" onclick="exportLeadsCSV()">⬇ Export CSV</button>
        <button class="btn-ghost" style="font-size:12.5px;padding:8px 12px;" onclick="openImportLeadsModal()">⬆ Import CSV</button>
        <button class="btn-secondary" onclick="openLeadModal()">+ Add lead</button>
      </div>
    </div>
    <div class="grid" style="margin-bottom:14px;">
      <div class="card"><div class="meta-row">Weighted pipeline value</div><div class="req-title" style="font-size:19px;">₹${Math.round(weighted).toLocaleString('en-IN')}</div></div>
      <div class="card"><div class="meta-row">Open leads</div><div class="req-title" style="font-size:19px;">${open.length}</div></div>
      <div class="card"><div class="meta-row">Conversion rate</div><div class="req-title" style="font-size:19px;">${convRate===null?'—':convRate+'%'}</div></div>
    </div>
    <div class="meta-row" style="margin-bottom:10px;">${Object.entries(stageCounts).map(([s,n])=>`${n} ${s}`).join(' · ')||'No open leads'}</div>
    <div id="leadsList"></div>`;

  const list = document.getElementById('leadsList');
  if(!leads.length){ list.innerHTML = `<div class="empty">No leads yet. Add your first prospect to start building the pipeline.</div>`; return; }
  list.innerHTML = leads.map(l=>{
    const stale = !['Won','Lost'].includes(l.stage) && (new Date() - new Date(l.last_interaction_at)) > 7*864e5;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="req-title">${l.company_name} ${stale?'<span class="badge on_hold">needs follow-up</span>':''}</div>
          <div class="meta-row">${l.segment||''} · Deal value ₹${l.estimated_deal_value||'?'} · ${l.win_probability||0}% probability</div>
        </div>
        <span class="badge ${l.stage==='Won'?'open':(l.stage==='Lost'?'closed':'draft')}">${l.stage}</span>
      </div>
      <div class="meta-row">${l.contact_name||''} ${l.contact_email?'· '+l.contact_email:''} ${l.contact_phone?'· '+l.contact_phone:''}</div>
      ${l.notes ? `<div class="meta-row" style="margin-top:6px;white-space:pre-wrap;">${l.notes}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        ${!['Won','Lost'].includes(l.stage) ? `
          <select id="stage_${l.id}" style="width:auto;padding:6px 8px;font-size:12.5px;">
            ${LEAD_STAGES.map(s=>`<option ${s===l.stage?'selected':''}>${s}</option>`).join('')}
          </select><button class="icon-btn" onclick="moveLeadStage('${l.id}')">Move</button>
          <button class="icon-btn" onclick='logLeadInteraction(${JSON.stringify(l)})'>Log interaction</button>
          <button class="icon-btn" onclick='researchCompany(${JSON.stringify(l)})'>🔍 Research</button>
          <button class="icon-btn" onclick='findDecisionMaker(${JSON.stringify(l)})'>Find contact</button>
          <button class="icon-btn" onclick='generatePitchEmail(${JSON.stringify(l)})'>✨ Pitch email</button>
          <button class="icon-btn" onclick='openLeadModal(${JSON.stringify(l)})'>Edit</button>
          <button class="icon-btn" onclick='markLeadWon(${JSON.stringify(l)})'>Mark Won</button>
          <button class="icon-btn" onclick="markLeadLost('${l.id}')">Mark Lost</button>
        ` : (l.stage==='Won' ? `<div class="meta-row">✓ Converted to client</div>` : `<div class="meta-row">Lost: ${l.lost_reason||''}</div>`)}
      </div>
    </div>`;
  }).join('');
}

function openLeadModal(existing){
  const l = existing || {};
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>${existing?'Edit lead':'Add lead'}</h3>
    <input type="hidden" id="l_id" value="${l.id||''}" />
    <label>Company name *</label><input id="l_name" value="${l.company_name||''}" />
    <label>Segment</label><select id="l_segment">${SEGMENTS.map(s=>`<option ${s===l.segment?'selected':''}>${s}</option>`).join('')}</select>
    <div class="row2"><div><label>Contact name</label><input id="l_contact" value="${l.contact_name||''}" /></div><div><label>Contact email</label><input id="l_email" value="${l.contact_email||''}" /></div></div>
    <label>Contact phone</label><input id="l_phone" value="${l.contact_phone||''}" />
    <div class="row2"><div><label>Est. deal value (₹, total fee)</label><input id="l_value" value="${l.estimated_deal_value||''}" /></div><div><label>Win probability (%)</label><input id="l_prob" value="${l.win_probability||25}" /></div></div>
    <div class="row2"><div><label>Expected close date</label><input id="l_close" type="date" value="${l.expected_close_date||''}" /></div><div><label>Source</label>
      <select id="l_source">${['Referral','Cold Outreach','Inbound','Event','Other'].map(s=>`<option ${s===l.source?'selected':''}>${s}</option>`).join('')}</select></div></div>
    <label>Notes</label><textarea id="l_notes" rows="3">${l.notes||''}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveLead()">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function saveLead(){
  const id = document.getElementById('l_id').value;
  const name = document.getElementById('l_name').value;
  if(!name){ toast('Company name required'); return; }
  const body = {
    company_name: name,
    segment: document.getElementById('l_segment').value,
    contact_name: document.getElementById('l_contact').value,
    contact_email: document.getElementById('l_email').value,
    contact_phone: document.getElementById('l_phone').value,
    estimated_deal_value: parseFloat(document.getElementById('l_value').value)||null,
    win_probability: parseInt(document.getElementById('l_prob').value)||25,
    expected_close_date: document.getElementById('l_close').value || null,
    source: document.getElementById('l_source').value,
    notes: document.getElementById('l_notes').value
  };
  if(id){
    await rest('leads', {method:'PATCH', query:`id=eq.${id}`, body});
  } else {
    body.owned_by = profile.id;
    body.last_interaction_at = new Date().toISOString();
    await rest('leads', {method:'POST', body});
  }
  closeModal(); toast(id?'Lead updated':'Lead added'); renderLeadsTab();
}
async function moveLeadStage(leadId){
  const newStage = document.getElementById('stage_'+leadId).value;
  await rest('leads', {method:'PATCH', query:`id=eq.${leadId}`, body:{stage:newStage, last_interaction_at:new Date().toISOString()}});
  toast('Stage updated'); renderLeadsTab();
}
function logLeadInteraction(lead){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Log interaction — ${lead.company_name}</h3>
    <label>Note</label><textarea id="li_note" rows="3" placeholder="What happened? e.g. Called, discussed budget, sending proposal Monday"></textarea>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveLeadInteraction('${lead.id}')">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div></div>`;
  document.body.appendChild(bg);
}
async function saveLeadInteraction(leadId){
  const note = document.getElementById('li_note').value;
  if(!note){ toast('Add a note'); return; }
  const current = await rest('leads', {query:`id=eq.${leadId}&select=notes`});
  const existingNotes = current[0].notes || '';
  const stamped = `[${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'})}] ${note}`;
  const newNotes = existingNotes ? existingNotes + '\n' + stamped : stamped;
  await rest('leads', {method:'PATCH', query:`id=eq.${leadId}`, body:{notes:newNotes, last_interaction_at:new Date().toISOString()}});
  closeModal(); toast('Interaction logged'); renderLeadsTab();
}

async function researchCompany(lead){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Company research — ${lead.company_name}</h3><div id="researchBox" class="ai-box">Searching the web…</div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
  try{
    const text = await callClaudeWithSearch(
      `Research this company for a recruitment agency BD person about to pitch them staffing/recruitment services. Give: 1) what they do (1-2 sentences), 2) size/industry signals if findable, 3) any recent news or hiring activity found, 4) a suggested pitch angle. Keep it under 150 words, plain text, no markdown headers. If you can't find much, say so honestly rather than guessing.

Company: ${lead.company_name}${lead.segment ? ' (industry context: '+lead.segment+')' : ''}`, 700);
    document.getElementById('researchBox').innerHTML = text.replace(/\n/g,'<br/>');
    await rest('leads', {method:'PATCH', query:`id=eq.${lead.id}`, body:{company_research: text}});
  }catch(e){ document.getElementById('researchBox').textContent = 'Research failed: ' + e.message; }
}

function findDecisionMaker(lead){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Find decision-maker — ${lead.company_name}</h3>
    <label>Target role</label><input id="dm_role" value="HR Head" />
    <button class="btn-primary" style="margin-top:14px;" onclick='runDMSearch(${JSON.stringify(lead)})'>Search</button>
    <div id="dmBox" class="ai-box" style="margin-top:14px;display:none;"></div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
}
async function runDMSearch(lead){
  const role = document.getElementById('dm_role').value || 'HR Head';
  const box = document.getElementById('dmBox');
  box.style.display = 'block'; box.innerHTML = 'Searching…';
  try{
    const text = await callClaudeWithSearch(
      `Find publicly available information about who holds the "${role}" position (or closest equivalent) at this company. Only report what you can actually find via public search — company website, press mentions, publicly indexed profiles. If you find a name, say where you found it. If you can't find anything reliable, say so clearly rather than guessing a name. Do not fabricate contact details. Plain text, under 120 words.

Company: ${lead.company_name}`, 500);
    box.innerHTML = text.replace(/\n/g,'<br/>');
  }catch(e){ box.textContent = 'Search failed: ' + e.message; }
}

async function generatePitchEmail(lead){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Pitch email draft — ${lead.company_name}</h3><div id="pitchBox" class="ai-box">Generating…</div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
  try{
    const res = await fetch(AI_PROXY_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:
        `Draft a short, professional pitch email from a recruitment agency (WorkSource) BD person to a prospective client, introducing WorkSource's recruitment services (contingency search, standard fee 8.33% of annual CTC + GST, replacement guarantee included). Personalize using the research notes if provided. Plain text, under 150 words, no markdown, ready to paste into an email client. End with a soft call-to-action for a short call.

Company: ${lead.company_name}
Segment: ${lead.segment||'Not specified'}
Research notes: ${lead.company_research || 'None available — keep it general but professional.'}
Internal notes: ${lead.notes || 'None'}`}]})
    });
    const data = await res.json();
    const text = data.content.find(b=>b.type==='text').text;
    document.getElementById('pitchBox').innerHTML = text.replace(/\n/g,'<br/>');
  }catch(e){ document.getElementById('pitchBox').textContent = 'Failed: ' + e.message; }
}

function markLeadLost(leadId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Mark as lost</h3>
    <label>Reason</label><select id="lost_reason">${['Competitor won it','Budget cut','Internal hiring','Went cold','Other'].map(r=>`<option>${r}</option>`).join('')}</select>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="saveLeadLost('${leadId}')">Confirm</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div></div>`;
  document.body.appendChild(bg);
}
async function saveLeadLost(leadId){
  await rest('leads', {method:'PATCH', query:`id=eq.${leadId}`, body:{stage:'Lost', lost_reason: document.getElementById('lost_reason').value}});
  closeModal(); toast('Lead marked lost'); renderLeadsTab();
}

function markLeadWon(lead){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>Mark won — convert to client</h3>
    <p class="meta-row">This creates a real client record from this lead's data. Confirm terms below.</p>
    <label>Fee %</label><input id="won_fee" value="8.33" />
    <label>GST %</label><input id="won_gst" value="18" />
    <label>Replacement guarantee (days)</label><input id="won_guarantee" value="90" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick='confirmLeadWon(${JSON.stringify(lead)})'>Confirm &amp; create client</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div></div>`;
  document.body.appendChild(bg);
}
async function confirmLeadWon(lead){
  const created = await rest('clients', {method:'POST', prefer:'return=representation', body:{
    company_name: lead.company_name,
    segment: lead.segment || 'Other',
    contact_name: lead.contact_name,
    contact_email: lead.contact_email,
    contact_phone: lead.contact_phone,
    fee_pct: parseFloat(document.getElementById('won_fee').value)||8.33,
    gst_pct: parseFloat(document.getElementById('won_gst').value)||18,
    replacement_guarantee_days: parseInt(document.getElementById('won_guarantee').value)||90,
    status: 'active',
    created_by: profile.id
  }});
  const clientId = created[0].id;
  await rest('leads', {method:'PATCH', query:`id=eq.${lead.id}`, body:{stage:'Won', converted_client_id: clientId}});
  closeModal(); toast('Client created from lead 🎉'); renderLeadsTab();
}

// ---------- Leads: CSV export / import ----------
function csvEscape(val){
  if(val===null||val===undefined) return '';
  const str = String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g,'""')}"` : str;
}
function downloadFile(content, filename, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
async function exportLeadsCSV(){
  const leads = await rest('leads', {query:'select=*&order=created_at.desc'});
  const headers = ['company_name','segment','contact_name','contact_email','contact_phone','stage','estimated_deal_value','win_probability','expected_close_date','source','notes','lost_reason'];
  const csv = [headers.join(',')].concat(leads.map(l => headers.map(h=>csvEscape(l[h])).join(','))).join('\n');
  downloadFile(csv, `leads_export_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
  toast(`Exported ${leads.length} lead(s)`);
}

let papaLoaded = false;
function ensurePapaLoaded(){
  return new Promise((resolve,reject)=>{
    if(papaLoaded || window.Papa){ papaLoaded = true; resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';
    script.onload = () => { papaLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Could not load CSV parser'));
    document.head.appendChild(script);
  });
}
function openImportLeadsModal(){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Import leads from CSV</h3>
    <p class="meta-row">Expected columns: company_name, segment, contact_name, contact_email, contact_phone, stage, estimated_deal_value, win_probability, expected_close_date, source, notes. Only company_name is required — everything else defaults sensibly if missing or invalid.</p>
    <input type="file" id="import_file" accept=".csv" style="margin-top:10px;" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="importLeadsCSV(this)">Import</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function importLeadsCSV(btn){
  const file = document.getElementById('import_file').files[0];
  if(!file){ toast('Choose a CSV file'); return; }
  const orig = btn.textContent; btn.textContent = 'Importing…'; btn.disabled = true;
  try{
    await ensurePapaLoaded();
    const text = await file.text();
    const parsed = Papa.parse(text, {header:true, skipEmptyLines:true});
    const validStages = LEAD_STAGES.concat(['Won','Lost']);
    const validSources = ['Referral','Cold Outreach','Inbound','Event','Other'];
    const rows = parsed.data.filter(r=>r.company_name && r.company_name.trim()).map(r=>({
      company_name: r.company_name.trim(),
      segment: SEGMENTS.includes(r.segment) ? r.segment : null,
      contact_name: r.contact_name||null,
      contact_email: r.contact_email||null,
      contact_phone: r.contact_phone||null,
      stage: validStages.includes(r.stage) ? r.stage : 'Prospecting',
      estimated_deal_value: parseFloat(r.estimated_deal_value)||null,
      win_probability: parseInt(r.win_probability)||25,
      expected_close_date: r.expected_close_date || null,
      source: validSources.includes(r.source) ? r.source : 'Other',
      notes: r.notes||null,
      owned_by: profile.id,
      last_interaction_at: new Date().toISOString()
    }));
    if(!rows.length){ toast('No valid rows found — company_name is required'); btn.textContent = orig; btn.disabled = false; return; }
    await rest('leads', {method:'POST', body:rows});
    closeModal(); toast(`Imported ${rows.length} lead(s)`); renderLeadsTab();
  }catch(e){ toast('Import failed: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

// Wrap renderers so admin can target a sub-container instead of #mainContent
async function renderBDInto(container){
  container.innerHTML = `<div class="tabbar">
      <button id="tabDash" class="active" onclick="bdTab('dash')">Dashboard</button>
      <button id="tabClients" onclick="bdTab('clients')">Clients</button>
      <button id="tabReqs" onclick="bdTab('reqs')">Requisitions</button>
      <button id="tabLeads" onclick="bdTab('leads')">Leads</button>
    </div><div id="bdBody"></div>`;
  window.bdTab = async function(which){
    document.getElementById('tabDash').classList.toggle('active', which==='dash');
    document.getElementById('tabClients').classList.toggle('active', which==='clients');
    document.getElementById('tabReqs').classList.toggle('active', which==='reqs');
    document.getElementById('tabLeads').classList.toggle('active', which==='leads');
    if(which==='dash') await renderBDDashboard();
    else if(which==='clients') await renderClientsTab();
    else if(which==='reqs') await renderReqsTab();
    else await renderLeadsTab();
  };
  await renderBDDashboard();
}
async function renderRecruiterInto(container){
  await renderRecruiterJobs(container);
}

// ============================================================
// 8. CLIENT PORTAL
// ============================================================
async function renderClient(){
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="empty">Loading…</div>`;
  const [reqs, myDrafts] = await Promise.all([
    rest('requisitions', {query:`status=in.(open,on_hold,closed)&select=*&order=created_at.desc`}),
    rest('requisitions', {query:`source=eq.client_submitted&status=eq.draft&select=*&order=created_at.desc`})
  ]);
  const reqIds = reqs.map(r=>r.id);
  const allApps = reqIds.length ? await rest('applications', {query:`requisition_id=in.(${reqIds.join(',')})&select=*`}) : [];

  const totalSubmitted = allApps.length;
  const awaitingFeedback = allApps.filter(a=>!a.client_feedback).length;
  const inInterview = allApps.filter(a=>a.current_stage.includes('Interview')).length;
  const offersOut = allApps.filter(a=>['Offer Stage','Offer Accepted'].includes(a.current_stage)).length;

  main.innerHTML = `
    <div class="section-title"><h2>Dashboard</h2></div>
    <div class="grid" style="margin-bottom:14px;">
      <div class="card"><div class="meta-row">Candidates submitted</div><div class="req-title" style="font-size:22px;">${totalSubmitted}</div></div>
      <div class="card"><div class="meta-row">Awaiting your feedback</div><div class="req-title" style="font-size:22px;">${awaitingFeedback}</div></div>
      <div class="card"><div class="meta-row">In interview stage</div><div class="req-title" style="font-size:22px;">${inInterview}</div></div>
      <div class="card"><div class="meta-row">Offers extended</div><div class="req-title" style="font-size:22px;">${offersOut}</div></div>
    </div>
    ${myDrafts.length ? `
    <div class="section-title"><h2>Your submitted requirements — pending review</h2></div>
    <div style="margin-bottom:14px;">${myDrafts.map(r=>`
      <div class="card"><div class="req-title">${r.title}</div>
      <div class="meta-row">Submitted ${new Date(r.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})} · Your WorkSource contact will review and get in touch</div></div>`).join('')}
    </div>` : ''}
    <div class="section-title"><h2>Your open roles</h2><button class="btn-secondary" onclick="openSubmitRequirementModal()">+ Submit new requirement</button></div>
    <div id="clientReqList"></div>`;
  const list = document.getElementById('clientReqList');
  if(!reqs.length){ list.innerHTML = `<div class="empty">No open roles yet — submit a requirement above, or your WorkSource contact will publish here once a search kicks off.</div>`; return; }
  list.innerHTML = reqs.map(r => {
    const roleApps = allApps.filter(a=>a.requisition_id===r.id);
    const stageCounts = {};
    roleApps.forEach(a=>{ stageCounts[a.current_stage] = (stageCounts[a.current_stage]||0)+1; });
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><div class="req-title">${r.title}</div>
        <div class="meta-row">${r.openings} opening(s) · Priority: ${r.priority}</div>
        <div class="meta-row">${Object.entries(stageCounts).map(([s,n])=>`${n} ${s}`).join(' · ')||'No candidates submitted yet'}</div></div>
        <span class="badge ${r.status}">${r.status.replace('_',' ')}</span>
      </div>
      ${roleApps.length>=2 ? `<button class="icon-btn" style="margin-top:8px;" onclick="compareClientCandidates('${r.id}')">⚖ Compare candidates</button>` : ''}
      <div id="clientCompareBox_${r.id}" class="hidden ai-box" style="margin-top:8px;"></div>
      <div id="clientApps_${r.id}" class="app-list" style="margin-top:10px;"></div>
    </div>`;
  }).join('');
  reqs.forEach(r => loadClientApplications(r.id));
}

function clientFeedbackLabel(fb){
  return {interested:'Interested', not_interested:'Not interested', request_interview:'Interview requested'}[fb] || fb;
}

async function loadClientApplications(reqId){
  const apps = await rest('applications', {query:`requisition_id=eq.${reqId}&select=*,candidates(*)&order=created_at.desc`});
  const el = document.getElementById('clientApps_'+reqId);
  if(!apps.length){ el.innerHTML = `<div class="meta-row">No candidates submitted yet for this role.</div>`; return; }
  el.innerHTML = apps.map(a => `
    <div class="app-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div class="name">${a.candidates.full_name} ${!a.client_viewed_at?'<span class="badge open">New</span>':''}</div>
          <div class="sub"><span class="stage-pill">${a.current_stage}</span></div>
          ${a.client_feedback ? `<div class="sub" style="margin-top:4px;">Your response: <b>${clientFeedbackLabel(a.client_feedback)}</b>${a.client_feedback_note?' — '+a.client_feedback_note:''}</div>` : ''}
        </div>
        <button class="icon-btn" onclick='viewClientCandidateSummary(${JSON.stringify(a)},"${reqId}")'>View profile</button>
        <button class="icon-btn" onclick="openClientMessageThread('${a.id}','${a.candidates.full_name}')">💬 Message</button>
      </div>
      ${!a.client_feedback ? `
      <div style="margin-top:8px;">
        <input id="fbnote_${a.id}" placeholder="Optional note (e.g. reason, priority)" style="margin-bottom:6px;" />
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="icon-btn" onclick="setClientFeedback('${a.id}','interested','${reqId}')">👍 Interested</button>
          <button class="icon-btn" onclick="setClientFeedback('${a.id}','not_interested','${reqId}')">👎 Not interested</button>
          <button class="icon-btn" onclick="setClientFeedback('${a.id}','request_interview','${reqId}')">📅 Request interview</button>
        </div>
      </div>` : ''}
    </div>`).join('');
}

async function viewClientCandidateSummary(app, reqId){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal"><h3>${app.candidates.full_name}</h3><div id="clientSummaryBox" class="ai-box">Loading…</div>
    <div style="display:flex;gap:10px;margin-top:18px;"><button class="btn-ghost" onclick="closeModal()">Close</button></div></div>`;
  document.body.appendChild(bg);
  // Mark viewed — separates "hasn't looked yet" from "looked and went quiet" for the recruiter/BD side
  if(!app.client_viewed_at){
    rest('applications', {method:'PATCH', query:`id=eq.${app.id}`, body:{client_viewed_at:new Date().toISOString()}}).then(()=>{ if(reqId) loadClientApplications(reqId); });
  }
  const c = app.candidates;
  try{
    const text = await callClaudeSimple(`Write a client-ready candidate summary, professional, 4-6 short lines covering: experience level, current/expected CTC, notice period, and a brief note on career direction. Do NOT include family background, marital status, or anything like that — those are deliberately excluded.

Candidate: ${c.full_name}
Experience: ${c.experience_yrs||'?'} yrs
Current CTC: ${c.current_ctc||'?'} LPA, Expected: ${c.expected_ctc||'?'} LPA
Notice period: ${c.notice_period_days||'?'} days
Skills: ${(c.skills||[]).join(', ')||'Not specified'}
AI match notes: ${app.ai_match_detail ? JSON.stringify(app.ai_match_detail) : 'Not available'}`, 400);
    document.getElementById('clientSummaryBox').innerHTML = text.replace(/\n/g,'<br/>');
  }catch(e){ document.getElementById('clientSummaryBox').textContent = 'Failed to load: ' + e.message; }
}

async function setClientFeedback(appId, feedback, reqId){
  const noteEl = document.getElementById('fbnote_'+appId);
  const note = noteEl ? noteEl.value : '';
  await rest('applications', {method:'PATCH', query:`id=eq.${appId}`, body:{client_feedback:feedback, client_feedback_at:new Date().toISOString(), client_feedback_note: note||null}});
  toast('Response recorded — your WorkSource contact will follow up');
  loadClientApplications(reqId);
}

async function compareClientCandidates(reqId){
  const box = document.getElementById('clientCompareBox_'+reqId);
  box.classList.remove('hidden'); box.innerHTML = 'Comparing…';
  const [reqRows, apps] = await Promise.all([
    rest('requisitions', {query:`id=eq.${reqId}&select=title`}),
    rest('applications', {query:`requisition_id=eq.${reqId}&select=*,candidates(*)`})
  ]);
  const candList = apps.map(a=>`- ${a.candidates.full_name}: Exp ${a.candidates.experience_yrs||'?'} yrs, Current ${a.candidates.current_ctc||'?'} → Expected ${a.candidates.expected_ctc||'?'} LPA, Notice ${a.candidates.notice_period_days||'?'} days, Skills: ${(a.candidates.skills||[]).join(', ')||'Not specified'}, Stage: ${a.current_stage}`).join('\n');
  const text = await callClaudeSimple(`Compare these candidates submitted for the same role, for a client deciding who to move forward with. Give a short, organized comparison — relative strengths, who's available sooner, who's closer to budget. This is informational only — do not recommend a single "best" choice, just organize the comparison so the client can decide. Plain text, no markdown headers, under 200 words.

Role: ${reqRows[0].title}

Candidates:
${candList}`, 500);
  box.innerHTML = text.replace(/\n/g,'<br/>');
}

// ---------- Client-submitted requirements ----------
function openSubmitRequirementModal(){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Submit new requirement</h3>
    <p class="meta-row">Your WorkSource contact will review this, confirm details, and get the search moving.</p>
    <label>Role title *</label><input id="cr_title" placeholder="e.g. Senior Accountant" />
    <div class="row2"><div><label>CTC min (LPA)</label><input id="cr_ctcmin" /></div><div><label>CTC max (LPA)</label><input id="cr_ctcmax" /></div></div>
    <div class="row2"><div><label>Openings</label><input id="cr_openings" value="1" /></div><div><label>Priority</label>
      <select id="cr_priority"><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></div></div>
    <label>Requirements / description</label><textarea id="cr_desc" rows="4" placeholder="Describe the role, must-have skills, experience needed, location, etc."></textarea>
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="submitClientRequirement()">Submit</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function submitClientRequirement(){
  const title = document.getElementById('cr_title').value;
  if(!title){ toast('Role title required'); return; }
  const myClientId = profile.client_id;
  const clientRows = await rest('clients', {query:`id=eq.${myClientId}&select=segment`});
  await rest('requisitions', {method:'POST', body:{
    client_id: myClientId,
    title,
    segment: clientRows[0]?.segment || 'Other',
    ctc_min: parseFloat(document.getElementById('cr_ctcmin').value)||null,
    ctc_max: parseFloat(document.getElementById('cr_ctcmax').value)||null,
    openings: parseInt(document.getElementById('cr_openings').value)||1,
    priority: document.getElementById('cr_priority').value,
    jd_text: document.getElementById('cr_desc').value,
    status: 'draft',
    source: 'client_submitted'
  }});
  closeModal(); toast('Requirement submitted — your WorkSource contact will review it shortly'); renderClient();
}

// ---------- Direct client-candidate messaging ----------
function openClientMessageThread(appId, candidateName){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Messages — ${candidateName}</h3>
    <div class="meta-row" style="background:var(--orange-light);padding:8px;border-radius:8px;margin-bottom:10px;">Reminder: standard placement terms apply regardless of how you connect with this candidate.</div>
    <div id="msgThread_${appId}" style="max-height:240px;overflow-y:auto;margin-bottom:10px;"></div>
    <textarea id="msg_input_${appId}" rows="2" placeholder="Type a message…"></textarea>
    <div style="display:flex;gap:10px;margin-top:10px;">
      <button class="btn-primary" style="margin-top:0;" onclick="sendClientMessage('${appId}')">Send</button>
      <button class="btn-ghost" onclick="closeModal()">Close</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  loadClientMessageThread(appId);
}
async function loadClientMessageThread(appId){
  const el = document.getElementById('msgThread_'+appId);
  if(!el) return;
  const msgs = await rest('messages', {query:`application_id=eq.${appId}&select=*&order=sent_at`});
  el.innerHTML = msgs.length ? msgs.map(m=>`
    <div style="padding:6px 0;border-bottom:1px solid var(--line);">
      <span class="stage-pill">${m.sender_role==='client'?'You':'Candidate'}</span>
      <span class="meta-row" style="display:inline;">${m.message_text}</span>
      <div style="font-size:11px;color:var(--ink-soft);">${new Date(m.sent_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`).join('') : `<div class="empty">No messages yet.</div>`;
}
async function sendClientMessage(appId){
  const input = document.getElementById('msg_input_'+appId);
  const text = input.value.trim();
  if(!text) return;
  await rest('messages', {method:'POST', body:{application_id: appId, sender_role:'client', sender_user_id: profile.id, message_text: text}});
  input.value = '';
  loadClientMessageThread(appId);
}

// ============================================================
// 9. CANDIDATE PORTAL
// ============================================================
const CANDIDATE_STAGE_LABEL = {
  'Sourced': 'Under Review', 'Screened': 'Under Review',
  'Submitted to Client': 'With Employer',
  'Client Interview R1': 'Interview Scheduled', 'Client Interview R2': 'Interview Scheduled',
  'Offer Stage': 'Offer in Progress', 'Offer Accepted': 'Offer Accepted',
  'Joined': 'Onboarding', 'Placed': 'Placed',
  'Rejected': 'Not Selected This Time', 'On Hold': 'On Hold'
};

async function renderCandidatePortal(){
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="section-title"><h2>Your applications</h2><button class="btn-secondary" onclick="openCandidateResumeUpdateModal()">📄 Update resume</button></div><div id="candAppsList"></div>`;
  const apps = await rest('applications', {query:`select=*,requisitions(*)&order=created_at.desc`});
  const list = document.getElementById('candAppsList');
  if(!apps.length){ list.innerHTML = `<div class="empty">No active applications right now.</div>`; return; }
  for(const a of apps){
    const req = a.requisitions;
    let clientLabel = `Confidential Client — ${req.segment} sector`;
    try{
      const revealed = await rest('rpc/get_client_name_if_revealed', {method:'POST', body:{req_id: req.id}});
      if(revealed) clientLabel = revealed;
    }catch(e){ /* stays confidential on any error — safe default */ }
    const interviews = await rest('interviews', {query:`application_id=eq.${a.id}&select=*&order=scheduled_at`});
    const pendingSelection = interviews.find(iv=>iv.status==='pending_candidate_selection');
    const scheduledUpcoming = interviews.find(iv=>iv.status==='scheduled');

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><div class="req-title">${req.title}</div>
        <div class="meta-row">${clientLabel}</div></div>
        <span class="stage-pill">${CANDIDATE_STAGE_LABEL[a.current_stage]||a.current_stage}</span>
      </div>
      ${pendingSelection ? `
        <div class="card" style="border-color:var(--orange);margin-top:10px;">
          <div class="meta-row" style="font-weight:600;">Pick an interview time:</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            ${(pendingSelection.proposed_slots||[]).map(s=>`<button class="icon-btn" onclick="pickInterviewSlot('${pendingSelection.id}','${s}','${a.id}')">${new Date(s).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</button>`).join('')}
          </div>
        </div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        ${scheduledUpcoming ? `<button class="icon-btn" onclick='candidateInterviewPrep(${JSON.stringify(req)},"${a.id}")'>✨ Prep for my interview</button>` : ''}
        <button class="icon-btn" onclick="openCandidateMessageThread('${a.id}')">💬 Messages</button>
        <button class="icon-btn" onclick="toggleCandidateFAQ('${a.id}','${a.current_stage}')">❓ Ask a question</button>
      </div>
      <div id="candPrepBox_${a.id}" class="hidden" style="margin-top:8px;"></div>
      <div id="candFaqBox_${a.id}" class="hidden" style="margin-top:8px;"></div>
      <div id="candMsgBox_${a.id}" class="hidden" style="margin-top:8px;"></div>`;
    list.appendChild(card);
  }
}

// ---------- A. Self-scheduling ----------
async function pickInterviewSlot(interviewId, isoSlot, appId){
  await rest('interviews', {method:'PATCH', query:`id=eq.${interviewId}`, body:{scheduled_at: isoSlot, status:'scheduled'}});
  toast('Interview confirmed'); renderCandidatePortal();
}

// ---------- B. AI interview prep (segment-level only, never client-specific) ----------
async function candidateInterviewPrep(req, appId){
  const box = document.getElementById('candPrepBox_'+appId);
  box.classList.remove('hidden'); box.innerHTML = `<div class="ai-box">Preparing…</div>`;
  const text = await callClaudeSimple(`Give a candidate short, encouraging interview prep for this type of role. Cover: what to expect in this kind of interview, 2-3 general tips, and 3 practice questions typical for this role/sector. Do not mention any specific company — speak generally about the role type and sector. Plain text, no markdown, under 180 words.

Role: ${req.title}
Sector: ${req.segment}
Hiring category: ${req.hiring_category||'Not specified'}`, 400);
  box.innerHTML = `<div class="ai-box">${text.replace(/\n/g,'<br/>')}</div>`;
}

// ---------- C. Self-service FAQ ----------
function toggleCandidateFAQ(appId, stage){
  const box = document.getElementById('candFaqBox_'+appId);
  const isHidden = box.classList.contains('hidden');
  document.querySelectorAll('[id^="candFaqBox_"]').forEach(b=>b.classList.add('hidden'));
  if(!isHidden) return;
  box.classList.remove('hidden');
  box.innerHTML = `
    <input id="candFaqInput_${appId}" placeholder="e.g. What happens after the interview?" style="margin-bottom:8px;" />
    <button class="btn-primary" onclick="askCandidateFAQ('${appId}','${stage}')">Ask</button>
    <div id="candFaqAnswer_${appId}" style="margin-top:8px;"></div>`;
}
async function askCandidateFAQ(appId, stage){
  const q = document.getElementById('candFaqInput_'+appId).value.trim();
  if(!q){ toast('Type a question first'); return; }
  const answerBox = document.getElementById('candFaqAnswer_'+appId);
  answerBox.innerHTML = `<div class="ai-box">Thinking…</div>`;
  const text = await callClaudeSimple(`A job candidate going through a recruitment agency process is asking a question. Answer helpfully and briefly using general recruitment-process knowledge and their current stage. Do not invent specific details about their case beyond what's given — if you don't know something specific (like exact dates), say the recruiter will confirm that. Plain text, under 100 words.

Candidate's current stage: ${CANDIDATE_STAGE_LABEL[stage]||stage}
Question: ${q}`, 300);
  answerBox.innerHTML = `<div class="ai-box">${text.replace(/\n/g,'<br/>')}</div>`;
}

// ---------- D. Resume refresh (recruiter approval required) ----------
function openCandidateResumeUpdateModal(){
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML = `<div class="modal">
    <h3>Update your resume</h3>
    <p class="meta-row">Upload your latest resume. Your recruiter will review the changes before anything updates on your profile.</p>
    <input type="file" id="cand_resume_file" accept=".pdf,.doc,.docx,.txt" style="margin-top:10px;" />
    <div style="display:flex;gap:10px;margin-top:18px;">
      <button class="btn-primary" style="margin-top:0;" onclick="submitCandidateResumeUpdate(this)">Submit for review</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
}
async function submitCandidateResumeUpdate(btn){
  const file = document.getElementById('cand_resume_file').files[0];
  if(!file){ toast('Choose a file first'); return; }
  const orig = btn.textContent; btn.textContent = 'Processing…'; btn.disabled = true;
  try{
    const ext = file.name.split('.').pop().toLowerCase();
    let fields;
    if(ext === 'pdf'){
      const base64 = await fileToBase64(file);
      const res = await fetch(AI_PROXY_URL, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
        body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user', content:[
          {type:'document', source:{type:'base64', media_type:'application/pdf', data: base64}},
          {type:'text', text:`Extract updated candidate fields from this resume. Respond ONLY with valid JSON, no markdown fences: {"current_company": "... or null", "experience_yrs": <number or null>, "skills": ["...", "..."]}`}
        ]}]})
      });
      const data = await res.json();
      fields = JSON.parse(data.content.find(b=>b.type==='text').text.replace(/```json|```/g,'').trim());
    } else if(ext === 'docx' || ext === 'doc'){
      await ensureMammothLoaded();
      const result = await mammoth.extractRawText({arrayBuffer: await file.arrayBuffer()});
      fields = await extractResumeFieldsFromText(result.value);
    } else {
      fields = await extractResumeFieldsFromText(await file.text());
    }
    const diff = {};
    if(fields.current_company) diff.current_company = fields.current_company;
    if(fields.experience_yrs) diff.experience_yrs = fields.experience_yrs;
    if(fields.skills && fields.skills.length) diff.skills = fields.skills;
    await rest('candidates', {method:'PATCH', query:`id=eq.${profile.candidate_id}`, body:{pending_resume_update: diff}});
    closeModal(); toast('Submitted — your recruiter will review and confirm the update');
  }catch(e){ toast('Failed: ' + e.message); btn.textContent = orig; btn.disabled = false; }
}

function openCandidateMessageThread(appId){
  const box = document.getElementById('candMsgBox_'+appId);
  const isHidden = box.classList.contains('hidden');
  document.querySelectorAll('[id^="candMsgBox_"]').forEach(b=>b.classList.add('hidden'));
  if(!isHidden) return;
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="meta-row" style="background:var(--orange-light);padding:8px;border-radius:8px;margin-bottom:10px;">Reminder: standard placement terms apply regardless of how you connect through this portal.</div>
    <div id="candMsgThread_${appId}" style="max-height:220px;overflow-y:auto;margin-bottom:10px;"></div>
    <textarea id="candMsgInput_${appId}" rows="2" placeholder="Type a message…"></textarea>
    <button class="btn-primary" style="margin-top:8px;" onclick="sendCandidateMessage('${appId}')">Send</button>`;
  loadCandidateMessageThread(appId);
}
async function loadCandidateMessageThread(appId){
  const el = document.getElementById('candMsgThread_'+appId);
  if(!el) return;
  const msgs = await rest('messages', {query:`application_id=eq.${appId}&select=*&order=sent_at`});
  el.innerHTML = msgs.length ? msgs.map(m=>`
    <div style="padding:6px 0;border-bottom:1px solid var(--line);">
      <span class="stage-pill">${m.sender_role==='candidate'?'You':'Client'}</span>
      <span class="meta-row" style="display:inline;">${m.message_text}</span>
      <div style="font-size:11px;color:var(--ink-soft);">${new Date(m.sent_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`).join('') : `<div class="empty">No messages yet.</div>`;
}
async function sendCandidateMessage(appId){
  const input = document.getElementById('candMsgInput_'+appId);
  const text = input.value.trim();
  if(!text) return;
  await rest('messages', {method:'POST', body:{application_id: appId, sender_role:'candidate', sender_user_id: profile.id, message_text: text}});
  input.value = '';
  loadCandidateMessageThread(appId);
}

// Enter key on login
document.getElementById('loginPassword').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
