# Google Maps Address Autocomplete for GoHighLevel Forms & Surveys

Adds **Google Maps Places Address Autocomplete** to public-facing GoHighLevel Forms and Surveys via a Custom HTML field, automatically populating `address`, `city`, `state`, `postal_code`, and optional custom `latitude` / `longitude` fields.

## How It Works

- Attaches Google Places Autocomplete to `#form-builder input[data-q="address"]`.
- When a visitor selects an address, it populates:
  - `address` (`input[data-q="address"]`)
  - `city` (`input[data-q="city"]`)
  - `state` (`input[data-q="state"]` — 2-letter short code)
  - `postal_code` (`input[data-q="postal_code"]`)
  - `latitude` (`input[data-q="latitude"]`)
  - `longitude` (`input[data-q="longitude"]`)
- Automatically hides the `state`, `latitude`, and `longitude` field containers if you want them populated silently in the background (customize `fieldsToHide` in [`forms-gmaps-address-autocomplete.html`](./forms-gmaps-address-autocomplete.html) as needed).

## Prerequisites (Google Cloud Console)

1. Create a Google Maps API key in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Maps JavaScript API** and **Places API (New)** on your project.
3. Restrict the key by **HTTP referrers** to the domains your forms are served on, and restrict it to those two APIs.

> **Upgrading from an older version?** This snippet previously used the legacy **Places API**, which Google no longer offers to new projects. Enable **Places API (New)** on your key or suggestions won't load.

## Installation

1. Create a Custom Value in your GHL sub-account named `Google Maps API Key` (`{{custom_values.google_maps_api_key}}`), or replace `{{custom_values.google_maps_api_key}}` directly with your HTTP-referrer-restricted Google Maps API key.
2. In your GHL Form or Survey, add the standard address fields (`Address`, `City`, `State`, `Postal Code`) and optional custom fields (`latitude`, `longitude`).
3. Drag a **Custom HTML** element onto the form and paste the contents of [`forms-gmaps-address-autocomplete.html`](./forms-gmaps-address-autocomplete.html).

## Recommended Workflow Backstop

Visitors don't always click an autocomplete suggestion when filling out a form. Pair this with the **[GAddress GHL Marketplace App](https://gaddressapp.ablepro.page/)** to validate, standardize, and geocode addresses automatically in the background via GHL Workflows.

## Troubleshooting

- **Changes not showing up if fetching via CDN?** If you load or fetch this snippet from jsDelivr (`https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-forms/forms-gmaps-address-autocomplete.html`), visit the [jsDelivr Purge Link](https://purge.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-forms/forms-gmaps-address-autocomplete.html) or use the [jsDelivr Purge Tool](https://www.jsdelivr.com/tools/purge).
- **Need help, found a bug, or want to contribute?** See the [main repository README](../README.md#troubleshooting--contributing) for issue reporting, PR guidelines, and contact links.
