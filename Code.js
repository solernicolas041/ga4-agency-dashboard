/**
 * Multi-client GA4 dashboard — web app server (token-based auth)
 * 
 * SECURITY MODEL:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ADMIN: No token needed → getEffectiveUser() = owner = admin    │
 * │  CLIENT: URL has ?t=uuid → token looked up in Access_Control    │
 * │  UNKNOWN: No token, not owner → Access Denied                   │
 * │                                                                  │
 * │  Why: "Execute as Me" makes getActiveUser() unreliable.          │
 * │  URL tokens bypass this entirely.                                │
 * │                                                                  │
 * │  SESSION: doGet() creates a CacheService session token.          │
 * │  All google.script.run calls pass this session token.            │
 * │  No reliance on getActiveUser() anywhere.                        │
 * └──────────────────────────────────────────────────────────────────┘
 * 
 * Access_Control columns:
 * email | name | role | accounts | pages | status | expires | created_at | last_login | notes | token
 */


// ════════════════════════════════════════
//  SESSION (CacheService — for google.script.run calls)
// ════════════════════════════════════════
function createSession_(auth, identifier) {
  var token = Utilities.getUuid();
  var session = {
    identifier: identifier,
    email: auth.email || identifier,
    level: auth.level,
    role: auth.role || 'admin',
    name: auth.name || '',
    accounts: auth.accounts || [],
    pages: auth.pages || []
  };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), 21600);
  return token;
}

function getSession_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

function isAdmin_(token) {
  var s = getSession_(token);
  return s && s.level === 'admin';
}

function isStaff_(token) {
  var s = getSession_(token);
  return s && (s.level === 'admin' || s.level === 'manager');
}

// ════════════════════════════════════════
//  ROUTING — doGet
// ════════════════════════════════════════
// ═══ BRANDING — one source of truth, from AGENCY in config.js ═══
function agencyName_()    { return (typeof AGENCY !== 'undefined' && AGENCY.name) || 'Analytics Dashboard'; }
function agencyProduct_() { return (typeof AGENCY !== 'undefined' && AGENCY.productName) || 'Analytics Dashboard'; }
function agencyTitle_()   { return agencyName_() + ' — ' + agencyProduct_(); }

/** Signature block for report emails. Empty AGENCY fields are left out entirely. */
function emailSignature_() {
  var left = '<div style="font-size:20px;font-weight:800;color:#1a3a5c;letter-spacing:0.5px">' + agencyName_() + '</div>';
  if (AGENCY.tagline) {
    left += '<div style="font-size:9px;color:#5b9bd5;letter-spacing:1px;margin-top:2px">' + AGENCY.tagline + '</div>';
  }
  var right = '';
  if (AGENCY.contactName) {
    right += '<div style="font-size:18px;font-weight:700;color:#1a2a3a;margin-bottom:4px">' + AGENCY.contactName + '</div>';
  }
  if (AGENCY.contactTitle) {
    right += '<div style="font-size:14px;font-weight:600;color:#5b9bd5;margin-bottom:8px">' + AGENCY.contactTitle + '</div>';
  }
  if (AGENCY.website) {
    var href = AGENCY.website.indexOf('http') === 0 ? AGENCY.website : 'https://' + AGENCY.website;
    right += '<div style="font-size:13px;color:#5b9bd5">🌐 <a href="' + href + '" style="color:#5b9bd5;text-decoration:none">' + AGENCY.website + '</a></div>';
  }
  var h = '<div style="padding:24px 32px;border-top:1px solid #e2e8f0">';
  h += '<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif"><tr>';
  h += '<td style="' + (right ? 'padding-right:20px;border-right:2px solid #5b9bd5;' : '') + 'vertical-align:middle">' + left + '</td>';
  if (right) h += '<td style="padding-left:20px;vertical-align:middle">' + right + '</td>';
  h += '</tr></table></div>';
  return h;
}

function doGet(e) {
  var urlToken = (e && e.parameter && e.parameter.t) ? String(e.parameter.t).trim() : '';
  
  // ── PATH 1: Client with URL token ──
  if (urlToken) {
    var clientAuth = getAuthByToken_(urlToken);
    if (clientAuth && (clientAuth.level === 'client' || clientAuth.level === 'manager')) {
      logSession_(clientAuth.email, clientAuth.level, 'page_load');
      updateLastLogin_(clientAuth.email);
      var sessToken = createSession_(clientAuth, clientAuth.email);
      return serveDashboard_(clientAuth, sessToken);
    }
    // Invalid/expired/revoked token
    return accessDeniedPage_('Invalid or expired access link.', urlToken);
  }
  
  // ── PATH 2: Admin (script owner, no token needed) ──
  var ownerEmail = '';
  try { ownerEmail = Session.getEffectiveUser().getEmail().toLowerCase(); } catch(e) {}
  
  if (ownerEmail === ADMIN_EMAIL) {
    var adminAuth = { level: 'admin', email: ADMIN_EMAIL, name: 'Admin', role: 'admin', accounts: [], pages: [] };
    logSession_(ADMIN_EMAIL, 'admin', 'page_load');
    var sessToken = createSession_(adminAuth, ADMIN_EMAIL);
    return serveDashboard_(adminAuth, sessToken);
  }
  
  // ── PATH 3: Unknown visitor ──
  return accessDeniedPage_('No access token provided and you are not the admin.', ownerEmail);
}

function serveDashboard_(auth, sessionToken) {
  var template = HtmlService.createTemplateFromFile('index');
  template.authLevel = auth.level;
  template.authName = auth.name || '';
  template.authRole = auth.role || 'admin';
  template.authAccounts = JSON.stringify(auth.accounts || []);
  template.authPages = JSON.stringify(auth.pages || []);
  template.userEmail = auth.email || '';
  template.sessionToken = sessionToken;
  template.agencyJson = JSON.stringify(typeof AGENCY !== 'undefined' ? AGENCY : {});
  return template.evaluate()
    .setTitle(agencyTitle_())
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function accessDeniedPage_(reason, debug) {
  return HtmlService.createHtmlOutput(
    '<html><head><style>' +
    'body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#fff}' +
    '.box{text-align:center;padding:40px;border-radius:16px;background:#1e293b;max-width:500px}' +
    'h1{font-size:48px;margin:0}h2{margin:8px 0 16px;color:#f87171}' +
    'p{color:#94a3b8;font-size:14px;line-height:1.6}' +
    '.debug{margin-top:20px;padding:12px;background:#0f172a;border-radius:8px;font-size:11px;color:#475569;text-align:left}' +
    '</style></head><body><div class="box">' +
    '<h1>🔒</h1><h2>Access Denied</h2>' +
    '<p>' + reason + '</p><p>Contact ' + agencyName_() + ' to request access.</p>' +
    '<div class="debug">' + (debug || '') + '</div>' +
    '</div></body></html>'
  ).setTitle('Access Denied — ' + agencyName_());
}

// ════════════════════════════════════════
//  TOKEN-BASED AUTH (for clients)
// ════════════════════════════════════════
function getAuthByToken_(urlToken) {
  var clients = getAccessControlSheet_();
  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    if (String(c.token || '').trim() === urlToken) {
      // Check status
      if (String(c.status).toLowerCase() !== 'active') return null;
      // Check expiration
      var exp = String(c.expires || '').trim();
      if (exp) {
        var expDate = new Date(exp);
        if (!isNaN(expDate.getTime()) && new Date() > expDate) {
          autoExpire_(c.email);
          return null;
        }
      }
      var accounts = String(c.accounts || '').split(',').map(function(a) { return a.trim(); }).filter(Boolean);
      var role = String(c.role || 'viewer').toLowerCase().trim();
      var level, pages;

      if (role === 'manager') {
        level = 'manager';
        pages = ['overview','budget','performance','keywords','search','quality','bidchanges','autoneg','dsa',
                 'pmax','clientpmax','health','signals','tracking','anomalies','learning',
                 'decisions','analytics','ga4channels','ga4pages','reports'];
      } else {
        level = 'client';
        pages = ['overview', 'clientpmax', 'pmax', 'tracking', 'health', 'performance', 'keywords', 'search', 'quality', 'analytics', 'ga4channels', 'ga4pages'];
      }

      return {
        level: level,
        email: String(c.email).toLowerCase().trim(),
        name: c.name || '',
        role: role === 'manager' ? 'manager' : 'viewer',
        accounts: accounts,
        pages: pages
      };
    }
  }
  return null;
}

