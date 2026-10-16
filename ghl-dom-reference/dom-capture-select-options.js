/**
 * GHL Select Options Export (developer tool, not deployed)
 *
 * Paste into the browser DevTools Console on a GHL Contact detail page (optionally with a
 * Company side panel open). It opens each supported dropdown, scrolls through its virtualized
 * list to collect every option, closes it without changing the value, and downloads
 * select-options-country-timezone.json to commit into ghl-dom-reference/.
 * See ghl-dom-reference/README.md.
 *
 * Options are GHL's own lists (countries, time zones), never record data.
 *
 * @see https://github.com/cliffordp/ghl-customizations
 * @author Clifford Paulick
 * @license AGPL-3.0
 */
(async () => {
	'use strict';

	const SELECTION = '.hr-base-selection, .n-base-selection';
	const MENU = '.hr-base-select-menu, .n-base-select-menu';
	const OPTION = '.hr-base-select-option, .n-base-select-option';
	const SCROLLER = '.v-vl, .hr-virtual-list, .n-virtual-list, .hr-scrollbar-container, .n-scrollbar-container';

	const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
	const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
	const isVisible = (el) => el.getClientRects().length > 0;

	/** A select inside `scope` whose form label matches `labelText` (Company fields have random ids) */
	function selectByLabel(labelText, scope) {
		const label = [...document.querySelectorAll(`${scope} .hr-form-item-label__text, ${scope} .n-form-item-label__text`)]
			.find(el => clean(el.textContent).toLowerCase() === labelText.toLowerCase());
		return label?.closest('.hr-form-item, .n-form-item')?.querySelector(SELECTION) || null;
	}

	// Dropdowns gmaps-address-autocomplete-crm/script.js sets. Missing ones (screen not open) are skipped.
	const SELECTS = [
		{ key: 'contactCountry', name: 'Contact detail: Country', find: () => document.querySelector('#contact\\.country')?.querySelector(SELECTION) },
		{ key: 'contactTimeZone', name: 'Contact detail: Time zone', find: () => document.querySelector('#contact\\.timezone')?.querySelector(SELECTION) },
		{ key: 'companyCountry', name: 'Company side panel: Country', find: () => selectByLabel('Country', '.details-view') }
	];

	/** Save scroll positions of the select's scrollable ancestors (opening a menu can scroll the panel) */
	function saveScrollPositions(element) {
		const saved = [];
		for (let el = element.parentElement; el; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight) saved.push([el, el.scrollTop]);
		}
		return () => saved.forEach(([el, top]) => { el.scrollTop = top; });
	}

	/** Open a select, scroll its whole (virtualized) list, and return every option label in order */
	async function collectOptions(selection) {
		const restoreScroll = saveScrollPositions(selection);
		const menusBefore = new Set(document.querySelectorAll(MENU));
		const trigger = selection.querySelector('.hr-base-selection-label, .n-base-selection-label') || selection;
		trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		trigger.click();
		await wait(400);

		const menus = [...document.querySelectorAll(MENU)].filter(isVisible);
		const menu = menus.find(m => !menusBefore.has(m)) || menus[menus.length - 1];
		if (!menu) {
			restoreScroll();
			return null;
		}

		// A Map keeps first-seen order, which matches the list order as we scroll down
		const seen = new Map();
		const collect = () => menu.querySelectorAll(OPTION).forEach(option => {
			const text = clean(option.textContent);
			if (text) seen.set(text, true);
		});

		const scroller = menu.querySelector(SCROLLER);
		if (scroller) {
			scroller.scrollTop = 0;
			scroller.dispatchEvent(new Event('scroll'));
			await wait(100);
			collect();
			const step = Math.max(scroller.clientHeight * 0.7, 50);
			for (let guard = 0; guard < 5000; guard++) {
				const before = scroller.scrollTop;
				scroller.scrollTop = before + step;
				scroller.dispatchEvent(new Event('scroll'));
				await wait(60);
				collect();
				if (scroller.scrollTop === before) break; // Reached the bottom
			}
		} else {
			collect();
		}

		// Close without selecting anything
		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await wait(350);
		restoreScroll();
		return [...seen.keys()];
	}

	const result = {
		captured: new Date().toISOString().slice(0, 10),
		source: 'ghl-dom-reference/dom-capture-select-options.js',
		note: "Option labels exactly as GHL renders them. GHL's own lists, not record data.",
		selects: {}
	};
	const summary = [];

	for (const select of SELECTS) {
		const selection = select.find();
		if (!selection) {
			summary.push(`–  ${select.name}: not on screen (skipped)`);
			continue;
		}
		const options = await collectOptions(selection);
		if (!options) {
			summary.push(`✗  ${select.name}: menu didn't open`);
			continue;
		}
		result.selects[select.key] = { name: select.name, count: options.length, options };
		summary.push(`✓  ${select.name}: ${options.length} options`);
	}

	if (!Object.keys(result.selects).length) {
		console.warn(`[ghl-dom-reference] No supported dropdowns found. Open a Contact detail page.\n${summary.join('\n')}`);
		return;
	}

	const FILE_NAME = 'select-options-country-timezone.json';
	const blob = new Blob([JSON.stringify(result, null, '\t') + '\n'], { type: 'application/json' });
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = FILE_NAME;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);

	console.log(`[ghl-dom-reference] Downloaded ${FILE_NAME}\n${summary.join('\n')}`);
})();
