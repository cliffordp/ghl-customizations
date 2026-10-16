# Google Maps Address Autocomplete & Map Embed for GoHighLevel CRM

Adds **Google Maps Places Address Autocomplete** and an **interactive embedded Google Map** directly inside the GoHighLevel (GHL) desktop web application via **Agency Settings → Company → White Label tab → Custom JS**.

## Where It Works

1. **Contact Detail Screen** (`/v2/location/{locationId}/contacts/detail/{contactId}`)
   - Attaches Google Places Autocomplete to the **Street address** field.
   - Selecting an address automatically populates:
     - **Street address** (including unit/suite when present)
     - **City**
     - **State** (full state name, e.g., `Oklahoma`, as required for GHL automated tax calculation)
     - **Postal code**
     - **Country** *(matched by ISO country code, so naming differences like Google's "Czechia" vs GHL's "Czech Republic" don't matter, nor does GHL user's language setting)*
     - **Latitude** & **Longitude** *(if you have created custom fields with those exact names)*
     - **Time zone** *(the most specific zone GHL offers for the address; see [Time zone auto-select](#time-zone-auto-select))*
   - Fires the input events GHL needs to register each new value, so the fields keep their values and are saved when you click **Save**.
   - Embeds an interactive Google Map above the Street address field whenever a contact has an existing address or a new address is selected.

2. **Company / Business Detail Screen** (`/businesses`, `/companies`, `/objects`)
   - Attaches Google Places Autocomplete to the Company **Address** field in the details panel.
   - Populates **Address**, **City**, **State**, **Postal Code**, **Country**, **Latitude**, and **Longitude**, and embeds a Google Map above the Address field.

3. **Book / Edit Appointment Modal** (Calendars, Contacts, Conversations, Opportunities)
   - Whenever **Meeting location** is set to **Custom** (`Custom` radio + `Custom` dropdown), attaches Google Places Autocomplete to the **Enter meeting location** input field and embeds a Google Map once an address is selected.

## Important Limitation: Desktop Web Browser Only (Not Mobile App)

> **Note:** GoHighLevel only executes Agency **Custom JS** inside the **desktop/computer web browser version** of GHL (`app.gohighlevel.com` or your white-labeled web domain). Custom JS is **not** loaded inside the GoHighLevel / LeadConnector mobile app (iOS / Android).

### Recommended Backstop for Mobile App & Manual Entry
Because users may type an address without clicking an autocomplete suggestion—or add/edit contacts and appointments from the **mobile app**, imports, AI Agents, or integrations—pair this script with the **[GAddress GHL Marketplace App](https://gaddressapp.ablepro.page/)**.

**GAddress** runs in the background via GHL Workflows to automatically validate, standardize, and populate address components and coordinates even when the browser autocomplete wasn't used.

## Prerequisites (Google Cloud Console)

1. Create a Google Maps API key in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable these APIs on your project:
   - **Maps JavaScript API**
   - **Places API (New)**
   - **Maps Embed API**
3. Restrict the API key by **HTTP referrers** to your GHL domains (e.g., `app.gohighlevel.com/*` and your white-label domain `app.YOURDOMAIN.com/*`), and restrict it to the APIs above.

<img width="898" height="1378" alt="image" src="https://github.com/user-attachments/assets/b4a508bc-1b34-4a7d-b6c5-a254f9ba8c22" />

## Installation

Go to **Agency View → Settings → Company → White Label tab → Custom JS** and use either option below:

### Option A: One-Line CDN Embed (Recommended)
Copy and paste this single line into **Custom JS**, replacing `YOUR_GOOGLE_MAPS_API_KEY` with your actual key:

```html
<script defer id="crm-gmaps-address-autocomplete" data-api-key="YOUR_GOOGLE_MAPS_API_KEY" src="https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-crm/script.js"></script>
```

*(The script injects its own dropdown CSS—including a max `z-index`—so suggestions render above GHL modals.)*

### Option B: Inline Embed
If you prefer pasting the full code directly into **Custom JS** without loading an external file:
1. Copy the wrapper from [`crm-gmaps-address-autocomplete.html`](./crm-gmaps-address-autocomplete.html).
2. Paste the contents of [`script.js`](./script.js) inside the `<script>` tag and set your API key in `const googleMapsApiKey = 'YOUR_GOOGLE_MAPS_API_KEY';`.

## Time Zone Auto-Select

When an address is chosen on the **Contact Detail** screen, the script selects the most specific time zone GHL offers for it in the **Time zone** field. As with every other field, click **Save** to keep it. *(Company and Appointment screens don't have a Time zone field, so this doesn't apply there.)*

- **Specific zones:** Michigan gets `America/Detroit`, Indiana `America/Indiana/Indianapolis`, Kentucky `America/Louisville`, Idaho `America/Boise`, and so on.
- **Split states use the county:** e.g. Michigan's Upper Peninsula Central-time counties, northwest and southwest Indiana, western Kentucky, East Tennessee, the Florida Panhandle, El Paso, and western Kansas, Nebraska, and the Dakotas. Canadian provinces, Mexican states, Brazilian states, and Australian states are handled the same way.
- **Only zones in GHL's list:** GHL's dropdown has about 109 zones. When a city's own zone isn't there, the script uses one with identical rules (e.g. Paris → `Europe/Brussels`, Winnipeg → `America/Chicago`, Puerto Rico → `America/Santo_Domingo`).
- **Replaces a less specific zone:** a Michigan contact set to `America/New_York` is changed to `America/Detroit`. If the best zone is already selected, the field isn't touched.
- **Leaves it alone when unsure:** for countries with no mapping, the Time zone field is left unchanged.
- **No extra API:** everything is resolved in the browser from Google's address details, so it works with HTTP-referrer-restricted keys (Google's Time Zone API doesn't).

Known gaps: counties split down the middle (e.g. Gulf County, FL; Dunn County, ND) get their state's main zone, and small exceptions like Arizona's Navajo Nation (observes daylight saving time) aren't handled. Russia and Indonesia are approximated by longitude.

This is **on by default**. If you do not want the script to touch the Time zone field, turn it off by adding `data-set-tz="false"` to the script tag:

```html
<script defer id="crm-gmaps-address-autocomplete" data-api-key="YOUR_GOOGLE_MAPS_API_KEY" data-set-tz="false" src="https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-crm/script.js"></script>
```

For the inline embed, add `data-set-tz="false"` to the wrapper `<script>` tag, or set `window.tkGmapsSetTz = false;` before the script runs.

## Troubleshooting

- **Script updates not showing up in GHL?** jsDelivr edge-caches branch URLs like `@main` for up to 12 hours. You can clear it immediately:
  - Visit the [jsDelivr Purge Link](https://purge.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-crm/script.js) for this script.
  - Or paste the URL into the [jsDelivr Purge Tool](https://www.jsdelivr.com/tools/purge).
  - Then hard-refresh your browser (`Cmd + Shift + R` or `Ctrl + Shift + R`).
  - To test a specific version, replace `@main` in the script URL with a commit hash (e.g. `@3cde5c6`). Commit URLs are never stale.
- **Need verbose console logs?** Add `data-debug="true"` to the script tag (or set `window.tkGmapsDebug = true;` for the inline embed). Errors and warnings always log; informational messages only log in debug mode.
- **Need help, found a bug, or want to contribute?** See the [main repository README](../README.md#troubleshooting--contributing) for issue reporting, PR guidelines, and contact links.

## Development

Run the tests from the repository root after changing `script.js`:

```sh
node gmaps-address-autocomplete-crm/tests/script.test.js
# macOS without Node:
osascript -l JavaScript gmaps-address-autocomplete-crm/tests/script.test.js
```

The tests check every Country label and Time zone the script can pick against GHL's real dropdown options in [`ghl-dom-reference/select-options-country-timezone.json`](../ghl-dom-reference/select-options-country-timezone.json). When GHL changes those lists, re-export them (see the [reference README](../ghl-dom-reference/README.md#how-to-export-dropdown-options)) and re-run the tests: any label the script uses that no longer exists fails.
