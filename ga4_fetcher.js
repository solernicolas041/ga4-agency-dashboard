// ╔════════════════════════════════════════════════════════════════╗
// ║  GA4 FETCHER — pulls GA4 into the spreadsheet               ║
// ║  Pulls GA4 data via Analytics Data API → writes to Sheets     ║
// ║                                                                ║
// ║                                                                ║
// ║  16 properties split into 2 batches (BATCH_SIZE=8):           ║
// ║    6:00 AM → Batch 1 (properties 1-8)                         ║
// ║    6:15 AM → Batch 2 (properties 9-15)                        ║
// ║                                                                ║
// ║  Setup: run setupGA4Trigger() once → creates both triggers    ║
// ╚════════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════



var GA4_LOOKBACK_DAYS = 30;
var BATCH_SIZE = 8;
var SLEEP_BETWEEN_REPORTS_MS = 2000;
var SLEEP_BETWEEN_PROPERTIES_MS = 3000;
var MAX_RETRIES = 3;
// Apps Script kills any execution at 6 min (360s). Stop fetching new
// properties past this soft budget so the merge+write at the end still runs.
// Unfetched clients keep yesterday's data via mergeData_ (no data loss).
var MAX_RUNTIME_MS = 280000;

// ═══════════════════════════════════════════════════════════════
// ENTRY POINTS (triggered automatically)
// ═══════════════════════════════════════════════════════════════

function fetchGA4Batch1() { runBatch_(0); }
function fetchGA4Batch2() { runBatch_(1); }

// Manual: run all (waits 2min between batches)
function fetchAllGA4Data() {
  runBatch_(0);
  Logger.log('⏳ Waiting 2 minutes before batch 2...');
  Utilities.sleep(120000);
  runBatch_(1);
}

// ═══════════════════════════════════════════════════════════════
// CORE — runs one batch of properties
// ═══════════════════════════════════════════════════════════════

