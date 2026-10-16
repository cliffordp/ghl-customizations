/**
 * GHL Customizations: Google Maps Address Autocomplete & Map Embed (CRM)
 * Repository: https://github.com/cliffordp/ghl-customizations
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
	const config = {
		debounceTime: 500,
		retryTime: 4000,
		maxRetries: 3,
		mapHeight: '240',
		modalWaitTime: 300
	};

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
	 * Check if the appointment dropdown is set to 'Custom'\n		 * @returns {boolean} Whether the dropdown is set to 'Custom'
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

			const streetAddressInput = getStreetAddressInputSelector(type);
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

		console.log('Attempting to reattach appointment autocomplete...');

		// Only proceed if dropdown is 'Custom'
		if (!isAppointmentDropdownCustom()) {
			console.log('Dropdown is not Custom, skipping autocomplete attachment');
			return;
		}

		// Clear any existing autocomplete instances for appointment
		if (cache.autocompleteInstances['appt']) {
			try {
				const apptInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
				if (apptInput) {
					console.log('Clearing existing autocomplete listeners');
					destroyPlacesAutocomplete(apptInput);
					delete apptInput.dataset.tkAutocompleteAttached;
				}
				delete cache.autocompleteInstances['appt'];
			} catch (error) {
				console.error('Error clearing existing autocomplete:', error);
			}
		}

		// Get the appointment address input
		const apptAddressInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
		if (!apptAddressInput) {
			console.error('Could not find appointment address input');
			return;
		}

		// Check if Google Maps Places API is loaded
		if (!isGooglePlacesReady()) {
			console.log('Google Maps API not loaded yet, waiting...');
			setTimeout(reattachAppointmentAutocomplete, 500);
			return;
		}

		// If we have a stored address value, restore it
		if (lastKnownAddressValue && !apptAddressInput.value) {
			console.log('Restoring saved address value before attaching autocomplete:', lastKnownAddressValue);
			setNativeInputValue(apptAddressInput, lastKnownAddressValue);
			triggerInputEvents(apptAddressInput);
		}

		// Attach autocomplete
		console.log('Attaching autocomplete to appointment input');

		try {
			// Create new autocomplete instance directly
			const autocomplete = createPlacesAutocomplete(apptAddressInput, function (place) {
				console.log('Appointment autocomplete place selected');

				if (!place || !place.geometry) {
					console.error('Invalid place selected or no geometry');
					return;
				}

				// Ensure the dropdown is still 'Custom'
				if (!isAppointmentDropdownCustom()) {
					console.log('Dropdown no longer Custom, ignoring selection');
					return;
				}

				console.log('Setting appointment address to:', place.formatted_address);

				// Store the address value for later use
				lastKnownAddressValue = place.formatted_address;
				console.log('Stored address value for future use:', lastKnownAddressValue);

				// Set the input value to the formatted address and force update
				setNativeInputValue(apptAddressInput, place.formatted_address);
				triggerInputEvents(apptAddressInput);

				// Embed map for appointment with the selected address
				console.log('Embedding map for appointment with address:', place.formatted_address);
				embedGoogleMap('appt', place.formatted_address);

				// Force close any open autocomplete dropdowns
				closeAutocompleteDropdown();
			});

			// Store the autocomplete instance for future reference
			cache.autocompleteInstances['appt'] = autocomplete;
			apptAddressInput.dataset.tkAutocompleteAttached = 'true';

			console.log('Appointment autocomplete attached successfully');
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
	 * Store the current address value for later use
	 * This should be called whenever an address is selected
	 */
	function storeCurrentAddressValue() {
		try {
			const apptInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
			if (apptInput && apptInput.value) {
				lastKnownAddressValue = apptInput.value;
				console.log('Stored address value:', lastKnownAddressValue);
			}
		} catch (error) {
			console.error('Error storing address value:', error);
		}
	}

	/**
	 * Force reattachment of the appointment autocomplete
	 * This can be called from anywhere to ensure the autocomplete is attached
	 */
	function forceReattachAppointmentAutocomplete() {
		if (!loadGoogleMapsApi()) {
			return;
		}

		console.log('Forcing reattachment of appointment autocomplete');
		forceReattachmentNeeded = false;

		// Only proceed if dropdown is 'Custom'
		if (!isAppointmentDropdownCustom()) {
			console.log('Dropdown is not Custom, skipping forced reattachment');
			return;
		}

		try {
			// First, clear any existing autocomplete instances
			const apptInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
			if (apptInput) {
				console.log('Clearing autocomplete listeners');

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
					console.log('Restoring saved address value:', lastKnownAddressValue);
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
			const apptAddressInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
			if (apptAddressInput) {
				console.log('Reattaching autocomplete to input');

				// Double-check if the value is set correctly
				if (lastKnownAddressValue && !apptAddressInput.value) {
					console.log('Value was lost, restoring again:', lastKnownAddressValue);
					setNativeInputValue(apptAddressInput, lastKnownAddressValue);
					triggerInputEvents(apptAddressInput);
				}

				reattachAppointmentAutocomplete();
			} else {
				console.log('Could not find appointment input');
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
			console.log('Setting up location dropdown & radio listener on appointment modal');

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

				const apptInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
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

			const address1 = getStreetAddressInputSelector(type)?.value?.trim();

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
	 * Attach Google Maps autocomplete to an input element
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {HTMLElement} inputElement - The input element to attach autocomplete to
	 */
	async function attachAutocompleteToElement(type, inputElement) {
		if (!inputElement) {
			return;
		}

		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return;
		}

		try {
			// If there's already an autocomplete instance for this input, remove it
			if (cache.autocompleteInstances[type]) {
				cache.autocompleteInstances[type].destroy();
				delete cache.autocompleteInstances[type];
			}

			// Create new autocomplete instance (also destroys any instance already on this input)
			const autocomplete = createPlacesAutocomplete(inputElement, function (place) {
				if (!place || !place.geometry) {
					return; // Invalid place selected
				}

				let fullStreet = '';
				let streetNumber = '';
				let streetName = '';
				let addressLine2 = '';
				let city = '';
				let state = '';
				let postal_code = '';
				let latitude = '';
				let longitude = '';
				let country = '';
				let countryCode = '';

				// Extract address components
				place.address_components.forEach(component => {
					switch (component.types[0]) {
						case 'street_number':
							streetNumber = component.long_name;
							break;
						case 'route':
							streetName = component.long_name;
							break;
						case 'subpremise':
						case 'sublocality_level_1':
							addressLine2 = component.long_name;
							break;
						case 'locality':
						case 'administrative_area_level_3':
						case 'postal_town':
							city = component.long_name;
							break;
						case 'administrative_area_level_1':
							state = component.long_name; // Automated tax calculation requires long_name (e.g. "Oklahoma" not "OK").
							break;
						case 'postal_code':
							postal_code = component.long_name;
							break;
						case 'country':
							country = component.long_name;
							countryCode = component.short_name; // ISO 3166-1 alpha-2, e.g. 'CZ'
							break;
					}
				});

				fullStreet = `${streetNumber} ${streetName}`.trim() + (addressLine2 ? ', ' + addressLine2 : '');

				if (place.geometry && place.geometry.location) {
					latitude = place.geometry.location.lat();
					longitude = place.geometry.location.lng();
				}

				if (type === 'appt') {
					// For appointment type, only proceed if dropdown is still 'Custom'
					if (!isAppointmentDropdownCustom()) {
						return;
					}

					// Ensure the value is properly set for appointment type
					setNativeInputValue(inputElement, place.formatted_address); // Single line address field.

					// Force the input to update by triggering events
					triggerInputEvents(inputElement);

					// Force close the autocomplete dropdown
					closeAutocompleteDropdown();

					// Now we can embed map for appointment type
					embedGoogleMap(type, place.formatted_address);

					// Reattach autocomplete after a longer delay to ensure it works for subsequent typing
					// and to ensure the dropdown is fully closed
					setTimeout(() => {
						attachAutocompleteToElement(type, inputElement);
					}, config.modalWaitTime);
				} else {
					// For contact and business types, update street address first while focused
					const streetInput = type === 'business' ? inputElement : (getStreetAddressInputSelector(type) || inputElement);
					if (streetInput) {
						setNativeInputValue(streetInput, fullStreet);
						triggerInputEvents(streetInput);
					}

					setFieldValue(type, 'City', city);
					setFieldValue(type, 'State', state);
					setFieldValue(type, 'Postal Code', postal_code);
					setFieldValue(type, 'Latitude', latitude); // Custom Field name
					setFieldValue(type, 'Longitude', longitude); // Custom Field name
					// Country is a dropdown, set below via setCountry()

					// Force close the autocomplete dropdown
					closeAutocompleteDropdown();

					// Embed map for non-appointment types
					embedGoogleMap(type, place.formatted_address);

					// Dropdowns are set one at a time so two menus are never open at once.
					// Runs after closeAutocompleteDropdown() so its body click can't close the menus we open.
					(async () => {
						const savedScroll = captureScrollState(streetInput || inputElement);
						if (countryCode) {
							await setCountry(type, countryCode, country);
						}
						// Time zone only exists on Contact Details
						if (type === 'contact' && setTimeZoneEnabled && latitude !== '' && longitude !== '') {
							await setTimeZoneFromCoordinates(latitude, longitude, state, countryCode);
						}
						restoreScrollState(savedScroll);
						requestAnimationFrame(() => restoreScrollState(savedScroll));
						setTimeout(() => restoreScrollState(savedScroll), 100);
					})();

					// For business type, reattach autocomplete after a delay
					if (type === 'business') {
						setTimeout(() => {
							attachAutocompleteToElement(type, inputElement);
						}, config.modalWaitTime);
					}
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

	/**
	 * Equivalent IANA timezone groups.
	 * If the contact's Time zone field is already set to an equivalent zone in the same group,
	 * we keep it to avoid unnecessary UI changes and dropdown interactions.
	 */
	const TIMEZONE_GROUPS = {
		eastern: [
			'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville',
			'America/Kentucky/Monticello', 'America/Indiana/Indianapolis',
			'America/Indiana/Vincennes', 'America/Indiana/Winamac',
			'America/Indiana/Marengo', 'America/Indiana/Petersburg',
			'America/Indiana/Vevay', 'America/Toronto', 'America/Montreal',
			'US/Eastern', 'EST5EDT', 'EDT', 'EST', 'Eastern Time'
		],
		central: [
			'America/Chicago', 'America/Indiana/Knox', 'America/Indiana/Tell_City',
			'America/Menominee', 'America/North_Dakota/Center',
			'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah',
			'America/Winnipeg', 'US/Central', 'CST6CDT', 'CDT', 'CST', 'Central Time'
		],
		mountain: [
			'America/Denver', 'America/Boise', 'America/Edmonton',
			'US/Mountain', 'MST7MDT', 'MDT', 'MST', 'Mountain Time'
		],
		arizona: [
			'America/Phoenix', 'America/Hermosillo', 'US/Arizona', 'Arizona'
		],
		pacific: [
			'America/Los_Angeles', 'America/Vancouver', 'US/Pacific',
			'PST8PDT', 'PDT', 'PST', 'Pacific Time'
		],
		alaska: [
			'America/Anchorage', 'America/Juneau', 'America/Sitka',
			'America/Nome', 'America/Yakutat', 'America/Metlakatla',
			'US/Alaska', 'AKST', 'AKDT', 'Alaska'
		],
		hawaii: [
			'Pacific/Honolulu', 'US/Hawaii', 'HST', 'Hawaii'
		]
	};

	/**
	 * Client-side lookup of IANA time zone ID from coordinates and optional state/country.
	 * Resolves directly in the browser so no Google Time Zone API or server-side calls are needed,
	 * keeping the implementation 100% compatible with HTTP-referrer-restricted API keys.
	 *
	 * @param {number|string} latitude
	 * @param {number|string} longitude
	 * @param {string} [state] - Region / state name or 2-letter abbreviation if available
	 * @param {string} [countryCode] - ISO 3166-1 alpha-2 country code
	 * @returns {string} The IANA time zone ID, or '' if undetermined
	 */
	function getTimeZoneIdFromCoordinates(latitude, longitude, state, countryCode) {
		const normState = normalizeName(state || '');
		const cc = (countryCode || '').toUpperCase();

		// State-specific US mappings for canonical IANA zone (supports full name or 2-letter postal code)
		if (cc === 'US' || !cc) {
			if (normState === 'michigan' || normState === 'mi') return 'America/Detroit';
			if (normState === 'indiana' || normState === 'in') return 'America/Indiana/Indianapolis';
			if (normState === 'arizona' || normState === 'az') return 'America/Phoenix';
			if (normState === 'hawaii' || normState === 'hi') return 'Pacific/Honolulu';
			if (normState === 'alaska' || normState === 'ak') return 'America/Anchorage';
			if (['california', 'ca', 'washington', 'wa', 'oregon', 'or', 'nevada', 'nv'].includes(normState)) {
				return 'America/Los_Angeles';
			}
			if (['texas', 'tx', 'illinois', 'il', 'wisconsin', 'wi', 'minnesota', 'mn', 'iowa', 'ia', 'missouri', 'mo', 'arkansas', 'ar', 'louisiana', 'la', 'oklahoma', 'ok', 'kansas', 'ks', 'nebraska', 'ne', 'alabama', 'al', 'mississippi', 'ms', 'tennessee', 'tn'].includes(normState)) {
				return 'America/Chicago';
			}
			if (['colorado', 'co', 'utah', 'ut', 'new mexico', 'nm', 'wyoming', 'wy', 'montana', 'mt'].includes(normState)) {
				return 'America/Denver';
			}
			if (normState === 'idaho' || normState === 'id') {
				return 'America/Boise';
			}
			if (['new york', 'ny', 'florida', 'fl', 'ohio', 'oh', 'pennsylvania', 'pa', 'north carolina', 'nc', 'georgia', 'ga', 'virginia', 'va', 'massachusetts', 'ma', 'new jersey', 'nj', 'maryland', 'md', 'south carolina', 'sc', 'connecticut', 'ct', 'kentucky', 'ky', 'maine', 'me', 'new hampshire', 'nh', 'rhode island', 'ri', 'delaware', 'de', 'district of columbia', 'dc', 'vermont', 'vt', 'west virginia', 'wv'].includes(normState)) {
				return 'America/New_York';
			}
		}

		const lat = parseFloat(latitude);
		const lng = parseFloat(longitude);
		if (isNaN(lat) || isNaN(lng)) return '';

		// United States & Territories (coordinate fallback)
		if (lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66) {
			if (lng < -114) {
				return 'America/Los_Angeles'; // Pacific
			} else if (lng < -102) {
				if (lat >= 31.3 && lat <= 37.0 && lng >= -114.8 && lng <= -109.0) {
					return 'America/Phoenix';
				}
				return 'America/Denver'; // Mountain
			} else if (lng < -85.5) {
				return 'America/Chicago'; // Central
			} else {
				return 'America/New_York'; // Eastern
			}
		}
		if (lat >= 51 && lat <= 72 && lng >= -170 && lng <= -130) {
			return 'America/Anchorage'; // Alaska
		}
		if (lat >= 18 && lat <= 23 && lng >= -161 && lng <= -154) {
			return 'Pacific/Honolulu'; // Hawaii
		}
		if (lat >= 17.8 && lat <= 18.6 && lng >= -67.4 && lng <= -65.2) {
			return 'America/Puerto_Rico'; // Puerto Rico
		}

		// Canada
		if (lat > 48 && lat <= 70 && lng >= -141 && lng <= -52) {
			if (lng < -120) return 'America/Vancouver';
			if (lng < -110) return 'America/Edmonton';
			if (lng < -95) return 'America/Winnipeg';
			if (lng < -75) return 'America/Toronto';
			if (lng < -60) return 'America/Halifax';
			return 'America/St_Johns';
		}

		// Europe (major zones)
		if (lat >= 35 && lat <= 71 && lng >= -25 && lng <= 45) {
			if (lng < -5) return 'Europe/London'; // UK, Ireland, Portugal
			if (lng < 20) return 'Europe/Paris'; // Central European (France, Germany, Italy, Spain, etc.)
			return 'Europe/Athens'; // Eastern European (Greece, Finland, Romania, etc.)
		}

		// Australia
		if (lat >= -44 && lat <= -10 && lng >= 112 && lng <= 154) {
			if (lng < 129) return 'Australia/Perth';
			if (lng < 138) return 'Australia/Adelaide';
			if (lat < -30) return 'Australia/Sydney';
			return 'Australia/Brisbane';
		}

		// New Zealand
		if (lat >= -48 && lat <= -34 && lng >= 166 && lng <= 179) {
			return 'Pacific/Auckland';
		}

		// Default fallback using standard longitude time offset zones
		const utcOffsetHours = Math.round(lng / 15);
		const timezoneByOffset = {
			'-12': 'Etc/GMT+12', '-11': 'Pacific/Midway', '-10': 'Pacific/Honolulu',
			'-9': 'America/Anchorage', '-8': 'America/Los_Angeles', '-7': 'America/Denver',
			'-6': 'America/Chicago', '-5': 'America/New_York', '-4': 'America/Halifax',
			'-3': 'America/Sao_Paulo', '-2': 'Atlantic/South_Georgia', '-1': 'Atlantic/Azores',
			'0': 'Europe/London', '1': 'Europe/Paris', '2': 'Europe/Athens',
			'3': 'Europe/Moscow', '4': 'Asia/Dubai', '5': 'Asia/Karachi',
			'6': 'Asia/Dhaka', '7': 'Asia/Bangkok', '8': 'Asia/Singapore',
			'9': 'Asia/Tokyo', '10': 'Australia/Sydney', '11': 'Pacific/Guadalcanal',
			'12': 'Pacific/Auckland'
		};
		return timezoneByOffset[String(utcOffsetHours)] || '';
	}

	/**
	 * Capture scroll positions of an element, all its ancestors, window, and CRM scrollable panels.
	 */
	function captureScrollState(element) {
		const states = [];
		const seen = new Set();

		const add = (el) => {
			if (el && !seen.has(el)) {
				seen.add(el);
				states.push({ el, top: el.scrollTop, left: el.scrollLeft });
			}
		};

		let el = element;
		while (el && el !== document.body && el !== document.documentElement) {
			add(el);
			el = el.parentElement;
		}

		// Also capture common scroll containers in GHL CRM
		const crmContainers = document.querySelectorAll(
			'#field-container, .contact-details, .hl-card-content, .n-layout-sider, .n-layout-content, [class*="overflow-y-auto"], [class*="overflow-auto"], [class*="scrollbar"]'
		);
		crmContainers.forEach(add);

		return {
			states,
			bodyTop: document.body ? document.body.scrollTop : 0,
			docTop: document.documentElement ? document.documentElement.scrollTop : 0,
			windowX: window.scrollX || window.pageXOffset || 0,
			windowY: window.scrollY || window.pageYOffset || 0
		};
	}

	/**
	 * Restore previously captured scroll positions.
	 */
	function restoreScrollState(saved) {
		if (!saved) return;
		for (const { el, top, left } of saved.states) {
			if (el.scrollTop !== top) el.scrollTop = top;
			if (el.scrollLeft !== left) el.scrollLeft = left;
		}
		if (document.body && document.body.scrollTop !== saved.bodyTop) {
			document.body.scrollTop = saved.bodyTop;
		}
		if (document.documentElement && document.documentElement.scrollTop !== saved.docTop) {
			document.documentElement.scrollTop = saved.docTop;
		}
		window.scrollTo(saved.windowX, saved.windowY);
	}

	/**
	 * Find a HighRise select (a custom component, not a native <select>) by its label text
	 * @param {string} labelText - e.g. 'Time zone' or 'Country'
	 * @param {string} scope - Selector the label must be inside (keeps Contact vs Company fields apart)
	 * @returns {HTMLElement|null} The .hr-base-selection element
	 */
	function getHighRiseSelectByLabel(labelText, scope) {
		const wanted = labelText.toLowerCase().replace(/\s+/g, '');
		const labels = document.querySelectorAll('.hr-form-item-label__text, .n-form-item-label__text');
		for (const label of labels) {
			if (label.textContent.trim().toLowerCase().replace(/\s+/g, '') !== wanted || !label.closest(scope)) {
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
	 * Whether option/label text matches a time zone ID as a whole token,
	 * or matches any equivalent time zone in the same geographic time zone group.
	 * e.g. 'GMT-04:00 America/Detroit (EDT)' matches 'America/Detroit' and also matches
	 * 'America/New_York' since both belong to the same Eastern Time group.
	 */
	function textMatchesTimeZone(text, timeZoneId) {
		if (!text || !timeZoneId) return false;
		const cleanText = text.trim();

		// Exact match on timeZoneId token (delimited by boundary, whitespace, slashes, or parens)
		const escaped = timeZoneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (new RegExp(`(^|[/\\s(])${escaped}([/\\s)]|$)`, 'i').test(cleanText)) {
			return true;
		}

		// Equivalent timezone group match (e.g. America/Detroit and America/New_York are both Eastern)
		for (const group of Object.values(TIMEZONE_GROUPS)) {
			if (group.some(id => id.toLowerCase() === timeZoneId.toLowerCase())) {
				for (const altId of group) {
					const altEscaped = altId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					if (new RegExp(`(^|[/\\s(])${altEscaped}([/\\s)]|$)`, 'i').test(cleanText)) {
						return true;
					}
				}
				break;
			}
		}

		return false;
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
		const currentText = (
			selection.querySelector(
				'.hr-base-selection-input__content, .n-base-selection-input__content, .hr-base-selection-label, .n-base-selection-label, .hr-base-selection-overlay__wrapper, .n-base-selection-overlay__wrapper, .hr-base-selection-tags, .n-base-selection-tags, .hr-base-selection-value, .n-base-selection-value'
			)?.textContent ||
			selection.textContent ||
			''
		).replace(/\s+/g, ' ').trim();
		if (matches(currentText)) return true; // Already correct

		const savedScroll = captureScrollState(selection);

		const findOption = () => {
			const options = document.querySelectorAll('.hr-base-select-option, .n-base-select-option');
			return Array.from(options).find(option => matches(option.textContent || '')) || null;
		};

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
			restoreScrollState(savedScroll);
			requestAnimationFrame(() => restoreScrollState(savedScroll));
			setTimeout(() => restoreScrollState(savedScroll), 100);
			return true;
		}
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		restoreScrollState(savedScroll);
		requestAnimationFrame(() => restoreScrollState(savedScroll));
		setTimeout(() => restoreScrollState(savedScroll), 100);
		return false;
	}

	/**
	 * Look up the time zone for coordinates and select it in the Contact "Time zone" field.
	 * Like other fields, the user still has to click Save.
	 */
	async function setTimeZoneFromCoordinates(latitude, longitude, state, countryCode) {
		try {
			const timeZoneId = getTimeZoneIdFromCoordinates(latitude, longitude, state, countryCode);
			if (!timeZoneId) return;

			// Prefer the stable id (label text may be translated per GHL user language)
			const selection =
				document.getElementById('contact.timezone')?.querySelector('.hr-base-selection, .n-base-selection') ||
				getHighRiseSelectByLabel('Time zone', '#field-container');
			if (!selection) return; // No Time zone field on this screen

			const selected = await selectHighRiseOption(selection, text => textMatchesTimeZone(text, timeZoneId), timeZoneId);
			if (!selected) {
				console.warn(`Time zone "${timeZoneId}" not found in the Time zone dropdown.`);
			}
		} catch (error) {
			console.error('Error setting time zone:', error);
		}
	}


	/**
	 * GHL Country dropdown labels keyed by ISO 3166-1 alpha-2 code (same list on Contact and Company).
	 * Matching by code avoids naming differences (Google 'Czechia' vs GHL 'Czech Republic') and
	 * doesn't depend on the language Google returns names in. Labels are copied verbatim from GHL,
	 * including its quirks ('AndorrA', 'Cote D"Ivoire'). Codes GHL lacks (e.g. SS, CW, BQ, BL) log a warning.
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
		GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana', HT: 'Haiti', HM: 'Heard Island and Mcdonald Islands',
		VA: 'Holy See (Vatican City State)', HN: 'Honduras', HK: 'Hong Kong', HU: 'Hungary', IS: 'Iceland',
		IN: 'India', ID: 'Indonesia', IR: 'Iran, Islamic Republic Of', IQ: 'Iraq', IE: 'Ireland',
		IM: 'Isle of Man', IL: 'Israel', IT: 'Italy', JM: 'Jamaica', JP: 'Japan',
		JE: 'Jersey', JO: 'Jordan', KZ: 'Kazakhstan', KE: 'Kenya', KI: 'Kiribati',
		KP: 'Korea, Democratic People"S Republic', KR: 'Korea, Republic of', XK: 'Kosovo', KW: 'Kuwait', KG: 'Kyrgyzstan',
		LA: 'Lao People\'s Democratic Republic', LV: 'Latvia', LB: 'Lebanon', LS: 'Lesotho', LR: 'Liberia',
		LY: 'Libyan Arab Jamahiriya', LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', MO: 'Macao',
		MK: 'Macedonia, The Former Yugoslav Republic of', MG: 'Madagascar', MW: 'Malawi', MY: 'Malaysia', MV: 'Maldives',
		ML: 'Mali', MT: 'Malta', MH: 'Marshall Islands', MQ: 'Martinique', MR: 'Mauritania',
		MU: 'Mauritius', YT: 'Mayotte', MX: 'Mexico', FM: 'Micronesia, Federated States of', MD: 'Moldova, Republic of',
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
		SJ: 'Svalbard and Jan Mayen', SZ: 'Swaziland', SE: 'Sweden', CH: 'Switzerland', SY: 'Syrian Arab Republic',
		TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania, United Republic of', TH: 'Thailand', TL: 'Timor-Leste',
		TG: 'Togo', TK: 'Tokelau', TO: 'Tonga', TT: 'Trinidad and Tobago', TN: 'Tunisia',
		TR: 'Turkey', TM: 'Turkmenistan', TC: 'Turks and Caicos Islands', TV: 'Tuvalu', UG: 'Uganda',
		GB: 'UK', UA: 'Ukraine', AE: 'United Arab Emirates', US: 'United States', UM: 'United States Minor Outlying Islands',
		UY: 'Uruguay', UZ: 'Uzbekistan', VU: 'Vanuatu', VE: 'Venezuela', VN: 'Viet Nam',
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
				field.focus();
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
				const inputs = document.querySelectorAll('.bookAppointmentFormContainer #meeting-location-text-input input');
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
	 * Try to attach autocomplete to an input element with retries
	 * @param {string} type - The type of address ('contact', 'business', or 'appt')
	 * @param {HTMLElement} inputElement - The input element to attach autocomplete to
	 * @param {number} retries - The number of retries left
	 */
	function tryAttachAutocomplete(type, inputElement, retries = config.maxRetries) {
		if (retries <= 0) {
			console.error('Failed to attach autocomplete after maximum attempts.');
			return;
		}

		// For appointment type, only proceed if dropdown is 'Custom'
		if (type === 'appt' && !isAppointmentDropdownCustom()) {
			return;
		}

		if (inputElement) {
			// Special handling for appointment type
			if (type === 'appt') {
				// Use the dedicated function for appointment type
				reattachAppointmentAutocomplete();
			} else {
				// For contact and business types, use the standard approach
				embedGoogleMap(type);
				attachAutocompleteToElement(type, inputElement);
			}
		} else {
			setTimeout(() => {
				tryAttachAutocomplete(type, getStreetAddressInputSelector(type), retries - 1);
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

		let inputElement = getStreetAddressInputSelector(type);

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
	function getStreetAddressInputSelector(type) {
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
		const contactAddressInput = getStreetAddressInputSelector('contact');
		if (contactAddressInput && !contactAddressInput.dataset.tkAutocompleteAttached) {
			checkGoogleMapsLoaded('contact');
		}

		// 2. Check Company / Business Address input
		const businessAddressInput = getStreetAddressInputSelector('business');
		if (businessAddressInput && !businessAddressInput.dataset.tkAutocompleteAttached) {
			checkGoogleMapsLoaded('business');
		}

		// 3. Check Book Appointment Modal (works from Calendars, Contacts, Conversations, Opportunities, etc.)
		if (document.querySelector('.bookAppointmentFormContainer')) {
			setupLocationDropdownListener();
			if (isAppointmentDropdownCustom()) {
				const apptAddressInput = getStreetAddressInputSelector('appt');
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
		const apptAddressInput = getStreetAddressInputSelector('appt');
		if (apptAddressInput && target === apptAddressInput) {
			setupLocationDropdownListener();
			checkGoogleMapsLoaded('appt');
			return;
		}
		const contactAddressInput = getStreetAddressInputSelector('contact');
		if (contactAddressInput && target === contactAddressInput) {
			checkGoogleMapsLoaded('contact');
			return;
		}
		const businessAddressInput = getStreetAddressInputSelector('business');
		if (businessAddressInput && target === businessAddressInput) {
			checkGoogleMapsLoaded('business');
		}
	});

	/**
	 * Check if the current page is relevant for address autocomplete
	 * @returns {boolean} Whether the current page is relevant
	 */
	function isRelevantScreen() {
		observePageChanges();

		if (
			window.location.pathname.includes('/businesses') ||
			window.location.pathname.includes('/companies') ||
			window.location.pathname.includes('/objects')
		) {
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
		console.log('Setting up business modal observer');

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
								const businessAddressInput = getStreetAddressInputSelector('business');
								if (businessAddressInput) {
									delete businessAddressInput.dataset.tkAutocompleteAttached;
									checkGoogleMapsLoaded('business');
								} else {
									const panelContentObserver = new MutationObserver(debounce(function () {
										const addressInput = getStreetAddressInputSelector('business');
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
			if (
				!window.location.pathname.includes('/businesses') &&
				!window.location.pathname.includes('/companies') &&
				!window.location.pathname.includes('/objects') &&
				!document.querySelector('.details-view')
			) {
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
			console.log('URL change detected, checking if relevant screen');
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