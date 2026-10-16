# GHL DOM Reference Snapshots

Sanitized HTML snapshots of the GoHighLevel CRM screens our scripts modify. They give AI agents and contributors **real GHL markup** to work from, so nobody has to guess at selectors.

> **Snapshots go stale.** GHL ships UI changes often and without notice. Check each file's `Captured:` date. If a selector in a snapshot doesn't match what you see in the browser, the browser wins: re-capture and commit the new snapshot.

## Files

| File | Screen | Used by |
| --- | --- | --- |
| [`dom-contact-detail.html`](./dom-contact-detail.html) | Contact detail page, left panel (`/v2/location/{id}/contacts/detail/{id}`) | [`gmaps-address-autocomplete-crm`](../gmaps-address-autocomplete-crm/) |
| [`dom-appointment-modal.html`](./dom-appointment-modal.html) | Book / Edit Appointment modal with **Meeting location: Custom** (a single address line: no City, State, Country, or Time zone fields) | [`gmaps-address-autocomplete-crm`](../gmaps-address-autocomplete-crm/) |
| [`dom-company-panel.html`](./dom-company-panel.html) | Company / Business details side panel (`/businesses`, `/companies`, `/objects`) | [`gmaps-address-autocomplete-crm`](../gmaps-address-autocomplete-crm/) |
| [`select-options-country-timezone.json`](./select-options-country-timezone.json) | Every Country and Time zone option, exactly as GHL labels them | [`gmaps-address-autocomplete-crm`](../gmaps-address-autocomplete-crm/) (country names, available time zones) |
| [`dom-capture.js`](./dom-capture.js) | Console tool that creates the `dom-*.html` snapshots | (developer tool, not deployed) |
| [`dom-capture-select-options.js`](./dom-capture-select-options.js) | Console tool that creates `select-options-country-timezone.json` | (developer tool, not deployed) |

The top of each snapshot holds a comment with the capture date and a **selector health check**: every selector `script.js` depends on, marked `✓` (found) or `✗ MISSING`.

## How to Capture or Update a Snapshot

Use the **desktop web app** in Chrome, Edge, or Firefox. Use a **test contact / company** with fake data when possible.

1. **Open the screen:**
   - **Contact:** open any contact so the detail page loads. Scroll the left panel so the **Time zone** field has rendered.
   - **Appointment:** open **Book Appointment** (from Calendars, a Contact, Conversations, or Opportunities). Set **Meeting location** to **Custom** so the "Enter meeting location" input appears.
   - **Company:** go to **Contacts → Companies** and click a company to open the side panel.
2. *(Optional, Contact only)* Open the **Time zone** dropdown so its option list is visible. The capture also saves the open menu, which documents GHL's option label format (e.g. `GMT-05:00 America/Chicago (CDT)`).
3. Open DevTools (`Cmd + Option + J` / `Ctrl + Shift + J`). Paste the full contents of [`dom-capture.js`](./dom-capture.js) into the **Console** and press Enter.
4. The browser downloads `dom-contact-detail.html`, `dom-appointment-modal.html`, or `dom-company-panel.html`. The console also prints the selector health check.
5. Move the file into this folder, replacing the old one.
6. **Review before committing** (see below), then commit, e.g. `docs(reference): refresh contact-detail snapshot`.

> **Note:** If an appointment modal is open, it's captured instead of the page underneath. Close it first to capture the Contact page. To force a screen, run `window.tkCaptureScreen = 'contact'` (or `'appointment'` / `'company'`) before pasting the script.

## How to Export Dropdown Options

`script.js` matches GHL's option labels (e.g. `Czech Republic`, `GMT-04:00 America/Detroit (EDT)`), so it needs to know exactly which options exist.

1. Open a **Contact** detail page. *(Optional: also open a Company side panel to include its Country dropdown.)*
2. Paste the full contents of [`dom-capture-select-options.js`](./dom-capture-select-options.js) into the DevTools **Console** and press Enter. Don't click while it runs: it opens each dropdown, scrolls through every option, and closes it without changing the value.
3. The browser downloads `select-options-country-timezone.json`. The console lists how many options each dropdown had.
4. Move it into this folder and commit, e.g. `docs(reference): refresh select options`.

Time zone labels include the current offset and abbreviation (`GMT-04:00 … (EDT)`), so they change with daylight saving time. Compare by IANA ID (`America/Detroit`), not by full label.

## What Gets Anonymized

`dom-capture.js` uses allowlists: anything it doesn't recognize as GHL UI is removed or replaced.

- **Attributes:** only structural ones are kept (`class`, `id`, `name`, `type`, `role`, `for`, `aria-*` states, `data-testid`, etc.). Inline styles, Vue props, `data-*` values, image sources, and SVG paths are dropped.
- **Record data:** input `value`, `title`, and `aria-label` become `[redacted]`. Displayed field values (inputs, selects, tags, avatars, record names) become `[value]`. Time zone labels are kept because they document GHL's format.
- **Agency-defined names:** Contact custom fields become `contact.custom_field_N` / "Custom field N" (placeholders `[custom]`), and custom folders become "Custom folder N". Built-in fields and folders keep their names. Latitude/Longitude keep theirs because `script.js` finds them by label.
- **Other text:** labels, buttons, headings, and placeholders are kept. Everything else becomes `[text]`. Open dropdown menus keep time zone options only; other options become `[option]`.
- **Anywhere:** emails, US phone numbers, generated IDs (`[id]`), and links (`[url]`)
- **Our own elements** (`.tk-gmaps-container`, `.tk-pac-container`) are removed, so the snapshot shows GHL's markup only.

### Review Checklist (Required)

Automated redaction isn't perfect. Before committing, search the new file for:

- [ ] Real names, company names, street addresses, or notes
- [ ] Emails, phone numbers, or anything else that looks like customer data
- [ ] Agency or white-label domain names you don't want public
- [ ] API keys or tokens (there shouldn't be any)

This repo is public. **Never commit a snapshot containing client data.**

## When the Health Check Shows `✗ MISSING`

1. GHL likely renamed or restructured something. Compare the new snapshot with the previous one: `git diff ghl-dom-reference/<file>.html`.
2. Update the selectors in [`gmaps-address-autocomplete-crm/script.js`](../gmaps-address-autocomplete-crm/script.js).
3. Update the matching `expect` list in [`dom-capture.js`](./dom-capture.js) so the health check stays accurate.
4. If the change affects documented DOM patterns, also update the **GHL DOM & SPA Technical Reference** in [`AGENTS.md`](../AGENTS.md).

## Notes for AI Agents

- Read the relevant snapshot **before** writing or changing selectors for that screen.
- Snapshots are evidence, not guarantees. When behavior doesn't match a snapshot, ask the user to re-run `dom-capture.js` (or a targeted console diagnostic) instead of guessing.
- Naive UI dropdown menus are *teleported* to `<body>`, outside the field's container. That's why open menus are captured as a separate section at the end of a snapshot.