function runBatch_(batchIndex) {
  var startIdx = batchIndex * BATCH_SIZE;
  var endIdx = Math.min(startIdx + BATCH_SIZE, GA4_PROPERTIES.length);
  var batchProps = GA4_PROPERTIES.slice(startIdx, endIdx);

  if (batchProps.length === 0) { Logger.log('⚠️ Batch ' + (batchIndex+1) + ': no properties'); return; }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tz = Session.getScriptTimeZone();
  var end = new Date();
  var start = new Date();
  start.setDate(start.getDate() - GA4_LOOKBACK_DAYS);
  var startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  var endStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');

  var batchNames = batchProps.map(function(p) { return p.client_name; });
  Logger.log('📊 GA4 Batch ' + (batchIndex+1) + ': ' + batchNames.join(', '));
  Logger.log('   Date range: ' + startStr + ' → ' + endStr);

  // Read existing data (to preserve other batch + failed clients)
  var existingDaily = readExistingSheet_(ss, 'GA4_Daily');
  var existingChannels = readExistingSheet_(ss, 'GA4_Channels');
  var existingPages = readExistingSheet_(ss, 'GA4_LandingPages');
  var existingKeyEvents = readExistingSheet_(ss, 'GA4_KeyEvents');

  var newDaily = [], newChannels = [], newPages = [], newKeyEvents = [];
  var fetchedClients = { daily: [], channels: [], pages: [], keyEvents: [] };
  var stats = { ok: 0, fail: 0 };
  var statusLog = []; // Track per-client fetch status for dashboard
  var t0 = new Date().getTime();

  for (var i = 0; i < batchProps.length; i++) {
    var prop = batchProps[i];
    // Time-budget guard: bail before the 6-min Apps Script kill so the
    // merge+write below still executes. Remaining clients keep old data.
    var elapsed = new Date().getTime() - t0;
    if (elapsed > MAX_RUNTIME_MS) {
      var skipped = batchProps.slice(i).map(function(p) { return p.client_name; });
      Logger.log('⏱️ Time budget hit (' + Math.round(elapsed/1000) + 's). Skipping: ' + skipped.join(', ') + ' (old data kept)');
      break;
    }
    Logger.log('  → [' + (i+1) + '/' + batchProps.length + '] ' + prop.client_name);
    var clientStatus = { client_name: prop.client_name, daily: 'ok', channels: 'ok', pages: 'ok', keyEvents: 'ok', errors: [] };

    // Daily
    try {
      var daily = retryFetch_(function() {
        return fetchDailyOverview_(prop.propertyId, prop.client_name, startStr, endStr);
      });
      newDaily = newDaily.concat(daily);
      fetchedClients.daily.push(prop.client_name);
      Logger.log('    ✅ Daily: ' + daily.length + ' rows');
      stats.ok++;
    } catch(e) {
      Logger.log('    ❌ Daily: ' + shortErr_(e));
      clientStatus.daily = 'fail';
      clientStatus.errors.push('Daily: ' + shortErr_(e));
      stats.fail++;
    }
    Utilities.sleep(SLEEP_BETWEEN_REPORTS_MS);

    // Channels
    try {
      var channels = retryFetch_(function() {
        return fetchChannelBreakdown_(prop.propertyId, prop.client_name, startStr, endStr);
      });
      newChannels = newChannels.concat(channels);
      fetchedClients.channels.push(prop.client_name);
      Logger.log('    ✅ Channels: ' + channels.length + ' rows');
      stats.ok++;
    } catch(e) {
      Logger.log('    ❌ Channels: ' + shortErr_(e));
      clientStatus.channels = 'fail';
      clientStatus.errors.push('Channels: ' + shortErr_(e));
      stats.fail++;
    }
    Utilities.sleep(SLEEP_BETWEEN_REPORTS_MS);

    // Landing Pages
    try {
      var pages = retryFetch_(function() {
        return fetchPaidLandingPages_(prop.propertyId, prop.client_name, startStr, endStr);
      });
      newPages = newPages.concat(pages);
      fetchedClients.pages.push(prop.client_name);
      Logger.log('    ✅ LPs: ' + pages.length + ' rows');
      stats.ok++;
    } catch(e) {
      Logger.log('    ❌ LPs: ' + shortErr_(e));
      clientStatus.pages = 'fail';
      clientStatus.errors.push('LPs: ' + shortErr_(e));
      stats.fail++;
    }

    Utilities.sleep(SLEEP_BETWEEN_REPORTS_MS);

    // Key Events (breakdown by eventName)
    try {
      var keyEvts = retryFetch_(function() {
        return fetchKeyEvents_(prop.propertyId, prop.client_name, startStr, endStr);
      });
      newKeyEvents = newKeyEvents.concat(keyEvts);
      fetchedClients.keyEvents.push(prop.client_name);
      Logger.log('    ✅ Key Events: ' + keyEvts.length + ' rows');
      stats.ok++;
    } catch(e) {
      Logger.log('    ❌ Key Events: ' + shortErr_(e));
      clientStatus.keyEvents = 'fail';
      clientStatus.errors.push('Key Events: ' + shortErr_(e));
      stats.fail++;
    }

    statusLog.push(clientStatus);
    if (i < batchProps.length - 1) Utilities.sleep(SLEEP_BETWEEN_PROPERTIES_MS);
  }

  // Merge: fresh data for succeeded clients + old data for everyone else
  var mergedDaily = mergeData_(existingDaily, newDaily, fetchedClients.daily, 1);
  var mergedChannels = mergeData_(existingChannels, newChannels, fetchedClients.channels, 1);
  var mergedPages = mergeData_(existingPages, newPages, fetchedClients.pages, 0);
  var mergedKeyEvents = mergeData_(existingKeyEvents, newKeyEvents, fetchedClients.keyEvents, 1);

  writeSheet_(ss, 'GA4_Daily',
    ['date','client_name','sessions','users','new_users','returning_users','bounce_rate','engagement_rate','avg_session_duration','conversions'],
    mergedDaily);
  writeSheet_(ss, 'GA4_Channels',
    ['date','client_name','channel_group','source','medium','sessions','users','new_users','conversions','engagement_rate','bounce_rate'],
    mergedChannels);
  writeSheet_(ss, 'GA4_LandingPages',
    ['client_name','landing_page','channel_group','sessions','users','bounce_rate','engagement_rate','avg_engagement_time','conversions'],
    mergedPages);
  writeSheet_(ss, 'GA4_KeyEvents',
    ['date','client_name','event_name','channel_group','source','medium','key_events','event_revenue'],
    mergedKeyEvents);

  Logger.log('✅ Batch ' + (batchIndex+1) + ' done | ' + stats.ok + ' ok, ' + stats.fail + ' failed (old data kept)');

  // Write fetch status for dashboard alerts
  writeStatus_(ss, statusLog);
}

