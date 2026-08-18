/**
 * CONFIG — the only file you need to edit.
 *
 * 1. SPREADSHEET_ID — the Google Sheet this dashboard reads and writes.
 * 2. ADMIN_EMAIL    — the Google account that gets full access.
 * 3. GA4_PROPERTIES — one entry per GA4 property you want on the dashboard.
 *
 * Find a property ID in GA4: Admin > Property settings (a 9-digit number).
 */

var SPREADSHEET_ID = 'PASTE_YOUR_SPREADSHEET_ID_HERE';
var ADMIN_EMAIL    = 'you@example.com';

var GA4_PROPERTIES = [
  { propertyId: '000000001', client_name: 'Acme Corp' },
  { propertyId: '000000002', client_name: 'Globex' },
  { propertyId: '000000003', client_name: 'Initech' }
];
