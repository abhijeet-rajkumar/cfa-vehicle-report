sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
	"use strict";

	return Controller.extend("com.cfa.vehiclelist.controller.App", {

		onInit: function () {
			// small view-scoped model so we can drive the app-level busy state if needed
			var oAppView = new JSONModel({ busy: false });
			this.getView().setModel(oAppView, "appView");

			// apply the content density the device/launchpad asks for
			this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
		}
	});
});