function autoExpire_(email) {
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName('Access_Control');
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().trim() === String(email).toLowerCase().trim()) {
        sheet.getRange(i + 1, 6).setValue('expired');
        break;
      }
    }
  } catch(e) {}
}

function updateLastLogin_(email) {
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName('Access_Control');
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().trim() === String(email).toLowerCase().trim()) {
        sheet.getRange(i + 1, 9).setValue(now);
        break;
      }
    }
  } catch(e) {}
}

// ════════════════════════════════════════
//  ACCESS CONTROL SHEET
// ════════════════════════════════════════
function getAccessControlSheet_() {
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName('Access_Control');
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      if (!String(data[i][0]).trim()) continue; // skip empty rows
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        var val = data[i][j];
        // Convert Date objects to strings (google.script.run can't serialize Date)
        if (val instanceof Date) val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
        row[headers[j]] = val;
      }
      rows.push(row);
    }
    return rows;
  } catch(e) { Logger.log('Error: ' + e.message); return []; }
}

function initAccessControlSheet() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Access_Control');
  
  if (sheet) {
    // Sheet exists — just add token column if missing
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var hasToken = headers.some(function(h) { return String(h).trim().toLowerCase() === 'token'; });
    if (!hasToken) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue('token').setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
      sheet.setColumnWidth(col, 320);
      // Generate tokens for existing rows
      var lastRow = sheet.getLastRow();
      for (var i = 2; i <= lastRow; i++) {
        sheet.getRange(i, col).setValue(Utilities.getUuid());
      }
      Logger.log('Token column added to existing Access_Control ✅');
      // Log all client URLs
      var data = sheet.getDataRange().getValues();
      var baseUrl = ScriptApp.getService().getUrl();
      for (var i = 1; i < data.length; i++) {
        Logger.log(data[i][0] + ' → ' + baseUrl + '?t=' + data[i][col - 1]);
      }
    } else {
      Logger.log('Access_Control already has token column ✅');
    }
  } else {
    // Create from scratch
    sheet = ss.insertSheet('Access_Control');
    var headers = ['email', 'name', 'role', 'accounts', 'pages', 'status', 'expires', 'created_at', 'last_login', 'notes', 'token'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    Logger.log('Access_Control created ✅');
  }
}

// ════════════════════════════════════════
//  ADMIN FUNCTIONS (all require session token)
// ════════════════════════════════════════
function getClientList(token) {
  if (!isAdmin_(token)) return { error: 'Admin only (token: ' + (token ? token.substring(0,8) + '...' : 'null') + ')' };
  var clients = getAccessControlSheet_();
  Logger.log('getClientList returning ' + clients.length + ' clients');
  return clients;
}

function saveClient(token, clientData) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName('Access_Control');
    if (!sheet) { initAccessControlSheet(); sheet = ss.getSheetByName('Access_Control'); }
    var data = sheet.getDataRange().getValues();
    var email = String(clientData.email).toLowerCase().trim();
    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    
    // Ensure token column header exists (column 11)
    var headers = data[0] || [];
    if (headers.length < 11 || String(headers[10]).trim().toLowerCase() !== 'token') {
      sheet.getRange(1, 11).setValue('token').setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
    }
    
    var existingRow = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().trim() === email) { existingRow = i + 1; break; }
    }
    
    var clientToken = existingRow > 0 ? (String(data[existingRow - 1][10] || '').trim() || Utilities.getUuid()) : Utilities.getUuid();
    
    // Role: 'viewer' (client) or 'manager' (staff with restricted admin access)
    var role = String(clientData.role || 'viewer').toLowerCase().trim();
    if (['viewer', 'manager'].indexOf(role) === -1) role = 'viewer';

    var fixedPages;
    if (role === 'manager') {
      fixedPages = 'overview, budget, performance, keywords, search, quality, bidchanges, autoneg, dsa, pmax, clientpmax, health, signals, tracking, anomalies, learning, decisions, analytics, ga4channels, ga4pages, reports';
    } else {
      fixedPages = 'overview, decisions, clientpmax, pmax, tracking, health, performance, keywords, search, analytics, ga4channels, ga4pages';
    }

    var rowData = [email, clientData.name || '', role, clientData.accounts || '', fixedPages, clientData.status || 'active', clientData.expires || '', existingRow > 0 ? data[existingRow - 1][7] : now, existingRow > 0 ? data[existingRow - 1][8] : '', clientData.notes || '', clientToken];
    
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
      logSession_(ADMIN_EMAIL, 'admin', 'client_updated: ' + email);
      return { success: true, action: 'updated', token: clientToken };
    } else {
      sheet.appendRow(rowData);
      logSession_(ADMIN_EMAIL, 'admin', 'client_added: ' + email);
      return { success: true, action: 'added', token: clientToken };
    }
  } catch(e) {
    Logger.log('saveClient error: ' + e.message);
    return { error: 'Save failed: ' + e.message };
  }
}

function revokeClient(token, email) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Access_Control');
  if (!sheet) return { error: 'No sheet' };
  var data = sheet.getDataRange().getValues();
  email = String(email).toLowerCase().trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === email) {
      sheet.getRange(i + 1, 6).setValue('revoked');
      logSession_(ADMIN_EMAIL, 'admin', 'client_revoked: ' + email);
      return { success: true };
    }
  }
  return { error: 'Not found' };
}

function reactivateClient(token, email) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Access_Control');
  if (!sheet) return { error: 'No sheet' };
  var data = sheet.getDataRange().getValues();
  email = String(email).toLowerCase().trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === email) {
      sheet.getRange(i + 1, 6).setValue('active');
      logSession_(ADMIN_EMAIL, 'admin', 'client_reactivated: ' + email);
      return { success: true };
    }
  }
  return { error: 'Not found' };
}

function sendInviteEmail(token, email, name) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  
  // Get client's URL token
  var clients = getAccessControlSheet_();
  var client = clients.find(function(c) { return String(c.email).toLowerCase().trim() === String(email).toLowerCase().trim(); });
  if (!client || !client.token) return { error: 'Client not found or no token' };
  
  var baseUrl = ScriptApp.getService().getUrl();
  var clientUrl = baseUrl + '?t=' + client.token;
  
  var htmlBody = '<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:30px">' +
    '<div style="background:#16213E;padding:20px;border-radius:12px 12px 0 0;text-align:center">' +
    '<h1 style="color:#fff;margin:0;font-size:22px">📊 ' + agencyName_() + '</h1></div>' +
    '<div style="background:#f8fafc;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 12px 12px">' +
    '<p>Hi ' + (name || 'there') + ',</p>' +
    '<p>Your performance dashboard is ready! Click the button below to access it.</p>' +
    '<div style="text-align:center;margin:24px 0">' +
    '<a href="' + clientUrl + '" style="background:#E94560;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">📊 Open My Dashboard</a></div>' +
    '<p style="font-size:13px;color:#94a3b8">This is your personal access link — do not share it with others.</p>' +
    '<p style="font-size:12px;color:#cbd5e1">Google may show a security warning on first visit. Click "Advanced" then "Go to MCC_DASHBOARD..." to continue.</p>' +
    '</div></div>';
  
  try {
    MailApp.sendEmail({
      to: email,
      subject: '📊 Your Dashboard Access — ' + agencyName_(),
      htmlBody: htmlBody,
      name: agencyTitle_()
    });
    logSession_(ADMIN_EMAIL, 'admin', 'invite_sent: ' + email);
    return { success: true };
  } catch(e) { return { error: e.message }; }
}

function getAvailableAccounts(token) {
  if (!isAdmin_(token)) return [];
  var config = getSheetData('Config');
  var accounts = config.map(function(r) { return r.client_name; }).filter(Boolean);
  var kpis = getSheetData('Daily_KPIs');
  kpis.forEach(function(r) {
    if (r.client_name && accounts.indexOf(r.client_name) === -1) accounts.push(r.client_name);
  });
  return accounts.sort();
}

function getSessionLogs(token) {
  if (!isAdmin_(token)) return [];
  return getSheetData('Session_Log');
}

