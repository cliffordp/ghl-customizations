# Google Maps Address Autocomplete & Map Embed for GoHighLevel CRM

Adds **Google Maps Places Address Autocomplete** and an **interactive embedded Google Map** directly inside the GoHighLevel (GHL) desktop web application via **Agency Settings → Company → Custom JS**.

---

## Where It Works

1. **Contact Detail Screen** (`/v2/location/{locationId}/contacts/detail/{contactId}`)
   - Attaches Google Places Autocomplete to the **Street address** field.
   - Selecting an address automatically populates:
     - **Street address** (including unit/suite when present)
     - **City**
     - **State** (full state name, e.g., `Oklahoma`, as required for GHL automated tax calculation)
     - **Postal code**
     - **Latitude** & **Longitude** *(if you have created custom fields with those exact names)*
   - Fires the input events GHL needs to register each new value, so the fields keep their values and are saved when you click **Save**.
   - Embeds an interactive Google Map above the Street address field whenever a contact has an existing address or a new address is selected.

2. **Company / Business Detail Screen** (`/businesses`, `/companies`, `/objects`)
   - Attaches Google Places Autocomplete to the Company **Address** field in the details panel.
   - Populates **Address**, **City**, **State**, **Postal Code**, **Latitude**, and **Longitude**, and embeds a Google Map above the Address field.

3. **Book / Edit Appointment Modal** (Calendars, Contacts, Conversations, Opportunities)
   - Whenever **Meeting location** is set to **Custom** (`Custom` radio + `Custom` dropdown), attaches Google Places Autocomplete to the **Enter meeting location** input field and embeds a Google Map once an address is selected.

---

## Important Limitation: Desktop Web Browser Only (Not Mobile App)

> **Note:** GoHighLevel only executes Agency **Custom JS** inside the **desktop/computer web browser version** of GHL (`app.gohighlevel.com` or your white-labeled web domain). Custom JS is **not** loaded inside the GoHighLevel / LeadConnector mobile app (iOS / Android).

### Recommended Backstop for Mobile App & Manual Entry
Because users may type an address without clicking an autocomplete suggestion—or add/edit contacts and appointments from the **mobile app**, imports, or integrations—pair this script with the **[GAddress GHL Marketplace App](https://gaddressapp.ablepro.page/)**.

**GAddress** runs in the background via GHL Workflows to automatically validate, standardize, and populate address components and coordinates even when the browser autocomplete wasn't used.

---

## Prerequisites (Google Cloud Console)

1. Create a Google Maps API key in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable these APIs on your project:
   - **Maps JavaScript API**
   - **Places API (New)**
   - **Maps Embed API**
3. Restrict the API key by **HTTP referrers** to your GHL domains (e.g., `*.gohighlevel.com/*` and your white-label domain `app.yourdomain.com/*`), and restrict it to the three APIs above.

> **Upgrading from an older version?** This script previously used the legacy **Places API**, which Google no longer offers to new projects. It now uses **Places API (New)**; enable that on your key or autocomplete suggestions won't load (check the browser console for an error).

---

## Installation

Go to **Agency View → Settings → Company → Custom JS** and use either option below:

### Option A: One-Line CDN Embed (Recommended)
Copy and paste this single line (see [`put-in-agency-company-white-label-settings.js`](./put-in-agency-company-white-label-settings.js)), replacing `YOUR_GOOGLE_MAPS_API_KEY` with your actual key:

```html
<script defer id="crm-gmaps-address-autocomplete" data-api-key="YOUR_GOOGLE_MAPS_API_KEY" src="https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-crm/script.js"></script>
```

*(The script injects its own dropdown CSS—including a max `z-index`—so suggestions render above GHL modals.)*

### Option B: Inline Embed
If you prefer pasting the full code directly into **Custom JS** without loading an external file:
1. Copy the wrapper from [`crm-gmaps-address-autocomplete.html`](./crm-gmaps-address-autocomplete.html).
2. Paste the contents of [`script.js`](./script.js) inside the `<script>` tag and set your API key in `const googleMapsApiKey = 'YOUR_GOOGLE_MAPS_API_KEY';`.
