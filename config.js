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

/**
 * BRANDING — what clients see on the dashboard, the emails and the exports.
 * Leave a field empty and it is simply not rendered.
 */
var AGENCY = {
  name:        'Your Agency',            // sidebar, email header, export watermark
  productName: 'Analytics Dashboard',    // shown under the name, and as the browser title
  tagline:     '',                       // e.g. 'Attract. Convert. Scale.'
  contactName: '',                       // e.g. 'Jane Doe' — email signature
  contactTitle:'',                       // e.g. 'Head of Paid — Your Agency'
  website:     ''                        // e.g. 'youragency.com'
};
