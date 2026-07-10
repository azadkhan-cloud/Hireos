/* ============================================================
   HireOS add-on module — Interview invites, Offers, Daily Digest
   Self-contained: uses the app's own session; no app.js changes.
   ============================================================ */
(function () {
  'use strict';
  var SUPA_URL = 'https://xrargvfdummasvaacfko.supabase.co';

  /* ---------- auth: reuse the app's own tokens at runtime ---------- */
  function jwtPayload(t) {
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
    catch (e) { return null; }
  }
  function collectJwts() {
    var found = {};
    function scan(v) {
      if (typeof v === 'string') {
        var m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g);
        if (m) m.forEach(function (x) { found[x] = true; });
      }
    }
    Object.keys(window).forEach(function (k) {
      try { var v = window[k]; if (typeof v === 'string') scan(v); } catch (e) {}
    });
    for (var i = 0; i < localStorage.length; i++) {
      try { scan(localStorage.getItem(localStorage.key(i))); } catch (e) {}
    }
    for (var j = 0; j < sessionStorage.length; j++) {
      try { scan(sessionStorage.getItem(sessionStorage.key(j))); } catch (e) {}
    }
    return Object.keys(found);
  }
  function tokens() {
    var anon = null, user = null, bestExp = 0;
    collectJwts().forEach(function (t) {
      var p = jwtPayload(t);
      if (!p) return;
      if (p.role === 'anon') anon = t;
      if (p.role === 'authenticated' && (p.exp || 0) > bestExp) { user = t; bestExp = p.exp || 0; }
    });
    return { anon: anon, user: user };
  }
  function authUid() {
    var t = tokens(); if (!t.user) return null;
    var p = jwtPayload(t.user); return p ? p.sub : null;
  }

  /* ---------- REST helper ---------- */
  function frest(path, opts) {
    opts = opts || {};
    var t = tokens();
    if (!t.anon) return Promise.reject(new Error('Not ready'));
    var headers = {
      apikey: t.anon,
      Authorization: 'Bearer ' + (t.user || t.anon),
      'Content-Type': 'application/json'
    };
    if (opts.method && opts.method !== 'GET') headers.Prefer = 'return=representation';
    if (opts.upsert) headers.Prefer = 'resolution=merge-duplicates,return=representation';
    return fetch(SUPA_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (x) { throw new Error(x); });
      return r.status === 204 ? null : r.json();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg) { if (window.toast) { try { window.toast(msg); return; } catch (e) {} } alert(msg); }
  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  var profile = null;
  function loadProfile() {
    var uid = authUid();
    if (!uid) return Promise.resolve(null);
    return frest('users?auth_id=eq.' + uid + '&select=id,full_name,role').then(function (rows) {
      profile = rows && rows[0] ? rows[0] : null; return profile;
    });
  }

  /* ---------- ICS + calendar links ---------- */
  function icsDate(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function buildICS(ev) {
    var end = new Date(new Date(ev.start).getTime() + 60 * 60 * 1000);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HireOS//EN', 'BEGIN:VEVENT',
      'UID:' + ev.uid + '@hireos',
      'DTSTAMP:' + icsDate(new Date()),
      'DTSTART:' + icsDate(ev.start),
      'DTEND:' + icsDate(end),
      'SUMMARY:' + ev.title,
      'DESCRIPTION:' + (ev.desc || '').replace(/\n/g, '\\n'),
      'LOCATION:' + (ev.location || ''),
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }
  function gcalLink(ev) {
    var s = icsDate(ev.start);
    var e = icsDate(new Date(new Date(ev.start).getTime() + 3600000));
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(ev.title) +
      '&dates=' + s + '/' + e + '&details=' + encodeURIComponent(ev.desc || '') + '&location=' + encodeURIComponent(ev.location || '');
  }

  /* ---------- Panel UI ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#fxFab{position:fixed;bottom:20px;left:20px;z-index:1040;background:var(--navy-900,#0B57A4);color:#fff;padding:11px 18px;border-radius:9999px;font-size:13.5px;font-weight:700;box-shadow:0 8px 24px rgba(10,26,51,.35);border:none;}' +
    '#fxFab:hover{background:var(--navy-800,#0F6FBF);}' +
    '#fxPanelBg{position:fixed;inset:0;background:rgba(10,26,51,.6);z-index:1050;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;}' +
    '#fxPanel{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:760px;box-shadow:0 25px 50px -12px rgba(10,26,51,.25);}' +
    '.fxTabs{display:flex;gap:2px;border-bottom:1px solid var(--gray-200,#E0E0E0);margin-bottom:14px;}' +
    '.fxTabs button{background:none;color:var(--gray-500,#757575);padding:9px 12px;border-bottom:2px solid transparent;border-radius:0;font-size:13.5px;}' +
    '.fxTabs button.active{color:var(--navy-900,#0B57A4);border-bottom-color:var(--orange-500,#F5A623);font-weight:700;}' +
    '.fxRow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;background:var(--gray-50,#FAFAFA);border:1px solid var(--gray-200,#E0E0E0);border-radius:12px;margin-bottom:8px;}' +
    '.fxBtn{background:#fff;color:var(--navy-900,#0B57A4);font-size:12px;padding:5px 10px;border:1px solid var(--gray-200,#E0E0E0);font-weight:600;border-radius:9999px;}' +
    '.fxBtn:hover{border-color:var(--navy-700,#1F86E3);}' +
    '@media(max-width:600px){#fxFab{bottom:14px;left:14px;padding:9px 14px;}}';
  document.head.appendChild(css);

  function ensureFab() {
    if (document.getElementById('fxFab')) return;
    var appEl = document.getElementById('app');
    if (!appEl || !appEl.classList.contains('active')) return;
    loadProfile().then(function (p) {
      if (!p || ['admin', 'recruiter', 'bd'].indexOf(p.role) < 0) return;
      if (document.getElementById('fxFab')) return;
      var b = document.createElement('button');
      b.id = 'fxFab'; b.textContent = '⚡ Tools';
      b.onclick = openPanel;
      document.body.appendChild(b);
    }).catch(function () {});
  }

  var currentTab = 'interviews';
  function openPanel() {
    closePanel();
    var bg = document.createElement('div'); bg.id = 'fxPanelBg';
    bg.onclick = function (e) { if (e.target === bg) closePanel(); };
    var tabs = '<button data-t="interviews">📅 Interview Invites</button>' +
      '<button data-t="offers">📄 Offers</button>';
    if (profile && (profile.role === 'admin' || profile.role === 'bd')) {
      tabs += '<button data-t="digest">📊 Daily Digest</button>';
    }
    bg.innerHTML = '<div id="fxPanel">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<h3 style="margin:0;color:var(--navy-900,#0B57A4);font-size:19px;">HireOS Tools</h3>' +
      '<button class="fxBtn" id="fxClose">✕ Close</button></div>' +
      '<div class="fxTabs">' + tabs + '</div><div id="fxBody">Loading…</div></div>';
    document.body.appendChild(bg);
    document.getElementById('fxClose').onclick = closePanel;
    bg.querySelectorAll('.fxTabs button').forEach(function (btn) {
      btn.onclick = function () { currentTab = btn.getAttribute('data-t'); renderTab(); };
    });
    renderTab();
  }
  function closePanel() { var el = document.getElementById('fxPanelBg'); if (el) el.remove(); }
  function body() { return document.getElementById('fxBody'); }
  function markTabs() {
    document.querySelectorAll('.fxTabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-t') === currentTab);
    });
  }
  function renderTab() {
    markTabs();
    if (currentTab === 'interviews') renderInterviews();
    else if (currentTab === 'offers') renderOffers();
    else renderDigest();
  }

  /* ---------- TAB 1: Interview invites ---------- */
  function renderInterviews() {
    body().innerHTML = 'Loading interviews…';
    frest('interviews?status=eq.scheduled&scheduled_at=gte.' + new Date(Date.now() - 86400000).toISOString() +
      '&order=scheduled_at.asc&limit=25&select=id,round,round_type,scheduled_at,mode,interviewer_name,' +
      'applications(id,candidates(full_name,email),requisitions(title,location,clients(company_name,contact_email)))')
      .then(function (rows) {
        if (!rows || !rows.length) { body().innerHTML = '<div class="empty">No upcoming scheduled interviews. Schedule one from the pipeline, then send invites from here.</div>'; return; }
        body().innerHTML = rows.map(function (iv, i) {
          var c = (iv.applications && iv.applications.candidates) || {};
          var r = (iv.applications && iv.applications.requisitions) || {};
          var cl = r.clients || {};
          var when = new Date(iv.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
          return '<div class="fxRow"><div>' +
            '<div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500,#757575);">' + esc(when) + ' · ' + esc(iv.mode) + ' · R' + iv.round + ' ' + esc(iv.round_type || '') +
            (iv.interviewer_name ? ' · with ' + esc(iv.interviewer_name) : '') + '</div></div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="fxBtn" data-ics="' + i + '">📅 .ics</button>' +
            '<button class="fxBtn" data-gcal="' + i + '">🗓 Google</button>' +
            '<button class="fxBtn" data-mail="' + i + '">✉️ Email invite</button>' +
            '</div></div>';
        }).join('');
        body().querySelectorAll('button').forEach(function (btn) {
          btn.onclick = function () {
            var i = +(btn.getAttribute('data-ics') || btn.getAttribute('data-gcal') || btn.getAttribute('data-mail'));
            var iv = rows[i];
            var c = (iv.applications && iv.applications.candidates) || {};
            var r = (iv.applications && iv.applications.requisitions) || {};
            var cl = r.clients || {};
            var ev = {
              uid: iv.id,
              start: iv.scheduled_at,
              title: 'Interview: ' + (c.full_name || 'Candidate') + ' — ' + (r.title || ''),
              desc: 'Round ' + iv.round + ' (' + (iv.round_type || '') + ')\nMode: ' + iv.mode +
                (iv.interviewer_name ? '\nInterviewer: ' + iv.interviewer_name : '') +
                '\nScheduled via HireOS (WorkSource)',
              location: iv.mode === 'In-Person' ? (r.location || '') : (iv.mode || '')
            };
            if (btn.hasAttribute('data-ics')) download('interview-' + (c.full_name || 'candidate').replace(/\s+/g, '-') + '.ics', buildICS(ev), 'text/calendar');
            else if (btn.hasAttribute('data-gcal')) window.open(gcalLink(ev), '_blank');
            else {
              var when = new Date(iv.scheduled_at).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' });
              var to = [c.email, cl.contact_email].filter(Boolean).join(',');
              var subject = 'Interview scheduled — ' + (r.title || '') + ' (Round ' + iv.round + ')';
              var bodyTxt = 'Dear ' + (c.full_name || 'Candidate') + ',%0D%0A%0D%0A' +
                'Your interview has been scheduled:%0D%0A%0D%0A' +
                'Role: ' + (r.title || '') + '%0D%0A' +
                'Date & time: ' + when + '%0D%0A' +
                'Mode: ' + iv.mode + '%0D%0A' +
                (iv.interviewer_name ? 'Interviewer: ' + iv.interviewer_name + '%0D%0A' : '') +
                '%0D%0APlease confirm your availability by replying to this email. A calendar invite is attached separately.%0D%0A%0D%0A' +
                'Best regards,%0D%0AWorkSource Recruitment Team';
              window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + bodyTxt;
            }
          };
        });
      }).catch(function (e) { body().innerHTML = '<div class="empty">Could not load interviews: ' + esc(e.message).slice(0, 200) + '</div>'; });
  }

  /* ---------- TAB 2: Offers ---------- */
  function offerTemplate(c, r, cl, ctc, joinDate) {
    var today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    return '<h2>Offer Letter</h2>' +
      '<p>Date: ' + today + '</p>' +
      '<p>Dear ' + esc(c.full_name) + ',</p>' +
      '<p>We are pleased to extend an offer for the position of <b>' + esc(r.title) + '</b>' +
      (cl.company_name ? ' with <b>' + esc(cl.company_name) + '</b>' : '') +
      (r.location ? ', based in ' + esc(r.location) : '') + '.</p>' +
      '<p><b>Annual CTC:</b> ₹' + esc(ctc) + ' LPA<br/>' +
      (joinDate ? '<b>Expected joining date:</b> ' + esc(joinDate) + '<br/>' : '') +
      '<b>Employment type:</b> Full-time</p>' +
      '<p>This offer is contingent on satisfactory completion of background verification and submission of required documents. Detailed terms will follow in the formal appointment letter from the employer.</p>' +
      '<p>Please confirm your acceptance by replying to this letter.</p>' +
      '<p>Warm regards,<br/>WorkSource Recruitment Team</p>';
  }
  function renderOffers() {
    if (profile && profile.role === 'bd') { body().innerHTML = '<div class="empty">Offers are managed by recruiters/admin.</div>'; return; }
    body().innerHTML = 'Loading offer-stage candidates…';
    Promise.all([
      frest('applications?current_stage=in.(%22Offer%20Stage%22,%22Offer%20Accepted%22)&select=id,current_stage,candidates(full_name,email),requisitions(title,location,ctc_min,ctc_max,clients(company_name))'),
      frest('offers?select=*')
    ]).then(function (res) {
      var apps = res[0] || [], offers = {};
      (res[1] || []).forEach(function (o) { offers[o.application_id] = o; });
      if (!apps.length) { body().innerHTML = '<div class="empty">No candidates at Offer Stage. Move a candidate to “Offer Stage” in the pipeline first.</div>'; return; }
      body().innerHTML = apps.map(function (a, i) {
        var c = a.candidates || {}, r = a.requisitions || {}, cl = r.clients || {};
        var o = offers[a.id];
        var status = o ? o.status : 'no letter';
        var badge = o ? ('<span class="badge ' + (o.status === 'accepted' ? 'open' : o.status === 'declined' ? 'closed' : 'on_hold') + '">' + esc(o.status) + '</span>') : '<span class="badge draft">no letter</span>';
        return '<div class="fxRow"><div>' +
          '<div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
          '<div style="font-size:12px;color:var(--gray-500,#757575);">' + esc(cl.company_name || '') + ' · stage: ' + esc(a.current_stage) + ' · ' + badge + '</div></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button class="fxBtn" data-gen="' + i + '">' + (o ? '↻ Regenerate' : '✨ Generate letter') + '</button>' +
          (o ? '<button class="fxBtn" data-dl="' + i + '">⬇ Download</button>' +
            '<button class="fxBtn" data-st="' + i + '" data-status="sent">Mark sent</button>' +
            '<button class="fxBtn" data-st="' + i + '" data-status="accepted">✅ Accepted</button>' +
            '<button class="fxBtn" data-st="' + i + '" data-status="declined">✖ Declined</button>' : '') +
          '</div></div>';
      }).join('');
      body().querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          var i = +(btn.getAttribute('data-gen') || btn.getAttribute('data-dl') || btn.getAttribute('data-st'));
          var a = apps[i], c = a.candidates || {}, r = a.requisitions || {}, cl = r.clients || {};
          var o = offers[a.id];
          if (btn.hasAttribute('data-gen')) {
            var ctc = prompt('Annual CTC for the offer (LPA):', o && o.ctc_annual ? o.ctc_annual : (r.ctc_max || ''));
            if (ctc === null) return;
            var jd = prompt('Expected joining date (e.g. 2026-08-01), or leave blank:', o && o.joining_date ? o.joining_date : '');
            btn.textContent = 'Generating…';
            var fallback = offerTemplate(c, r, cl, ctc, jd);
            var finish = function (html) {
              frest('offers?on_conflict=application_id', {
                method: 'POST', upsert: true,
                body: { application_id: a.id, ctc_annual: ctc || null, joining_date: jd || null, letter_html: html, status: 'draft', generated_by: profile ? profile.id : null, updated_at: new Date().toISOString() }
              }).then(function () { say('Offer letter saved'); renderOffers(); })
                .catch(function (e) { say('Save failed: ' + e.message.slice(0, 120)); renderOffers(); });
            };
            if (typeof window.callClaudeSimple === 'function') {
              var prompt2 = 'Write a warm, professional offer letter (HTML body only, use <p>/<b>, no <html> tag) from "WorkSource Recruitment Team" to candidate ' + (c.full_name || '') +
                ' for the role of ' + (r.title || '') + (cl.company_name ? ' at client company ' + cl.company_name : '') +
                (r.location ? ', location ' + r.location : '') + '. Annual CTC: INR ' + ctc + ' LPA.' +
                (jd ? ' Expected joining date: ' + jd + '.' : '') +
                ' Include: congratulations, role summary, CTC, joining date if given, standard contingency on background verification and documents, request to confirm acceptance. Keep under 250 words. Output HTML only.';
              Promise.resolve(window.callClaudeSimple(prompt2, 1200)).then(function (res2) {
                var txt = typeof res2 === 'string' ? res2 : (res2 && res2.text) || (res2 && res2.content && res2.content[0] && res2.content[0].text) || '';
                finish(txt && txt.indexOf('<') >= 0 ? txt : fallback);
              }).catch(function () { finish(fallback); });
            } else finish(fallback);
          } else if (btn.hasAttribute('data-dl')) {
            var doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offer — ' + esc(c.full_name) + '</title>' +
              '<style>body{font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6;color:#212121;}h2{color:#0B57A4;}</style></head><body>' +
              o.letter_html + '</body></html>';
            download('offer-' + (c.full_name || 'candidate').replace(/\s+/g, '-') + '.html', doc, 'text/html');
          } else {
            var st = btn.getAttribute('data-status');
            frest('offers?id=eq.' + o.id, { method: 'PATCH', body: { status: st, updated_at: new Date().toISOString() } })
              .then(function () {
                say('Offer marked ' + st);
                if (st === 'accepted') say('Tip: move the candidate to “Offer Accepted” in the pipeline.');
                renderOffers();
              }).catch(function (e) { say('Update failed: ' + e.message.slice(0, 120)); });
          }
        };
      });
    }).catch(function (e) { body().innerHTML = '<div class="empty">Could not load offers: ' + esc(e.message).slice(0, 200) + '</div>'; });
  }

  /* ---------- TAB 3: Daily digest ---------- */
  function renderDigest() {
    body().innerHTML = 'Loading digests…';
    frest('daily_digests?order=digest_date.desc&limit=7&select=*').then(function (rows) {
      var t = tokens();
      var head = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<div style="font-size:12.5px;color:var(--gray-500,#757575);">Auto-generated every morning at 8:00 IST. Latest 7 shown.</div>' +
        '<button class="fxBtn" id="fxGenDigest">⚡ Generate now</button></div>';
      if (!rows || !rows.length) {
        body().innerHTML = head + '<div class="empty">No digests yet — click “Generate now” to create the first one.</div>';
      } else {
        body().innerHTML = head + rows.map(function (d) {
          var s = d.stats || {};
          return '<div class="fxRow" style="align-items:flex-start;flex-direction:column;">' +
            '<div style="font-weight:700;color:var(--navy-900,#0B57A4);">' + esc(d.digest_date) + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500,#757575);">Open reqs: ' + (s.open_reqs != null ? s.open_reqs : '—') +
            ' · Active pipeline: ' + (s.active_apps != null ? s.active_apps : '—') +
            ' · Interviews next 48h: ' + (s.interviews_48h != null ? s.interviews_48h : '—') +
            ' · SLA breaches: ' + (s.sla_breaches != null ? s.sla_breaches : '—') +
            ' · New leads (24h): ' + (s.new_leads != null ? s.new_leads : '—') + '</div>' +
            (d.summary ? '<div style="font-size:13px;margin-top:6px;white-space:pre-wrap;">' + esc(d.summary) + '</div>' : '') +
            '</div>';
        }).join('');
      }
      document.getElementById('fxGenDigest').onclick = function () {
        this.textContent = 'Generating…';
        fetch(SUPA_URL + '/functions/v1/daily-digest?force=1', {
          method: 'POST',
          headers: { apikey: t.anon, Authorization: 'Bearer ' + (t.user || t.anon) }
        }).then(function (r) { return r.json(); })
          .then(function () { say('Digest generated'); renderDigest(); })
          .catch(function (e) { say('Failed: ' + e.message); renderDigest(); });
      };
    }).catch(function (e) { body().innerHTML = '<div class="empty">Could not load digests: ' + esc(e.message).slice(0, 200) + '</div>'; });
  }

  /* ---------- boot: show FAB once the app is active ---------- */
  var appEl = document.getElementById('app');
  if (appEl) {
    new MutationObserver(ensureFab).observe(appEl, { attributes: true, attributeFilter: ['class'] });
  }
  setInterval(ensureFab, 4000);
  ensureFab();
})();
