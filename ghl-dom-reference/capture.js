/**
 * GHL DOM Snapshot Capture (developer tool, not deployed)
 *
 * Paste into the browser DevTools Console on a GHL screen. It detects which screen you're on
 * (Contact detail, Book/Edit Appointment modal, or Company side panel), sanitizes the relevant
 * DOM, checks the selectors our scripts depend on, and downloads an .html snapshot to commit
 * into ghl-dom-reference/. See ghl-dom-reference/README.md.
 *
 * @see https://github.com/cliffordp/ghl-customizations
 * @author Clifford Paulick
 * @license AGPL-3.0
 */
(() => {
	'use strict';

	// Screens, in priority order (an appointment modal can be open on top of a Contact page).
	// `expect` = selectors gmaps-address-autocomplete-crm/script.js relies on. Keep in sync with script.js.
	const path = window.location.pathname;
	const SCREENS = [
		{
			file: 'appointment-modal.html',
			name: 'Book / Edit Appointment modal (Meeting location: Custom)',
			when: true,
			root: '.bookAppointmentFormContainer',
			expect: [
				'.bookAppointmentFormContainer',
				'#meeting-location-dropdown',
				'#location-default, #location-custom',
				'#meeting-location-text-input input'
			]
		},
		{
			file: 'company-panel.html',
			name: 'Company / Business details side panel',
			when: /\/(businesses|companies|objects)/.test(path),
			root: '.details-wrapper, .details-view, #fields-form',
			expect: [
				'.details-view',
				'.details-view .primary-property-name',
				'.fields .hr-form-item-label__text, .details-view .hr-form-item-label__text',
				'.hl-text-input-container'
			]
		},
		{
			file: 'contact-detail.html',
			name: 'Contact detail (left panel)',
			when: path.includes('/contacts/detail/'),
			root: '#record-details-lhs, #field-container',
			expect: [
				'#record-details-lhs',
				'#field-container',
				'#field-container .hr-form-item-label__text',
				'#field-container input.hr-input__input-el',
				'#contact\\.country .hr-base-selection',
				'#contact\\.timezone .hr-base-selection',
				'#contact\\.timezone .hr-base-selection-label[title]'
			]
		}
	];

	// Shared HighRise/Naive UI select internals used by selectHighRiseOption()
	const SELECT_EXPECT = ['.hr-base-selection', '.hr-base-selection-label'];
	const MENU_SELECTOR = '.hr-base-select-menu, .n-base-select-menu';

	const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
	// Text inside these is UI copy (labels, buttons, options), not record data, so it's kept
	const KEEP_TEXT = 'label, button, th, option, [class*="label"], [class*="title"], [class*="header"], [class*="placeholder"], [class*="select-option"], [role="tab"], [role="option"]';
	const DROP_ATTRS = /^(style|data-v-[\w-]+|data-sentry-[\w-]+|nonce)$/;
	const REDACT_ATTRS = new Set(['value', 'title', 'alt', 'src', 'aria-label', 'data-value']);

	const redactString = (text) => text
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
		.replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
		.replace(/\b[A-Za-z0-9]{20,}\b/g, '[id]');

	// Time zone and country labels are reference data we want to keep verbatim
	const isSafeValue = (text) => /^(GMT|UTC)[+-]\d/.test(text) || /^[A-Z][a-z]+(\/[A-Za-z_]+)+$/.test(text);

	/** Serialize a node as indented HTML, sanitizing as we go */
	function serialize(node, depth, keepText) {
		const pad = '\t'.repeat(depth);
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent.replace(/\s+/g, ' ').trim();
			if (!text) return '';
			return pad + (keepText || isSafeValue(text) ? redactString(text) : '[text]') + '\n';
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return '';

		const el = node;
		const tag = el.tagName.toLowerCase();
		if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
		if (el.classList.contains('tk-gmaps-container') || el.classList.contains('tk-pac-container')) {
			return `${pad}<!-- our injected ${el.className} removed -->\n`;
		}

		const attrs = [...el.attributes]
			.filter(attr => !DROP_ATTRS.test(attr.name))
			.map(attr => {
				let value = attr.value;
				if (REDACT_ATTRS.has(attr.name) && value && !isSafeValue(value)) {
					value = '[redacted]';
				}
				value = redactString(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
				return value === '' ? ` ${attr.name}` : ` ${attr.name}="${value}"`;
			})
			.join('');

		if (tag === 'svg') return `${pad}<svg${attrs}>…</svg>\n`;
		if (tag === 'iframe') return `${pad}<iframe${attrs}></iframe>\n`;
		if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs}>\n`;

		const childKeep = keepText || el.matches(KEEP_TEXT);
		const children = [...el.childNodes].map(child => serialize(child, depth + 1, childKeep)).join('');
		return children
			? `${pad}<${tag}${attrs}>\n${children}${pad}</${tag}>\n`
			: `${pad}<${tag}${attrs}></${tag}>\n`;
	}

	const screen = SCREENS.find(s => s.when && document.querySelector(s.root));
	if (!screen) {
		console.warn('[ghl-dom-reference] Not on a supported screen. Open a Contact, a Company side panel, or the Book Appointment modal (Meeting location: Custom).');
		return;
	}

	const root = document.querySelector(screen.root);
	const checks = [...screen.expect, ...SELECT_EXPECT].map(selector => {
		const found = !!document.querySelector(selector);
		return `${found ? '✓' : '✗ MISSING'}  ${selector}`;
	});

	let html = serialize(root, 0, false);
	const menu = document.querySelector(MENU_SELECTOR);
	if (menu) {
		html += '\n<!-- Open dropdown menu (teleported to <body> by Naive UI) -->\n' + serialize(menu, 0, true);
	}

	const header = [
		'<!--',
		`\tGHL DOM snapshot: ${screen.name}`,
		`\tCaptured: ${new Date().toISOString().slice(0, 10)}`,
		`\tRoot: ${screen.root}`,
		'\tSanitized by ghl-dom-reference/capture.js (inline styles, Vue data-v-* attributes, record text, IDs, emails, phones removed).',
		'\tReview for personal data before committing.',
		'',
		'\tSelectors used by gmaps-address-autocomplete-crm/script.js:',
		...checks.map(line => `\t\t${line}`),
		'-->',
		''
	].join('\n');

	const blob = new Blob([header + html], { type: 'text/html' });
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = screen.file;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);

	console.log(`[ghl-dom-reference] Downloaded ${screen.file} (${Math.round(blob.size / 1024)} KB)\n${checks.join('\n')}`);
})();