// ════════════════════════════════════════
//  DATA
// ════════════════════════════════════════
// ═══ TIER 1: Critical data — loads fast for Overview + Decisions ═══
function getAllDashboardData(token) {
  var session = getSession_(token);
  if (!session) return { error: 'Session expired — please refresh the page' };
  
  var t0 = Date.now();
  
  // TIER 1: Minimal — only what Overview needs (3 sheets instead of 8)
  var data = {
    dailyKpis: getSheetDataTrimmed('Daily_KPIs', 90),
    budgetPacing: getSheetData('Budget_Pacing'),
    config: getSheetData('Config'),
    lastUpdated: new Date().toISOString(),
    _loadTime: 0
  };

  // SLIM DOWN Daily_KPIs — keep only raw data, frontend recalculates derived KPIs
  var keepCols = ['date','account_id','client_name','campaign_name','campaign_type',
    'impressions','clicks','cost','conversions','conv_value','all_conversions',
    'all_conv_value','currency'];
  if (data.dailyKpis && data.dailyKpis.length > 0) {
    data.dailyKpis = data.dailyKpis.map(function(r) {
      var slim = {};
      keepCols.forEach(function(k) { if (r[k] !== undefined) slim[k] = r[k]; });
      return slim;
    });
  }

  // NORMALIZE client_name
  var nameMap = {};
  (data.dailyKpis || []).forEach(function(r) {
    if (r.client_name) {
      var key = String(r.client_name).toLowerCase().replace(/[\s_-]+/g, '');
      nameMap[key] = r.client_name;
    }
  });
  Object.keys(data).forEach(function(key) {
    if (key === 'lastUpdated' || key === '_loadTime' || !Array.isArray(data[key])) return;
    data[key].forEach(function(row) {
      if (row.client_name) {
        var key2 = String(row.client_name).toLowerCase().replace(/[\s_-]+/g, '');
        if (nameMap[key2] && nameMap[key2] !== row.client_name) row.client_name = nameMap[key2];
      }
    });
  });
  
  // NON-ADMIN: filter to allowed accounts only (clients + managers)
  if (session.level !== 'admin' && session.accounts.length > 0) {
    var allowed = session.accounts;
    var allowedLower = allowed.map(function(a) { return String(a).toLowerCase().trim(); });
    Object.keys(data).forEach(function(key) {
      if (key === 'lastUpdated' || key === 'config' || key === '_loadTime') return;
      if (Array.isArray(data[key])) {
        data[key] = data[key].filter(function(row) {
          var name = String(row.client_name || row.account_name || row.client || '').toLowerCase().trim();
          return allowedLower.indexOf(name) !== -1;
        });
      }
    });
    data.config = data.config.filter(function(r) {
      return allowedLower.indexOf(String(r.client_name || '').toLowerCase().trim()) !== -1;
    });
  }
  
  data._loadTime = Date.now() - t0;
  return data;
}

// ════════════════════════════════════════════════════════════════════
//  GA4-ONLY DATA (2026-08-09 — dashboard refocused on Analytics)
//  Single call feeding the whole UI. No Google Ads sheets are read.
// ════════════════════════════════════════════════════════════════════
function getGA4Data(token, force) {
  var session = getSession_(token);
  if (!session) return { error: 'Session expirée — rafraîchis la page' };

  if (force) invalidateAllCaches();

  var t0 = Date.now();
  var data = {
    ga4Daily:        getSheetDataTrimmed('GA4_Daily', 90),
    ga4Channels:     getSheetDataTrimmed('GA4_Channels', 90),
    ga4LandingPages: getSheetData('GA4_LandingPages'),
    ga4KeyEvents:    getSheetDataTrimmed('GA4_KeyEvents', 90),
    ga4FetchStatus:  getSheetData('GA4_Fetch_Status'),
    config:          getSheetData('Config'),   // client filter + currency + report language
    lastUpdated:     new Date().toISOString(),
    _loadTime:       0
  };

  // Drop ghost clients. The sheets keep rows written under names a client used to
  // have, which would show up as duplicate entries in the selector. GA4_PROPERTIES
  // is the single source of truth for which properties are actually being collected.
  var live = {};
  GA4_PROPERTIES.forEach(function(p) { live[p.client_name] = true; });
  Object.keys(data).forEach(function(key) {
    if (!Array.isArray(data[key])) return;
    data[key] = data[key].filter(function(row) { return live[row.client_name] === true; });
  });

  // Non-admin sees only the accounts granted in Access_Control
  if (session.level !== 'admin' && session.accounts.length > 0) {
    var allowed = session.accounts.map(function(a) { return String(a).toLowerCase().trim(); });
    Object.keys(data).forEach(function(key) {
      if (!Array.isArray(data[key])) return;
      data[key] = data[key].filter(function(row) {
        return allowed.indexOf(String(row.client_name || '').toLowerCase().trim()) !== -1;
      });
    });
  }

  data._loadTime = Date.now() - t0;
  Logger.log('getGA4Data: ' + data.ga4Daily.length + ' daily / ' + data.ga4Channels.length +
             ' channels / ' + data.ga4LandingPages.length + ' pages / ' +
             data.ga4KeyEvents.length + ' events in ' + data._loadTime + 'ms');
  return data;
}

// ═══ TIER 2: Page-specific data — lazy loaded on navigation ═══
// Only fetches sheets NOT already in Tier 1
function getPageData(token, page) {
  var session = getSession_(token);
  if (!session) return { error: 'Session expired' };
  
  var data = {};
  
  switch(page) {
    case 'signals':
    case 'health':
    case 'quality':
    case 'anomalies':
    case 'keywords':
      data.accountHealth = getSheetDataTrimmed('Account_Health', 90);
      data.qualityScores = getSheetDataTrimmed('Quality_Scores', 90);
      data.convActions = getSheetDataTrimmed('Conv_Actions', 90);
      data.convAlerts = getSheetDataTrimmed('Conv_Alerts', 90);
      data.anomalies = getSheetDataTrimmed('Anomalies_Log', 90);
      break;
    case 'decisions':
      data.accountHealth = getSheetDataTrimmed('Account_Health', 90);
      data.qualityScores = getSheetDataTrimmed('Quality_Scores', 90);
      data.convActions = getSheetDataTrimmed('Conv_Actions', 90);
      data.convAlerts = getSheetDataTrimmed('Conv_Alerts', 90);
      data.anomalies = getSheetDataTrimmed('Anomalies_Log', 90);
      data.searchTerms = getSheetDataTrimmed('Search_Terms', 60);
      data.pmaxInsights = getSheetDataTrimmed('PMax_Insights', 90);
      data.pmaxChannels = getSheetDataTrimmed('PMax_Channels', 90);
      data.pmaxProducts = getSheetDataTrimmed('PMax_Products', 90);
      break;
    case 'performance':
      data.monthlySummary = getSheetData('Monthly_Summary');
      data.weeklySummary = getSheetData('Weekly_Summary');
      data.searchTerms = getSheetDataTrimmed('Search_Terms', 60);
      break;
    case 'search':
      data.searchTerms = getSheetDataTrimmed('Search_Terms', 60);
      // Fallback: if trimming removed all rows, return unfiltered
      if ((!data.searchTerms || data.searchTerms.length === 0)) {
        var rawCheck = _readSheetRaw('Search_Terms');
        if (rawCheck.length > 0) {
          Logger.log('⚠️ Search_Terms: date filter removed all ' + rawCheck.length + ' rows — returning unfiltered');
          data.searchTerms = rawCheck;
        }
      }
      // Extract available snapshot dates for the dropdown (newest first)
      var snapDates = {};
      (data.searchTerms || []).forEach(function(r) {
        if (r.date_analyzed) {
          var d = String(r.date_analyzed).substring(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) snapDates[d] = true;
        }
      });
      data.searchSnapshots = Object.keys(snapDates).sort().reverse();
      Logger.log('Search_Terms final: ' + (data.searchTerms ? data.searchTerms.length : 0) + ' rows, ' + data.searchSnapshots.length + ' snapshots');
      break;
    case 'pmax':
      data.pmaxInsights = getSheetDataTrimmed('PMax_Insights', 90);
      data.pmaxChannels = getSheetDataTrimmed('PMax_Channels', 90);
      data.pmaxProducts = getSheetDataTrimmed('PMax_Products', 90);
      break;
    case 'bidchanges':
      data.bidChanges = getSheetData('Bid_Changes_Log');
      break;
    case 'autoneg':
      data.autoActions = getSheetData('Auto_Actions_Log');
      break;
    case 'learning':
      data.learningTracker = getSheetData('Learning_Tracker');
      break;
    case 'tracking':
      data.convDaily = getSheetDataTrimmed('Conv_Daily', 60);
      break;
    case 'clientpmax':
      data.pmaxInsights = getSheetDataTrimmed('PMax_Insights', 90);
      data.pmaxChannels = getSheetDataTrimmed('PMax_Channels', 90);
      data.pmaxProducts = getSheetDataTrimmed('PMax_Products', 90);
      break;
    case 'auction':
    case 'competition':
      data.auctionInsights = getSheetDataTrimmed('Auction_Insights', 30);
      break;
    case 'dsa':
      data.dsaPerformance = getSheetData('DSA_Performance');
      data.dsaTargets = getSheetData('DSA_Targets');
      break;
    case 'analytics':
    case 'ga4channels':
    case 'ga4pages':
      data.ga4Daily = getSheetDataTrimmed('GA4_Daily', 60);
      data.ga4Channels = getSheetDataTrimmed('GA4_Channels', 60);
      data.ga4LandingPages = getSheetData('GA4_LandingPages');
      data.ga4KeyEvents = getSheetDataTrimmed('GA4_KeyEvents', 60);
      data.ga4FetchStatus = getSheetData('GA4_Fetch_Status');
      break;
    case 'reports':
      data.monthlySummary = getSheetData('Monthly_Summary');
      data.pmaxInsights = getSheetData('PMax_Insights');
      data.pmaxChannels = getSheetData('PMax_Channels');
      data.searchTerms = getSheetDataTrimmed('Search_Terms', 60);
      break;
    default:
      return data;
  }
  
  // NORMALIZE client names
  var nameMap = {};
  var configData = getSheetData('Config');
  (configData || []).forEach(function(r) {
    if (r.client_name) {
      var key = String(r.client_name).toLowerCase().replace(/[\s_-]+/g, '');
      nameMap[key] = r.client_name;
    }
  });
  Object.keys(data).forEach(function(key) {
    if (!Array.isArray(data[key])) return;
    data[key].forEach(function(row) {
      if (row.client_name) {
        var k = String(row.client_name).toLowerCase().replace(/[\s_-]+/g, '');
        if (nameMap[k] && nameMap[k] !== row.client_name) row.client_name = nameMap[k];
      }
    });
  });
  
  // NON-ADMIN filter (clients + managers)
  if (session.level !== 'admin' && session.accounts.length > 0) {
    var allowed = session.accounts;
    var allowedLower = allowed.map(function(a) { return String(a).toLowerCase().trim(); });
    Object.keys(data).forEach(function(key) {
      if (Array.isArray(data[key])) {
        data[key] = data[key].filter(function(row) {
          var name = String(row.client_name || row.account_name || row.client || '').toLowerCase().trim();
          return allowedLower.indexOf(name) !== -1;
        });
      }
    });
  }
  
  return data;
}