// ═══════════════════════════════════════════════════════════════
// RETRY + HELPERS
// ═══════════════════════════════════════════════════════════════

function retryFetch_(fn) {
  var lastError;
  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch(e) {
      lastError = e;
      var msg = String(e.message);
      var is429 = msg.indexOf('429') !== -1 || msg.indexOf('RESOURCE_EXHAUSTED') !== -1;
      // Transient server-side errors return an HTML 5xx page from the Google
      // gateway, not a JSON API error. These are retryable like 429.
      var is5xx = msg.indexOf('500') !== -1 || msg.indexOf('502') !== -1 ||
                  msg.indexOf('503') !== -1 || msg.indexOf('504') !== -1;
      var retryable = is429 || is5xx;
      if (!retryable || attempt >= MAX_RETRIES - 1) throw e;
      var wait = Math.pow(2, attempt + 3) * 1000 + Math.floor(Math.random() * 3000);
      Logger.log('    ⏳ ' + (is429 ? '429' : '5xx') + ' — retry ' + (attempt+1) + '/' + MAX_RETRIES + ' in ' + Math.round(wait/1000) + 's');
      Utilities.sleep(wait);
    }
  }
  throw lastError;
}

function shortErr_(e) {
  var msg = String(e.message);
  if (msg.indexOf('429') !== -1) return '429 (kept old data)';
  var m5 = msg.match(/50[0234]/);
  if (m5) return m5[0] + ' transient (kept old data)';
  return msg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 80);
}

function readExistingSheet_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
}

function mergeData_(existingRows, newRows, fetchedClients, clientCol) {
  var preserved = existingRows.filter(function(row) {
    return fetchedClients.indexOf(String(row[clientCol] || '')) === -1;
  });
  return newRows.concat(preserved);
}

function writeSheet_(ss, sheetName, headers, rows) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { sheet = ss.insertSheet(sheetName); }
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  Logger.log('  📝 ' + sheetName + ': ' + rows.length + ' rows');
}

/**
 * Write fetch status per client to GA4_Fetch_Status sheet.
 * Each batch MERGES its status — doesn't erase the other batch.
 * Columns: client_name | status | daily | channels | pages | key_events | errors | timestamp
 */
function writeStatus_(ss, statusLog) {
  var sheetName = 'GA4_Fetch_Status';
  var headers = ['client_name', 'status', 'daily', 'channels', 'pages', 'key_events', 'errors', 'timestamp'];
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#16213E').setFontColor('#FFFFFF');
  }

  var tz = Session.getScriptTimeZone();
  var now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

  // Header may predate the key_events column — rewrite it so old sheets pick it up
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Read existing status rows (from other batch)
  var existing = [];
  if (sheet.getLastRow() > 1) {
    existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  }

  // Build name set for this batch
  var batchNames = {};
  statusLog.forEach(function(s) { batchNames[s.client_name] = true; });

  // Keep rows from other batch (not in this batch).
  // Legacy rows were written on the 7-column layout (no key_events): shift errors and
  // timestamp one column right so they don't land under the new key_events header.
  var kept = existing
    .filter(function(row) { return String(row[0]) && !batchNames[String(row[0])]; })
    .map(function(row) {
      var legacy = String(row[7] || '') === '';
      if (!legacy) return row;
      return [row[0], row[1], row[2], row[3], row[4], '', row[5], row[6]];
    });

  // Add this batch's status
  statusLog.forEach(function(s) {
    var allOk = s.daily === 'ok' && s.channels === 'ok' && s.pages === 'ok' && s.keyEvents === 'ok';
    kept.push([
      s.client_name,
      allOk ? 'ok' : 'partial',
      s.daily,
      s.channels,
      s.pages,
      s.keyEvents,
      s.errors.join(' | '),
      now
    ]);
  });

  // Rewrite sheet
  sheet.getRange(2, 1, Math.max(sheet.getLastRow(), 1), headers.length).clearContent();
  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, headers.length).setValues(kept);
  }
}

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

// ═══════════════════════════════════════════════════════════════
// REPORTS (unchanged logic)
// ═══════════════════════════════════════════════════════════════

