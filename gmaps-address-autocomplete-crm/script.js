/**
 * @name GHL Customizations: Google Maps Address Autocomplete & Map Embed (CRM)
 * @description Google Places address autocomplete, sibling-field fill, Time zone auto-select, and map embed
 *              for GHL Contact detail, Company side panel, and Book/Edit Appointment modal.
 * @see https://github.com/cliffordp/ghl-customizations/tree/main/gmaps-address-autocomplete-crm
 * @author Clifford Paulick (https://tourkick.com/)
 * @license AGPL-3.0
 *
 * Copyright (c) 2026 Clifford Paulick (https://tourkick.com/)
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
 * Free to use in your own GoHighLevel agency. Bundling into closed-source
 * commercial toolkits or paid SaaS add-ons is strictly prohibited.
 */
(function () {
	'use strict';

	// Configuration (supports inline key, data-api-key attribute on script tag, or window.tkGmapsApiKey)
	const scriptElement =
		document.querySelector('#crm-gmaps-address-autocomplete[data-api-key], script[src*="gmaps-address-autocomplete"][data-api-key], script[src*="crm-gmaps-address-autocomplete"][data-api-key]') ||
		document.getElementById('crm-gmaps-address-autocomplete') ||
		document.currentScript;
	const googleMapsApiKey = ''; // ONLY ENTER YOUR GOOGLE MAPS API KEY HERE if pasting entire snippet into Company Settings instead of passing to static file embed
	const resolvedApiKey = (googleMapsApiKey || scriptElement?.dataset?.apiKey || window.tkGmapsApiKey || '').trim();
	// Auto-set the Contact "Time zone" field from the chosen address coordinates.
	// Disable with data-set-tz="false" on the <script> tag, or window.tkGmapsSetTz = false.
	const setTimeZoneEnabled = !['false', '0', 'no', 'off'].includes(
		String(scriptElement?.dataset?.setTz ?? window.tkGmapsSetTz ?? 'true').trim().toLowerCase()
	);
	// Verbose console logging. Enable with data-debug="true" on the <script> tag, or window.tkGmapsDebug = true.
	const debugEnabled = ['true', '1', 'yes', 'on'].includes(
		String(scriptElement?.dataset?.debug ?? window.tkGmapsDebug ?? 'false').trim().toLowerCase()
	);
	const log = (...args) => {
		if (debugEnabled) console.log('[tk-gmaps]', ...args);
	};
	const config = {
		debounceTime: 500,
		retryTime: 4000,
		maxRetries: 3,
		mapHeight: '240',
		modalWaitTime: 300
	};

	// Book/Edit Appointment modal: "Enter meeting location" input (only rendered when Meeting location is Custom)
	const APPT_INPUT_SELECTOR = '.bookAppointmentFormContainer #meeting-location-text-input input';

	// Cache for DOM elements and autocomplete instances
	const cache = {
		elements: {},
		autocompleteInstances: {}
	};

	// One Places (New) autocomplete instance per input element
	const autocompleteByInput = new WeakMap();

	let missingKeyWarned = false;
	let placesImportPromise = null;

	// Inject dropdown styles. Max z-index + pointer-events so the dropdown works above GHL modals' focus/click traps.
	if (!document.getElementById('tk-gmaps-pac-style')) {
		const styleEl = document.createElement('style');
		styleEl.id = 'tk-gmaps-pac-style';
		styleEl.textContent = [
			'.tk-pac-container { position: fixed; z-index: 2147483647 !important; pointer-events: auto !important; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.15); font-family: inherit; font-size: 14px; overflow: hidden; }',
			'.tk-pac-container[hidden] { display: none !important; }',
			'.tk-pac-item { padding: 8px 12px; cursor: pointer; line-height: 1.3; border-top: 1px solid #f3f4f6; }',
			'.tk-pac-item:first-child { border-top: 0; }',
			'.tk-pac-item:hover, .tk-pac-item-selected { background: #f3f4f6; }',
			'.tk-pac-item-query { color: #111827; }',
			'.tk-pac-item-secondary { color: #6b7280; margin-left: 6px; font-size: 12px; }',
			'.tk-pac-logo { padding: 4px 12px; text-align: right; color: #6b7280; font-size: 11px; border-top: 1px solid #f3f4f6; }'
		].join('\n');
		document.head.appendChild(styleEl);
	}

	/**
	 * Creates a debounced function that delays invoking func until after wait milliseconds
	 * @param {Function} func - The function to debounce
	 * @param {number} wait - The number of milliseconds to delay
	 * @returns {Function} The debounced function
	 */
	function debounce(func, wait) {
		let timeout;
		return function (...args) {
			const context = this;
			clearTimeout(timeout);
			timeout = setTimeout(() => func.apply(context, args), wait);
		};
	}

	/**
	 * Convert a Places API (New) Place into the legacy shape the field-mapping code expects
	 * @param {google.maps.places.Place} place
	 * @returns {{address_components: Array, formatted_address: string, geometry: (Object|undefined)}}
	 */
	function toLegacyPlace(place) {
		return {
			address_components: (place.addressComponents || []).map(component => ({
				long_name: component.longText || '',
				short_name: component.shortText || '',
				types: component.types || []
			})),
			formatted_address: place.formattedAddress || '',
			geometry: place.location ? { location: place.location } : undefined
		};
	}

	/**
	 * Remove the Places autocomplete instance (dropdown + listeners) from an input
	 * @param {HTMLElement} inputElement
	 */
	function destroyPlacesAutocomplete(inputElement) {
		if (!inputElement) return;
		const instance = autocompleteByInput.get(inputElement);
		if (instance) {
			instance.destroy();
		}
	}

	/**
	 * Attach Places API (New) autocomplete to an existing input.
	 * Keeps GHL's own <input> (instead of PlaceAutocompleteElement, which replaces it) so Vue bindings keep working.
	 * @param {HTMLElement} inputElement - The input to attach to
	 * @param {Function} onPlaceSelected - Called with a legacy-shaped place object
	 * @returns {{destroy: Function}} The instance
	 */
	function createPlacesAutocomplete(inputElement, onPlaceSelected) {
		destroyPlacesAutocomplete(inputElement);

		const { AutocompleteSuggestion, AutocompleteSessionToken } = google.maps.places;
		const container = document.createElement('div');
		container.className = 'tk-pac-container';
		container.setAttribute('role', 'listbox');
		container.hidden = true;
		document.body.appendChild(container);

		let sessionToken = null;
		let suggestions = [];
		let activeIndex = -1;
		let requestId = 0;
		let inputTimer = null;

		const position = () => {
			if (container.hidden) return;
			const rect = inputElement.getBoundingClientRect();
			container.style.top = `${rect.bottom + 2}px`;
			container.style.left = `${rect.left}px`;
			container.style.width = `${Math.max(rect.width, 280)}px`;
		};

		const hide = () => {
			container.hidden = true;
			activeIndex = -1;
		};

		const select = async (index) => {
			const suggestion = suggestions[index];
			if (!suggestion) return;
			hide();
			suggestions = [];
			requestId++; // Discard any in-flight suggestion requests
			try {
				const place = suggestion.placePrediction.toPlace();
				await place.fetchFields({ fields: ['addressComponents', 'location', 'formattedAddress'] });
				sessionToken = null; // Session ends after fetchFields (billing)
				onPlaceSelected(toLegacyPlace(place));
			} catch (error) {
				console.error('Error fetching place details:', error);
			}
		};

		const render = () => {
			container.replaceChildren();
			if (!suggestions.length) {
				hide();
				return;
			}
			suggestions.forEach((suggestion, index) => {
				const prediction = suggestion.placePrediction;
				const item = document.createElement('div');
				item.className = 'tk-pac-item' + (index === activeIndex ? ' tk-pac-item-selected' : '');
				item.setAttribute('role', 'option');
				const main = document.createElement('span');
				main.className = 'tk-pac-item-query';
				main.textContent = String(prediction.mainText || prediction.text || '');
				item.appendChild(main);
				if (prediction.secondaryText) {
					const secondary = document.createElement('span');
					secondary.className = 'tk-pac-item-secondary';
					secondary.textContent = String(prediction.secondaryText);
					item.appendChild(secondary);
				}
				item.addEventListener('click', () => select(index));
				container.appendChild(item);
			});
			// Google requires attribution when predictions aren't shown on a Google map
			const logo = document.createElement('div');
			logo.className = 'tk-pac-logo';
			logo.textContent = 'powered by Google';
			container.appendChild(logo);
			container.hidden = false;
			position();
		};

		const fetchSuggestions = async (value) => {
			const thisRequest = ++requestId;
			if (!value.trim()) {
				suggestions = [];
				hide();
				return;
			}
			if (!sessionToken) {
				sessionToken = new AutocompleteSessionToken();
			}
			try {
				const response = await AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: value, sessionToken });
				if (thisRequest !== requestId) return; // A newer keystroke superseded this request
				suggestions = (response.suggestions || []).filter(suggestion => suggestion.placePrediction);
				activeIndex = -1;
				render();
			} catch (error) {
				console.error('Error fetching autocomplete suggestions (is Places API (New) enabled?):', error);
			}
		};

		const onInput = (event) => {
			// Ignore synthetic input events (e.g. our own setNativeInputValue/triggerInputEvents)
			if (!event.isTrusted) return;
			clearTimeout(inputTimer);
			inputTimer = setTimeout(() => fetchSuggestions(inputElement.value || ''), 200);
		};

		const onKeydown = (event) => {
			if (container.hidden || !suggestions.length) return;
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				activeIndex = (activeIndex + 1) % suggestions.length;
				render();
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1;
				render();
			} else if (event.key === 'Enter' && activeIndex >= 0) {
				event.preventDefault();
				event.stopPropagation();
				select(activeIndex);
			} else if (event.key === 'Escape') {
				hide();
			}
		};

		const onBlur = () => setTimeout(hide, 150);

		// preventDefault keeps focus in the input; stopPropagation stops GHL modals' outside-click handlers
		const onContainerMousedown = (event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		const onContainerClick = (event) => event.stopPropagation();

		inputElement.setAttribute('autocomplete', 'off');
		inputElement.addEventListener('input', onInput);
		inputElement.addEventListener('keydown', onKeydown, true);
		inputElement.addEventListener('blur', onBlur);
		container.addEventListener('mousedown', onContainerMousedown);
		container.addEventListener('click', onContainerClick);
		window.addEventListener('scroll', position, true);
		window.addEventListener('resize', position);

		const instance = {
			hide,
			destroy() {
				clearTimeout(inputTimer);
				requestId++;
				inputElement.removeEventListener('input', onInput);
				inputElement.removeEventListener('keydown', onKeydown, true);
				inputElement.removeEventListener('blur', onBlur);
				window.removeEventListener('scroll', position, true);
				window.removeEventListener('resize', position);
				container.remove();
				autocompleteByInput.delete(inputElement);
			}
		};
		autocompleteByInput.set(inputElement, instance);
		return instance;
	}

	/**
	 * Load the Google Maps API with Places library
	 * @returns {boolean} Whether an API key is configured
	 */
	function loadGoogleMapsApi() {
		if (!resolvedApiKey) {
			if (!missingKeyWarned) {
				console.error(`Google Maps API key is missing from Agency's Company settings (set googleMapsApiKey or data-api-key).`);
				missingKeyWarned = true;
			}
			return false;
		}

		const scriptId = 'tk-google-maps';
		// Check if the script with the ID already exists.
		if (document.getElementById(scriptId)) {
			return true;
		}

		// Create Google Maps <script> element dynamically.
		const gMapsScript = document.createElement('script');
		gMapsScript.id = scriptId;
		gMapsScript.async = true;
		gMapsScript.src = `https://maps.googleapis.com/maps/api/js?key=${resolvedApiKey}&loading=async&libraries=places`;
		gMapsScript.onerror = () => console.error('Failed to load Google Maps API');
		document.head.appendChild(gMapsScript);
		return true;
	}

	/**
	 * Check whether Google Maps Places Autocomplete is ready to use
	 * @returns {boolean}
	 */
	function isGooglePlacesReady() {
		if (
			typeof google !== 'undefined' &&
			typeof google.maps !== 'undefined' &&
			typeof google.maps.places !== 'undefined' &&
			typeof google.maps.places.AutocompleteSuggestion === 'function'
		) {
			return true;
		}

		// If Maps core loaded with loading=async but places hasn't initialized yet, trigger importLibrary('places')
		if (
			typeof google !== 'undefined' &&
			typeof google.maps !== 'undefined' &&
			typeof google.maps.importLibrary === 'function' &&
			!placesImportPromise
		) {
			placesImportPromise = google.maps.importLibrary('places').catch(err => {
				console.error('Error importing Google Maps places library:', err);
				placesImportPromise = null;
			});
		}

		return false;
	}

	/**
	 * Check if the appointment dropdown is set to 'Custom'
	 * @returns {boolean} Whether the dropdown is set to 'Custom'
	 */
	function isAppointmentDropdownCustom() {
		try {
			// If 'Calendar default' radio is explicitly checked, it's not Custom
			const defaultRadioChecked = document.querySelector(
				'.bookAppointmentFormContainer #location-default.n-radio--checked, ' +
				'.bookAppointmentFormContainer #location-default.hr-radio--checked'
			);
			if (defaultRadioChecked) {
				return false;
			}

			// Check the meeting location dropdown value when visible
			const dropdownContent = document.querySelector(
				'.bookAppointmentFormContainer #meeting-location-dropdown .n-base-selection-input__content, ' +
				'.bookAppointmentFormContainer #meeting-location-dropdown .hr-base-selection-input__content, ' +
				'.bookAppointmentFormContainer #meeting-location-dropdown .n-base-selection-overlay__wrapper, ' +
				'.bookAppointmentFormContainer #meeting-location-dropdown .hr-base-selection-overlay__wrapper'
			);
			if (dropdownContent) {
				return dropdownContent.textContent.trim() === 'Custom';
			}

			// Check for #location-custom radio or legacy radio label starting with 'Custom'
			const customRadio = document.querySelector(
				'.bookAppointmentFormContainer #location-custom.n-radio--checked, ' +
				'.bookAppointmentFormContainer #location-custom.hr-radio--checked, ' +
				'.bookAppointmentFormContainer .n-radio.n-radio--checked .n-radio__label, ' +
				'.bookAppointmentFormContainer .hr-radio.hr-radio--checked .hr-radio__label'
			);
			if (customRadio) {
				if (customRadio.id === 'location-custom' || customRadio.textContent.trim().startsWith('Custom')) {
					return true;
				}
			}

			return false;
		} catch (error) {
			console.error('Error checking appointment dropdown:', error);
			return false;
		}
	}

	/**
	 * Find the outer wrapper element for a field input to insert the map before.
	 * Uses sequential closest() calls so outer wrappers (.fields, #field-container)
	 * are matched before inner wrappers (.hr-form-item).
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {HTMLElement} inputElement - The street address input element
	 * @returns {HTMLElement|null} The field wrapper element
	 */
	function getFieldGroupContainer(type, inputElement) {
		if (!inputElement) {
			return null;
		}
		if (type === 'contact') {
			return (
				inputElement.closest('#field-container') ||
				inputElement.closest('.form-group') ||
				inputElement.closest('.hr-form') ||
				inputElement.closest('.hr-form-item') ||
				inputElement.closest('.n-form-item')
			);
		}
		if (type === 'business') {
			return (
				inputElement.closest('.fields') ||
				inputElement.closest('#field-container') ||
				inputElement.closest('.hr-form-item') ||
				inputElement.closest('.n-form-item')
			);
		}
		if (type === 'appt') {
			return inputElement.closest('#meeting-location-text-input');
		}
		return null;
	}

	/**
	 * Embed a Google Map for the specified address type
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {string} fullAddress - The full address to display on the map
	 */
	async function embedGoogleMap(type, fullAddress = '') {
		if (!resolvedApiKey) {
			return;
		}

		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return;
		}

		try {
			// Use different map classes for different types to allow maps to coexist
			const mapClass = type === 'appt'
				? 'tk-gmaps-embed-appt'
				: type === 'business'
					? 'tk-gmaps-embed-business'
					: 'tk-gmaps-embed-contact';

			// Remove any existing map of the same type before checking if the new record has an address
			const existingIframe = document.querySelector(`iframe.${mapClass}`);
			if (existingIframe) {
				const existingContainer = existingIframe.closest('.tk-gmaps-container');
				if (existingContainer) {
					existingContainer.remove();
				} else {
					existingIframe.remove();
				}
			}

			if (!fullAddress) {
				const existingFullAddress = getExistingFullAddress(type);
				if (!existingFullAddress) {
					return;
				}
				fullAddress = existingFullAddress;
			}

			const encodedAddress = encodeURIComponent(fullAddress);

			const mapContainer = document.createElement('div');
			mapContainer.style.width = '100%';
			mapContainer.classList.add('tk-gmaps-container');
			if (type === 'appt') {
				mapContainer.classList.add('tk-gmaps-container-appt');
			}

			const iframe = document.createElement('iframe');
			iframe.classList.add(mapClass);
			iframe.setAttribute('aria-label', 'Google Maps embed');
			iframe.width = '100%';
			iframe.height = config.mapHeight;
			iframe.frameBorder = '0';
			iframe.scrolling = 'no';
			iframe.marginHeight = '0';
			iframe.marginWidth = '0';
			iframe.src = `https://www.google.com/maps/embed/v1/place?q=${encodedAddress}&key=${resolvedApiKey}`;
			mapContainer.appendChild(iframe);

			const streetAddressInput = getStreetAddressInput(type);
			const addressFieldGroup = getFieldGroupContainer(type, streetAddressInput);

			if (addressFieldGroup && addressFieldGroup.parentNode) {
				addressFieldGroup.parentNode.insertBefore(mapContainer, addressFieldGroup);

				if (type === 'appt') {
					// Add a listener to the Meeting Location Dropdown to hide/remove the map when it's not 'Custom'
					setupLocationDropdownListener();
				}
			}
		} catch (error) {
			console.error('Error embedding Google Map:', error);
		}
	}

	/**
	 * Reattach autocomplete to the appointment address input
	 * This is a dedicated function to ensure robust reattachment
	 */
	function reattachAppointmentAutocomplete() {
		if (!loadGoogleMapsApi()) {
			return;
		}

		log('Attempting to reattach appointment autocomplete...');

		// Only proceed if dropdown is 'Custom'
		if (!isAppointmentDropdownCustom()) {
			log('Dropdown is not Custom, skipping autocomplete attachment');
			return;
		}

		// Clear any existing autocomplete instances for appointment
		if (cache.autocompleteInstances['appt']) {
			try {
				const apptInput = document.querySelector(APPT_INPUT_SELECTOR);
				if (apptInput) {
					log('Clearing existing autocomplete listeners');
					destroyPlacesAutocomplete(apptInput);
					delete apptInput.dataset.tkAutocompleteAttached;
				}
				delete cache.autocompleteInstances['appt'];
			} catch (error) {
				console.error('Error clearing existing autocomplete:', error);
			}
		}

		// Get the appointment address input
		const apptAddressInput = document.querySelector(APPT_INPUT_SELECTOR);
		if (!apptAddressInput) {
			console.error('Could not find appointment address input');
			return;
		}

		// Check if Google Maps Places API is loaded
		if (!isGooglePlacesReady()) {
			log('Google Maps API not loaded yet, waiting...');
			setTimeout(reattachAppointmentAutocomplete, 500);
			return;
		}

		// If we have a stored address value, restore it
		if (lastKnownAddressValue && !apptAddressInput.value) {
			log('Restoring saved address value before attaching autocomplete:', lastKnownAddressValue);
			setNativeInputValue(apptAddressInput, lastKnownAddressValue);
			triggerInputEvents(apptAddressInput);
		}

		// Attach autocomplete
		log('Attaching autocomplete to appointment input');

		try {
			// Create new autocomplete instance directly
			const autocomplete = createPlacesAutocomplete(apptAddressInput, function (place) {
				log('Appointment autocomplete place selected');

				if (!place || !place.geometry) {
					console.error('Invalid place selected or no geometry');
					return;
				}

				// Ensure the dropdown is still 'Custom'
				if (!isAppointmentDropdownCustom()) {
					log('Dropdown no longer Custom, ignoring selection');
					return;
				}

				log('Setting appointment address to:', place.formatted_address);

				// Store the address value for later use
				lastKnownAddressValue = place.formatted_address;
				log('Stored address value for future use:', lastKnownAddressValue);

				// Set the input value to the formatted address and force update
				setNativeInputValue(apptAddressInput, place.formatted_address);
				triggerInputEvents(apptAddressInput);

				// Embed map for appointment with the selected address
				log('Embedding map for appointment with address:', place.formatted_address);
				embedGoogleMap('appt', place.formatted_address);

				// Force close any open autocomplete dropdowns
				closeAutocompleteDropdown();
			});

			// Store the autocomplete instance for future reference
			cache.autocompleteInstances['appt'] = autocomplete;
			apptAddressInput.dataset.tkAutocompleteAttached = 'true';

			log('Appointment autocomplete attached successfully');
		} catch (error) {
			console.error('Error attaching appointment autocomplete:', error);
		}

		// Do NOT embed the map here - only embed after a place is selected
		// This prevents the map from showing up prematurely
	}

	// Global variables to track state
	let forceReattachmentNeeded = false;
	let lastKnownAddressValue = ''; // Store the last known address value

	/**
	 * Force reattachment of the appointment autocomplete
	 * This can be called from anywhere to ensure the autocomplete is attached
	 */
	function forceReattachAppointmentAutocomplete() {
		if (!loadGoogleMapsApi()) {
			return;
		}

		log('Forcing reattachment of appointment autocomplete');
		forceReattachmentNeeded = false;

		// Only proceed if dropdown is 'Custom'
		if (!isAppointmentDropdownCustom()) {
			log('Dropdown is not Custom, skipping forced reattachment');
			return;
		}

		try {
			// First, clear any existing autocomplete instances
			const apptInput = document.querySelector(APPT_INPUT_SELECTOR);
			if (apptInput) {
				log('Clearing autocomplete listeners');

				destroyPlacesAutocomplete(apptInput);
				delete apptInput.dataset.tkAutocompleteAttached;

				// Clear from cache
				if (cache.autocompleteInstances['appt']) {
					delete cache.autocompleteInstances['appt'];
				}

				// Clear any cached elements for appointment
				Object.keys(cache.elements).forEach(key => {
					if (key.startsWith('appt-') || key === 'street-address-appt') {
						delete cache.elements[key];
					}
				});

				// If we have a stored address value, restore it
				if (lastKnownAddressValue) {
					log('Restoring saved address value:', lastKnownAddressValue);
					setNativeInputValue(apptInput, lastKnownAddressValue);

					// Force the input to update
					triggerInputEvents(apptInput);

					// Also restore the map if needed
					embedGoogleMap('appt', lastKnownAddressValue);
				}
			}
		} catch (error) {
			console.error('Error clearing appointment input:', error);
		}

		// Wait a bit to ensure the DOM is stable
		setTimeout(() => {
			// Get a fresh reference to the input
			const apptAddressInput = document.querySelector(APPT_INPUT_SELECTOR);
			if (apptAddressInput) {
				log('Reattaching autocomplete to input');

				// Double-check if the value is set correctly
				if (lastKnownAddressValue && !apptAddressInput.value) {
					log('Value was lost, restoring again:', lastKnownAddressValue);
					setNativeInputValue(apptAddressInput, lastKnownAddressValue);
					triggerInputEvents(apptAddressInput);
				}

				reattachAppointmentAutocomplete();
			} else {
				log('Could not find appointment input');
			}
		}, 300);
	}

	/**
	 * Set up a listener for changes to the Meeting Location Dropdown / Radios
	 */
	function setupLocationDropdownListener() {
		const formContainer = document.querySelector('.bookAppointmentFormContainer');
		if (!formContainer) {
			return;
		}

		// Track the previous dropdown state to detect actual changes
		let wasCustomPreviously = isAppointmentDropdownCustom();

		// Attach click listener to the appointment form container / modal once
		const modalContainer =
			document.querySelector('.appointmentWizardBody') ||
			document.querySelector('.hl-modal, .hr-modal, .n-modal') ||
			formContainer;

		if (modalContainer && !modalContainer.dataset.clickListenerAttached) {
			modalContainer.dataset.clickListenerAttached = 'true';
			log('Setting up location dropdown & radio listener on appointment modal');

			modalContainer.addEventListener('click', function (event) {
				const clickedRadio = event.target.closest('#location-default, #location-custom, .n-radio, .hr-radio, .n-radio__label, .hr-radio__label');
				setTimeout(() => {
					const isCustomNow = isAppointmentDropdownCustom();
					if (isCustomNow !== wasCustomPreviously || (clickedRadio && isCustomNow)) {
						if (isCustomNow) {
							forceReattachmentNeeded = true;
							forceReattachAppointmentAutocomplete();
						} else {
							removeAppointmentMap();
						}
						wasCustomPreviously = isCustomNow;
					}
				}, 100);
			});

			// Periodic check while the appointment form remains open
			const checkInterval = setInterval(() => {
				if (!document.querySelector('.bookAppointmentFormContainer') || !resolvedApiKey) {
					clearInterval(checkInterval);
					lastKnownAddressValue = '';
					return;
				}

				const isCustomNow = isAppointmentDropdownCustom();
				if (isCustomNow !== wasCustomPreviously) {
					if (isCustomNow) {
						forceReattachmentNeeded = true;
					} else {
						removeAppointmentMap();
					}
					wasCustomPreviously = isCustomNow;
				}

				const apptInput = document.querySelector(APPT_INPUT_SELECTOR);
				if (isCustomNow && (forceReattachmentNeeded || (apptInput && !apptInput.dataset.tkAutocompleteAttached && isGooglePlacesReady()))) {
					forceReattachAppointmentAutocomplete();
				}
			}, 800);
		}

		// Observe #meeting-location-dropdown if present
		const locationDropdown = document.querySelector('.bookAppointmentFormContainer #meeting-location-dropdown');
		if (locationDropdown && !locationDropdown.dataset.observerAttached) {
			locationDropdown.dataset.observerAttached = 'true';
			const dropdownObserver = new MutationObserver(function () {
				try {
					const isCustomNow = isAppointmentDropdownCustom();
					if (isCustomNow !== wasCustomPreviously) {
						if (isCustomNow) {
							forceReattachmentNeeded = true;
							forceReattachAppointmentAutocomplete();
						} else {
							removeAppointmentMap();
						}
						wasCustomPreviously = isCustomNow;
					}
				} catch (error) {
					console.error('Error in dropdown observer:', error);
				}
			});

			dropdownObserver.observe(locationDropdown, {
				childList: true,
				subtree: true,
				characterData: true,
				attributes: true
			});
		}
	}

	/**
	 * Remove the appointment map container
	 */
	function removeAppointmentMap() {
		const mapContainer = document.querySelector('.tk-gmaps-container-appt');
		if (mapContainer) {
			mapContainer.remove();
		}
	}

	/**
	 * Get the existing full address for the specified type
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @returns {string|undefined} The full address or undefined if not found
	 */
	function getExistingFullAddress(type) {
		try {
			// For appointment type, only proceed if dropdown is 'Custom'
			if (type === 'appt' && !isAppointmentDropdownCustom()) {
				return;
			}

			const address1 = getStreetAddressInput(type)?.value?.trim();

			if (!address1 || address1 === '--') {
				return;
			}

			let city = '';
			let state = '';
			let postalCode = '';

			city = getInputElementFromText(type, 'City')?.value?.trim() || '';
			state = getInputElementFromText(type, 'State')?.value?.trim() || '';
			postalCode = getInputElementFromText(type, 'Postal Code')?.value?.trim() || '';

			const parts = [address1, city, `${state} ${postalCode}`.trim()].filter(Boolean);
			return parts.join(', ');
		} catch (error) {
			console.error('Error getting existing full address:', error);
			return '';
		}
	}

	/**
	 * Split a Places result into the pieces GHL's Contact/Company fields need
	 * @param {Object} place - Legacy-shaped place from toLegacyPlace()
	 * @returns {{street: string, city: string, state: string, stateCode: string, county: string, postalCode: string, country: string, countryCode: string, latitude: (number|string), longitude: (number|string)}}
	 */
	function parsePlace(place) {
		const parts = {};
		for (const component of place.address_components) {
			for (const type of component.types || []) {
				if (!(type in parts)) {
					parts[type] = component;
				}
			}
		}
		const long = (type) => parts[type]?.long_name || '';

		const line2 = long('subpremise') || long('sublocality_level_1');
		return {
			street: `${long('street_number')} ${long('route')}`.trim() + (line2 ? `, ${line2}` : ''),
			// Prefer locality; postal_town (UK) and administrative_area_level_3 are fallbacks
			city: long('locality') || long('postal_town') || long('administrative_area_level_3'),
			state: long('administrative_area_level_1'), // Full name (e.g. "Oklahoma" not "OK") for GHL automated tax calculation
			stateCode: parts.administrative_area_level_1?.short_name || '', // e.g. 'OK'; used for the time zone
			county: long('administrative_area_level_2'), // e.g. 'Gogebic County'; used for time zones in split states
			postalCode: long('postal_code'),
			country: long('country'),
			countryCode: parts.country?.short_name || '', // ISO 3166-1 alpha-2, e.g. 'CZ'
			latitude: place.geometry?.location?.lat() ?? '',
			longitude: place.geometry?.location?.lng() ?? ''
		};
	}

	/**
	 * Attach Google Maps autocomplete to the Contact or Company street address input
	 * (appointments use reattachAppointmentAutocomplete())
	 * @param {string} type - 'contact' or 'business'
	 * @param {HTMLElement} inputElement - The input element to attach autocomplete to
	 */
	function attachAutocompleteToElement(type, inputElement) {
		if (!inputElement) {
			return;
		}

		try {
			// If there's already an autocomplete instance for this type, remove it
			if (cache.autocompleteInstances[type]) {
				cache.autocompleteInstances[type].destroy();
				delete cache.autocompleteInstances[type];
			}

			// Create new autocomplete instance (also destroys any instance already on this input)
			const autocomplete = createPlacesAutocomplete(inputElement, function (place) {
				if (!place || !place.geometry) {
					return; // Invalid place selected
				}

				const address = parsePlace(place);

				const streetInput = type === 'business' ? inputElement : (getStreetAddressInput(type) || inputElement);
				setNativeInputValue(streetInput, address.street);
				triggerInputEvents(streetInput);

				setFieldValue(type, 'City', address.city);
				setFieldValue(type, 'State', address.state);
				setFieldValue(type, 'Postal Code', address.postalCode);
				setFieldValue(type, 'Latitude', address.latitude); // Custom Field name
				setFieldValue(type, 'Longitude', address.longitude); // Custom Field name

				closeAutocompleteDropdown();
				embedGoogleMap(type, place.formatted_address);

				// Dropdowns are set one at a time so two menus are never open at once.
				// Runs after closeAutocompleteDropdown() so its body click can't close the menus we open.
				(async () => {
					if (address.countryCode) {
						await setCountry(type, address.countryCode, address.country);
					}
					// Time zone only exists on Contact Details
					if (type === 'contact' && setTimeZoneEnabled) {
						await setTimeZone(address);
					}
				})();

				// The Company panel re-renders after edits, so reattach to the fresh input
				if (type === 'business') {
					setTimeout(() => attachAutocompleteToElement(type, inputElement), config.modalWaitTime);
				}
			});

			// Store the autocomplete instance for future reference
			cache.autocompleteInstances[type] = autocomplete;
			inputElement.dataset.tkAutocompleteAttached = 'true';
		} catch (error) {
			console.error('Error attaching autocomplete:', error);
		}
	}

	const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	/*
	 * ---- Time zone lookup -------------------------------------------------------------------
	 *
	 * GHL's Time zone dropdown offers only ~109 zones (see ghl-dom-reference/select-options-country-timezone.json),
	 * so every zone below must exist there. Where GHL lacks a city's own zone, we use one with identical
	 * rules (e.g. Paris -> Europe/Brussels, Winnipeg -> America/Chicago). tests/script.test.js enforces this.
	 *
	 * Each lookup returns a list: the best zone first, then zones with the same rules to fall back on
	 * if GHL ever drops the best one. Resolved in the browser from Google's address parts, so no extra
	 * API (Google Time Zone API needs a separately billed, non-referrer-restricted key).
	 */
	const EASTERN = ['America/New_York', 'US/Eastern', 'America/Toronto'];
	const CENTRAL = ['America/Chicago', 'US/Central'];
	const MOUNTAIN = ['America/Denver', 'US/Mountain', 'America/Edmonton'];
	const MOUNTAIN_NO_DST = ['America/Phoenix', 'US/Arizona', 'America/Dawson'];
	const PACIFIC = ['America/Los_Angeles', 'America/Tijuana'];
	const ATLANTIC = ['Canada/Atlantic', 'America/Glace_Bay'];
	const CANADA_EASTERN = ['America/Toronto', 'America/New_York', 'US/Eastern'];
	const CANADA_MOUNTAIN = ['America/Edmonton', 'America/Denver', 'US/Mountain'];

	/** Normalize a county/district name: 'LaPorte County' and 'La Porte' -> 'laporte' */
	function normalizeCounty(name) {
		return normalizeName(name)
			.replace(/\b(regional district|census area|municipio de|county|parish|borough|district|municipality)\b/g, '')
			.replace(/\s+/g, '');
	}

	/** A county exception: [zones, Set of normalized county names] */
	const counties = (zones, names) => [zones, new Set(names.split(',').map(normalizeCounty))];

	/**
	 * Countries with more than one zone, keyed by Google's administrative_area_level_1
	 * (short code like 'MI', or normalized long name like 'quintana roo').
	 * `counties` lists administrative_area_level_2 areas on a different zone than the rest of the region.
	 * Counties split down the middle (e.g. Gulf County FL, Dunn County ND) use the region's zone.
	 */
	const REGION_ZONES = {
		US: {
			AL: CENTRAL, AK: ['US/Alaska', 'America/Juneau'], AZ: MOUNTAIN_NO_DST, AR: CENTRAL, CA: PACIFIC,
			CO: MOUNTAIN, CT: EASTERN, DE: EASTERN, DC: EASTERN, GA: EASTERN, HI: ['Pacific/Honolulu'],
			IL: CENTRAL, IA: CENTRAL, LA: CENTRAL, ME: EASTERN, MD: EASTERN, MA: EASTERN, MN: CENTRAL,
			MS: CENTRAL, MO: CENTRAL, MT: MOUNTAIN, NV: PACIFIC, NH: EASTERN, NJ: EASTERN, NM: MOUNTAIN,
			NY: EASTERN, NC: EASTERN, OH: EASTERN, OK: CENTRAL, PA: EASTERN, RI: EASTERN, SC: EASTERN,
			UT: MOUNTAIN, VT: EASTERN, VA: EASTERN, WA: PACIFIC, WV: EASTERN, WI: CENTRAL, WY: MOUNTAIN,
			PR: ['America/Santo_Domingo'], VI: ['America/Santo_Domingo'], GU: ['Pacific/Guam'],
			MP: ['Pacific/Guam'], AS: ['Pacific/Midway'],
			FL: { zones: EASTERN, counties: [counties(CENTRAL, 'Bay, Calhoun, Escambia, Holmes, Jackson, Okaloosa, Santa Rosa, Walton, Washington')] },
			ID: { zones: ['America/Boise', ...MOUNTAIN], counties: [counties(PACIFIC, 'Benewah, Bonner, Boundary, Clearwater, Idaho, Kootenai, Latah, Lewis, Nez Perce, Shoshone')] },
			IN: {
				zones: ['America/Indiana/Indianapolis', 'US/East-Indiana', ...EASTERN],
				counties: [counties(CENTRAL, 'Gibson, Jasper, Lake, LaPorte, Newton, Perry, Porter, Posey, Spencer, Starke, Vanderburgh, Warrick')]
			},
			KS: { zones: CENTRAL, counties: [counties(MOUNTAIN, 'Greeley, Hamilton, Sherman, Wallace')] },
			KY: {
				zones: ['America/Louisville', ...EASTERN],
				counties: [counties(CENTRAL, 'Adair, Allen, Ballard, Barren, Breckinridge, Butler, Caldwell, Calloway, Carlisle, Christian, Clinton, Crittenden, Cumberland, Daviess, Edmonson, Fulton, Graves, Grayson, Green, Hancock, Hart, Henderson, Hickman, Hopkins, Livingston, Logan, Lyon, McCracken, McLean, Marshall, Metcalfe, Monroe, Muhlenberg, Ohio, Russell, Simpson, Todd, Trigg, Union, Warren, Webster')]
			},
			MI: { zones: ['America/Detroit', ...EASTERN], counties: [counties(CENTRAL, 'Dickinson, Gogebic, Iron, Menominee')] },
			NE: {
				zones: CENTRAL,
				counties: [counties(MOUNTAIN, 'Arthur, Banner, Box Butte, Chase, Cheyenne, Dawes, Deuel, Dundy, Garden, Grant, Hooker, Keith, Kimball, Morrill, Perkins, Scotts Bluff, Sheridan, Sioux')]
			},
			ND: { zones: CENTRAL, counties: [counties(MOUNTAIN, 'Adams, Billings, Bowman, Golden Valley, Grant, Hettinger, Slope, Stark')] },
			OR: { zones: PACIFIC, counties: [counties(['America/Boise', ...MOUNTAIN], 'Malheur')] },
			SD: {
				zones: CENTRAL,
				counties: [counties(MOUNTAIN, 'Bennett, Butte, Corson, Custer, Dewey, Fall River, Haakon, Harding, Jackson, Lawrence, Meade, Oglala Lakota, Pennington, Perkins, Shannon, Ziebach')]
			},
			TN: {
				zones: CENTRAL,
				counties: [counties(EASTERN, 'Anderson, Blount, Bradley, Campbell, Carter, Claiborne, Cocke, Grainger, Greene, Hamblen, Hamilton, Hancock, Hawkins, Jefferson, Johnson, Knox, Loudon, McMinn, Meigs, Monroe, Morgan, Polk, Rhea, Roane, Scott, Sevier, Sullivan, Unicoi, Union, Washington')]
			},
			TX: { zones: CENTRAL, counties: [counties(MOUNTAIN, 'El Paso, Hudspeth')] }
		},
		CA: {
			BC: { zones: PACIFIC, counties: [counties(MOUNTAIN_NO_DST.slice().reverse(), 'Peace River, Northern Rockies'), counties(CANADA_MOUNTAIN, 'East Kootenay')] },
			AB: CANADA_MOUNTAIN, SK: ['America/Regina', 'Canada/Saskatchewan'], MB: CENTRAL,
			ON: { zones: CANADA_EASTERN, counties: [counties(CENTRAL, 'Kenora, Rainy River')] },
			QC: { zones: CANADA_EASTERN, counties: [counties(ATLANTIC, 'Les Îles-de-la-Madeleine')] },
			NB: ATLANTIC, NS: ATLANTIC, PE: ATLANTIC,
			// Labrador (mainland, except the southeast coast) is on Atlantic time
			NL: { zones: ['America/St_Johns', 'Canada/Newfoundland'], byCoordinates: (lat, lng) => (lat > 51.6 && lng < -57.5 ? ATLANTIC : null) },
			YT: MOUNTAIN_NO_DST.slice().reverse(), NT: CANADA_MOUNTAIN,
			NU: { zones: CANADA_EASTERN, byCoordinates: (lat, lng) => (lng < -102 ? CANADA_MOUNTAIN : lng < -85 ? CENTRAL : null) }
		},
		MX: {
			default: ['America/Mexico_City'],
			'baja california': ['America/Tijuana', 'America/Los_Angeles'],
			'baja california sur': MOUNTAIN_NO_DST, sinaloa: MOUNTAIN_NO_DST, sonora: MOUNTAIN_NO_DST,
			nayarit: { zones: MOUNTAIN_NO_DST, counties: [counties(['America/Bahia_Banderas', 'America/Mexico_City'], 'Bahía de Banderas')] },
			chihuahua: { zones: ['America/Chihuahua', 'America/Mexico_City'], counties: [counties(MOUNTAIN, 'Juárez')] },
			'quintana roo': ['America/Cancun', 'America/Bogota']
		},
		BR: {
			default: ['America/Sao_Paulo'],
			AM: ['America/Manaus'], RR: ['America/Manaus'], RO: ['America/Manaus'], MT: ['America/Manaus'], MS: ['America/Manaus'],
			AC: ['America/Bogota']
		},
		AU: {
			default: ['Australia/Sydney', 'Australia/Canberra'],
			WA: ['Australia/Perth'], NT: ['Australia/Darwin'], SA: ['Australia/Adelaide'], QLD: ['Australia/Brisbane'],
			ACT: ['Australia/Canberra', 'Australia/Sydney'], TAS: ['Australia/Hobart', 'Australia/Sydney']
		},
		ES: { default: ['Europe/Madrid', 'Europe/Brussels'], canarias: ['Atlantic/Canary', 'Europe/London'], 'canary islands': ['Atlantic/Canary', 'Europe/London'] },
		PT: { default: ['Europe/London'], azores: ['Atlantic/Azores'], acores: ['Atlantic/Azores'], 'regiao autonoma dos acores': ['Atlantic/Azores'] },
		// Approximate longitude bands: Russia's zones follow oblast borders, Indonesia's follow islands
		RU: {
			byCoordinates: (lat, lng) => [
				[60, 'Europe/Moscow'], [76, 'Asia/Yekaterinburg'], [98, 'Asia/Krasnoyarsk'], [113, 'Asia/Irkutsk'],
				[130, 'Asia/Yakutsk'], [147, 'Asia/Vladivostok'], [Infinity, 'Asia/Magadan']
			].filter(([maxLng]) => lng < maxLng).map(([, zone]) => zone).slice(0, 1)
		},
		ID: { byCoordinates: (lat, lng) => [lng < 114.5 ? 'Asia/Bangkok' : lng < 126 ? 'Asia/Kuala_Lumpur' : 'Asia/Tokyo'] }
	};

	/** Countries on a single zone (as far as GHL's list goes), written as zone: 'ISO codes' */
	const COUNTRY_ZONES = Object.entries({
		'Pacific/Midway': 'AS UM',
		'Pacific/Honolulu': 'CK PF',
		'America/Bogota': 'CO PE EC PA JM KY',
		'America/Guatemala': 'GT SV HN CR',
		'America/Managua': 'NI',
		'America/Belize': 'BZ',
		'America/New_York': 'BS HT TC',
		'America/Caracas': 'VE GY',
		'America/Manaus': 'BO',
		'America/Santo_Domingo': 'DO PR VI VG AI AG DM GD KN LC VC MS BB TT AW CW BQ SX MF BL GP MQ',
		'Canada/Atlantic': 'BM',
		'America/Argentina/Buenos_Aires': 'AR',
		'America/Asuncion': 'PY',
		'America/Montevideo': 'UY',
		'America/Santiago': 'CL',
		'America/Godthab': 'GL',
		'Atlantic/Cape_Verde': 'CV',
		'Africa/Casablanca': 'MA EH',
		UTC: 'IS GH SN CI ML BF GM GN GW LR SL TG MR SH ST',
		'Europe/London': 'GB IE IM JE GG FO',
		'Africa/Algiers': 'DZ TN',
		'Africa/Lagos': 'NG CM BJ NE TD CF CG CD GA GQ AO',
		'Europe/Amsterdam': 'NL',
		'Europe/Brussels': 'BE FR MC LU DE CH LI AT IT SM VA MT AD',
		'Europe/Oslo': 'NO DK SE SJ',
		'Europe/Belgrade': 'RS PL CZ SK HU HR SI ME MK AL XK',
		'Europe/Sarajevo': 'BA',
		'Africa/Harare': 'ZW ZM MW MZ BW ZA NA LS SZ RW BI LY SD SS',
		'Africa/Cairo': 'EG',
		'Africa/Nairobi': 'KE TZ UG ET SO DJ ER KM MG YT',
		'Asia/Amman': 'JO SY',
		'Asia/Baghdad': 'IQ TR',
		'Asia/Jerusalem': 'IL PS',
		'Asia/Kuwait': 'KW SA YE',
		'Asia/Qatar': 'QA BH',
		'Europe/Athens': 'GR CY LB',
		'Europe/Bucharest': 'RO MD BG UA',
		'Europe/Helsinki': 'FI EE LV LT AX',
		'Europe/Moscow': 'BY',
		'Asia/Tehran': 'IR',
		'Asia/Baku': 'AZ GE AM',
		'Asia/Dubai': 'AE OM SC MU RE',
		'Asia/Kabul': 'AF',
		'Asia/Almaty': 'KZ',
		'Asia/Karachi': 'PK UZ TJ TM MV',
		'Asia/Kolkata': 'IN',
		'Asia/Colombo': 'LK',
		'Asia/Kathmandu': 'NP',
		'Asia/Dhaka': 'BD BT KG IO',
		'Asia/Rangoon': 'MM CC',
		'Asia/Bangkok': 'TH VN KH LA CX',
		'Asia/Kuala_Lumpur': 'MY SG BN PH',
		'Asia/Shanghai': 'CN HK MO MN',
		'Asia/Taipei': 'TW',
		'Asia/Seoul': 'KR KP',
		'Asia/Tokyo': 'JP PW TL',
		'Pacific/Guam': 'GU MP PG',
		'Asia/Magadan': 'SB NC VU',
		'Pacific/Fiji': 'FJ MH KI TV NR WF',
		'Pacific/Auckland': 'NZ',
		'Pacific/Tongatapu': 'TO WS'
	}).reduce((map, [zone, codes]) => {
		codes.split(' ').forEach(code => { map[code] = [zone]; });
		return map;
	}, {});

	/**
	 * Time zones for an address, best first (empty if we can't tell, so the field is left alone)
	 * @param {{countryCode: string, state: string, stateCode: string, county: string, latitude: (number|string), longitude: (number|string)}} address
	 * @returns {string[]} IANA IDs from GHL's Time zone list
	 */
	function getTimeZoneCandidates(address) {
		const cc = (address.countryCode || '').toUpperCase();
		const lat = parseFloat(address.latitude);
		const lng = parseFloat(address.longitude);
		const regions = REGION_ZONES[cc];
		if (!regions) return COUNTRY_ZONES[cc] || [];

		const keys = [(address.stateCode || '').toUpperCase(), normalizeName(address.state)].filter(Boolean);
		const entry = keys.map(key => (Object.prototype.hasOwnProperty.call(regions, key) ? regions[key] : null)).find(Boolean) || regions;
		const spec = Array.isArray(entry) ? { zones: entry } : entry;

		const county = normalizeCounty(address.county);
		const exception = county && spec.counties?.find(([, names]) => names.has(county));
		if (exception) return exception[0];
		const byCoordinates = !isNaN(lat) && !isNaN(lng) && spec.byCoordinates?.(lat, lng);
		if (byCoordinates?.length) return byCoordinates;
		return spec.zones || regions.default || [];
	}

	/**
	 * Snapshot the scroll position of every scrollable ancestor of an element
	 * (on Contact Details that's GHL's #record-details-lhs panel).
	 * @param {HTMLElement} element
	 * @returns {Function} Call to put the saved positions back
	 */
	function saveScrollPositions(element) {
		const saved = [];
		for (let el = element?.parentElement; el; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight) {
				saved.push([el, el.scrollTop]);
			}
		}
		return () => saved.forEach(([el, top]) => {
			if (el.scrollTop !== top) el.scrollTop = top;
		});
	}

	/**
	 * Find a HighRise select (a custom component, not a native <select>) by its label text
	 * @param {string} labelText - e.g. 'Time zone' or 'Country'
	 * @param {string} scope - Selector the label must be inside (keeps Contact vs Company fields apart)
	 * @returns {HTMLElement|null} The .hr-base-selection element
	 */
	function getHighRiseSelectByLabel(labelText, scope) {
		const wanted = labelText.toLowerCase().replace(/[^a-z0-9]/g, '');
		const labels = document.querySelectorAll(
			'.hr-form-item-label__text, .n-form-item-label__text, .hr-form-item label, .n-form-item label'
		);
		for (const label of labels) {
			if (label.textContent.toLowerCase().replace(/[^a-z0-9]/g, '') !== wanted || !label.closest(scope)) {
				continue;
			}
			const selection = label.closest('.hr-form-item, .n-form-item')?.querySelector('.hr-base-selection, .n-base-selection');
			if (selection) {
				return selection;
			}
		}
		return null;
	}

	/**
	 * Currently displayed value of a HighRise select.
	 * The label's title attribute holds the full value even when the visible text is truncated.
	 * @param {HTMLElement} selection - The .hr-base-selection element
	 * @returns {string}
	 */
	function getSelectionText(selection) {
		const label = selection.querySelector('.hr-base-selection-label, .n-base-selection-label');
		return (label?.getAttribute('title') || label?.textContent || selection.textContent || '').replace(/\s+/g, ' ').trim();
	}

	/**
	 * Whether text contains an IANA time zone ID as a whole token, e.g. 'GMT-04:00 America/Detroit (EDT)'
	 * contains 'America/Detroit', but 'America/Indiana/Indianapolis' does not contain 'America/Indiana'.
	 */
	function textHasTimeZoneId(text, timeZoneId) {
		if (!text || !timeZoneId) return false;
		const escaped = timeZoneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(^|[\\s(])${escaped}(?=[\\s)]|$)`, 'i').test(text);
	}

	/**
	 * Normalize names for comparison: case, accents, and punctuation-insensitive
	 * (GHL's list has entries like 'AndorrA' and 'Aland Islands', Google returns 'Andorra' and 'Åland Islands')
	 */
	function normalizeName(text) {
		return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	}

	/**
	 * Open a HighRise select and click the first option that matches.
	 * Handles filterable selects (types filterText) and virtualized lists (scrolls to render options).
	 * @param {HTMLElement} selection - The .hr-base-selection element
	 * @param {Function} matches - (optionText) => boolean
	 * @param {string} filterText - Text to type if the select is filterable
	 * @returns {Promise<boolean>} Whether an option was selected (or already selected)
	 */
	async function selectHighRiseOption(selection, matches, filterText) {
		if (matches(getSelectionText(selection))) return true; // Already correct

		const restoreScroll = saveScrollPositions(selection);
		const findOption = () => {
			const options = document.querySelectorAll('.hr-base-select-option, .n-base-select-option');
			return Array.from(options).find(option => matches(option.textContent || '')) || null;
		};

		try {
			// Open the dropdown
			const trigger = selection.querySelector('.hr-base-selection-label, .n-base-selection-label') || selection;
			trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			trigger.click();
			await wait(250);

			let option = findOption();

			// If the select is filterable, type to narrow the list
			if (!option && filterText) {
				const filterInput = selection.querySelector('input.hr-base-selection-input, input.n-base-selection-input');
				if (filterInput) {
					filterInput.focus({ preventScroll: true });
					setNativeInputValue(filterInput, filterText);
					filterInput.dispatchEvent(new Event('input', { bubbles: true }));
					await wait(250);
					option = findOption();
				}
			}

			// Long lists are virtualized (only visible options exist in the DOM), so scroll through to render the rest
			if (!option) {
				const menu = document.querySelector('.hr-base-select-menu, .n-base-select-menu');
				const scroller = menu?.querySelector('.v-vl, .hr-virtual-list, .n-virtual-list, .hr-scrollbar-container, .n-scrollbar-container');
				if (scroller) {
					const step = Math.max(scroller.clientHeight * 0.8, 100);
					for (let top = 0; top <= scroller.scrollHeight && !option; top += step) {
						scroller.scrollTop = top;
						scroller.dispatchEvent(new Event('scroll'));
						await wait(60);
						option = findOption();
					}
				}
			}

			if (option) {
				option.click();
				return true;
			}
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			return false;
		} finally {
			// Opening the menu can scroll GHL's panel down to the select (Time zone is near the bottom).
			// Restore now, and again after Naive UI's ~300ms close transition.
			restoreScroll();
			setTimeout(restoreScroll, 350);
		}
	}

	/**
	 * Select the best time zone for the address in the Contact "Time zone" field.
	 * Changes the field unless it already holds the best zone (e.g. a Michigan contact on
	 * America/New_York becomes America/Detroit). Like other fields, the user still has to click Save.
	 * @param {Object} address - From parsePlace()
	 */
	async function setTimeZone(address) {
		try {
			const candidates = getTimeZoneCandidates(address);
			if (!candidates.length) {
				log(`No time zone mapping for ${address.countryCode} / ${address.state}; leaving Time zone unchanged.`);
				return;
			}

			// Prefer the stable id (label text may be translated per GHL user language)
			const selection =
				document.getElementById('contact.timezone')?.querySelector('.hr-base-selection, .n-base-selection') ||
				getHighRiseSelectByLabel('Time zone', '#record-details-lhs, #field-container');
			if (!selection) return; // No Time zone field on this screen

			if (textHasTimeZoneId(getSelectionText(selection), candidates[0])) {
				return; // Already the best zone; don't touch the dropdown
			}

			for (const timeZoneId of candidates) {
				if (await selectHighRiseOption(selection, text => textHasTimeZoneId(text, timeZoneId), timeZoneId)) {
					log(`Time zone set to ${timeZoneId}`);
					return;
				}
			}
			console.warn(`None of these time zones are in GHL's Time zone dropdown: ${candidates.join(', ')}`);
		} catch (error) {
			console.error('Error setting time zone:', error);
		}
	}

	/**
	 * GHL Country dropdown labels keyed by ISO 3166-1 alpha-2 code (same list on Contact and Company).
	 * Matching by code avoids naming differences (Google 'Czechia' vs GHL 'Czech Republic') and
	 * doesn't depend on the language Google returns names in. Labels are copied verbatim from GHL,
	 * including its quirks ('AndorrA', 'Cote D"Ivoire'). Codes GHL lacks (e.g. SS, CW, BQ, BL) log a warning.
	 * Source of truth: ghl-dom-reference/select-options-country-timezone.json (re-export it when GHL changes the list).
	 */
	const GHL_COUNTRY_BY_ISO = {
		AF: 'Afghanistan', AX: 'Aland Islands', AL: 'Albania', DZ: 'Algeria', AS: 'American Samoa',
		AD: 'AndorrA', AO: 'Angola', AI: 'Anguilla', AQ: 'Antarctica', AG: 'Antigua and Barbuda',
		AR: 'Argentina', AM: 'Armenia', AW: 'Aruba', AU: 'Australia', AT: 'Austria',
		AZ: 'Azerbaijan', BS: 'Bahamas', BH: 'Bahrain', BD: 'Bangladesh', BB: 'Barbados',
		BY: 'Belarus', BE: 'Belgium', BZ: 'Belize', BJ: 'Benin', BM: 'Bermuda',
		BT: 'Bhutan', BO: 'Bolivia', BA: 'Bosnia and Herzegovina', BW: 'Botswana', BV: 'Bouvet Island',
		BR: 'Brazil', IO: 'British Indian Ocean Territory', BN: 'Brunei Darussalam', BG: 'Bulgaria', BF: 'Burkina Faso',
		BI: 'Burundi', KH: 'Cambodia', CM: 'Cameroon', CA: 'Canada', CV: 'Cape Verde',
		KY: 'Cayman Islands', CF: 'Central African Republic', TD: 'Chad', CL: 'Chile', CN: 'China',
		CX: 'Christmas Island', CC: 'Cocos (Keeling) Islands', CO: 'Colombia', KM: 'Comoros', CG: 'Congo',
		CD: 'Congo, The Democratic Republic of the', CK: 'Cook Islands', CR: 'Costa Rica', CI: 'Cote D"Ivoire', HR: 'Croatia',
		CU: 'Cuba', CY: 'Cyprus', CZ: 'Czech Republic', DK: 'Denmark', DJ: 'Djibouti',
		DM: 'Dominica', DO: 'Dominican Republic', EC: 'Ecuador', EG: 'Egypt', SV: 'El Salvador',
		GQ: 'Equatorial Guinea', ER: 'Eritrea', EE: 'Estonia', ET: 'Ethiopia', FK: 'Falkland Islands (Malvinas)',
		FO: 'Faroe Islands', FJ: 'Fiji', FI: 'Finland', FR: 'France', GF: 'French Guiana',
		PF: 'French Polynesia', TF: 'French Southern Territories', GA: 'Gabon', GM: 'Gambia', GE: 'Georgia',
		DE: 'Germany', GH: 'Ghana', GI: 'Gibraltar', GR: 'Greece', GL: 'Greenland',
		GD: 'Grenada', GP: 'Guadeloupe', GU: 'Guam', GT: 'Guatemala', GG: 'Guernsey',
		GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana', HT: 'Haiti', HM: 'Heard Island and McDonald Islands',
		VA: 'Holy See (Vatican City State)', HN: 'Honduras', HK: 'Hong Kong', HU: 'Hungary', IS: 'Iceland',
		IN: 'India', ID: 'Indonesia', IR: 'Iran, Islamic Republic Of', IQ: 'Iraq', IE: 'Ireland',
		IM: 'Isle of Man', IL: 'Israel', IT: 'Italy', JM: 'Jamaica', JP: 'Japan',
		JE: 'Jersey', JO: 'Jordan', KZ: 'Kazakhstan', KE: 'Kenya', KI: 'Kiribati',
		KP: 'Korea People\'s Democratic Republic', KR: 'Republic of Korea', XK: 'Kosovo', KW: 'Kuwait', KG: 'Kyrgyzstan',
		LA: 'Lao People\'s Democratic Republic', LV: 'Latvia', LB: 'Lebanon', LS: 'Lesotho', LR: 'Liberia',
		LY: 'Libyan Arab Jamahiriya', LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', MO: 'Macao',
		MK: 'North Macedonia', MG: 'Madagascar', MW: 'Malawi', MY: 'Malaysia', MV: 'Maldives',
		ML: 'Mali', MT: 'Malta', MH: 'Marshall Islands', MQ: 'Martinique', MR: 'Mauritania',
		MU: 'Mauritius', YT: 'Mayotte', MX: 'Mexico', FM: 'Federated States of Micronesia', MD: 'Moldova, Republic of',
		MC: 'Monaco', MN: 'Mongolia', ME: 'Montenegro', MS: 'Montserrat', MA: 'Morocco',
		MZ: 'Mozambique', MM: 'Myanmar', NA: 'Namibia', NR: 'Nauru', NP: 'Nepal',
		NL: 'Netherlands', AN: 'Netherlands Antilles', NC: 'New Caledonia', NZ: 'New Zealand', NI: 'Nicaragua',
		NE: 'Niger', NG: 'Nigeria', NU: 'Niue', NF: 'Norfolk Island', MP: 'Northern Mariana Islands',
		NO: 'Norway', OM: 'Oman', PK: 'Pakistan', PW: 'Palau', PS: 'Palestinian Territory, Occupied',
		PA: 'Panama', PG: 'Papua New Guinea', PY: 'Paraguay', PE: 'Peru', PH: 'Philippines',
		PN: 'Pitcairn', PL: 'Poland', PT: 'Portugal', PR: 'Puerto Rico', QA: 'Qatar',
		RE: 'Reunion', RO: 'Romania', RU: 'Russian Federation', RW: 'Rwanda', SH: 'Saint Helena',
		KN: 'Saint Kitts and Nevis', LC: 'Saint Lucia', MF: 'Saint Martin', PM: 'Saint Pierre and Miquelon', VC: 'Saint Vincent and the Grenadines',
		WS: 'Samoa', SM: 'San Marino', ST: 'Sao Tome and Principe', SA: 'Saudi Arabia', SN: 'Senegal',
		RS: 'Serbia', SC: 'Seychelles', SL: 'Sierra Leone', SG: 'Singapore', SX: 'Sint Maarten',
		SK: 'Slovakia', SI: 'Slovenia', SB: 'Solomon Islands', SO: 'Somalia', ZA: 'South Africa',
		GS: 'South Georgia and the South Sandwich Islands', ES: 'Spain', LK: 'Sri Lanka', SD: 'Sudan', SR: 'Suriname',
		SJ: 'Svalbard and Jan Mayen', SZ: 'Eswatini', SE: 'Sweden', CH: 'Switzerland', SY: 'Syrian Arab Republic',
		TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania, United Republic of', TH: 'Thailand', TL: 'Timor-Leste',
		TG: 'Togo', TK: 'Tokelau', TO: 'Tonga', TT: 'Trinidad and Tobago', TN: 'Tunisia',
		TR: 'Turkey', TM: 'Turkmenistan', TC: 'Turks and Caicos Islands', TV: 'Tuvalu', UG: 'Uganda',
		GB: 'UK', UA: 'Ukraine', AE: 'United Arab Emirates', US: 'United States', UM: 'United States Minor Outlying Islands',
		UY: 'Uruguay', UZ: 'Uzbekistan', VU: 'Vanuatu', VE: 'Venezuela', VN: 'Vietnam',
		VG: 'Virgin Islands, British', VI: 'Virgin Islands, U.S.', WF: 'Wallis and Futuna', EH: 'Western Sahara', YE: 'Yemen',
		ZM: 'Zambia', ZW: 'Zimbabwe'
	};

	/**
	 * Select the Country dropdown option for an ISO country code (Contact and Company).
	 * Like other fields, the user still has to click Save.
	 * @param {string} type - 'contact' or 'business'
	 * @param {string} countryCode - ISO 3166-1 alpha-2 code from Google (e.g. 'CZ')
	 * @param {string} countryName - Google's name, only used in warnings
	 */
	async function setCountry(type, countryCode, countryName) {
		try {
			const ghlLabel = GHL_COUNTRY_BY_ISO[(countryCode || '').toUpperCase()];
			if (!ghlLabel) {
				console.warn(`Country "${countryName}" (${countryCode}) has no matching option in GHL's Country list.`);
				return;
			}

			// Prefer the stable id on Contact (label text may be translated per GHL user language)
			const selection = type === 'contact'
				? (document.getElementById('contact.country')?.querySelector('.hr-base-selection, .n-base-selection') ||
					getHighRiseSelectByLabel('Country', '#field-container'))
				: getHighRiseSelectByLabel('Country', '.fields, .details-view, #fields-form');
			if (!selection) return;

			const wanted = normalizeName(ghlLabel);
			const selected = await selectHighRiseOption(selection, text => normalizeName(text) === wanted, ghlLabel);
			if (!selected) {
				console.warn(`Country "${ghlLabel}" not found in the Country dropdown.`);
			}
		} catch (error) {
			console.error('Error setting country:', error);
		}
	}

	/**
	 * Force close any open autocomplete dropdowns
	 */
	function closeAutocompleteDropdown() {
		try {
			// Force close any open autocomplete dropdowns
			if (document.activeElement && typeof document.activeElement.blur === 'function') {
				document.activeElement.blur();
			}

			// Hide any autocomplete dropdowns that might be lingering
			const pacContainers = document.querySelectorAll('.tk-pac-container');
			pacContainers.forEach(container => {
				container.hidden = true;
			});

			// Click elsewhere on the page to force close dropdowns
			document.body.click();
		} catch (error) {
			console.error('Error closing autocomplete dropdown:', error);
		}
	}

	/**
	 * Set input value using the native HTMLInputElement prototype setter so Vue/React detects it
	 * @param {HTMLElement} inputElement - The input element to update
	 * @param {string|number} value - The value to set
	 */
	function setNativeInputValue(inputElement, value) {
		if (!inputElement) return;
		const stringValue = value !== undefined && value !== null ? String(value) : '';
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
		if (nativeInputValueSetter) {
			nativeInputValueSetter.call(inputElement, stringValue);
		} else {
			inputElement.value = stringValue;
		}
	}

	/**
	 * Trigger input events on an element to ensure the value is properly recognized
	 * @param {HTMLElement} inputElement - The input element to trigger events on
	 */
	function triggerInputEvents(inputElement) {
		if (!inputElement) return;

		try {
			const currentVal = inputElement.value || '';
			// Create and dispatch events to ensure the value is properly recognized by Vue/HighRise
			const inputEvent = typeof InputEvent === 'function'
				? new InputEvent('input', { bubbles: true, cancelable: true, data: currentVal })
				: new Event('input', { bubbles: true, cancelable: true });
			const changeEvent = new Event('change', { bubbles: true, cancelable: true });
			const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, cancelable: true });
			const blurEvent = new FocusEvent('blur', { bubbles: false, cancelable: true });
			const focusOutEvent = new FocusEvent('focusout', { bubbles: true, cancelable: true });

			inputElement.dispatchEvent(inputEvent);
			inputElement.dispatchEvent(changeEvent);
			inputElement.dispatchEvent(keyupEvent);
			inputElement.dispatchEvent(blurEvent);
			inputElement.dispatchEvent(focusOutEvent);
		} catch (error) {
			console.error('Error triggering input events:', error);
		}
	}

	/**
	 * Set the value of a field and trigger events
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {string} inputLabel - The label of the input field
	 * @param {string} value - The value to set
	 * @returns {boolean} Whether the value was successfully set
	 */
	function setFieldValue(type, inputLabel, value) {
		try {
			const field = getInputElementFromText(type, inputLabel);

			if (field) {
				// Focus first so HighRise inline-edit fields enter edit state before value changes
				field.focus({ preventScroll: true });
				field.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
				field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
				setNativeInputValue(field, value);
				triggerInputEvents(field);
				field.blur();
				return true; // Successfully set value
			}
			return false; // Failed to find field
		} catch (error) {
			console.error('Error setting field value:', error);
			return false;
		}
	}

	/**
	 * Get an input element based on its label text
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {string} textString - The label text to search for
	 * @returns {HTMLElement|null} The input element or null if not found
	 */
	function getInputElementFromText(type, textString) {
		if (!type || !textString) {
			return null;
		}

		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return null;
		}

		try {
			// Check cache first (and ensure cached element is still connected to DOM)
			const cacheKey = `${type}-${textString}`;
			if (cache.elements[cacheKey]) {
				if (!cache.elements[cacheKey].isConnected) {
					delete cache.elements[cacheKey];
				} else if (type === 'appt' && !isAppointmentDropdownCustom()) {
					delete cache.elements[cacheKey];
					return null;
				} else {
					return cache.elements[cacheKey];
				}
			}

			// Handle typos in the HTML DOM like 'Enter  Meeting Location' having a double space.
			const normalizedSearch = textString.toLowerCase().replace(/\s+/g, ''); // Example: 'entermeetinglocation'

			let searchWithin = [];

			// Find input from labels text (scoped to Contact vs Company/Business vs Appointment containers)
			if (type === 'contact') {
				searchWithin = document.querySelectorAll(
					'#field-container .hr-form-item-label__text, ' +
					'#field-container .hr-form-item label, ' +
					'#field-container .n-form-item-label__text, ' +
					'#field-container .n-form-item label, ' +
					'.form-group .label, ' +
					'.form-group label'
				);
			} else if (type === 'business') {
				searchWithin = document.querySelectorAll(
					'.fields .hr-form-item-label__text, ' +
					'.fields .n-form-item-label__text, ' +
					'.details-view .hr-form-item-label__text, ' +
					'.details-view .n-form-item-label__text'
				);
			} else if (type === 'appt') {
				searchWithin = document.querySelectorAll('.bookAppointmentFormContainer #meeting-location-text-input');
			}

			if (!searchWithin.length) {
				return null;
			}

			let result = null;

			if (type !== 'appt') { // Appointment input does not have a label.
				const findMatchingInput = (exactMatchOnly) => {
					for (const label of searchWithin) {
						const normalizedLabel = label.textContent.trim().toLowerCase().replace(/\s+/g, '');
						const isMatch = exactMatchOnly
							? normalizedLabel === normalizedSearch
							: normalizedLabel.includes(normalizedSearch);

						if (isMatch) {
							let container = null;
							if (type === 'contact') {
								container =
									label.closest('#field-container') ||
									label.closest('.form-group') ||
									label.closest('.hr-form-item') ||
									label.closest('.n-form-item');
							} else if (type === 'business') {
								container =
									label.closest('.fields') ||
									label.closest('.hr-form-item') ||
									label.closest('.n-form-item');
							}
							const input = container
								? container.querySelector('input[type="text"], input.hr-input__input-el, input.n-input__input-el')
								: null;
							if (input) {
								return input;
							}
						}
					}
					return null;
				};

				// Prefer exact label match first (e.g. 'State' vs custom fields containing 'state'), then fallback to substring match
				result = findMatchingInput(true) || findMatchingInput(false);
			} else { // For appointment type
				// For appointment, we directly look for the input within the meeting-location-text-input
				const inputs = document.querySelectorAll(APPT_INPUT_SELECTOR);
				if (inputs.length === 1) {
					result = inputs[0];
				}
			}

			// Also check each input's Placeholders text if no result found yet
			if (!result) {
				let inputs = [];
				for (const label of searchWithin) {
					try {
						const labelInputs = label.querySelectorAll('input[placeholder]');
						inputs = [...inputs, ...labelInputs];
					} catch (error) {
						console.error('Error accessing element:', error);
					}
				}

				for (const input of inputs) {
					try {
						if (input.placeholder) {
							const normalizedPlaceholder = input.placeholder.toLowerCase().replace(/\s+/g, '');
							if (normalizedPlaceholder.includes(normalizedSearch)) {
								result = input;
								break;
							}
						}
					} catch (error) {
						console.error('Error processing input:', error);
					}
				}
			}

			// Cache the result if found
			if (result) {
				cache.elements[cacheKey] = result;
			}

			return result;
		} catch (error) {
			console.error('Error finding input element:', error);
			return null;
		}
	}

	/**
	 * Try to attach autocomplete to a Contact or Company input, retrying while the input mounts
	 * @param {string} type - 'contact' or 'business'
	 * @param {HTMLElement} inputElement - The input element to attach autocomplete to
	 * @param {number} retries - The number of retries left
	 */
	function tryAttachAutocomplete(type, inputElement, retries = config.maxRetries) {
		if (retries <= 0) {
			console.error('Failed to attach autocomplete after maximum attempts.');
			return;
		}

		if (inputElement) {
			embedGoogleMap(type);
			attachAutocompleteToElement(type, inputElement);
		} else {
			setTimeout(() => {
				tryAttachAutocomplete(type, getStreetAddressInput(type), retries - 1);
			}, config.retryTime);
		}
	}

	/**
	 * Check if Google Maps API is loaded and attach autocomplete
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 */
	function checkGoogleMapsLoaded(type) {
		if (!type) {
			return;
		}

		if (!loadGoogleMapsApi()) {
			return;
		}

		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return;
		}

		let inputElement = getStreetAddressInput(type);

		if (!inputElement) {
			return;
		}

		if (isGooglePlacesReady()) {
			// Special handling for appointment type
			if (type === 'appt') {
				reattachAppointmentAutocomplete();
			} else {
				tryAttachAutocomplete(type, inputElement);
			}
		} else {
			setTimeout(() => {
				checkGoogleMapsLoaded(type);
			}, 500);
		}
	}

	/**
	 * Get the street address input selector for the specified type
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @returns {HTMLElement|false} The input element or false if not found
	 */
	function getStreetAddressInput(type) {
		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return false;
		}

		// Check cache first (and verify element is still connected to the DOM)
		const cacheKey = `street-address-${type}`;
		if (cache.elements[cacheKey]) {
			if (!cache.elements[cacheKey].isConnected) {
				delete cache.elements[cacheKey];
			} else if (type === 'appt' && !isAppointmentDropdownCustom()) {
				delete cache.elements[cacheKey];
				return false;
			} else {
				return cache.elements[cacheKey];
			}
		}

		let getSelector = '';

		if (type === 'contact') {
			getSelector = getInputElementFromText(type, 'Street Address');
		} else if (type === 'business') {
			getSelector = getInputElementFromText(type, 'Address');
		} else if (type === 'appt') {
			getSelector = getInputElementFromText(type, 'Enter  Meeting Location'); // with extra space typo
		} else {
			return false;
		}

		if (!getSelector) {
			return false;
		}

		// Cache the result
		cache.elements[cacheKey] = getSelector;

		return getSelector;
	}

	// Track active page observer so we don't register duplicates
	let pageObserver = null;

	/**
	 * Clear cached elements for a specific type ('contact', 'business', or 'appt')
	 * @param {string} type - The address type to clear
	 */
	function clearTypeCache(type) {
		Object.keys(cache.elements).forEach(key => {
			if (key.startsWith(`${type}-`) || key === `street-address-${type}`) {
				delete cache.elements[key];
			}
		});
	}

	/**
	 * Inspect current DOM for Contact, Company/Business, and Appointment inputs across all screens
	 */
	function scanAndAttachAddressFields() {
		// Prune any disconnected elements from cache
		Object.keys(cache.elements).forEach(key => {
			if (!cache.elements[key] || !cache.elements[key].isConnected) {
				delete cache.elements[key];
			}
		});

		// 1. Check Contact Street Address input
		const contactAddressInput = getStreetAddressInput('contact');
		if (contactAddressInput && !contactAddressInput.dataset.tkAutocompleteAttached) {
			checkGoogleMapsLoaded('contact');
		}

		// 2. Check Company / Business Address input
		const businessAddressInput = getStreetAddressInput('business');
		if (businessAddressInput && !businessAddressInput.dataset.tkAutocompleteAttached) {
			checkGoogleMapsLoaded('business');
		}

		// 3. Check Book Appointment Modal (works from Calendars, Contacts, Conversations, Opportunities, etc.)
		if (document.querySelector('.bookAppointmentFormContainer')) {
			setupLocationDropdownListener();
			if (isAppointmentDropdownCustom()) {
				const apptAddressInput = getStreetAddressInput('appt');
				if (apptAddressInput && !apptAddressInput.dataset.tkAutocompleteAttached) {
					checkGoogleMapsLoaded('appt');
				}
			}
		}
	}

	/**
	 * Observe page changes to detect when address inputs are added to the DOM
	 */
	function observePageChanges() {
		let observerTimeout = null;

		scanAndAttachAddressFields();

		if (pageObserver) {
			return;
		}

		pageObserver = new MutationObserver(function (mutations) {
			if (observerTimeout) {
				clearTimeout(observerTimeout);
			}

			observerTimeout = setTimeout(() => {
				try {
					const hasRelevantMutation = mutations.some(
						mutation => mutation.addedNodes.length > 0 || mutation.type === 'attributes'
					);
					if (!hasRelevantMutation) {
						return;
					}

					scanAndAttachAddressFields();
				} catch (error) {
					console.error('Error in mutation observer:', error);
				}
			}, config.debounceTime);
		});

		// Start observing the document body for added nodes
		pageObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});
	}

	// Ensure autocomplete is attached whenever the user clicks/focuses into Contact, Company, or Appointment address inputs
	document.addEventListener('focusin', function (event) {
		const target = event.target;
		if (!target || target.tagName !== 'INPUT' || target.dataset.tkAutocompleteAttached) {
			return;
		}
		const apptAddressInput = getStreetAddressInput('appt');
		if (apptAddressInput && target === apptAddressInput) {
			setupLocationDropdownListener();
			checkGoogleMapsLoaded('appt');
			return;
		}
		const contactAddressInput = getStreetAddressInput('contact');
		if (contactAddressInput && target === contactAddressInput) {
			checkGoogleMapsLoaded('contact');
			return;
		}
		const businessAddressInput = getStreetAddressInput('business');
		if (businessAddressInput && target === businessAddressInput) {
			checkGoogleMapsLoaded('business');
		}
	});

	/**
	 * Whether the URL is a Company / Business / custom Object list (Company details open in a side panel)
	 * @returns {boolean}
	 */
	function isCompanyPath() {
		return /\/(businesses|companies|objects)/.test(window.location.pathname);
	}

	/**
	 * Check if the current page is relevant for address autocomplete
	 * @returns {boolean} Whether the current page is relevant
	 */
	function isRelevantScreen() {
		observePageChanges();

		if (isCompanyPath()) {
			setupBusinessModalObserver();
			return true;
		}

		return window.location.pathname.includes('/contacts/detail/');
	}

	let businessModalIntervalRunning = false;

	/**
	 * Set up an observer to watch for the business/company modal side panel
	 */
	function setupBusinessModalObserver() {
		if (businessModalIntervalRunning) {
			return;
		}
		businessModalIntervalRunning = true;
		log('Setting up business modal observer');

		let lastRecordId = null;
		let lastCompanyName = null;

		// Check for recordId or company panel changes every 300ms
		const recordIdInterval = setInterval(() => {
			try {
				const urlParams = new URLSearchParams(window.location.search);
				const currentRecordId = urlParams.get('recordId');
				const currentCompanyName = document.querySelector('.details-view .primary-property-name')?.textContent?.trim() || null;

				if (currentRecordId !== lastRecordId || (currentCompanyName && currentCompanyName !== lastCompanyName)) {
					lastRecordId = currentRecordId;
					lastCompanyName = currentCompanyName;

					if (currentRecordId || currentCompanyName) {
						clearTypeCache('business');

						const existingBusinessInput = document.querySelector('.details-view input[data-tk-autocomplete-attached]');
						if (existingBusinessInput) {
							delete existingBusinessInput.dataset.tkAutocompleteAttached;
						}
						if (cache.autocompleteInstances['business']) {
							try {
								cache.autocompleteInstances['business'].destroy();
								delete cache.autocompleteInstances['business'];
							} catch (error) {
								console.error('Error clearing business autocomplete instance:', error);
							}
						}

						setTimeout(() => {
							const detailsPanel = document.querySelector('.details-wrapper .details-view, .details-view, #fields-form');
							if (detailsPanel) {
								const businessAddressInput = getStreetAddressInput('business');
								if (businessAddressInput) {
									delete businessAddressInput.dataset.tkAutocompleteAttached;
									checkGoogleMapsLoaded('business');
								} else {
									const panelContentObserver = new MutationObserver(debounce(function () {
										const addressInput = getStreetAddressInput('business');
										if (addressInput && !addressInput.dataset.tkAutocompleteAttached) {
											checkGoogleMapsLoaded('business');
										}
									}, 200));

									panelContentObserver.observe(detailsPanel, {
										childList: true,
										subtree: true,
										attributes: true
									});

									setTimeout(() => {
										panelContentObserver.disconnect();
									}, 5000);
								}
							}
						}, 500);
					}
				}
			} catch (error) {
				console.error('Error in recordId interval check:', error);
			}
		}, 300);

		const urlCheckInterval = setInterval(() => {
			if (!isCompanyPath() && !document.querySelector('.details-view')) {
				clearInterval(recordIdInterval);
				clearInterval(urlCheckInterval);
				businessModalIntervalRunning = false;
			}
		}, 1000);
	}

	// Function to check URL changes at regular intervals
	let lastUrl = location.href;
	let lastPathWithId = '';

	/**
	 * Extract the path with ID from a URL, ignoring query parameters
	 * @param {string} url - The URL to extract from
	 * @returns {string} The path with ID
	 */
	function extractPathWithId(url) {
		try {
			const urlObj = new URL(url);
			// For contact pages, extract up to the contact ID
			if (urlObj.pathname.includes('/contacts/detail/')) {
				const pathParts = urlObj.pathname.split('/');
				const contactIdIndex = pathParts.indexOf('detail') + 1;
				if (contactIdIndex < pathParts.length) {
					return pathParts.slice(0, contactIdIndex + 1).join('/');
				}
			}
			// For business/company pages, include the recordId parameter if present
			else if (urlObj.search.includes('recordId=')) {
				return urlObj.pathname + '?recordId=' + new URLSearchParams(urlObj.search).get('recordId');
			}
			// Default fallback
			return urlObj.pathname;
		} catch (error) {
			console.error('Error extracting path with ID:', error);
			return url;
		}
	}

	/**
	 * Check if the URL has changed and call isRelevantScreen if it has
	 */
	function checkUrlChange() {
		const currentUrl = location.href;
		const currentPathWithId = extractPathWithId(currentUrl);

		const hasRecordId = currentUrl.includes('recordId=');
		const hadRecordId = lastUrl.includes('recordId=');

		if (
			lastPathWithId !== currentPathWithId ||
			(hasRecordId && !hadRecordId) ||
			(hasRecordId && hadRecordId &&
				new URLSearchParams(new URL(currentUrl).search).get('recordId') !==
				new URLSearchParams(new URL(lastUrl).search).get('recordId'))
		) {
			log('URL change detected, checking if relevant screen');
			lastUrl = currentUrl;
			lastPathWithId = currentPathWithId;
			Object.keys(cache.elements).forEach(key => delete cache.elements[key]);
			isRelevantScreen();
		} else if (lastUrl !== currentUrl) {
			lastUrl = currentUrl;
		}
	}

	// Set an interval to check for URL changes
	setInterval(checkUrlChange, 1000);

	// Listen to the popstate event for back/forward navigation
	window.addEventListener('popstate', isRelevantScreen);

	// Call the function to load the Google Maps API first
	loadGoogleMapsApi();

	// Check URL on initial load
	isRelevantScreen();
})();