// ════════════════════════════════════════
//  CLIENT INSTRUCTIONS
// ════════════════════════════════════════

/** Save client instructions (from pasted text/email) */
function saveClientInstructions(token, instructions) {
  if (!isStaff_(token)) return { error: 'Staff only' };
  if (!instructions || instructions.length === 0) return { error: 'No instructions' };
  
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Client_Instructions');
  if (!sheet) {
    sheet = ss.insertSheet('Client_Instructions');
    sheet.getRange(1, 1, 1, 7).setValues([['id', 'timestamp', 'client_name', 'instruction', 'source', 'status', 'added_by']]);
    sheet.setFrozenRows(1);
  }
  
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var added = 0;
  
  for (var i = 0; i < instructions.length; i++) {
    var inst = instructions[i];
    if (!inst.text || !inst.client_name) continue;
    var id = 'instr-' + inst.client_name.replace(/\s+/g, '-').substring(0, 20) + '-' + Date.now() + '-' + i;
    sheet.appendRow([id, now, inst.client_name, inst.text, inst.source || 'manual', 'active', ADMIN_EMAIL]);
    added++;
  }
  
  // Invalidate cache
  invalidateCache(['Client_Instructions']);
  
  return { success: true, count: added };
}

/** Get client instructions */
function getClientInstructions(token) {
  var session = getSession_(token);
  if (!session) return [];
  var rows = getSheetData('Client_Instructions');
  // Non-admin: filter
  if (session.level !== 'admin' && session.accounts.length > 0) {
    var allowedLower = session.accounts.map(function(a) { return String(a).toLowerCase().trim(); });
    rows = rows.filter(function(r) { return allowedLower.indexOf(String(r.client_name || '').toLowerCase().trim()) !== -1; });
  }
  return rows;
}

/** Archive a client instruction */
function archiveClientInstruction(token, instructionId) {
  if (!isStaff_(token)) return { error: 'Staff only' };
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Client_Instructions');
  if (!sheet) return { error: 'No instructions sheet' };
  
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === instructionId) {
      sheet.getRange(i + 1, 6).setValue('archived'); // status column
      invalidateCache(['Client_Instructions']);
      return { success: true };
    }
  }
  return { error: 'Instruction not found' };
}

// ════════════════════════════════════════
//  TODO ACTIONS
// ════════════════════════════════════════
function saveTodoAction(token, actionId, status, title, priority, clientName) {
  // Allow staff via session OR via owner email fallback
  var isStf = isStaff_(token);
  if (!isStf) {
    // Fallback: check if script owner is admin (session may have expired)
    try {
      var ownerEmail = Session.getEffectiveUser().getEmail();
      if (ownerEmail === ADMIN_EMAIL) isStf = true;
    } catch(e) {}
  }
  if (!isStf) return { error: 'Staff only' };
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Actions_Log');
  if (!sheet) {
    sheet = ss.insertSheet('Actions_Log');
    sheet.getRange(1, 1, 1, 7).setValues([['timestamp', 'action_id', 'title', 'priority', 'status', 'completed_by', 'client_name']]);
    sheet.setFrozenRows(1);
  }
  // Add client_name column if missing (migration for existing sheets)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('client_name') === -1) {
    var nextCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextCol).setValue('client_name');
  }
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([ts, actionId, title, priority, status, ADMIN_EMAIL, clientName || '']);
  return { success: true, saved: actionId + ' → ' + status };
}

function getActionHistory(token) {
  var session = getSession_(token);
  // Fallback: if session expired but owner is admin
  if (!session) {
    try {
      var ownerEmail = Session.getEffectiveUser().getEmail();
      if (ownerEmail === ADMIN_EMAIL) session = { level: 'admin', email: ADMIN_EMAIL };
    } catch(e) {}
  }
  if (!session) return [];
  
  // Manual actions from Actions_Log
  var manual = getSheetData('Actions_Log');
  manual.forEach(function(r) { r._source = 'manual'; });
  
  // Auto actions from Auto_Actions_Log (if exists)
  var auto = [];
  try {
    auto = getSheetData('Auto_Actions_Log');
    auto.forEach(function(r) { r._source = 'auto'; });
  } catch(e) { /* sheet doesn't exist yet */ }
  
  var all = manual.concat(auto);
  
  if (session.level === 'admin') return all;
  // Client: filter to only their accounts
  var clientAccountsLower = (Array.isArray(session.accounts) ? session.accounts : String(session.accounts || '').split(',')).map(function(a) { return String(a).toLowerCase().trim(); });
  return all.filter(function(row) {
    return clientAccountsLower.indexOf(String(row.client_name || '').toLowerCase().trim()) !== -1;
  });
}

// ════════════════════════════════════════
//  SESSION LOGGING
// ════════════════════════════════════════
function logSession_(email, level, action) {
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName('Session_Log');
    if (!sheet) {
      sheet = ss.insertSheet('Session_Log');
      sheet.getRange(1, 1, 1, 4).setValues([['timestamp', 'email', 'level', 'action']]);
      sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
    var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([ts, email, level, action]);
    if (sheet.getLastRow() > 520) sheet.deleteRows(2, sheet.getLastRow() - 500);
  } catch(e) { Logger.log('Log error: ' + e.message); }
}

function logPageNavigation(token, page) {
  var s = getSession_(token);
  if (s) logSession_(s.email, s.level, 'navigate: ' + page);
}