function fetchDailyOverview_(propertyId, clientName, startDate, endDate) {
  var request = AnalyticsData.newRunReportRequest();
  request.dateRanges = [{ startDate: startDate, endDate: endDate }];
  request.dimensions = [{ name: 'date' }, { name: 'newVsReturning' }];
  request.metrics = [
    { name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' },
    { name: 'engagementRate' }, { name: 'averageSessionDuration' }, { name: 'conversions' }
  ];
  request.orderBys = [{ dimension: { dimensionName: 'date' } }];
  var response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);

  var byDate = {};
  (response.rows || []).forEach(function(row) {
    var d = String(row.dimensionValues[0].value);
    var dateStr = d.substring(0,4) + '-' + d.substring(4,6) + '-' + d.substring(6,8);
    var type = row.dimensionValues[1].value;
    if (!byDate[dateStr]) byDate[dateStr] = { sessions:0, users:0, newUsers:0, retUsers:0, bounceRate:0, engRate:0, avgDur:0, conv:0, count:0 };
    var b = byDate[dateStr], s = Number(row.metricValues[0].value);
    b.sessions += s;
    b.users += Number(row.metricValues[1].value);
    if (type === 'new') b.newUsers += Number(row.metricValues[1].value);
    else b.retUsers += Number(row.metricValues[1].value);
    b.bounceRate += Number(row.metricValues[2].value) * s;
    b.engRate += Number(row.metricValues[3].value) * s;
    b.avgDur += Number(row.metricValues[4].value) * s;
    b.conv += Number(row.metricValues[5].value);
    b.count += s;
  });

  var result = [];
  Object.keys(byDate).sort().forEach(function(dateStr) {
    var b = byDate[dateStr], w = b.count || 1;
    result.push([dateStr, clientName, b.sessions, b.users, b.newUsers, b.retUsers,
      r4(b.bounceRate/w), r4(b.engRate/w), r2(b.avgDur/w), b.conv]);
  });
  return result;
}

function fetchChannelBreakdown_(propertyId, clientName, startDate, endDate) {
  var request = AnalyticsData.newRunReportRequest();
  request.dateRanges = [{ startDate: startDate, endDate: endDate }];
  request.dimensions = [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }, { name: 'sessionMedium' }];
  request.metrics = [
    { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
    { name: 'conversions' }, { name: 'engagementRate' }, { name: 'bounceRate' }
  ];
  request.orderBys = [{ metric: { metricName: 'sessions' }, desc: true }];
  request.limit = 2000;
  var response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);
  return (response.rows || []).map(function(row) {
    var d = String(row.dimensionValues[0].value);
    return [d.substring(0,4)+'-'+d.substring(4,6)+'-'+d.substring(6,8), clientName,
      row.dimensionValues[1].value, row.dimensionValues[2].value, row.dimensionValues[3].value,
      Number(row.metricValues[0].value), Number(row.metricValues[1].value), Number(row.metricValues[2].value),
      Number(row.metricValues[3].value), Number(row.metricValues[4].value), Number(row.metricValues[5].value)];
  });
}

function fetchPaidLandingPages_(propertyId, clientName, startDate, endDate) {
  var request = AnalyticsData.newRunReportRequest();
  request.dateRanges = [{ startDate: startDate, endDate: endDate }];
  request.dimensions = [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }];
  // "conversions" (last col) = LEADS ONLY (generate_lead + phone_call), NOT engagement
  // key events (cta_click/scroll_50/scroll_75) which inflate the count. Fallback to the
  // generic conversions metric if event-scoped names error on this property.
  var leadMetricSets = [
    [{ name: 'conversions:generate_lead' }, { name: 'conversions:phone_call' }],
    [{ name: 'keyEvents:generate_lead' }, { name: 'keyEvents:phone_call' }],
    [{ name: 'conversions' }]
  ];
  var response, leadCols;
  for (var s = 0; s < leadMetricSets.length; s++) {
    try {
      var request = AnalyticsData.newRunReportRequest();
      request.dateRanges = [{ startDate: startDate, endDate: endDate }];
      request.dimensions = [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }];
      request.metrics = [
        { name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' },
        { name: 'engagementRate' }, { name: 'averageSessionDuration' }
      ].concat(leadMetricSets[s]);
      request.orderBys = [{ metric: { metricName: 'sessions' }, desc: true }];
      request.limit = 100;
      response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);
      leadCols = leadMetricSets[s].length; // 2 = leads split, 1 = generic fallback
      break;
    } catch (e) { if (s === leadMetricSets.length - 1) throw e; }
  }
  return (response.rows || []).map(function(row) {
    var leads = leadCols === 2
      ? Number(row.metricValues[5].value) + Number(row.metricValues[6].value)
      : Number(row.metricValues[5].value);
    return [clientName, row.dimensionValues[0].value, row.dimensionValues[1].value,
      Number(row.metricValues[0].value), Number(row.metricValues[1].value), Number(row.metricValues[2].value),
      Number(row.metricValues[3].value), Number(row.metricValues[4].value), leads];
  });
}

