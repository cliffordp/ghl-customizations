# GoHighLevel (GHL) Customizations & Snippets

A curated collection of battle-tested custom JavaScript, CSS, and HTML enhancements for **GoHighLevel (GHL)**—built by [Clifford Paulick](https://tourkick.com/).

## Why This Repo Exists & Who It's For

GoHighLevel is powerful out of the box, but day-to-day agency use often reveals UI/UX gaps—like missing address autocomplete and map previews across CRM screens, or small workflow friction points—and GHL's frequent UI updates (such as the move to HighRise `hr-*` components) regularly break older snippets floating around in forum posts and Gists.

I created this repository for **GHL agency owners, SaaSpreneurs, and GHL admins** so we have a single, version-controlled place to:
- Load up-to-date scripts directly via CDN (so fixes apply across your agency without hunting down old snippets)
- Track and adapt quickly when GoHighLevel updates its DOM/UI
- Collaborate via **Issues** and **Pull Requests**

## Included Customizations

| Folder | Scope | Description |
| :--- | :--- | :--- |
| **[`gmaps-address-autocomplete-crm`](./gmaps-address-autocomplete-crm/)** | Agency White-Label Custom JS (Desktop Web App) | Adds Google Maps Places Address Autocomplete and an embedded Google Map to **Contact Details**, **Company Details**, and the **Book/Edit Appointment Modal** (Custom meeting location). |
| **[`gmaps-address-autocomplete-forms`](./gmaps-address-autocomplete-forms/)** | GHL Forms & Surveys (Custom HTML Field) | Adds Google Maps Places Address Autocomplete to public-facing GHL Forms & Surveys, populating street, city, state, postal code, latitude, and longitude. |

## Desktop vs. Mobile App & Background Workflow Backstop

GoHighLevel only runs Agency **Custom JS** inside the **desktop/computer web browser** (`app.gohighlevel.com` or your white-labeled web domain)—it does **not** run inside the GHL / LeadConnector mobile app, nor can browser autocomplete force a user to click a dropdown suggestion if they just type and hit save.

### Recommended Backstop: [GAddress Marketplace App](https://gaddressapp.ablepro.page/)
To guarantee clean, standardized addresses and coordinates 100% of the time—including when team members use the **mobile app**, skip the autocomplete dropdown, or import contacts—install **[GAddress](https://gaddressapp.ablepro.page/)** from the GHL Marketplace. It runs automatically in the background via GHL Workflows.

## Related Resources & Links

- **[GAddress GHL Marketplace App](https://gaddressapp.ablepro.page/)** — Background address validation, standardization, and geocoding via GHL Workflows (the essential backstop when users don't select from autocomplete or use the mobile app).
- **[AblePro](https://www.ableproapp.com/)** — My GoHighLevel Agency platform.
- **[LeadGen Learning](http://leadgenlearning.com/)** — My community and training resource for other GHL agencies.
- **[TourKick](https://tourkick.com/)** — My agency & the best place to get in touch with me.

## Troubleshooting & Contributing

### Clearing jsDelivr CDN Cache
If you load scripts via jsDelivr using `@main`, updates are cached at the CDN edge for up to 12 hours. You can clear the cache immediately whenever needed:
- **Instant Purge Link:** Replace `cdn.jsdelivr.net` with `purge.jsdelivr.net` in the URL (for example: [Purge CRM Script](https://purge.jsdelivr.net/gh/cliffordp/ghl-customizations@main/gmaps-address-autocomplete-crm/script.js)).
- **Web UI Tool:** Paste any file URL into the official [jsDelivr Purge Tool](https://www.jsdelivr.com/tools/purge).
- **Browser Cache:** After purging the CDN, remember to perform a hard refresh in your browser (`Cmd + Shift + R` or `Ctrl + Shift + R`).

### Reporting Issues & Submitting PRs
GoHighLevel updates its UI frequently. If a GHL update breaks a selector or you have an improvement:
1. **Open an Issue:** Check existing [Issues](https://github.com/cliffordp/ghl-customizations/issues) or open a new one. Please provide:
   - The GHL screen URL pattern (e.g., `/v2/location/.../contacts/detail/...`)
   - The relevant element's outer HTML or DevTools inspection details
   - Any console errors
2. **Submit a Pull Request:** PRs are welcome! Fork the repo, keep changes focused, and submit a [Pull Request](https://github.com/cliffordp/ghl-customizations/pulls).
3. **Contact:** Feel free to reach out via [TourKick](https://tourkick.com/) or connect through [LeadGen Learning](http://leadgenlearning.com/).

## License

Licensed under the **[GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)**.

**Why AGPLv3?** This license was chosen intentionally so that **any GoHighLevel agency or business owner can freely use these customizations** in their own agency and client sub-accounts, while preventing commercial GHL toolkit/add-on vendors from absorbing community-contributed code into closed-source, paid SaaS products.

- **Allowed:** Using these scripts in your own GoHighLevel agency (and client sub-accounts), forking, submitting PRs, and sharing in free/open-source community resources with attribution.
- **Not Allowed:** Rolling, bundling, or serving these scripts inside closed-source commercial GHL toolkits, extensions, or paid SaaS add-ons without releasing the entire toolkit's source code under AGPLv3.