// ════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════
function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheetData(sheetName) {
  // ═══ CHUNKED CACHE: handles datasets >100KB ═══
  var cache = CacheService.getScriptCache();
  var metaKey = 'v3_smeta_' + sheetName;
  var meta = cache.get(metaKey);
  
  if (meta) {
    try {
      var m = JSON.parse(meta);
      if (m.chunks === 1) {
        // Single chunk — read directly
        var single = cache.get('v3_schunk_' + sheetName + '_0');
        if (single) return JSON.parse(single);
      } else if (m.chunks > 1) {
        // Multi-chunk — read all chunks with batch getAll
        var keys = [];
        for (var c = 0; c < m.chunks; c++) keys.push('v3_schunk_' + sheetName + '_' + c);
        var chunks = cache.getAll(keys);
        // Verify all chunks present
        var allPresent = true;
        var assembled = '';
        for (var c2 = 0; c2 < m.chunks; c2++) {
          var part = chunks['v3_schunk_' + sheetName + '_' + c2];
          if (!part) { allPresent = false; break; }
          assembled += part;
        }
        if (allPresent) {
          try { return JSON.parse(assembled); } catch(e2) { /* corrupted, fall through */ }
        }
      }
    } catch(e) { /* meta corrupted, fall through */ }
  }
  
  // Cache miss — read from sheet
  var rows = _readSheetRaw(sheetName);
  
  // Write to chunked cache (90KB per chunk, ~92160 bytes safe limit)
  try {
    var json = JSON.stringify(rows);
    var CHUNK_SIZE = 90000; // 90KB per chunk
    var numChunks = Math.ceil(json.length / CHUNK_SIZE) || 1;
    
    if (numChunks === 1 && json.length < CHUNK_SIZE) {
      cache.put('v3_schunk_' + sheetName + '_0', json, 21600);
    } else {
      // Write chunks with putAll for speed
      var batch = {};
      for (var i = 0; i < numChunks; i++) {
        batch['v3_schunk_' + sheetName + '_' + i] = json.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      }
      cache.putAll(batch, 21600);
    }
    cache.put(metaKey, JSON.stringify({ chunks: numChunks, size: json.length, ts: Date.now() }), 21600);
  } catch(e) {
    Logger.log('Cache write failed for ' + sheetName + ': ' + e.message);
  }
  return rows;
}

/** Read sheet but trim to last N days for large time-series sheets */
function getSheetDataTrimmed(sheetName, maxDays) {
  var cache = CacheService.getScriptCache();
  var trimKey = 'v3_smeta_' + sheetName + '_d' + maxDays;
  var meta = cache.get(trimKey);
  
  if (meta) {
    try {
      var m = JSON.parse(meta);
      var keys = [];
      for (var c = 0; c < m.chunks; c++) keys.push('v3_strim_' + sheetName + '_' + c);
      var chunks = cache.getAll(keys);
      var assembled = '';
      var allPresent = true;
      for (var c2 = 0; c2 < m.chunks; c2++) {
        var part = chunks['v3_strim_' + sheetName + '_' + c2];
        if (!part) { allPresent = false; break; }
        assembled += part;
      }
      if (allPresent) {
        try { return JSON.parse(assembled); } catch(e) { /* fall through */ }
      }
    } catch(e) { /* fall through */ }
  }
  
  // Read (tail-capped for huge append-ordered sheets), then trim by date.
  // Search_Terms holds 100k+ rows but the UI only renders the latest snapshot,
  // so reading the last few thousand rows is enough and avoids a 100k-row read.
  var TAIL_CAP = { 'Search_Terms': 6000 };
  var rows = _readSheetRaw(sheetName, TAIL_CAP[sheetName]);
  if (maxDays && rows.length > 0) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    var cutStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    rows = rows.filter(function(r) {
      // Try ALL possible date fields — Search_Terms uses date_analyzed, Daily_KPIs uses date, etc.
      var d = '';
      if (r.date && String(r.date).length >= 10) d = String(r.date).substring(0,10);
      else if (r.timestamp && String(r.timestamp).length >= 10) d = String(r.timestamp).substring(0,10);
      else if (r.date_analyzed && String(r.date_analyzed).length >= 10) d = String(r.date_analyzed).substring(0,10);
      else if (r.date_updated && String(r.date_updated).length >= 10) d = String(r.date_updated).substring(0,10);
      // No parseable date? Exclude the row
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      return d >= cutStr;
    });
  }
  
  // Cache trimmed result
  try {
    var json = JSON.stringify(rows);
    var CHUNK_SIZE = 90000;
    var numChunks = Math.ceil(json.length / CHUNK_SIZE) || 1;
    var batch = {};
    for (var i = 0; i < numChunks; i++) {
      batch['v3_strim_' + sheetName + '_' + i] = json.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }
    cache.putAll(batch, 21600);
    cache.put(trimKey, JSON.stringify({ chunks: numChunks, size: json.length }), 21600);
  } catch(e) { /* ignore */ }
  
  return rows;
}

/** Force cache refresh — call after any script writes data */
function invalidateCache(sheetNames) {
  var cache = CacheService.getScriptCache();
  var keys = [];
  (sheetNames || []).forEach(function(n) {
    keys.push('v3_smeta_' + n);
    keys.push('v3_smeta_' + n + '_d90');
    keys.push('v3_smeta_' + n + '_d60');
    for (var c = 0; c < 20; c++) {
      keys.push('v3_schunk_' + n + '_' + c);
      keys.push('v3_strim_' + n + '_' + c);
    }
  });
  if (keys.length > 0) cache.removeAll(keys);
}

/** Invalidate ALL dashboard caches */
function invalidateAllCaches() {
  var allSheets = ['Daily_KPIs','Budget_Pacing','Monthly_Summary','Weekly_Summary','Search_Terms',
    'Quality_Scores','PMax_Insights','Account_Health','Bid_Changes_Log','Anomalies_Log',
    'PMax_Channels','PMax_Products','Conv_Actions','Conv_Daily','Conv_Alerts',
    'Config','Actions_Log','Client_Instructions',
    'GA4_Daily','GA4_Channels','GA4_LandingPages','GA4_KeyEvents','GA4_Fetch_Status',
    'Auction_Insights'];
  invalidateCache(allSheets);
  Logger.log('✅ All caches invalidated');
}

/** Force refresh — clears all caches then returns fresh data */
function forceRefreshData(token) {
  invalidateAllCaches();
  return getAllDashboardData(token);
}

/** Get current search lookback days from Dashboard_Config */
function getSearchLookback(token) {
  if (!isStaff_(token)) return 30;
  var ss = getSpreadsheet_();
  var dcSheet = ss.getSheetByName('Dashboard_Config');
  if (!dcSheet) return 30;
  var data = dcSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === 'search_lookback_days') {
      var v = parseInt(data[i][1]);
      return (v > 0 && v <= 90) ? v : 30;
    }
  }
  return 30;
}

/** Set search lookback days in Dashboard_Config */
function setSearchLookback(token, days) {
  if (!isStaff_(token)) return { error: 'Staff only' };
  var parsed = parseInt(days);
  if (isNaN(parsed) || parsed < 7 || parsed > 90) return { error: 'Days must be 7-90' };

  var ss = getSpreadsheet_();
  var dcSheet = ss.getSheetByName('Dashboard_Config');

  if (!dcSheet) {
    dcSheet = ss.insertSheet('Dashboard_Config');
    dcSheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    dcSheet.getRange(2, 1, 2, 2).setValues([
      ['search_lookback_days', parsed],
      ['search_snapshot_retention', 14]
    ]);
    Logger.log('Created Dashboard_Config sheet with lookback=' + parsed);
    return { success: true, days: parsed };
  }

  var data = dcSheet.getDataRange().getValues();
  var found = false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === 'search_lookback_days') {
      dcSheet.getRange(i + 1, 2).setValue(parsed);
      found = true;
      break;
    }
  }
  if (!found) {
    dcSheet.getRange(dcSheet.getLastRow() + 1, 1, 1, 2).setValues([['search_lookback_days', parsed]]);
  }

  Logger.log('Search lookback updated to ' + parsed + ' days');
  return { success: true, days: parsed };
}

