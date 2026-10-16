/**
 * GHL DOM Snapshot Capture (developer tool, not deployed)
 *
 * Paste into the browser DevTools Console on a GHL screen. It detects which screen you're on
 * (Contact detail, Book/Edit Appointment modal, or Company side panel), anonymizes the relevant
 * DOM, checks the selectors our scripts depend on, and downloads an .html snapshot to commit
 * into ghl-dom-reference/. See ghl-dom-reference/README.md.
 *
 * Optional: set window.tkCaptureScreen = 'contact' | 'appointment' | 'company' before pasting
 * to force a screen (skips URL detection).
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
			key: 'appointment',
			file: 'dom-appointment-modal.html',
			name: 'Book / Edit Appointment modal (Meeting location: Custom)',
			when: true,
			root: '.bookAppointmentFormContainer',
			expect: [
				'.bookAppointmentFormContainer',
				'#location-default, #location-custom',
				'#meeting-location-dropdown',
				'#meeting-location-text-input input'
			]
		},
		{
			key: 'company',
			file: 'dom-company-panel.html',
			name: 'Company / Business details side panel',
			when: /\/(businesses|companies|objects)/.test(path),
			root: '.details-wrapper, .details-view, #fields-form',
			expect: [
				'.details-view',
				'.details-view .primary-property-name',
				'.fields .hr-form-item-label__text, .details-view .hr-form-item-label__text',
				'.fields input.hr-input__input-el'
			]
		},
		{
			key: 'contact',
			file: 'dom-contact-detail.html',
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
	const MENU_SELECTOR = '.hr-base-select-menu, .n-base-select-menu';

	// ---- Anonymization rules -------------------------------------------------------------

	// Attributes that describe structure. Everything else (custom Vue props, data-image-src, etc.) is dropped.
	const KEEP_ATTRS = new Set([
		'class', 'id', 'name', 'type', 'role', 'tabindex', 'for', 'placeholder', 'title', 'value', 'href',
		'aria-hidden', 'aria-checked', 'aria-disabled', 'aria-expanded', 'aria-selected', 'aria-label', 'aria-labelledby',
		'data-testid', 'data-pendo-id', 'disabled', 'readonly', 'checked', 'size', 'rows', 'maxlength', 'autocomplete', 'accept'
	]);

	// GHL's built-in Contact fields (id "contact.<key>" / data-pendo-id "contact-details-field-<key>"). Any other key is
	// an agency custom field. latitude/longitude are custom fields, but script.js looks them up by label, so they're kept.
	const STANDARD_CONTACT_KEYS = /^(first_name|last_name|name|full_name|email|phone|company_name|address1|city|state|postal_code|country|timezone|website|date_of_birth|source|type|dnd|tags|assigned_to|latitude|longitude|(email|phone)-[\w-]*)$/;
	// Company fields have random ids, so built-in ones are recognized by label
	const STANDARD_COMPANY_LABELS = new Set(['Company Name', 'Domain name', 'Phone', 'Email', 'Website', 'Address', 'City', 'State', 'Postal Code', 'Country', 'Description']);
	const STANDARD_FOLDERS = new Set(['Contact', 'General Info', 'Additional Info', 'Company Info', 'All fields']);

	// Elements whose text is a record's data: always redacted (checked before KEEP_TEXT)
	const VALUE_TEXT = [
		'.hr-input__text-content', '.hr-input__inline-text', 'textarea', '[contenteditable="true"]',
		'[class*="base-selection-overlay"]', '[class*="base-selection-input__content"]', '[class*="base-selection-tags"]',
		'.hr-tag', '.n-tag', '[class*="tag-chip"]', '.hr-avatar', '.n-avatar', '.primary-property-name', '.record-name'
	].join(', ');
	// Elements whose text is GHL UI copy: kept
	const KEEP_TEXT = [
		'label', 'button', 'th', 'option', '[role="tab"]', '[role="option"]', '[role="menuitem"]',
		'[class*="label__text"]', '[class*="__label"]', '[class*="__header"]', '.folder-name', '[class*="select-option"]',
		'.hr-input__placeholder', '.n-input__placeholder'
	].join(', ');
	const FORM_ITEM = '.hr-form-item, .n-form-item';
	const PENDO_FIELD_PREFIX = 'contact-details-field-';
	const FIELD_SCOPE = `[data-pendo-id^="${PENDO_FIELD_PREFIX}"], ${FORM_ITEM}`;
	const FORM_LABEL_TEXT = '.hr-form-item-label__text, .n-form-item-label__text';
	const FOLDER_HEADER = '.hr-collapse-item__header-main, .folder-name';

	// Time zone labels are reference data (they show GHL's option format), never personal
	const isTimeZoneText = (text) => /^(GMT|UTC)[+-]\d{2}:\d{2} [A-Za-z_]+\/[\w/+-]+/.test(text);
	// Generated IDs (GHL record IDs are 20 random alphanumerics) mix letters with digits or with many capitals.
	// Readable ids like "bookAppointmentFormContainer" don't.
	const isGeneratedId = (token) => token.length >= 12 && /^[A-Za-z0-9]+$/.test(token) && /[a-z]/i.test(token)
		&& (/\d/.test(token) || (token.length >= 16 && (token.match(/[A-Z]/g) || []).length >= 4));
	const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
	const EMAIL_IN_ID = /[\w.+]+@[\w-]+\.[\w.]+/g; // ids are hyphen-delimited, so stop at hyphens

	const scrubText = (text) => text
		.replace(EMAIL, '[email]')
		.replace(/\+?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
		.split(/(\s+)/).map(token => (isGeneratedId(token) ? '[id]' : token)).join('');

	// Consistent placeholders for agency-defined names
	const customFieldNumbers = new Map();
	const customFolderNumbers = new Map();
	const numberFor = (map, key) => {
		if (!map.has(key)) map.set(key, map.size + 1);
		return map.get(key);
	};

	/** A field's key: Contact key from data-pendo-id or a contact.* id/name, or the label on the Company panel */
	function fieldKey(el) {
		const pendo = el.getAttribute('data-pendo-id') || '';
		if (pendo.startsWith(PENDO_FIELD_PREFIX)) return pendo.slice(PENDO_FIELD_PREFIX.length);
		const keyed = el.matches('[id^="contact."]') ? el : el.querySelector('[id^="contact."], [name^="contact."]');
		if (keyed) {
			const id = keyed.id.startsWith('contact.') ? keyed.id : keyed.getAttribute('name');
			return id.replace(/^contact\./, '');
		}
		if (screen.key === 'company') {
			const label = el.querySelector(FORM_LABEL_TEXT)?.textContent.replace(/\s+/g, ' ').trim();
			if (label) return `company:${label}`;
		}
		return null;
	}

	/** The custom-field number for a field, 0 if it's a built-in field, or null if it can't tell */
	function customFieldNumber(el) {
		const key = fieldKey(el);
		if (key === null) return null;
		const standard = key.startsWith('company:')
			? STANDARD_COMPANY_LABELS.has(key.slice(8))
			: STANDARD_CONTACT_KEYS.test(key);
		return standard ? 0 : numberFor(customFieldNumbers, key);
	}

	/** Anonymize each segment of an id: "phone-label-<recordId>-additional-0-<phone>-label-trigger" */
	function anonymizeId(id, context) {
		if (!id) return id;
		if (id.startsWith('contact.') && context.customField) return `contact.custom_field_${context.customField}`;
		if (id.startsWith(PENDO_FIELD_PREFIX) && context.customField) return `${PENDO_FIELD_PREFIX}custom_field_${context.customField}`;
		// Upload fields: "<fieldId>.<Field label>"
		if (id.includes('.') && context.customField) return `[id].custom_field_${context.customField}`;
		if (id.startsWith('tag-')) return 'tag-[value]';
		return id.replace(EMAIL_IN_ID, '[email]').split(/([-\s])/).map(part => {
			if (/^\+?\d{7,}$/.test(part)) return '[phone]';
			return isGeneratedId(part) || /^[a-f0-9]{8}$/.test(part) ? '[id]' : part;
		}).join('');
	}

	function attributesFor(el, context) {
		const svg = el.tagName.toLowerCase() === 'svg';
		return [...el.attributes]
			.filter(attr => KEEP_ATTRS.has(attr.name) || (svg && attr.name === 'viewBox'))
			.map(attr => {
				let value = attr.value;
				switch (attr.name) {
					case 'id':
					case 'for':
					case 'name':
					case 'aria-labelledby':
					case 'data-pendo-id':
						value = anonymizeId(value, context);
						break;
					case 'value':
					case 'aria-label':
						value = value ? '[redacted]' : value;
						break;
					case 'title':
						value = value && !isTimeZoneText(value) ? '[redacted]' : value;
						break;
					case 'href':
						value = value.startsWith('#') ? value : '[url]';
						break;
					case 'placeholder':
						value = context.customField ? '[custom]' : scrubText(value);
						break;
				}
				value = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
				return value === '' ? ` ${attr.name}` : ` ${attr.name}="${value}"`;
			})
			.join('');
	}

	function textFor(el, text, context) {
		if (isTimeZoneText(text)) return text;
		if (context.folderHeader) return context.folderHeader;
		if (context.customField) {
			return context.inLabel ? `Custom field ${context.customField}` : '[custom]';
		}
		if (context.value) return '[value]';
		// Open menus can list calendars, users, etc.: only time zone options (handled above) keep their text
		if (context.menu) return '[option]';
		return context.keep ? scrubText(text) : '[text]';
	}

	const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

	/** Serialize a node as indented, anonymized HTML */
	function serialize(node, depth, parentContext) {
		const pad = '\t'.repeat(depth);
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent.replace(/\s+/g, ' ').trim();
			return text ? `${pad}${textFor(node.parentElement, text, parentContext)}\n` : '';
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return '';

		const el = node;
		const tag = el.tagName.toLowerCase();
		if (['script', 'style', 'noscript', 'template'].includes(tag)) return '';
		if (el.classList.contains('tk-gmaps-container') || el.classList.contains('tk-pac-container')) {
			return `${pad}<!-- our injected ${el.classList[0]} removed -->\n`;
		}

		const context = { ...parentContext };
		if (el.matches(FIELD_SCOPE)) {
			const number = customFieldNumber(el);
			if (number !== null) context.customField = number;
		}
		if (el.matches('.hr-form-item-label, .n-form-item-label, label')) context.inLabel = true;
		if (el.matches(VALUE_TEXT)) context.value = true;
		if (el.matches(KEEP_TEXT)) context.keep = true;
		if (el.matches(FOLDER_HEADER)) {
			const name = el.textContent.replace(/\s+/g, ' ').trim();
			context.folderHeader = STANDARD_FOLDERS.has(name) ? null : `Custom folder ${numberFor(customFolderNumbers, name)}`;
		}

		const attrs = attributesFor(el, context);
		if (tag === 'svg') return `${pad}<svg${attrs}>…</svg>\n`;
		if (tag === 'iframe' || tag === 'img') return `${pad}<${tag}${attrs}>${tag === 'iframe' ? '</iframe>' : ''}\n`;
		if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs}>\n`;

		const children = [...el.childNodes].map(child => serialize(child, depth + 1, context)).join('');
		return children
			? `${pad}<${tag}${attrs}>\n${children}${pad}</${tag}>\n`
			: `${pad}<${tag}${attrs}></${tag}>\n`;
	}

	// ---- Capture --------------------------------------------------------------------------

	const forced = window.tkCaptureScreen;
	const screen = forced
		? SCREENS.find(s => s.key === forced)
		: SCREENS.find(s => s.when && document.querySelector(s.root));
	if (!screen || !document.querySelector(screen.root)) {
		console.warn('[ghl-dom-reference] Not on a supported screen. Open a Contact, a Company side panel, or the Book Appointment modal (Meeting location: Custom).');
		return;
	}

	const checks = screen.expect.map(selector => `${document.querySelector(selector) ? '✓' : '✗ MISSING'}  ${selector}`);

	let html = serialize(document.querySelector(screen.root), 0, {});
	const menu = document.querySelector(MENU_SELECTOR);
	if (menu) {
		html += '\n<!-- Open dropdown menu (Naive UI teleports it to <body>, outside the field) -->\n' + serialize(menu, 0, { menu: true });
	}

	const header = [
		'<!--',
		`\tGHL DOM snapshot: ${screen.name}`,
		`\tCaptured: ${new Date().toISOString().slice(0, 10)}`,
		`\tRoot: ${screen.root}`,
		'\tAnonymized by ghl-dom-reference/dom-capture.js:',
		'\t\t[value]/[redacted] = record data, [custom] / "Custom field N" / "Custom folder N" = agency-defined names,',
		'\t\t[text] = other text, [option] = non-time-zone menu options, [id] = generated IDs. Non-structural attributes, inline styles, and SVG paths are removed.',
		'\tStill review for personal data before committing.',
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
