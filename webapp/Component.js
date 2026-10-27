sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/Device",
	"com/cfa/vehiclelist/model/models"
], function (UIComponent, Device, models) {
	"use strict";

	return UIComponent.extend("com.cfa.vehiclelist.Component", {

		metadata: {
			manifest: "json"
		},

		/**
		 * The component is initialized by UI5 automatically during the startup of the app.
		 * @public
		 * @override
		 */
		init: function () {
			// call the base component's init function
			UIComponent.prototype.init.apply(this, arguments);

			// set the device model
			this.setModel(models.createDeviceModel(), "device");

			// enable routing (single "main" route, but keeps the contract standard)
			this.getRouter().initialize();
		},

		/**
		 * Returns the content density CSS class the current device should use,
		 * provided the corresponding density is declared in the manifest.
		 * @returns {string} "sapUiSizeCompact", "sapUiSizeCozy" or ""
		 * @public
		 */
		getContentDensityClass: function () {
			if (this._sContentDensityClass === undefined) {
				if (document.body.classList.contains("sapUiSizeCozy") || document.body.classList.contains("sapUiSizeCompact")) {
					// density class already set by the FLP container
					this._sContentDensityClass = "";
				} else if (!Device.support.touch) {
					this._sContentDensityClass = "sapUiSizeCompact";
				} else {
					this._sContentDensityClass = "sapUiSizeCozy";
				}
			}
			return this._sContentDensityClass;
		}
	});
});