function _readSheetRaw(sheetName, maxRows) {
  try {
    var sheet = getSpreadsheet_().getSheetByName(sheetName);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return [];
    // PERF: for very large append-ordered sheets, read ONLY the last maxRows rows
    // (recent data lives at the bottom). Avoids loading 100k+ rows on every cache miss.
    var startRow = 2;
    var totalData = lastRow - 1;
    if (maxRows && totalData > maxRows) {
      startRow = lastRow - maxRows + 1;
      Logger.log('PERF cap ' + sheetName + ': read last ' + maxRows + ' of ' + totalData + ' rows');
    }
    var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
    var rawHeaders = headerRow.map(function(h) { return String(h).trim(); });
    var headers = rawHeaders.map(function(h) { return h.toLowerCase().replace(/ +/g, '_'); });
    var dateColIdx = {};
    headers.forEach(function(h, idx) {
      if (h === 'date' || h === 'timestamp' || h.indexOf('date_') === 0) dateColIdx[idx] = true;
    });
    var tz = Session.getScriptTimeZone();
    var rows = [];
    for (var i = 0; i < data.length; i++) {
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        var val = data[i][j];
        if (val instanceof Date) {
          if (headers[j] === 'date' || headers[j] === 'date_analyzed' || headers[j] === 'date_updated') {
            val = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
          } else {
            val = Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm');
          }
        } else if (dateColIdx[j] && val && typeof val === 'string') {
          var s = String(val).trim();
          if (/^\d{8}$/.test(s)) {
            val = s.substring(0,4) + '-' + s.substring(4,6) + '-' + s.substring(6,8);
          }
        }
        row[headers[j]] = val;
      }
      rows.push(row);
    }
    return rows;
  } catch(e) { Logger.log('Read error ' + sheetName + ': ' + e.message); return []; }
}

// ════════════════════════════════════════
//  CLIENT REPORT — Email delivery
// ════════════════════════════════════════

/**
 * Send HTML report email to client
 * @param {string} token - session token
 * @param {string} recipientEmail - client email
 * @param {string} recipientName - client name
 * @param {string} clientName - account name
 * @param {string} subject - email subject
 * @param {string} htmlBody - full HTML report (generated client-side)
 * @param {string} customMessage - admin's personal note
 */
function sendClientReport(token, recipientEmail, recipientName, clientName, subject, htmlBody, customMessage, emailLang, attachments, closingMessage) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  if (!recipientEmail) return { error: 'No recipient email' };
  
  var L = emailLang || 'en';
  
  // Wrap in email template
  var fullHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">';
  fullHtml += '<div style="max-width:700px;margin:0 auto;background:#ffffff">';
  
  // Header
  fullHtml += '<div style="background:linear-gradient(135deg,#16213E,#0F3460);padding:30px 32px;text-align:center">';
  fullHtml += '<div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.5px">📊 ' + agencyName_() + '</div>';
  fullHtml += '<div style="font-size:13px;color:#94a3b8;margin-top:4px">' + (L === 'fr' ? 'Rapport Performance' : 'Performance Report') + ' — ' + clientName + '</div>';
  fullHtml += '</div>';
  
  // Greeting
  if (recipientName) {
    fullHtml += '<div style="padding:20px 32px 0;font-size:14px;color:#1e293b">';
    fullHtml += (L === 'fr' ? 'Bonjour ' : 'Hi ') + recipientName + ',';
    fullHtml += '</div>';
  }
  
  // Intro message from admin (before data)
  if (customMessage) {
    fullHtml += '<div style="padding:16px 32px;background:#f0f9ff;border-left:4px solid #3b82f6;margin:12px 32px;border-radius:0 8px 8px 0">';
    fullHtml += '<div style="font-size:13px;color:#1e293b;line-height:1.6">' + customMessage.replace(/\n/g, '<br>') + '</div>';
    fullHtml += '</div>';
  }
  
  // Report content (data sections)
  fullHtml += '<div style="padding:24px 32px">' + htmlBody + '</div>';
  
  // Closing message from admin (after data — next steps, sign-off, etc.)
  if (closingMessage) {
    fullHtml += '<div style="padding:16px 32px;background:#f8fafc;border-left:4px solid #16a34a;margin:0 32px 12px;border-radius:0 8px 8px 0">';
    fullHtml += '<div style="font-size:13px;color:#1e293b;line-height:1.6">' + closingMessage.replace(/\n/g, '<br>') + '</div>';
    fullHtml += '</div>';
  }
  
  fullHtml += emailSignature_();
  
  // Footer
  fullHtml += '<div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center">';
  fullHtml += '<div style="font-size:11px;color:#94a3b8">' + (L === 'fr' ? 'Généré par ' : 'Generated by ') + agencyTitle_() + '</div>';
  fullHtml += '<div style="font-size:11px;color:#94a3b8;margin-top:4px">' + new Date().toLocaleDateString(L === 'fr' ? 'fr-FR' : 'en-AU', { year:'numeric', month:'long', day:'numeric' }) + '</div>';
  fullHtml += '</div></div></body></html>';
  
  try {
    // Build email options
    var emailOptions = {
      to: recipientEmail,
      cc: ADMIN_EMAIL,
      subject: subject,
      htmlBody: fullHtml,
      name: agencyName_(),
      replyTo: ADMIN_EMAIL
    };
    
    // Convert base64 attachments to Blobs
    if (attachments && attachments.length > 0) {
      var blobs = [];
      for (var i = 0; i < attachments.length; i++) {
        var att = attachments[i];
        try {
          var decoded = Utilities.base64Decode(att.data);
          var blob = Utilities.newBlob(decoded, att.mime || 'application/octet-stream', att.name || 'file');
          blobs.push(blob);
        } catch(blobErr) {
          Logger.log('Attachment error for ' + att.name + ': ' + blobErr.message);
        }
      }
      if (blobs.length > 0) emailOptions.attachments = blobs;
    }
    
    MailApp.sendEmail(emailOptions);
    
    // Log the send
    var attachCount = (attachments && attachments.length) || 0;
    logSession_(recipientEmail, 'report', 'Report sent to ' + recipientEmail + ' for ' + clientName + ' [' + L + ']' + (attachCount > 0 ? ' +' + attachCount + ' files' : ''));
    
    return { success: true, message: (L === 'fr' ? 'Rapport envoyé à ' : 'Report sent to ') + recipientEmail + (attachCount > 0 ? ' (+' + attachCount + ' ' + (L === 'fr' ? 'pièces jointes' : 'attachments') + ')' : '') };
  } catch(e) {
    return { error: 'Failed to send: ' + e.message };
  }
}

/**
 * Get client contacts for report sending (from Access_Control)
 */
function getReportRecipients(token, clientName) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  var clients = getAccessControlSheet_();
  var matches = clients.filter(function(c) {
    if (!c.accounts) return false;
    var accs = String(c.accounts).split(',').map(function(a) { return a.trim(); });
    return accs.indexOf(clientName) !== -1;
  });
  return matches.map(function(c) {
    return { email: c.email, name: c.name || '', role: c.role || '' };
  });
}


// ═══════════════════════════════════════════════════════════════
//  AUTO-REPORT SCHEDULING SYSTEM
//  Weekly (Monday 9am) and Monthly (1st of month 9am)
//  Sends performance summaries to clients with email in Config
// ═══════════════════════════════════════════════════════════════

/**
 * Setup scheduled report triggers (run once)
 * Creates: weekly trigger (every Monday 9am) + monthly trigger (1st of month 9am)
 */
function setupAutoReports() {
  // Remove existing triggers first
  removeAutoReports();

  // GA4-only dashboard: re-arming the Ads report e-mails is blocked on purpose.
  // Flip AUTO_REPORTS_DISABLED to false if these ever come back.
  if (AUTO_REPORTS_DISABLED) {
    Logger.log('AUTO-REPORTS OFF — setupAutoReports() refusé, aucun déclencheur créé');
    return;
  }

  // Weekly: every Monday at 9am AEST
  ScriptApp.newTrigger('sendWeeklyReports')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
  
  // Monthly: 1st of each month at 9am AEST  
  ScriptApp.newTrigger('sendMonthlyReports')
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();
  
  Logger.log('✅ Auto-reports scheduled: Weekly (Mon 9am) + Monthly (1st 9am)');
}

/**
 * Remove all scheduled report triggers
 */
function removeAutoReports() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    var fn = trigger.getHandlerFunction();
    if (fn === 'sendWeeklyReports' || fn === 'sendMonthlyReports') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log('Removed existing auto-report triggers');
}

// ── AUTO-REPORTS COUPÉS (2026-08-09) ────────────────────────────────
// Le dashboard est GA4-only : ces e-mails automatiques envoyaient un rapport
// Google Ads aux clients. Ils sont neutralisés ici, pas seulement dans l'UI, pour
// qu'un déclencheur resté en place n'envoie plus rien. Chaque tir supprime aussi
// son propre déclencheur : la planification s'auto-nettoie au premier passage.
var AUTO_REPORTS_DISABLED = true;

/** Delete the trigger that just fired (and any twin), so nothing fires again. */
function killAutoReportTriggers_(fnName) {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(tr) {
    if (tr.getHandlerFunction() === fnName) { ScriptApp.deleteTrigger(tr); removed++; }
  });
  Logger.log('AUTO-REPORTS OFF — ' + fnName + ' a tiré, 0 email envoyé, ' +
             removed + ' déclencheur(s) supprimé(s)');
}

