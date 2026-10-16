# AGENTS.md — GoHighLevel (GHL) Customizations

Instructions and technical context for AI coding agents working in this repository.

## Project Overview

- **Repository:** `https://github.com/cliffordp/ghl-customizations`
- **License:** GNU Affero General Public License v3.0 (`AGPL-3.0`)
  - **Why AGPL-3.0:** Chosen intentionally so any GoHighLevel agency or business can freely use, modify, and deploy these customizations in their own agency and client sub-accounts (or share in free/open-source community resources), while preventing third-party commercial GHL script-library/toolkit vendors from rolling these scripts into closed-source, paid SaaS products without open-sourcing their entire platform under AGPL-3.0. All standalone `.js` files must preserve `@license AGPL-3.0` in their JSDoc header.
- **Purpose:** A collection of custom JavaScript, CSS, and HTML snippets for GoHighLevel (GHL) agencies—covering both the GHL CRM web interface (Agency Custom JS/CSS) and GHL Funnels/Forms/Surveys.
- **Zero-Build Policy:** All scripts in this repository must be plain, browser-ready vanilla JavaScript (ES6+) or HTML/CSS so they can be served directly via jsDelivr (`https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/...`) or copy-pasted into GHL without a build step.

---

## Repository Structure & Conventions

1. **One Folder Per Customization:**
   - Use descriptive kebab-case folder names (e.g., `gmaps-address-autocomplete-crm/`, `gmaps-address-autocomplete-forms/`).
   - Keep each folder self-contained.

2. **Required Files Per Folder:**
   - `README.md`: Must clearly document:
     - What the customization does and **where it works** (e.g., Contact Detail, Company Detail, Appointment Modal, Forms/Surveys).
     - **Platform limitations:** Specifically note when a customization relies on Agency Custom JS/CSS and therefore **only works on the desktop/computer web browser version of GHL** (not the LeadConnector / white-labeled mobile app).
     - Step-by-step installation instructions with ready-to-copy snippets.
   - `script.js` (when served externally via jsDelivr):
     - Keep the filename as `script.js` inside its named folder.
     - Include a JSDoc frontmatter header at the top of `script.js` with `@name`, `@description`, `@see`, `@author`, and `@license AGPL-3.0`.
     - HTML snippet files (`*.html`) do **not** use JSDoc frontmatter headers.
   - Loader / Embed Snippets:
     - Point external `<script>` embeds to `https://cdn.jsdelivr.net/gh/cliffordp/ghl-customizations@main/<folder-name>/script.js`.

3. **Security & Placeholders:**
   - **NEVER** commit real API keys, GHL Location IDs, Private Integration Tokens, webhook URLs, or client data.
   - Always use obvious placeholders such as `YOUR_GOOGLE_MAPS_API_KEY`.

4. **Code Style:**
   - Wrap all standalone JS files in an IIFE (`(() => { 'use strict'; ... })();`) to avoid polluting `window` or colliding with GHL globals.
   - Use **tabs** for indentation.
   - Prefer clean, dependency-free vanilla JS.

---

## GoHighLevel (GHL) DOM & SPA Technical Reference

GHL's desktop web application is a **Vue 3 + Naive UI + Tailwind CSS Single Page Application (SPA)**. Keep these architectural realities in mind whenever writing or debugging CRM scripts:

> **Real markup:** Sanitized DOM snapshots of the Contact detail page, Appointment modal, and Company side panel live in [`ghl-dom-reference/`](./ghl-dom-reference/). Read the relevant snapshot before writing selectors, and check its `Captured:` date. If GHL has changed since, ask the user to re-run [`ghl-dom-reference/dom-capture.js`](./ghl-dom-reference/dom-capture.js). GHL's exact Country and Time zone dropdown options are in [`select-options-country-timezone.json`](./ghl-dom-reference/select-options-country-timezone.json): only select values that exist there. After changing `gmaps-address-autocomplete-crm/script.js`, run its tests: `node gmaps-address-autocomplete-crm/tests/script.test.js` (or `osascript -l JavaScript …` on macOS without Node).

