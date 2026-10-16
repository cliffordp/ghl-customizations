/**
 * Tests for gmaps-address-autocomplete-crm/script.js (developer tool, not deployed)
 *
 * Run from the repository root:
 *   node gmaps-address-autocomplete-crm/tests/script.test.js
 *   osascript -l JavaScript gmaps-address-autocomplete-crm/tests/script.test.js   (macOS, no Node needed)
 *
 * Loads script.js with a minimal fake browser, exposes its pure helpers, and checks:
 * - every Country label and Time zone ID script.js can pick exists in GHL's real dropdowns
 *   (ghl-dom-reference/select-options-country-timezone.json), so a GHL rename fails here first
 * - time zone lookups for split states, Canada, and other countries
 * - address parsing and time zone label matching
 *
 * @see https://github.com/cliffordp/ghl-customizations
 * @author Clifford Paulick
 * @license AGPL-3.0
 */
/* global ObjC, $, require, process */
(() => {
	'use strict';

	const isNode = typeof process !== 'undefined' && process.versions?.node;
	const readFile = isNode
		? (path) => require('fs').readFileSync(path, 'utf8')
		: (path) => {
			ObjC.import('Foundation');
			const contents = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
			if (contents.isNil()) throw new Error(`Can't read ${path}. Run from the repository root.`);
			return ObjC.unwrap(contents);
		};

	// ---- Load script.js with a fake browser --------------------------------------------------

	const EXPOSED = [
		'textHasTimeZoneId', 'parsePlace', 'getTimeZoneCandidates', 'getSelectionText', 'normalizeCounty',
		'REGION_ZONES', 'COUNTRY_ZONES', 'GHL_COUNTRY_BY_ISO'
	];
	const source = readFile('gmaps-address-autocomplete-crm/script.js')
		.replace(/\}\)\(\);\s*$/, `fakeWindow.__test = { ${EXPOSED.join(', ')} }; })();`);
	if (!source.includes('fakeWindow.__test')) throw new Error('Could not find the end of script.js\'s IIFE');

	const noop = () => {};
	const fakeElement = () => ({ setAttribute: noop, appendChild: noop, addEventListener: noop, style: {}, dataset: {} });
	const fakeWindow = {
		addEventListener: noop,
		HTMLInputElement: { prototype: {} },
		location: { pathname: '/v2/location/x/contacts/detail/y', href: 'https://app.example.com/', search: '' }
	};
	const fakeDocument = {
		currentScript: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
		addEventListener: noop, createElement: fakeElement, head: fakeElement(), body: fakeElement(), readyState: 'complete'
	};
	const fakeConsole = { log: noop, warn: noop, error: noop, info: noop, debug: noop };

	// script.js only touches these globals; shadow them so it runs outside a browser
	new Function(
		'window', 'document', 'location', 'MutationObserver', 'setInterval', 'setTimeout', 'clearTimeout', 'console', 'fakeWindow',
		source
	)(
		fakeWindow, fakeDocument, fakeWindow.location, function () { return { observe: noop, disconnect: noop }; },
		() => 0, () => 0, noop, fakeConsole, fakeWindow
	);
	const t = fakeWindow.__test;

	// ---- Test helpers ------------------------------------------------------------------------

	const results = [];
	let failures = 0;
	const check = (name, actual, expected) => {
		const pass = JSON.stringify(actual) === JSON.stringify(expected);
		if (!pass) failures++;
		results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
	};
	const best = (address) => t.getTimeZoneCandidates(address)[0] || null;
	const us = (stateCode, county) => ({ countryCode: 'US', stateCode, state: '', county: county || '' });

	// ---- GHL's real dropdown options ---------------------------------------------------------

	const options = JSON.parse(readFile('ghl-dom-reference/select-options-country-timezone.json')).selects;
	const ghlTimeZoneIds = new Set(options.contactTimeZone.options.map(label => label.split(' ')[1]));
	const ghlCountries = new Set(options.contactCountry.options);

	// Every zone any lookup can return
	const allZones = new Set(Object.values(t.COUNTRY_ZONES).flat());
	const collect = (entry) => {
		if (!entry || typeof entry === 'function') return;
		if (Array.isArray(entry)) {
			entry.forEach(item => (typeof item === 'string' ? allZones.add(item) : collect(item)));
			return;
		}
		if (entry instanceof Set) return;
		Object.values(entry).forEach(collect);
	};
	collect(t.REGION_ZONES);
	// byCoordinates functions: sweep the globe
	for (const [cc, regions] of Object.entries(t.REGION_ZONES)) {
		for (const region of [regions, ...Object.values(regions)]) {
			if (typeof region?.byCoordinates !== 'function') continue;
			for (let lat = -60; lat <= 80; lat += 2) {
				for (let lng = -180; lng <= 180; lng += 2) {
					(region.byCoordinates(lat, lng) || []).forEach(zone => allZones.add(zone));
				}
			}
		}
	}
	check('every time zone script.js can pick is in GHL\'s dropdown', [...allZones].filter(zone => !ghlTimeZoneIds.has(zone)), []);

	const mappedCountries = Object.values(t.GHL_COUNTRY_BY_ISO);
	check('every Country label script.js uses is in GHL\'s dropdown', mappedCountries.filter(label => !ghlCountries.has(label)), []);
	check('every GHL Country option is mapped', [...ghlCountries].filter(label => !mappedCountries.includes(label)), []);

	// ---- Time zone lookups -------------------------------------------------------------------

	check('Michigan -> Detroit', best(us('MI', 'Wayne County')), 'America/Detroit');
	check('Michigan UP Central county -> Chicago', best(us('MI', 'Gogebic County')), 'America/Chicago');
	check('Michigan UP Eastern county -> Detroit', best(us('MI', 'Marquette County')), 'America/Detroit');
	check('Indiana -> Indianapolis', best(us('IN', 'Marion County')), 'America/Indiana/Indianapolis');
	check('Indiana LaPorte (spelled "La Porte") -> Chicago', best(us('IN', 'La Porte County')), 'America/Chicago');
	check('Kentucky -> Louisville', best(us('KY', 'Fayette County')), 'America/Louisville');
	check('Kentucky McCracken -> Chicago', best(us('KY', 'McCracken County')), 'America/Chicago');
	check('Tennessee Knox -> New York', best(us('TN', 'Knox County')), 'America/New_York');
	check('Tennessee Davidson -> Chicago', best(us('TN', 'Davidson County')), 'America/Chicago');
	check('Florida Escambia -> Chicago', best(us('FL', 'Escambia County')), 'America/Chicago');
	check('Florida Leon -> New York', best(us('FL', 'Leon County')), 'America/New_York');
	check('Texas El Paso -> Denver', best(us('TX', 'El Paso County')), 'America/Denver');
	check('Texas Harris -> Chicago', best(us('TX', 'Harris County')), 'America/Chicago');
	check('Idaho Ada -> Boise', best(us('ID', 'Ada County')), 'America/Boise');
	check('Idaho Kootenai -> Los Angeles', best(us('ID', 'Kootenai County')), 'America/Los_Angeles');
	check('Oregon Malheur -> Boise', best(us('OR', 'Malheur County')), 'America/Boise');
	check('South Dakota Pennington -> Denver', best(us('SD', 'Pennington County')), 'America/Denver');
	check('South Dakota Minnehaha -> Chicago', best(us('SD', 'Minnehaha County')), 'America/Chicago');
	check('Nebraska Scotts Bluff -> Denver', best(us('NE', 'Scotts Bluff County')), 'America/Denver');
	check('North Dakota Stark -> Denver', best(us('ND', 'Stark County')), 'America/Denver');
	check('Kansas Sherman -> Denver', best(us('KS', 'Sherman County')), 'America/Denver');
	check('Alaska -> US/Alaska', best(us('AK')), 'US/Alaska');
	check('Hawaii -> Honolulu', best(us('HI')), 'Pacific/Honolulu');
	check('Arizona -> Phoenix', best(us('AZ', 'Maricopa County')), 'America/Phoenix');
	check('Louisiana parish', best(us('LA', 'Orleans Parish')), 'America/Chicago');
	check('US with unknown state -> leave unchanged', t.getTimeZoneCandidates({ countryCode: 'US', state: '', stateCode: '' }), []);
	check('Michigan falls back to New York, US/Eastern', t.getTimeZoneCandidates(us('MI')).slice(0, 3), ['America/Detroit', 'America/New_York', 'US/Eastern']);
	check('Puerto Rico (country PR)', best({ countryCode: 'PR' }), 'America/Santo_Domingo');

	check('Canada BC -> Los Angeles', best({ countryCode: 'CA', stateCode: 'BC', county: 'Metro Vancouver' }), 'America/Los_Angeles');
	check('Canada BC Peace River -> Dawson (MST all year)', best({ countryCode: 'CA', stateCode: 'BC', county: 'Peace River Regional District' }), 'America/Dawson');
	check('Canada Ontario -> Toronto', best({ countryCode: 'CA', stateCode: 'ON', county: 'Toronto' }), 'America/Toronto');
	check('Canada Ontario Kenora District -> Chicago', best({ countryCode: 'CA', stateCode: 'ON', county: 'Kenora District' }), 'America/Chicago');
	check('Canada Manitoba -> Chicago', best({ countryCode: 'CA', stateCode: 'MB' }), 'America/Chicago');
	check('Canada Saskatchewan -> Regina', best({ countryCode: 'CA', stateCode: 'SK' }), 'America/Regina');
	check('Canada Nova Scotia -> Canada/Atlantic', best({ countryCode: 'CA', stateCode: 'NS' }), 'Canada/Atlantic');
	check('Canada St. John\'s -> St_Johns', best({ countryCode: 'CA', stateCode: 'NL', latitude: 47.56, longitude: -52.71 }), 'America/St_Johns');
	check('Canada Labrador City -> Canada/Atlantic', best({ countryCode: 'CA', stateCode: 'NL', latitude: 52.94, longitude: -66.91 }), 'Canada/Atlantic');
	check('Canada Iqaluit -> Toronto', best({ countryCode: 'CA', stateCode: 'NU', latitude: 63.75, longitude: -68.52 }), 'America/Toronto');

	check('Mexico City', best({ countryCode: 'MX', state: 'Ciudad de México', stateCode: 'CDMX' }), 'America/Mexico_City');
	check('Mexico Cancun', best({ countryCode: 'MX', state: 'Quintana Roo', stateCode: 'Q.R.' }), 'America/Cancun');
	check('Mexico Tijuana', best({ countryCode: 'MX', state: 'Baja California', stateCode: 'B.C.' }), 'America/Tijuana');
	check('Mexico Baja California Sur is not Baja California', best({ countryCode: 'MX', state: 'Baja California Sur', stateCode: 'B.C.S.' }), 'America/Phoenix');
	check('Mexico Ciudad Juárez -> Denver', best({ countryCode: 'MX', state: 'Chihuahua', stateCode: 'Chih.', county: 'Juárez' }), 'America/Denver');
	check('Brazil Manaus', best({ countryCode: 'BR', state: 'Amazonas', stateCode: 'AM' }), 'America/Manaus');
	check('Brazil São Paulo', best({ countryCode: 'BR', state: 'São Paulo', stateCode: 'SP' }), 'America/Sao_Paulo');
	check('Australia Melbourne -> Sydney', best({ countryCode: 'AU', stateCode: 'VIC' }), 'Australia/Sydney');
	check('Australia Perth', best({ countryCode: 'AU', stateCode: 'WA' }), 'Australia/Perth');
	check('Spain Canary Islands', best({ countryCode: 'ES', state: 'Canarias', stateCode: 'CN' }), 'Atlantic/Canary');
	check('Spain Madrid', best({ countryCode: 'ES', state: 'Comunidad de Madrid', stateCode: 'MD' }), 'Europe/Madrid');
	check('Portugal Azores', best({ countryCode: 'PT', state: 'Açores', stateCode: 'Açores' }), 'Atlantic/Azores');
	check('France -> Brussels (same rules as Paris)', best({ countryCode: 'FR' }), 'Europe/Brussels');
	check('UK -> London', best({ countryCode: 'GB' }), 'Europe/London');
	check('Russia Moscow', best({ countryCode: 'RU', latitude: 55.75, longitude: 37.62 }), 'Europe/Moscow');
	check('Russia Vladivostok', best({ countryCode: 'RU', latitude: 43.12, longitude: 131.89 }), 'Asia/Vladivostok');
	check('Indonesia Jakarta', best({ countryCode: 'ID', latitude: -6.2, longitude: 106.85 }), 'Asia/Bangkok');
	check('Indonesia Bali', best({ countryCode: 'ID', latitude: -8.65, longitude: 115.22 }), 'Asia/Kuala_Lumpur');
	check('unmapped country -> leave unchanged', t.getTimeZoneCandidates({ countryCode: 'AQ' }), []);
	check('no country -> leave unchanged', t.getTimeZoneCandidates({}), []);

	// ---- Helpers -----------------------------------------------------------------------------

	check('county normalization', t.normalizeCounty('St. Clair County'), 'stclair');
	check('label match: exact id', t.textHasTimeZoneId('GMT-04:00 America/Detroit (EDT)', 'America/Detroit'), true);
	check('label match: no prefix match', t.textHasTimeZoneId('GMT-04:00 America/Indiana/Indianapolis (EDT)', 'America/Indiana'), false);
	check('label match: US/Eastern is not US/East-Indiana', t.textHasTimeZoneId('GMT-04:00 US/East-Indiana (EDT)', 'US/Eastern'), false);

	const place = t.parsePlace({
		geometry: { location: { lat: () => 46.45, lng: () => -90.17 } },
		address_components: [
			{ long_name: '100', short_name: '100', types: ['street_number'] },
			{ long_name: 'Main Street', short_name: 'Main St', types: ['route'] },
			{ long_name: 'Ironwood', short_name: 'Ironwood', types: ['locality', 'political'] },
			{ long_name: 'Gogebic County', short_name: 'Gogebic County', types: ['administrative_area_level_2', 'political'] },
			{ long_name: 'Michigan', short_name: 'MI', types: ['administrative_area_level_1', 'political'] },
			{ long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
			{ long_name: '49938', short_name: '49938', types: ['postal_code'] }
		]
	});
	check('parsePlace street', place.street, '100 Main Street');
	check('parsePlace state (full name, for GHL tax)', place.state, 'Michigan');
	check('parsePlace stateCode', place.stateCode, 'MI');
	check('parsePlace county', place.county, 'Gogebic County');
	check('parsePlace -> Ironwood, MI is Central time', best(place), 'America/Chicago');

	const fakeSelection = { querySelector: () => ({ getAttribute: () => 'GMT-05:00 America/Chicago (CDT)', textContent: 'GMT-05:00 Amer…' }), textContent: '' };
	check('selection text prefers the full title', t.getSelectionText(fakeSelection), 'GMT-05:00 America/Chicago (CDT)');

	// ---- Report ------------------------------------------------------------------------------

	const summary = `${results.length - failures}/${results.length} passed`;
	const report = [...results, '', failures ? `FAILED: ${summary}` : `OK: ${summary}`].join('\n');
	if (isNode) {
		console.log(report);
		process.exitCode = failures ? 1 : 0;
	} else {
		// osascript prints the script's last value
		globalThis.__report = report;
	}
})();
globalThis.__report;
