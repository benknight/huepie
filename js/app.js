define(function (require) {
	'use strict';

	var $          = require('jquery');
	var _          = require('lodash');
	var d3         = require('d3');
	var tinycolor  = require('tinycolor');
	var jsHue      = require('jshue');
	var colors     = require('hue-hacking');
	var ColorWheel = require('colorwheel');
	var observejs  = require('observe-js');

	// Collection of strings the app may need to show the user
	var msg = {
		CONNECTING              : 'Connecting...',
		SUCCESS                 : 'Successfully connected to local bridge!',
		NO_BRIDGE               : 'No Philips Hue bridge found on your local network.',
		PRESS_BUTTON            : 'Please authenticate by pressing the button on the Hue bridge.',
		CONNECTION_ERROR_GENERIC: 'Unable to connect to the Internet.',
		CONNECTION_ERROR_BRIDGE : 'Unable to connect to local bridge. Try a refresh.',
		UNAUTHORIZED_USER       : 'Unauthorized user.'
	};

	var app = {
		APP_ID: 'colorwheel', // for registering with the API
		APP_USERNAME: 'colorwheel-user',
		hue: jsHue(), // jsHue instance
		api: null, // jsHueUser instance
		wheel: null, // ColorWheel instance
		bridgeIP: null, // the bridge IP
		username: null, // the hue API username
		cache: {}, // for caching API data
		lights: {},
		template: document.querySelector('#app'), // template used for data binding
		initSettings: '', // serialized copy of settings on init
		colorWheelOptions: { // options for the ColorWheel instance
			container: '#wheel',
			markerWidth: 45
		},
		$: { // jQuery references to DOM nodes
			status:   $('#status'),
			controls: $('#controls')
		},

		checkSettingsVersion: function () {
			if (this.template.get('settings.version') !== window.APP_SETTINGS_VERSION) {
				this.template.initSettings();
			}
		},

		// Cache the full Hue Bridge state
		cacheFullState: function () {
			console.log('Caching API fullState...');
			var self = this;
			return new Promise(function (resolve, reject) {
				self.api.getFullState(function (data) {
					if (data.length && data[0].error) {
						if (data[0].error.type == 1) {
							self.getAPIUser(true).then(self.cacheFullState.bind(self), reject).then(resolve, reject);
						} else {
							reject(Error('"' + data[0].error.description + '" (error type ' + data[0].error.type + ')'));
						}
					} else {
						self.cache.fullState = data;
						self.$.status.attr({ duration: 3000, text: msg.SUCCESS }).get(0).show();
						resolve();
					}
				},
				function (error) {
					this.template.set('settings', null);
					reject(Error(msg.CONNECTION_ERROR_BRIDGE));
				});
			});
		},

		observeChanges: function () {
			var self = this;
			if (! Object.observe) {
				window.setInterval(Platform.performMicrotaskCheckpoint, 100);
			}
			$.each(self.lights, function (lid, light) {
				// See: https://github.com/polymer/observe-js
				var observer = new ObjectObserver(light.state);
				observer.open(function (added, removed, changed, getOldValueFn) {
					if (Object.keys(changed).length > 0) {
						self.api.setLightState(lid, changed);
					}
				});
				// --- This is how we would do it with native O.o: ---
				// Object.observe(light.state, function (changes) {
				// 	changes.forEach(function (change) {
				// 		if (change.type == 'update') {
				// 			if (JSON.stringify(light.state[change.name]) !== JSON.stringify(change.oldValue)) {
				// 				var update = {};
				// 				update[change.name] = light.state[change.name];
				// 				self.api.setLightState(lid, update);
				// 			}
				// 		}
				// 	});
				// });
			});
		},

		// This is some complicated unelegant shit. An LID-to-marker map is created
		// based on the DOM order & visibility of theme swatches, mashed with the LIDs
		// based on their appearance in the "on" switches table or "off" table.
		getLIDToMarkerMap: function () {
			var lidToMarkerMap = [];
			var lids = this.$.controls.find('.Switch').map(function () { return $(this).data('lid') });
			var visibleSwatches = $('.Theme-swatch:visible').toArray();
			var hiddenSwatches = $('.Theme-swatch:hidden').toArray();
			$(visibleSwatches.concat(hiddenSwatches)).each(function (index) {
				lidToMarkerMap[lids[index]] = window.parseInt($(this).attr('data-marker-id'));
			});
			return lidToMarkerMap;
		},

		// See if there is already a saved username, if not create one
		getAPIUser: function (createNew) {
			console.log('Getting API user...');
			this.username = this.template.get('settings.username');
			this.bridge = this.hue.bridge(this.bridgeIP);
			if (!createNew && this.username) {
				this.api = this.bridge.user(this.username);
				return;
			}
			return this.createAPIUser().then(this.getAPIUser.bind(this));
		},

		// Creates a new API user, only succeeds if the Bridge's button has been pressed
		createAPIUser: function () {
			console.log('Creating a new API user...');
			var self = this;
			return new Promise(function (resolve, reject) {
				self.bridge.createUser(
					self.APP_ID,
					function (data) {
						if (data[0].success) {
							self.username = data[0].success.username;
							self.template.set('settings.username', self.username);
							resolve();
						} else {
							if (data[0].error.type === 101) {
								reject(Error(msg.PRESS_BUTTON));
							} else {
								reject(Error(data[0].error.description));
							}
						}
					},
					function () { // ajax error
						reject(Error(msg.CONNECTION_ERROR_BRIDGE));
					}
				);
			});
		},

		// Hunt for the local Hue Bridge
		connectToLocalBridge: function () {
			console.log('Connecting to local bridge...');
			var self = this;
			return new Promise(function (resolve, reject) {
				self.bridgeIP = self.template.get('settings.bridge_ip');
				self.autoDiscover = self.template.get('settings.auto_discover');
				if (self.bridgeIP && !self.autoDiscover) {
					resolve();
					return;
				}
				self.hue.discover(
					function (bridges) {
						if (bridges.length === 0) {
							reject(Error(msg.NO_BRIDGE));
						} else {
							self.bridgeIP = bridges[0].internalipaddress;
							self.template.set('settings.bridge_ip', self.bridgeIP);
							resolve();
						}
					},
					function (error) {
						reject(Error(msg.CONNECTION_ERROR_GENERIC));
					}
				);
			});
		},

		resetStatus: function () {
			this.$.status.unbind('click');
			this.$.status.get(0).hide();
			this.$.status.find('a').empty();
		},

		setInitialState: function () {
			this.template.set('selected', 0);
			if (! this.template.settings.lights) {
			  this.lights = this.cache.fullState.lights;
				this.template.set('settings.lights', _.map(this.cache.fullState.lights,
					function (light, lid) {
						return { name: light.name, active: true };
					}
				));
			} else {
			  this.lights = {};
			  for (var lid in this.cache.fullState.lights) {
			    var light = this.cache.fullState.lights[lid];
			    var setting = _.find(this.template.settings.lights, { name: light.name });
			    if (! setting || setting.active) {
			      this.lights[lid] = light;
			    }
			  }
			}
		},

		cacheSettings: function () {
			this.cachedSettings = JSON.stringify(this.template.settings);
		},

		// Any time we suspect settings have changed, read them and take appropriate action.
		updateSettings: function () {
			// If settings have changed, refresh the page.
			if (this.cachedSettings !== JSON.stringify(this.template.settings)) {
				window.location.reload();
			}
		},

		randomizeColors: function () {
			var onLights = _.filter(this.lights, function (light) { return light.state.on });
			var shuffled = _.shuffle(_.map(onLights, function (light) {
				return light.state.xy;
			}));
			_.forEach(onLights, function (light) {
				light.state.xy = shuffled.pop();
			});
		},

		// Updates light states after wheel user interaction
		wheelUpdateAction: function () {
			for (var lid in this.lights) {
				var light = this.lights[lid];
				if (light.state.on) {
					var markerIndex = this.getLIDToMarkerMap()[lid];
					var d = d3.select(this.wheel.getMarkers()[0][markerIndex]).datum();
					var hex = tinycolor({h: d.color.h, s: d.color.s, v: d.color.v}).toHexString();
					light.state.xy = colors.hexToCIE1931(hex);
				}
			}
		},

		modeToggleAction: function () {
			if (this.wheel.currentMode == ColorWheel.modes.MONOCHROMATIC) {
				this.wheel.getMarkers().data().forEach(function (d) {
					d.color.s = 1;
					d.color.v = 1;
				});
				this.wheel.dispatch.markersUpdated();
				this.wheel.dispatch.updateEnd();
			}
		},

		// Builds the UI once the Hue API has been loaded
		render: function () {
			this.setInitialState();
			this.renderWheel();
			this.renderControls();
		},

		// Renders the ColorWheel when everything's ready
		renderWheel: function () {
			var wheelData = [];
			for (var lid in this.lights) {
				var light = this.lights[lid];
				if (! light.state.xy) { // Only deal with lights that have color data.
					continue;
				}
				var lightHex = colors.CIE1931ToHex.apply(null, light.state.xy);
				var lightHue = tinycolor(lightHex).toHsv().h;
				wheelData.push(ColorWheel.createMarker(
					{ h: lightHue, s: 1, v: 100 },
					null,
					light.state.on
				));
			}
			this.wheel = new ColorWheel(this.colorWheelOptions);
			this.wheel.bindData(wheelData);
			this.wheel.dispatch.on('modeChanged.colorwheel', this.modeToggleAction.bind(this));
			this.wheel.dispatch.on('updateEnd.colorwheel', this.wheelUpdateAction.bind(this));
		},

		// Renders the light switches and attached behavior
		renderControls: function () {
			var self = this;
			var rows = { on: [], off: [] };
			var controls = {
				on: $('<div>').addClass('Switches Switches--on'),
				off: $('<div>').addClass('Switches Switches--off')
			};

			$.each(this.lights, function (lid, light) {
				var $row = $('<div class="Switch">').attr('data-lid', lid);
				var slider = document.createElement('paper-slider');
				var toggle = document.createElement('paper-toggle-button');

				// Add on/off switch
				Polymer.dom(toggle).setAttribute('class', 'Switch-toggle');
				toggle.checked = !! light.state.on;
				toggle.addEventListener('change', function () {
					var markerIndex = self.getLIDToMarkerMap()[lid];
					var marker = d3.select(self.wheel.getMarkers()[0][markerIndex]);
					marker.datum().show = this.checked;
					slider.disabled = ! this.checked;
					light.state.on = this.checked;
					self.wheel.dispatch.markersUpdated();
					self.wheel.setHarmony();
					self.wheel.dispatch.updateEnd();
					$(this).closest('div')
						[light.state.on ? 'appendTo' : 'prependTo']
						(controls[light.state.on ? 'on': 'off']);
				});

				// Add brightness slider
				Polymer.dom(slider).setAttribute('class', 'Switch-slider');
				slider.pin = true;
				slider.min = 0;
				slider.max = 255;
				slider.value = light.state.bri;
				slider.disabled = ! light.state.on;
				slider.addEventListener('change', function () {
					light.state.bri = this.value;
				});

				$row.append( $('<b>').text(light.name) );
				$row.append(toggle);
				$row.append(slider);
				rows[light.state.on ? 'on' : 'off'].push($row);
			});
			controls.on.append(rows.on).appendTo(this.$.controls);
			controls.off.append(rows.off).appendTo(this.$.controls);
		},

		// Displays an error to the user, expecting an Error instance
		renderError: function (e) {
			console.warn(e.stack);
			if (e.message == msg.PRESS_BUTTON) {
				this.$.status.find('a').text('Retry');
				this.$.status.click(this.init.bind(this));
			}
			if (e.message == msg.NO_BRIDGE) {
				this.$.status.find('a').text('Restart in demo mode');
				this.$.status.click(this.demo.bind(this));
			}
			this.$.status.attr({ text: e.message }).get(0).show();
		},

		// Start the app!
		init: function () {
			this.resetStatus();
			this.$.status.attr({ text: msg.CONNECTING, duration: 1e10 }).get(0).show();
			// Dialog listeners
			var dialog = document.querySelector('paper-dialog');
			dialog.addEventListener('iron-overlay-closed', this.updateSettings.bind(this))
			dialog.addEventListener('iron-overlay-opened', this.cacheSettings.bind(this));
			// Do do that voodoo that you do
			this.checkSettingsVersion();
			this.connectToLocalBridge()
				.then(this.getAPIUser.bind(this))
				.then(this.cacheFullState.bind(this))
				.then(this.render.bind(this))
				.then(this.observeChanges.bind(this))
				.catch(this.renderError.bind(this));
		},

		// Start the app in demo mode, using mock data.
		demo: function () {
			var self = this;
			self.resetStatus();
			$.get('demo.json', function (data) {
				self.cache.fullState = data;
				self.render();
			});
		}
	};

	return app;
});
