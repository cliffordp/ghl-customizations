/**
 * GHL Customizations: Google Maps Address Autocomplete & Map Embed (CRM)
 * Repository: https://github.com/cliffordp/ghl-customizations/tree/main/gmaps-address-autocomplete-crm
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

		let missingKeyWarned = false;
		let placesImportPromise = null;

		// Ensure .pac-container z-index style exists even if loaded as an external .js file
		if (!document.getElementById('tk-gmaps-pac-style')) {
			const styleEl = document.createElement('style');
			styleEl.id = 'tk-gmaps-pac-style';
			styleEl.textContent = '.pac-container { z-index: 10000 !important; }';
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
			return function(...args) {
				const context = this;
				clearTimeout(timeout);
				timeout = setTimeout(() => func.apply(context, args), wait);
			};
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
				typeof google.maps.places.Autocomplete === 'function'
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
			if (cache.autocompleteInstances['appt'] && typeof google !== 'undefined' && google.maps?.event) {
				try {
					const apptInput = document.querySelector('.bookAppointmentFormContainer #meeting-location-text-input input');
					if (apptInput) {
						console.log('Clearing existing autocomplete listeners');
						google.maps.event.clearInstanceListeners(apptInput);
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
				let autocomplete = new google.maps.places.Autocomplete(apptAddressInput, {
					types: ['geocode'],
				});
				
				// Store the autocomplete instance for future reference
				cache.autocompleteInstances['appt'] = autocomplete;
				apptAddressInput.dataset.tkAutocompleteAttached = 'true';
				
				autocomplete.setFields(['address_components', 'geometry', 'formatted_address']);
				
				// Add place_changed event listener
				google.maps.event.addListener(autocomplete, 'place_changed', function() {
					console.log('Appointment autocomplete place changed event fired');
					
					// Get the place details
					let place = autocomplete.getPlace();
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
				if (apptInput && typeof google !== 'undefined') {
					console.log('Clearing autocomplete listeners');
					
					// Clear Google Maps event listeners
					if (google && google.maps && google.maps.event) {
						google.maps.event.clearInstanceListeners(apptInput);
					}
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

				modalContainer.addEventListener('click', function(event) {
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
				const dropdownObserver = new MutationObserver(function() {
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
				if (cache.autocompleteInstances[type] && google.maps?.event) {
					google.maps.event.clearInstanceListeners(inputElement);
					delete cache.autocompleteInstances[type];
				}
				
				// Create new autocomplete instance
				let autocomplete = new google.maps.places.Autocomplete(inputElement, {
					types: ['geocode'],
				});
				
				// Store the autocomplete instance for future reference
				cache.autocompleteInstances[type] = autocomplete;
				inputElement.dataset.tkAutocompleteAttached = 'true';
				
				autocomplete.setFields(['address_components', 'geometry', 'formatted_address']);
				autocomplete.addListener('place_changed', function() {
					let place = autocomplete.getPlace();
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
						//setFieldValue(type, 'Country', country); // Gets set totally differently
						
						// Force close the autocomplete dropdown
						closeAutocompleteDropdown();
						
						// Embed map for non-appointment types
						embedGoogleMap(type, place.formatted_address);
						
						// For business type, reattach autocomplete after a delay
						if (type === 'business') {
							setTimeout(() => {
								attachAutocompleteToElement(type, inputElement);
							}, config.modalWaitTime);
						}
					}
				});
			} catch (error) {
				console.error('Error attaching autocomplete:', error);
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
				
				// Remove any pac-container elements that might be lingering
				const pacContainers = document.querySelectorAll('.pac-container');
				pacContainers.forEach(container => {
					container.style.display = 'none';
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
			
			pageObserver = new MutationObserver(function(mutations) {
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
		document.addEventListener('focusin', function(event) {
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
							if (cache.autocompleteInstances['business'] && typeof google !== 'undefined') {
								try {
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
										const panelContentObserver = new MutationObserver(debounce(function() {
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