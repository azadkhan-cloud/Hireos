/* ============================================================
   HireOS add-on module — Interview invites, Offers, Daily Digest
   Uses the app's own authenticated helpers (window.rest,
   window.callClaudeSimple). No separate auth handling.
   ============================================================ */
(function () {
  'use strict';
  var FN_BASE = 'https://xrargvfdummasvaacfko.supabase.co/functions/v1';

  function ready() { return typeof window.rest === 'function'; }
  function api(table, opts) { return window.rest(table, opts || {}); }

  /* ------------------------------------------------------------------
     Session-expiry guard.
     The app holds its access token in memory and does not refresh it, so
     after ~1h every request fails with a raw "JWT expired" PostgREST error
     that leaks into the UI. Until the token refresh is added to app.js,
     catch that state once and show a clean re-login prompt instead.
     ------------------------------------------------------------------ */
  var expiredShown = false;
  function isExpiredSession(err) {
    var s = String((err && (err.message || err)) || '');
    return /jwt expired|PGRST303|\b401\b/i.test(s);
  }
  function showSessionExpired() {
    if (expiredShown || document.getElementById('fxExpired')) return;
    expiredShown = true;
    var d = document.createElement('div');
    d.id = 'fxExpired';
    d.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(10,26,51,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;';
    d.innerHTML = '<div style="background:var(--card,#fff);color:var(--ink,#212121);border-radius:16px;padding:30px;max-width:380px;width:100%;box-shadow:0 25px 60px rgba(0,0,0,.4);text-align:center;">' +
      '<div style="font-size:34px;margin-bottom:10px;">🔒</div>' +
      '<h3 style="margin:0 0 8px;color:var(--navy-900,#0B57A4);font-size:19px;">Session expired</h3>' +
      '<p style="margin:0 0 20px;font-size:14px;color:var(--gray-500,#757575);line-height:1.5;">' +
      'You have been signed out for security. Please sign in again to continue — nothing you saved has been lost.</p>' +
      '<button type="button" id="fxReauth" style="width:100%;background:var(--orange-500,#F5A623);color:#1A1206;border:none;padding:12px;border-radius:8px;font-weight:700;font-size:14.5px;cursor:pointer;">Sign in again</button>' +
      '</div>';
    document.body.appendChild(d);
    document.getElementById('fxReauth').onclick = function () { location.reload(); };
  }

  // Watch the app's own requests: if PostgREST starts rejecting them because the
  // token died, surface the friendly prompt instead of a raw error string.
  function installGuard() {
    if (!ready() || window.__fxGuarded) return;
    window.__fxGuarded = true;
    var orig = window.rest;
    window.rest = function () {
      var p;
      try { p = orig.apply(this, arguments); } catch (e) { if (isExpiredSession(e)) showSessionExpired(); throw e; }
      return (p && p.catch) ? p.catch(function (e) {
        if (isExpiredSession(e)) showSessionExpired();
        throw e;
      }) : p;
    };
  }
  installGuard();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg) { if (typeof window.toast === 'function') { try { window.toast(msg); return; } catch (e) {} } alert(msg); }
  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  var profile = null;
  function loadProfile() {
    if (profile) return Promise.resolve(profile);
    // The app already knows who is logged in; ask PostgREST for the row RLS allows.
    return api('users', { query: 'select=id,full_name,email,role&limit=50' }).then(function (rows) {
      if (!rows || !rows.length) return null;
      var name = (document.getElementById('whoAmI') || {}).textContent || '';
      var pill = ((document.getElementById('rolePill') || {}).textContent || '').trim().toLowerCase();
      profile = rows.filter(function (r) { return r.full_name && name.indexOf(r.full_name) >= 0; })[0]
             || rows.filter(function (r) { return r.role === pill; })[0]
             || rows[0];
      return profile;
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

  /* ---------- styles ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#fxFab{position:fixed;bottom:20px;left:20px;z-index:1040;background:var(--navy-900,#0B57A4);color:#fff;padding:11px 18px;border-radius:9999px;font-size:13.5px;font-weight:700;box-shadow:0 8px 24px rgba(10,26,51,.35);border:none;cursor:pointer;}' +
    '#fxFab:hover{background:var(--navy-800,#0F6FBF);}' +
    '#fxPanelBg{position:fixed;inset:0;background:rgba(10,26,51,.6);z-index:1050;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;}' +
    '#fxPanel{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:780px;box-shadow:0 25px 50px -12px rgba(10,26,51,.25);}' +
    '.fxTabs{display:flex;gap:2px;border-bottom:1px solid var(--gray-200,#E0E0E0);margin-bottom:14px;}' +
    '.fxTabs button{background:none;border:none;color:var(--gray-500,#757575);padding:9px 12px;border-bottom:2px solid transparent;border-radius:0;font-size:13.5px;cursor:pointer;font-weight:600;}' +
    '.fxTabs button.active{color:var(--navy-900,#0B57A4);border-bottom-color:var(--orange-500,#F5A623);}' +
    '.fxRow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;background:var(--gray-50,#FAFAFA);border:1px solid var(--gray-200,#E0E0E0);border-radius:12px;margin-bottom:8px;}' +
    '.fxBtn{background:#fff;color:var(--navy-900,#0B57A4);font-size:12px;padding:5px 10px;border:1px solid var(--gray-200,#E0E0E0);font-weight:600;border-radius:9999px;cursor:pointer;}' +
    '.fxBtn:hover{border-color:var(--navy-700,#1F86E3);background:rgba(31,134,227,.06);}' +
    '.fxEmpty{color:var(--gray-500,#757575);font-size:13.5px;padding:26px 18px;text-align:center;border:1.5px dashed var(--gray-200,#E0E0E0);border-radius:12px;background:var(--gray-50,#FAFAFA);}' +
    '@media(max-width:600px){#fxFab{bottom:14px;left:14px;padding:9px 14px;}}';
  document.head.appendChild(css);

  function ensureFab() {
    if (document.getElementById('fxFab')) return;
    var appEl = document.getElementById('app');
    if (!appEl || !appEl.classList.contains('active') || !ready()) return;
    loadProfile().then(function (p) {
      if (!p || ['admin', 'recruiter', 'bd'].indexOf(p.role) < 0) return;
      if (document.getElementById('fxFab')) return;
      var b = document.createElement('button');
      b.id = 'fxFab'; b.type = 'button'; b.textContent = '⚡ Tools';
      b.onclick = openPanel;
      document.body.appendChild(b);
    }).catch(function () {});
  }

  var currentTab = 'interviews';
  function openPanel() {
    closePanel();
    var bg = document.createElement('div'); bg.id = 'fxPanelBg';
    bg.onclick = function (e) { if (e.target === bg) closePanel(); };
    var tabs = '<button type="button" data-t="interviews">📅 Interview Invites</button>' +
      '<button type="button" data-t="offers">📄 Offers</button>' +
      '<button type="button" data-t="onboarding">🚀 Onboarding</button>';
    if (profile && (profile.role === 'admin' || profile.role === 'bd')) {
      tabs += '<button type="button" data-t="digest">📊 Daily Digest</button>';
    }
    bg.innerHTML = '<div id="fxPanel">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<h3 style="margin:0;color:var(--navy-900,#0B57A4);font-size:19px;">HireOS Tools</h3>' +
      '<button type="button" class="fxBtn" id="fxClose">✕ Close</button></div>' +
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
  function renderTab() {
    document.querySelectorAll('.fxTabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-t') === currentTab);
    });
    if (currentTab === 'interviews') renderInterviews();
    else if (currentTab === 'offers') renderOffers();
    else if (currentTab === 'onboarding') renderOnboarding();
    else renderDigest();
  }

  /* ---------- TAB 1: Interview invites ---------- */
  function renderInterviews() {
    body().innerHTML = 'Loading interviews…';
    var since = new Date(Date.now() - 86400000).toISOString();
    api('interviews', {
      query: 'status=eq.scheduled&scheduled_at=gte.' + since + '&order=scheduled_at.asc&limit=25' +
        '&select=id,round,round_type,scheduled_at,mode,interviewer_name,' +
        'applications(id,candidates(full_name,email),requisitions(title,location,clients(company_name,contact_email)))'
    }).then(function (rows) {
      if (!rows || !rows.length) {
        body().innerHTML = '<div class="fxEmpty">No upcoming scheduled interviews.<br/>Schedule one from a candidate\'s pipeline, then send invites from here.</div>';
        return;
      }
      body().innerHTML = rows.map(function (iv, i) {
        var c = (iv.applications && iv.applications.candidates) || {};
        var r = (iv.applications && iv.applications.requisitions) || {};
        var when = new Date(iv.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        return '<div class="fxRow"><div>' +
          '<div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
          '<div style="font-size:12px;color:var(--gray-500,#757575);">' + esc(when) + ' · ' + esc(iv.mode) + ' · R' + iv.round + ' ' + esc(iv.round_type || '') +
          (iv.interviewer_name ? ' · with ' + esc(iv.interviewer_name) : '') + '</div></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button type="button" class="fxBtn" data-ics="' + i + '">📅 .ics</button>' +
          '<button type="button" class="fxBtn" data-gcal="' + i + '">🗓 Google</button>' +
          '<button type="button" class="fxBtn" data-mail="' + i + '">✉️ Email invite</button>' +
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
            uid: iv.id, start: iv.scheduled_at,
            title: 'Interview: ' + (c.full_name || 'Candidate') + ' — ' + (r.title || ''),
            desc: 'Round ' + iv.round + ' (' + (iv.round_type || '') + ')\nMode: ' + iv.mode +
              (iv.interviewer_name ? '\nInterviewer: ' + iv.interviewer_name : '') +
              '\nScheduled via HireOS (WorkSource)',
            location: iv.mode === 'In-Person' ? (r.location || '') : (iv.mode || '')
          };
          if (btn.hasAttribute('data-ics')) {
            download('interview-' + (c.full_name || 'candidate').replace(/\s+/g, '-') + '.ics', buildICS(ev), 'text/calendar');
          } else if (btn.hasAttribute('data-gcal')) {
            window.open(gcalLink(ev), '_blank');
          } else {
            var when = new Date(iv.scheduled_at).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' });
            var to = [c.email, cl.contact_email].filter(Boolean).join(',');
            var subject = 'Interview scheduled — ' + (r.title || '') + ' (Round ' + iv.round + ')';
            var text = 'Dear ' + (c.full_name || 'Candidate') + ',%0D%0A%0D%0A' +
              'Your interview has been scheduled:%0D%0A%0D%0A' +
              'Role: ' + (r.title || '') + '%0D%0A' +
              'Date & time: ' + when + '%0D%0A' +
              'Mode: ' + iv.mode + '%0D%0A' +
              (iv.interviewer_name ? 'Interviewer: ' + iv.interviewer_name + '%0D%0A' : '') +
              '%0D%0APlease confirm your availability by replying to this email.%0D%0A%0D%0A' +
              'Best regards,%0D%0AWorkSource Recruitment Team';
            window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + text;
          }
        };
      });
    }).catch(function (e) {
      body().innerHTML = '<div class="fxEmpty">Could not load interviews: ' + esc(String(e.message || e)).slice(0, 200) + '</div>';
    });
  }

  /* ---------- TAB 2: Offers ---------- */
  function offerTemplate(c, r, cl, ctc, joinDate) {
    var today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    return '<h2>Offer Letter</h2><p>Date: ' + today + '</p>' +
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
    body().innerHTML = 'Loading offer-stage candidates…';
    Promise.all([
      api('applications', { query: 'current_stage=in.("Offer Stage","Offer Accepted")&select=id,current_stage,candidates(full_name,email),requisitions(title,location,ctc_min,ctc_max,clients(company_name))' }),
      api('offers', { query: 'select=*' })
    ]).then(function (res) {
      var apps = res[0] || [], offers = {};
      (res[1] || []).forEach(function (o) { offers[o.application_id] = o; });
      if (!apps.length) {
        body().innerHTML = '<div class="fxEmpty">No candidates at Offer Stage.<br/>Move a candidate to “Offer Stage” in the pipeline, then generate their letter here.</div>';
        return;
      }
      body().innerHTML = apps.map(function (a, i) {
        var c = a.candidates || {}, r = a.requisitions || {}, cl = r.clients || {};
        var o = offers[a.id];
        var badge = o
          ? '<span class="badge ' + (o.status === 'accepted' ? 'open' : o.status === 'declined' ? 'closed' : 'on_hold') + '">' + esc(o.status) + '</span>'
          : '<span class="badge draft">no letter</span>';
        return '<div class="fxRow"><div>' +
          '<div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
          '<div style="font-size:12px;color:var(--gray-500,#757575);margin-top:4px;">' + esc(cl.company_name || '') + ' · ' + esc(a.current_stage) + ' · ' + badge + '</div></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button type="button" class="fxBtn" data-gen="' + i + '">' + (o ? '↻ Regenerate' : '✨ Generate letter') + '</button>' +
          (o ? '<button type="button" class="fxBtn" data-dl="' + i + '">⬇ Download</button>' +
               '<button type="button" class="fxBtn" data-st="' + i + '" data-status="sent">Mark sent</button>' +
               '<button type="button" class="fxBtn" data-st="' + i + '" data-status="accepted">✅ Accepted</button>' +
               '<button type="button" class="fxBtn" data-st="' + i + '" data-status="declined">✖ Declined</button>' : '') +
          '</div></div>';
      }).join('');

      body().querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          var i = +(btn.getAttribute('data-gen') || btn.getAttribute('data-dl') || btn.getAttribute('data-st'));
          var a = apps[i], c = a.candidates || {}, r = a.requisitions || {}, cl = r.clients || {};
          var o = offers[a.id];

          if (btn.hasAttribute('data-gen')) {
            var ctc = prompt('Annual CTC for the offer (LPA):', (o && o.ctc_annual) || r.ctc_max || '');
            if (ctc === null) return;
            var jd = prompt('Expected joining date (YYYY-MM-DD), or leave blank:', (o && o.joining_date) || '');
            btn.textContent = 'Generating…'; btn.disabled = true;

            var save = function (html) {
              var row = {
                application_id: a.id, ctc_annual: ctc || null, joining_date: jd || null,
                letter_html: html, status: 'draft',
                generated_by: profile ? profile.id : null, updated_at: new Date().toISOString()
              };
              var p = o
                ? api('offers', { method: 'PATCH', query: 'id=eq.' + o.id, body: row })
                : api('offers', { method: 'POST', body: row });
              p.then(function () { say('Offer letter saved'); renderOffers(); })
               .catch(function (e) { say('Save failed: ' + String(e.message || e).slice(0, 120)); renderOffers(); });
            };

            var fallback = offerTemplate(c, r, cl, ctc, jd);
            if (typeof window.callClaudeSimple === 'function') {
              var p2 = 'Write a warm, professional offer letter (HTML body only, use <p>/<b>, no <html> tag) from "WorkSource Recruitment Team" to candidate ' + (c.full_name || '') +
                ' for the role of ' + (r.title || '') + (cl.company_name ? ' at client company ' + cl.company_name : '') +
                (r.location ? ', location ' + r.location : '') + '. Annual CTC: INR ' + ctc + ' LPA.' +
                (jd ? ' Expected joining date: ' + jd + '.' : '') +
                ' Include congratulations, role summary, CTC, joining date if given, contingency on background verification, and a request to confirm acceptance. Under 250 words. Output HTML only.';
              Promise.resolve(window.callClaudeSimple(p2, 1200)).then(function (res2) {
                var txt = typeof res2 === 'string' ? res2
                  : (res2 && res2.text) || (res2 && res2.content && res2.content[0] && res2.content[0].text) || '';
                save(txt && txt.indexOf('<') >= 0 ? txt : fallback);
              }).catch(function () { save(fallback); });
            } else save(fallback);

          } else if (btn.hasAttribute('data-dl')) {
            var doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offer — ' + esc(c.full_name) + '</title>' +
              '<style>body{font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6;color:#212121;}h2{color:#0B57A4;}</style>' +
              '</head><body>' + o.letter_html + '</body></html>';
            download('offer-' + (c.full_name || 'candidate').replace(/\s+/g, '-') + '.html', doc, 'text/html');

          } else {
            var st = btn.getAttribute('data-status');
            api('offers', { method: 'PATCH', query: 'id=eq.' + o.id, body: { status: st, updated_at: new Date().toISOString() } })
              .then(function () {
                say('Offer marked ' + st);
                if (st === 'accepted') say('Tip: move the candidate to “Offer Accepted” in the pipeline.');
                renderOffers();
              })
              .catch(function (e) { say('Update failed: ' + String(e.message || e).slice(0, 120)); });
          }
        };
      });
    }).catch(function (e) {
      body().innerHTML = '<div class="fxEmpty">Could not load offers: ' + esc(String(e.message || e)).slice(0, 200) + '</div>';
    });
  }

  /* ---------- TAB 3: Onboarding ---------- */
  var CAT_ICON = { document: '📄', verification: '🔍', formality: '✍️', client: '🏢', followup: '📞' };
  var openOnb = {};   // which onboarding cards are expanded

  function renderOnboarding() {
    body().innerHTML = 'Loading onboarding…';
    Promise.all([
      api('onboardings', { query: 'select=*,candidates(full_name,email,phone),requisitions(title),clients(company_name)&order=created_at.desc' }),
      api('onboarding_tasks', { query: 'select=*&order=sort_order.asc' }),
      // Accepted offers with no onboarding yet = candidates ready to start onboarding
      api('offers', { query: 'status=eq.accepted&select=id,application_id,joining_date,applications(id,candidate_id,requisition_id,candidates(full_name),requisitions(title,client_id,clients(company_name)))' })
    ]).then(function (res) {
      var onbs = res[0] || [], tasks = res[1] || [], offers = res[2] || [];
      var byOnb = {};
      tasks.forEach(function (t) { (byOnb[t.onboarding_id] = byOnb[t.onboarding_id] || []).push(t); });
      var started = {};
      onbs.forEach(function (o) { started[o.application_id] = true; });
      var pending = offers.filter(function (o) { return !started[o.application_id]; });

      var html = '';

      // --- candidates ready to onboard ---
      if (pending.length) {
        html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--gray-500,#757575);margin:4px 0 8px;">Offer accepted — start onboarding</div>';
        html += pending.map(function (o, i) {
          var a = o.applications || {}, c = a.candidates || {}, r = a.requisitions || {};
          var cl = r.clients || {};
          return '<div class="fxRow"><div>' +
            '<div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500,#757575);margin-top:3px;">' + esc(cl.company_name || '') +
            (o.joining_date ? ' · joining ' + esc(o.joining_date) : '') + '</div></div>' +
            '<button type="button" class="fxBtn" data-start="' + i + '">🚀 Start onboarding</button></div>';
        }).join('');
      }

      // --- active onboardings ---
      if (onbs.length) {
        html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--gray-500,#757575);margin:16px 0 8px;">In onboarding</div>';
        html += onbs.map(function (o, i) {
          var c = o.candidates || {}, r = o.requisitions || {}, cl = o.clients || {};
          var ts = byOnb[o.id] || [];
          var req = ts.filter(function (t) { return t.required; });
          var done = req.filter(function (t) { return t.status === 'received' || t.status === 'waived'; });
          var pct = req.length ? Math.round(done.length / req.length * 100) : 0;
          var isOpen = !!openOnb[o.id];
          var statusBadge = o.status === 'joined' ? '<span class="badge open">joined</span>'
            : o.status === 'dropped' ? '<span class="badge closed">dropped</span>'
            : o.status === 'ready_to_join' ? '<span class="badge open">ready to join</span>'
            : '<span class="badge on_hold">in progress</span>';

          var s = '<div class="fxRow" style="flex-direction:column;align-items:stretch;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">' +
              '<div><div style="font-weight:700;font-size:14px;">' + esc(c.full_name) + ' — ' + esc(r.title) + '</div>' +
              '<div style="font-size:12px;color:var(--gray-500,#757575);margin-top:3px;">' + esc(cl.company_name || '') +
                (o.joining_date ? ' · joining ' + esc(o.joining_date) : ' · no joining date') +
                ' · BGV: ' + esc(o.bgv_status) + ' · ' + statusBadge + '</div></div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" class="fxBtn" data-toggle="' + i + '">' + (isOpen ? '▲ Hide' : '▼ Checklist (' + done.length + '/' + req.length + ')') + '</button>' +
                (o.status !== 'joined' ? '<button type="button" class="fxBtn" data-joined="' + i + '">✅ Mark joined</button>' : '') +
                '<button type="button" class="fxBtn" data-edit="' + i + '">✏️ Details</button>' +
              '</div>' +
            '</div>' +
            // progress bar
            '<div style="margin-top:9px;height:7px;border-radius:9999px;background:var(--gray-200,#E0E0E0);overflow:hidden;">' +
              '<div style="height:100%;width:' + pct + '%;background:' + (pct === 100 ? 'var(--success,#1E8E5A)' : 'var(--orange-500,#F5A623)') + ';transition:width .3s;"></div>' +
            '</div>' +
            '<div style="font-size:11.5px;color:var(--gray-500,#757575);margin-top:4px;">' + pct + '% of required items complete</div>';

          if (isOpen) {
            s += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;">' +
              ts.map(function (t) {
                var doneT = t.status === 'received' || t.status === 'waived';
                return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;background:var(--white,#fff);border:1px solid var(--gray-200,#E0E0E0);">' +
                  '<div style="display:flex;align-items:center;gap:8px;min-width:0;">' +
                    '<span>' + (CAT_ICON[t.category] || '•') + '</span>' +
                    '<span style="font-size:13px;' + (doneT ? 'text-decoration:line-through;color:var(--gray-500,#757575);' : '') + '">' + esc(t.label) +
                      (t.required ? '' : ' <span style="font-size:10px;color:var(--gray-500,#757575);">(optional)</span>') + '</span>' +
                  '</div>' +
                  '<div style="display:flex;gap:4px;flex-shrink:0;">' +
                    (t.status !== 'received' ? '<button type="button" class="fxBtn" data-task="' + t.id + '" data-st="received">✓ Received</button>' : '<span class="badge open">received</span>') +
                    (!doneT ? '<button type="button" class="fxBtn" data-task="' + t.id + '" data-st="waived">Waive</button>' : '') +
                    (doneT ? '<button type="button" class="fxBtn" data-task="' + t.id + '" data-st="pending">↺</button>' : '') +
                  '</div></div>';
              }).join('') + '</div>';
          }
          return s + '</div>';
        }).join('');
      }

      if (!html) {
        html = '<div class="fxEmpty">Nothing to onboard yet.<br/>When an offer is marked <b>accepted</b> in the Offers tab, the candidate appears here with a full joining checklist.</div>';
      }
      body().innerHTML = html;

      // ---- handlers ----
      body().querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          // start onboarding
          if (btn.hasAttribute('data-start')) {
            var o = pending[+btn.getAttribute('data-start')];
            var a = o.applications || {}, r = a.requisitions || {};
            btn.textContent = 'Starting…'; btn.disabled = true;
            api('onboardings', { method: 'POST', body: {
              application_id: o.application_id,
              candidate_id: a.candidate_id,
              requisition_id: a.requisition_id,
              client_id: r.client_id || null,
              joining_date: o.joining_date || null,
              owner_id: profile ? profile.id : null
            }}).then(function () { say('Onboarding started — 14-item checklist created'); renderOnboarding(); })
              .catch(function (e) { say('Failed: ' + String(e.message || e).slice(0, 120)); renderOnboarding(); });
            return;
          }
          // expand/collapse
          if (btn.hasAttribute('data-toggle')) {
            var ob = onbs[+btn.getAttribute('data-toggle')];
            openOnb[ob.id] = !openOnb[ob.id];
            renderOnboarding();
            return;
          }
          // task status
          if (btn.hasAttribute('data-task')) {
            var id = btn.getAttribute('data-task'), st = btn.getAttribute('data-st');
            btn.disabled = true;
            api('onboarding_tasks', { method: 'PATCH', query: 'id=eq.' + id, body: {
              status: st,
              completed_by: st === 'pending' ? null : (profile ? profile.id : null),
              completed_at: st === 'pending' ? null : new Date().toISOString()
            }}).then(function () { renderOnboarding(); })
              .catch(function (e) { say('Failed: ' + String(e.message || e).slice(0, 120)); renderOnboarding(); });
            return;
          }
          // mark joined
          if (btn.hasAttribute('data-joined')) {
            var ob2 = onbs[+btn.getAttribute('data-joined')];
            var ts2 = byOnb[ob2.id] || [];
            var missing = ts2.filter(function (t) { return t.required && t.status !== 'received' && t.status !== 'waived'; });
            if (missing.length && !confirm(missing.length + ' required item(s) still pending:\n\n' +
                missing.slice(0, 6).map(function (t) { return '• ' + t.label; }).join('\n') +
                '\n\nMark as joined anyway?')) return;
            api('onboardings', { method: 'PATCH', query: 'id=eq.' + ob2.id, body: {
              status: 'joined', updated_at: new Date().toISOString()
            }}).then(function () {
              say('Marked joined — remember to move the candidate to “Joined” in the pipeline to trigger the placement.');
              renderOnboarding();
            }).catch(function (e) { say('Failed: ' + String(e.message || e).slice(0, 120)); });
            return;
          }
          // edit details
          if (btn.hasAttribute('data-edit')) {
            var ob3 = onbs[+btn.getAttribute('data-edit')];
            var jd = prompt('Joining date (YYYY-MM-DD), blank to clear:', ob3.joining_date || '');
            if (jd === null) return;
            var bgv = prompt('BGV status — pending / in_progress / cleared / flagged:', ob3.bgv_status || 'pending');
            if (bgv === null) return;
            bgv = String(bgv).trim().toLowerCase();
            if (['pending','in_progress','cleared','flagged'].indexOf(bgv) < 0) { say('Invalid BGV status'); return; }
            api('onboardings', { method: 'PATCH', query: 'id=eq.' + ob3.id, body: {
              joining_date: jd || null, bgv_status: bgv, updated_at: new Date().toISOString()
            }}).then(function () { say('Updated'); renderOnboarding(); })
              .catch(function (e) { say('Failed: ' + String(e.message || e).slice(0, 120)); });
          }
        };
      });
    }).catch(function (e) {
      body().innerHTML = '<div class="fxEmpty">Could not load onboarding: ' + esc(String(e.message || e)).slice(0, 200) + '</div>';
    });
  }

  /* ---------- TAB 4: Daily digest ---------- */
  function renderDigest() {
    body().innerHTML = 'Loading digests…';
    api('daily_digests', { query: 'order=digest_date.desc&limit=7&select=*' }).then(function (rows) {
      var head = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;">' +
        '<div style="font-size:12.5px;color:var(--gray-500,#757575);">Auto-generated every morning at 8:00 IST.</div>' +
        '<button type="button" class="fxBtn" id="fxGenDigest">⚡ Generate now</button></div>';
      if (!rows || !rows.length) {
        body().innerHTML = head + '<div class="fxEmpty">No digests yet — click “Generate now”.</div>';
      } else {
        body().innerHTML = head + rows.map(function (d) {
          var s = d.stats || {};
          return '<div class="fxRow" style="align-items:flex-start;flex-direction:column;">' +
            '<div style="font-weight:700;color:var(--navy-900,#0B57A4);">' + esc(d.digest_date) + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500,#757575);margin-top:3px;">Open reqs: ' + (s.open_reqs != null ? s.open_reqs : '—') +
            ' · Pipeline: ' + (s.active_apps != null ? s.active_apps : '—') +
            ' · Interviews 48h: ' + (s.interviews_48h != null ? s.interviews_48h : '—') +
            ' · SLA breaches: ' + (s.sla_breaches != null ? s.sla_breaches : '—') +
            ' · New leads: ' + (s.new_leads != null ? s.new_leads : '—') + '</div>' +
            (d.summary ? '<div style="font-size:13px;margin-top:8px;white-space:pre-wrap;line-height:1.55;">' + esc(d.summary) + '</div>' : '') +
            '</div>';
        }).join('');
      }
      document.getElementById('fxGenDigest').onclick = function () {
        var b = this; b.textContent = 'Generating…'; b.disabled = true;
        fetch(FN_BASE + '/daily-digest?force=1', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { say('Digest generated'); renderDigest(); })
          .catch(function (e) { say('Failed: ' + e.message); renderDigest(); });
      };
    }).catch(function (e) {
      body().innerHTML = '<div class="fxEmpty">Could not load digests: ' + esc(String(e.message || e)).slice(0, 200) + '</div>';
    });
  }

  /* ============================================================
     THEME (light / dark / system) — applied before paint on load
     ============================================================ */
  function systemDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function getThemePref() { try { return localStorage.getItem('hireos_theme') || 'light'; } catch (e) { return 'light'; } }
  function applyTheme(pref) {
    var dark = pref === 'dark' || (pref === 'system' && systemDark());
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#060B14' : '#132A54');
  }
  function setTheme(pref) {
    try { localStorage.setItem('hireos_theme', pref); } catch (e) {}
    applyTheme(pref);
    var menu = document.getElementById('userMenu');
    if (menu) menu.querySelectorAll('.theme-seg button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === pref);
    });
  }
  applyTheme(getThemePref());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (getThemePref() === 'system') applyTheme('system');
  });

  /* ============================================================
     USER MENU — replaces the bare "Sign out" button in the topbar
     ============================================================ */
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  function closeUserMenu() { var m = document.getElementById('userMenu'); if (m) m.remove(); }

  function openUserMenu(anchorBtn) {
    if (document.getElementById('userMenu')) { closeUserMenu(); return; }
    var p = profile || {};
    var pref = getThemePref();
    var role = (p.role || '').toLowerCase();
    var m = document.createElement('div');
    m.id = 'userMenu'; m.className = 'user-menu';

    var canTools = ['admin', 'recruiter', 'bd'].indexOf(role) >= 0;
    m.innerHTML =
      '<div class="um-head">' +
        '<div class="um-name">' + esc(p.full_name || 'Signed in') + '</div>' +
        '<div class="um-mail">' + esc(p.email || '') + '</div>' +
        '<div style="margin-top:7px;"><span class="badge open" style="text-transform:uppercase;">' + esc(p.role || '') + '</span></div>' +
      '</div>' +
      '<div class="um-sec">' +
        '<div class="um-label">Appearance</div>' +
        '<div class="theme-seg">' +
          '<button type="button" data-theme="light"' + (pref === 'light' ? ' class="active"' : '') + '>☀️ Light</button>' +
          '<button type="button" data-theme="dark"' + (pref === 'dark' ? ' class="active"' : '') + '>🌙 Dark</button>' +
          '<button type="button" data-theme="system"' + (pref === 'system' ? ' class="active"' : '') + '>💻 Auto</button>' +
        '</div>' +
        '<div class="um-divider"></div>' +
        (canTools ? '<button type="button" class="um-item" id="umTools">⚡ <span>HireOS Tools</span></button>' : '') +
        '<button type="button" class="um-item" id="umCareers">🌐 <span>Public career page</span></button>' +
        '<button type="button" class="um-item" id="umRefresh">🔄 <span>Refresh data</span></button>' +
        '<div class="um-divider"></div>' +
        '<button type="button" class="um-item danger" id="umSignout">↩︎ <span>Sign out</span></button>' +
      '</div>';
    document.body.appendChild(m);

    m.querySelectorAll('.theme-seg button').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); setTheme(b.getAttribute('data-theme')); };
    });
    var t = document.getElementById('umTools');
    if (t) t.onclick = function () { closeUserMenu(); openPanel(); };
    document.getElementById('umCareers').onclick = function () { window.open('careers.html', '_blank'); closeUserMenu(); };
    document.getElementById('umRefresh').onclick = function () { location.reload(); };
    document.getElementById('umSignout').onclick = function () {
      closeUserMenu();
      if (typeof window.logout === 'function') window.logout(); else location.reload();
    };

    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        var menu = document.getElementById('userMenu');
        if (menu && !menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
          closeUserMenu(); document.removeEventListener('click', onDoc);
        }
      });
    }, 0);
  }

  function ensureUserMenu() {
    var bar = document.querySelector('header.topbar');
    if (!bar || document.getElementById('userBtn')) return;
    var appEl = document.getElementById('app');
    if (!appEl || !appEl.classList.contains('active')) return;

    loadProfile().then(function (p) {
      if (!p || document.getElementById('userBtn')) return;
      var right = bar.lastElementChild;               // the div holding whoAmI + Sign out
      var signOut = Array.prototype.slice.call(bar.querySelectorAll('button'))
        .filter(function (b) { return /sign\s*out/i.test(b.textContent); })[0];
      var who = document.getElementById('whoAmI');
      if (signOut) signOut.style.display = 'none';    // replaced by the menu
      if (who) who.style.display = 'none';

      var btn = document.createElement('button');
      btn.id = 'userBtn'; btn.type = 'button'; btn.className = 'user-btn';
      btn.innerHTML = '<span class="user-avatar">' + esc(initials(p.full_name)) + '</span>' +
        '<span>' + esc((p.full_name || '').split(' ')[0]) + '</span><span style="opacity:.7;font-size:10px;">▾</span>';
      btn.onclick = function (e) { e.stopPropagation(); openUserMenu(btn); };
      (right || bar).appendChild(btn);
    }).catch(function () {});
  }

  /* ---------- boot ---------- */
  var appEl = document.getElementById('app');
  function boot() { installGuard(); ensureFab(); ensureUserMenu(); }
  if (appEl) new MutationObserver(boot).observe(appEl, { attributes: true, attributeFilter: ['class'] });
  setInterval(boot, 3000);
  boot();
})();