/**
 * Send weekly performance reports to all clients with email
 */
function sendWeeklyReports() {
  if (AUTO_REPORTS_DISABLED) { killAutoReportTriggers_('sendWeeklyReports'); return; }
  sendScheduledReports_('weekly');
}

/**
 * Send monthly performance reports to all clients with email
 */
function sendMonthlyReports() {
  if (AUTO_REPORTS_DISABLED) { killAutoReportTriggers_('sendMonthlyReports'); return; }
  sendScheduledReports_('monthly');
}

/**
 * Core: builds and sends reports for each client
 */
function sendScheduledReports_(period) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // Get config for all active clients
  var config = getSheetData('Config');
  var activeClients = config.filter(function(c) { return c.active === true || c.active === 'TRUE'; });
  
  var sentCount = 0;
  var errorCount = 0;
  
  activeClients.forEach(function(client) {
    var email = client.client_email;
    if (!email) return; // Skip clients without email
    
    var clientName = client.client_name;
    var lang = (client.report_lang || 'EN').toUpperCase() === 'FR' ? 'fr' : 'en';
    var currency = client.currency || 'AUD';
    var objective = client.objective || 'leads';
    
    try {
      var reportHtml = buildScheduledReportHtml_(clientName, period, lang, currency, objective);
      
      var subject = period === 'weekly'
        ? (lang === 'fr' ? '📊 Rapport Hebdomadaire — ' : '📊 Weekly Report — ') + clientName
        : (lang === 'fr' ? '📊 Rapport Mensuel — ' : '📊 Monthly Report — ') + clientName;
      
      var greeting = lang === 'fr' 
        ? 'Voici votre rapport ' + (period === 'weekly' ? 'hebdomadaire' : 'mensuel') + ' automatique.'
        : 'Here is your automated ' + (period === 'weekly' ? 'weekly' : 'monthly') + ' report.';
      
      var closing = lang === 'fr'
        ? 'Ce rapport est généré automatiquement. Pour toute question, répondez directement à cet email.'
        : 'This report is auto-generated. For questions, reply directly to this email.';
      
      // Use existing sendClientReport infrastructure (without token check)
      var emailOptions = {
        to: email,
        cc: ADMIN_EMAIL,
        subject: subject,
        htmlBody: buildEmailWrapper_(reportHtml, clientName, greeting, closing, lang),
        name: agencyName_(),
        replyTo: ADMIN_EMAIL
      };
      
      MailApp.sendEmail(emailOptions);
      sentCount++;
      Logger.log('✅ ' + period + ' report sent to ' + email + ' (' + clientName + ')');
      
    } catch(e) {
      errorCount++;
      Logger.log('❌ Failed: ' + clientName + ' — ' + e.message);
    }
  });
  
  // Notify admin
  MailApp.sendEmail({
    to: ADMIN_EMAIL,
    subject: '📊 Auto-Reports: ' + sentCount + ' sent, ' + errorCount + ' errors',
    htmlBody: '<p><strong>' + (period === 'weekly' ? 'Weekly' : 'Monthly') + ' reports sent:</strong> ' + sentCount + '</p>'
      + (errorCount > 0 ? '<p style="color:red">Errors: ' + errorCount + '</p>' : '<p style="color:green">No errors.</p>')
  });
}

/**
 * Build report HTML content from sheet data
 */
