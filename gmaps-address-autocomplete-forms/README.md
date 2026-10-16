# Google Maps Address Autocomplete for GoHighLevel Forms & Surveys

Adds **Google Maps Places Address Autocomplete** to public-facing GoHighLevel Forms and Surveys via a Custom HTML field, automatically populating `address`, `city`, `state`, `postal_code`, and optional custom `latitude` / `longitude` fields.

---

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

---

## Installation

1. Create a Custom Value in your GHL sub-account named `Google Maps API Key` (`{{custom_values.google_maps_api_key}}`), or replace `{{custom_values.google_maps_api_key}}` directly with your HTTP-referrer-restricted Google Maps API key.
2. In your GHL Form or Survey, add the standard address fields (`Address`, `City`, `State`, `Postal Code`) and optional custom fields (`latitude`, `longitude`).
3. Drag a **Custom HTML** element onto the form and paste the contents of [`forms-gmaps-address-autocomplete.html`](./forms-gmaps-address-autocomplete.html).

---

## Recommended Workflow Backstop

Visitors don't always click an autocomplete suggestion when filling out a form. Pair this with the **[GAddress GHL Marketplace App](https://gaddressapp.ablepro.page/)** to validate, standardize, and geocode addresses automatically in the background via GHL Workflows.