### 1. SPA Lifecycle & Navigation
- Agency Custom JS loads once when the browser tab initializes and persists across client-side route changes.
- Never rely solely on `DOMContentLoaded` or `window.onload`.
- Use a debounced `MutationObserver` on `document.body` (with `childList: true, subtree: true`) to detect newly mounted views, drawers, and modals.
- Mark processed DOM elements with a `data-*` attribute (e.g., `data-autocomplete-initialized="true"`) to guarantee idempotency and prevent duplicate event listeners.

### 2. Vue 3 Input Reactivity
- Setting `inputElement.value = 'new value'` directly **will not update GHL's underlying Vue state**, causing GHL to revert the field or fail to enable the "Save" button.
- Always use the native `HTMLInputElement.prototype.value` setter and dispatch bubbling `input` and `change` events:
  ```javascript
  function setNativeInputValue( input, value ) {
  	const nativeSetter = Object.getOwnPropertyDescriptor(
  		window.HTMLInputElement.prototype,
  		'value'
  	)?.set;
  	if ( nativeSetter ) {
  		nativeSetter.call( input, value );
  	} else {
  		input.value = value;
  	}
  	input.dispatchEvent( new Event( 'input', { bubbles: true } ) );
  	input.dispatchEvent( new Event( 'change', { bubbles: true } ) );
  }
  ```

### 3. Three Distinct DOM Patterns in GHL CRM
GHL uses different component libraries across different screens in the same app:
1. **Contact Detail View (`/v2/location/.../contacts/detail/...`):**
   - Standard inputs use `name="contact.<field>"` (e.g., `input[name="contact.address1"]`, `input[name="contact.city"]`, `input[name="contact.postal_code"]`) inside `.hr-input__input-el` wrappers.
   - Select dropdowns (such as Country and State) are custom Naive UI / HighRise components (`.hr-base-selection-input__content` / `div[tabindex="0"]`), **not** native `<select>` elements.
2. **Company Side Panel (opened from a Contact's Company, or `/objects/`):**
   - Each field has its own `.fields` wrapper containing an `.hr-form-item-label__text` label and an already-mounted `input.hr-input__input-el`.
   - Inputs have no stable `id` or `name`, so find fields **by label text**, scoped to that field's own `.fields` wrapper.
   - Country is a HighRise select found by its label, like on the Contact page.
3. **Book/Edit Appointment Modal:**
   - Has a **single** address line only: `.bookAppointmentFormContainer #meeting-location-text-input input`. No City/State/Zip/Country/Time zone fields to fill.
   - The input mounts only when the Meeting location dropdown (`#meeting-location-dropdown`, Naive UI `n-` components) is set to Custom, so observe that dropdown for changes.
   - Modals render inside high-z-index overlays (`.hr-modal-container`, `.n-modal-mask`) with focus/click traps. Any floating dropdowns appended to `document.body` (such as the Places autocomplete `.tk-pac-container`) require:
     - `z-index: 2147483647 !important;`
     - `pointer-events: auto !important;`
     - `mousedown` `stopPropagation()` so the modal's outside-click handler does not swallow selection clicks.

### 4. Focus & Scroll Jumps
- The Contact detail left panel scrolls inside `#record-details-lhs`, not the window.
- Calling `input.focus()` makes the browser scroll that input into view. When a script fills several fields in sequence, the panel jumps to the **last** field focused (e.g. a Longitude custom field near the bottom). Always use `focus({ preventScroll: true })`.
- Opening a Naive UI select can scroll its container. Save the scroll positions of the select's scrollable ancestors and restore them after selecting (see `saveScrollPositions()` in `gmaps-address-autocomplete-crm/script.js`).
- Don't patch `HTMLElement.prototype` / `Element.prototype` methods or restore scroll on timers as a guess.

### 5. Debug With Evidence, Not Guesses
When GHL behaves unexpectedly, give the user a short DevTools Console diagnostic that logs what actually happens: the target element's `outerHTML`, scroll events with the element that scrolled, and wrapped `focus` / `scrollIntoView` calls with stack traces. Fix the cause it reveals.

If a user reports that a fix "didn't change anything", first confirm they're running the new code. Stack trace line numbers reveal stale browser or jsDelivr caches. For testing, pin the embed to a commit (`@<sha>` instead of `@main`).