function buildScheduledReportHtml_(clientName, period, lang, currency, objective) {
  // ── Gather data ──
  var kpis = getSheetData('Daily_KPIs').filter(function(r) { return r.client_name === clientName; });
  var budget = getSheetData('Budget_Pacing').filter(function(r) { return r.client_name === clientName; });
  var health = getSheetData('Account_Health').filter(function(r) { return r.client_name === clientName; });
  
  // Date range
  var now = new Date();
  var daysBack = period === 'weekly' ? 7 : 30;
  var startDate = new Date(now);
  startDate.setDate(now.getDate() - daysBack);
  
  // Filter KPIs to period
  var periodKpis = kpis.filter(function(r) {
    var d = new Date(r.date);
    return d >= startDate && d <= now;
  });
  
  // Aggregate metrics
  var totalCost = 0, totalConv = 0, totalValue = 0, totalClicks = 0, totalImpr = 0;
  periodKpis.forEach(function(r) {
    totalCost += Number(r.cost) || 0;
    totalConv += Number(r.conversions) || 0;
    totalValue += Number(r.conv_value) || 0;
    totalClicks += Number(r.clicks) || 0;
    totalImpr += Number(r.impressions) || 0;
  });
  var cpa = totalConv > 0 ? totalCost / totalConv : 0;
  var roas = totalCost > 0 ? totalValue / totalCost : 0;
  var ctr = totalImpr > 0 ? (totalClicks / totalImpr * 100) : 0;
  
  // Previous period for comparison
  var prevStart = new Date(startDate);
  prevStart.setDate(prevStart.getDate() - daysBack);
  var prevKpis = kpis.filter(function(r) {
    var d = new Date(r.date);
    return d >= prevStart && d < startDate;
  });
  var prevCost = 0, prevConv = 0, prevValue = 0;
  prevKpis.forEach(function(r) {
    prevCost += Number(r.cost) || 0;
    prevConv += Number(r.conversions) || 0;
    prevValue += Number(r.conv_value) || 0;
  });
  
  // Deltas
  var convDelta = prevConv > 0 ? ((totalConv - prevConv) / prevConv * 100) : 0;
  var costDelta = prevCost > 0 ? ((totalCost - prevCost) / prevCost * 100) : 0;
  var roasDelta = prevCost > 0 && prevValue > 0 ? ((roas - prevValue/prevCost) / (prevValue/prevCost) * 100) : 0;
  
  var sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  function fmtC(v) { return sym + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtN(v,d) { return Number(v).toFixed(d||0); }
  function fmtDelta(v) { var s = v >= 0 ? '+' : ''; return '<span style="color:' + (v >= 0 ? '#16a34a' : '#dc2626') + ';font-weight:700">' + s + fmtN(v,1) + '%</span>'; }
  
  // ── Build HTML ──
  var h = '';
  
  // KPI Cards
  h += '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px"><tr>';
  
  // Cost card
  h += '<td width="25%" style="padding:4px"><div style="background:#f8fafc;border-radius:8px;padding:14px;text-align:center">';
  h += '<div style="font-size:11px;color:#64748b">' + (lang === 'fr' ? 'Dépenses' : 'Spend') + '</div>';
  h += '<div style="font-size:20px;font-weight:800;color:#16213E">' + fmtC(totalCost) + '</div>';
  h += '<div style="font-size:11px">' + fmtDelta(costDelta) + '</div></div></td>';
  
  // Conversions card
  h += '<td width="25%" style="padding:4px"><div style="background:#f0fdf4;border-radius:8px;padding:14px;text-align:center">';
  h += '<div style="font-size:11px;color:#64748b">Conversions</div>';
  h += '<div style="font-size:20px;font-weight:800;color:#16a34a">' + fmtN(totalConv, 1) + '</div>';
  h += '<div style="font-size:11px">' + fmtDelta(convDelta) + '</div></div></td>';
  
  // CPA or ROAS card
  if (objective === 'ecom') {
    h += '<td width="25%" style="padding:4px"><div style="background:#fefce8;border-radius:8px;padding:14px;text-align:center">';
    h += '<div style="font-size:11px;color:#64748b">ROAS</div>';
    h += '<div style="font-size:20px;font-weight:800;color:#ca8a04">' + fmtN(roas, 2) + 'x</div>';
    h += '<div style="font-size:11px">' + fmtDelta(roasDelta) + '</div></div></td>';
  } else {
    var cpaDelta = prevConv > 0 ? ((cpa - prevCost/prevConv) / (prevCost/prevConv) * 100) : 0;
    h += '<td width="25%" style="padding:4px"><div style="background:#fefce8;border-radius:8px;padding:14px;text-align:center">';
    h += '<div style="font-size:11px;color:#64748b">CPA</div>';
    h += '<div style="font-size:20px;font-weight:800;color:#ca8a04">' + fmtC(cpa) + '</div>';
    h += '<div style="font-size:11px">' + fmtDelta(-cpaDelta) + '</div></div></td>'; // Negative CPA delta is good
  }
  
  // Revenue card (ecom) or CTR (leads)
  if (objective === 'ecom') {
    h += '<td width="25%" style="padding:4px"><div style="background:#eff6ff;border-radius:8px;padding:14px;text-align:center">';
    h += '<div style="font-size:11px;color:#64748b">Revenue</div>';
    h += '<div style="font-size:20px;font-weight:800;color:#1d4ed8">' + fmtC(totalValue) + '</div>';
    h += '</div></td>';
  } else {
    h += '<td width="25%" style="padding:4px"><div style="background:#eff6ff;border-radius:8px;padding:14px;text-align:center">';
    h += '<div style="font-size:11px;color:#64748b">CTR</div>';
    h += '<div style="font-size:20px;font-weight:800;color:#1d4ed8">' + fmtN(ctr, 2) + '%</div>';
    h += '</div></td>';
  }
  h += '</tr></table>';
  
  // Budget pacing
  if (budget.length > 0) {
    var b = budget[budget.length - 1]; // Latest entry
    var pacing = Number(b.pacing_pct) || 0;
    var pacingColor = pacing >= 90 && pacing <= 110 ? '#16a34a' : pacing < 70 || pacing > 130 ? '#dc2626' : '#ca8a04';
    h += '<div style="background:#f8fafc;border-radius:8px;padding:14px;margin-bottom:16px">';
    h += '<div style="font-size:12px;color:#64748b;margin-bottom:6px">' + (lang === 'fr' ? 'Budget Pacing' : 'Budget Pacing') + '</div>';
    h += '<div style="background:#e2e8f0;border-radius:4px;height:18px;overflow:hidden">';
    h += '<div style="width:' + Math.min(pacing, 100) + '%;background:' + pacingColor + ';height:100%;border-radius:4px;transition:width 0.3s"></div></div>';
    h += '<div style="font-size:11px;margin-top:4px"><span style="color:' + pacingColor + ';font-weight:700">' + fmtN(pacing, 0) + '%</span> ' + (lang === 'fr' ? 'du budget mensuel dépensé' : 'of monthly budget spent') + ' (' + fmtC(Number(b.spent_so_far)||0) + ' / ' + fmtC(Number(b.monthly_budget)||0) + ')</div>';
    h += '</div>';
  }
  
  // Campaign breakdown
  var campData = {};
  periodKpis.forEach(function(r) {
    var cn = r.campaign_name || 'Unknown';
    if (!campData[cn]) campData[cn] = { type: r.campaign_type, cost: 0, conv: 0, value: 0 };
    campData[cn].cost += Number(r.cost) || 0;
    campData[cn].conv += Number(r.conversions) || 0;
    campData[cn].value += Number(r.conv_value) || 0;
  });
  
  var campRows = Object.keys(campData).map(function(cn) { return { name: cn, data: campData[cn] }; })
    .sort(function(a,b) { return b.data.cost - a.data.cost; });
  
  if (campRows.length > 0) {
    h += '<div style="margin-top:16px">';
    h += '<div style="font-size:13px;font-weight:700;color:#16213E;margin-bottom:8px">' + (lang === 'fr' ? 'Détail par campagne' : 'Campaign breakdown') + '</div>';
    h += '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:12px;border-collapse:collapse">';
    h += '<tr style="background:#f8fafc"><th style="text-align:left;padding:6px 8px">' + (lang === 'fr' ? 'Campagne' : 'Campaign') + '</th><th style="text-align:right;padding:6px 8px">' + (lang === 'fr' ? 'Dépenses' : 'Spend') + '</th><th style="text-align:right;padding:6px 8px">Conv</th>';
    h += objective === 'ecom' ? '<th style="text-align:right;padding:6px 8px">ROAS</th>' : '<th style="text-align:right;padding:6px 8px">CPA</th>';
    h += '</tr>';
    campRows.forEach(function(c) {
      var campCpa = c.data.conv > 0 ? c.data.cost / c.data.conv : 0;
      var campRoas = c.data.cost > 0 ? c.data.value / c.data.cost : 0;
      h += '<tr style="border-bottom:1px solid #f1f5f9">';
      h += '<td style="padding:6px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + c.name.substring(0,40) + '</td>';
      h += '<td style="text-align:right;padding:6px 8px">' + fmtC(c.data.cost) + '</td>';
      h += '<td style="text-align:right;padding:6px 8px">' + fmtN(c.data.conv, 1) + '</td>';
      h += objective === 'ecom' 
        ? '<td style="text-align:right;padding:6px 8px">' + (campRoas > 0 ? fmtN(campRoas,2) + 'x' : '—') + '</td>'
        : '<td style="text-align:right;padding:6px 8px">' + (campCpa > 0 ? fmtC(campCpa) : '—') + '</td>';
      h += '</tr>';
    });
    h += '</table></div>';
  }
  
  // Health score
  if (health.length > 0) {
    var latest = health[health.length - 1];
    var score = Number(latest.health_score) || 0;
    h += '<div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;text-align:center">';
    h += '<span style="font-size:12px;color:#64748b">' + (lang === 'fr' ? 'Score Santé du Compte' : 'Account Health Score') + ': </span>';
    h += '<span style="font-size:18px;font-weight:800;color:' + (score >= 70 ? '#16a34a' : score >= 50 ? '#ca8a04' : '#dc2626') + '">' + fmtN(score,0) + '/100 (' + (latest.grade||'') + ')</span>';
    h += '</div>';
  }
  
  return h;
}

/**
 * Wrap report content in email template (reused for scheduled reports)
 */
function buildEmailWrapper_(bodyHtml, clientName, greeting, closing, lang) {
  var h = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">';
  h += '<div style="max-width:700px;margin:0 auto;background:#ffffff">';
  h += '<div style="background:linear-gradient(135deg,#16213E,#0F3460);padding:30px 32px;text-align:center">';
  h += '<div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.5px">📊 ' + agencyName_() + '</div>';
  h += '<div style="font-size:13px;color:#94a3b8;margin-top:4px">' + (lang === 'fr' ? 'Rapport Performance' : 'Performance Report') + ' — ' + clientName + '</div>';
  h += '</div>';
  if (greeting) {
    h += '<div style="padding:16px 32px;background:#f0f9ff;border-left:4px solid #3b82f6;margin:12px 32px;border-radius:0 8px 8px 0">';
    h += '<div style="font-size:13px;color:#1e293b;line-height:1.6">' + greeting + '</div></div>';
  }
  h += '<div style="padding:24px 32px">' + bodyHtml + '</div>';
  if (closing) {
    h += '<div style="padding:16px 32px;background:#f8fafc;border-left:4px solid #16a34a;margin:0 32px 12px;border-radius:0 8px 8px 0">';
    h += '<div style="font-size:13px;color:#1e293b;line-height:1.6">' + closing + '</div></div>';
  }
  h += emailSignature_();
  h += '<div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center">';
  h += '<div style="font-size:11px;color:#94a3b8">' + (lang === 'fr' ? 'Rapport automatique — ' : 'Automated report — ') + agencyTitle_() + '</div>';
  h += '<div style="font-size:11px;color:#94a3b8;margin-top:4px">' + new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-AU', { year:'numeric', month:'long', day:'numeric' }) + '</div>';
  h += '</div></div></body></html>';
  return h;
}

/**
 * Get auto-report status (for dashboard UI)
 */
function getAutoReportStatus(token) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  var triggers = ScriptApp.getProjectTriggers();
  var weekly = false, monthly = false;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'sendWeeklyReports') weekly = true;
    if (t.getHandlerFunction() === 'sendMonthlyReports') monthly = true;
  });
  
  var config = getSheetData('Config');
  var withEmail = config.filter(function(c) { return (c.active === true || c.active === 'TRUE') && c.client_email; });
  
  return {
    weeklyActive: weekly,
    monthlyActive: monthly,
    clientsWithEmail: withEmail.length,
    totalActive: config.filter(function(c) { return c.active === true || c.active === 'TRUE'; }).length
  };
}

/**
 * Toggle auto-reports on/off (from dashboard)
 */
function toggleAutoReports(token, enable) {
  if (!isAdmin_(token)) return { error: 'Admin only' };
  if (enable) {
    if (AUTO_REPORTS_DISABLED) {
      removeAutoReports();
      return { error: 'Rapports Ads automatiques coupés (dashboard GA4-only)' };
    }
    setupAutoReports();
    return { success: true, message: 'Auto-reports enabled (Weekly Mon 9am + Monthly 1st 9am)' };
  } else {
    removeAutoReports();
    return { success: true, message: 'Auto-reports disabled' };
  }
}