// ═══════════════════════════════════════════════════════════════
// KEY EVENTS BREAKDOWN (new in v6)
// ═══════════════════════════════════════════════════════════════

function fetchKeyEvents_(propertyId, clientName, startDate, endDate) {
  // Try 'keyEvents' first (new API name), fallback to 'conversions' (deprecated but works)
  var metricNames = [
    ['keyEvents', 'totalRevenue'],
    ['conversions', 'totalRevenue']
  ];
  var lastError;
  for (var m = 0; m < metricNames.length; m++) {
    try {
      var request = AnalyticsData.newRunReportRequest();
      request.dateRanges = [{ startDate: startDate, endDate: endDate }];
      request.dimensions = [
        { name: 'date' },
        { name: 'eventName' },
        { name: 'sessionDefaultChannelGroup' },
        { name: 'sessionSource' },
        { name: 'sessionMedium' }
      ];
      request.metrics = [
        { name: metricNames[m][0] }, { name: metricNames[m][1] }
      ];
      request.orderBys = [{ dimension: { dimensionName: 'date' } }];
      request.limit = 10000;
      var response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);
      // Filter: only keep rows where key events count > 0
      var rows = (response.rows || []).filter(function(row) {
        return Number(row.metricValues[0].value) > 0;
      });
      if (m > 0) Logger.log('    ℹ️ Used fallback metric: ' + metricNames[m][0]);
      return rows.map(function(row) {
        var d = String(row.dimensionValues[0].value);
        return [
          d.substring(0,4) + '-' + d.substring(4,6) + '-' + d.substring(6,8),
          clientName,
          row.dimensionValues[1].value,                        // event_name
          row.dimensionValues[2].value || '(not set)',          // channel_group
          row.dimensionValues[3].value || '(not set)',          // source
          row.dimensionValues[4].value || '(not set)',          // medium
          Number(row.metricValues[0].value),                    // key_events count
          r2(Number(row.metricValues[1].value))                 // totalRevenue
        ];
      });
    } catch(e) {
      lastError = e;
      Logger.log('    ⚠️ Metric "' + metricNames[m][0] + '" failed: ' + String(e.message).substring(0, 60));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// SETUP — run once to create both daily triggers
// ═══════════════════════════════════════════════════════════════

function setupGA4Trigger() {
  // Clean old triggers
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'fetchAllGA4Data' || fn === 'fetchGA4Batch1' || fn === 'fetchGA4Batch2') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Batch 1: daily at 6:00 AM
  ScriptApp.newTrigger('fetchGA4Batch1').timeBased().everyDays(1).atHour(6).create();
  // Batch 2: daily at ~6:15 AM
  ScriptApp.newTrigger('fetchGA4Batch2').timeBased().everyDays(1).atHour(6).nearMinute(15).create();

  Logger.log('✅ GA4 triggers set:');
  Logger.log('   Batch 1 (props 1-8) → 6:00 AM');
  Logger.log('   Batch 2 (props 9-15) → ~6:15 AM');
}

function testGA4Connection() {
  var prop = GA4_PROPERTIES[0];
  Logger.log('Testing: ' + prop.client_name);
  try {
    var req = AnalyticsData.newRunReportRequest();
    req.dateRanges = [{ startDate: '7daysAgo', endDate: 'today' }];
    req.metrics = [{ name: 'sessions' }, { name: 'totalUsers' }];
    var res = AnalyticsData.Properties.runReport(req, 'properties/' + prop.propertyId);
    Logger.log('✅ OK! ' + res.rows[0].metricValues[0].value + ' sessions');
  } catch(e) { Logger.log('❌ ' + e.message); }
}
