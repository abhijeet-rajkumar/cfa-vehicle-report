sap.ui.define([
	"sap/ui/core/Control"
], function (Control) {
	"use strict";

	return Control.extend("com.cfa.vehiclelist.control.TopTableScrollbar", {
		metadata: {
			properties: {
				label: { type: "string", defaultValue: "" }
			},
			associations: {
				table: { type: "sap.ui.table.Table", multiple: false }
			}
		},

		renderer: {
			apiVersion: 2,
			render: function (oRm, oControl) {
				oRm.openStart("div", oControl).class("cfaTopTableScrollbar").openEnd();
				oRm.openStart("div", oControl.getId() + "-scroll")
					.class("cfaTopTableScrollbarScroll")
					.attr("role", "region")
					.attr("aria-label", oControl.getLabel())
					.attr("tabindex", "0")
					.openEnd();
				oRm.openStart("div", oControl.getId() + "-content").openEnd().close("div");
				oRm.close("div");
				oRm.close("div");
			}
		},

		onAfterRendering: function () {
			this._table = sap.ui.getCore().byId(this.getTable());
			if (!this._table) {
				return;
			}
			this._tableDelegate = {
				onBeforeRendering: this._disconnectScrollbar.bind(this),
				onAfterRendering: this._connectScrollbar.bind(this)
			};
			this._table.addEventDelegate(this._tableDelegate);
			this._connectScrollbar();
		},

		onBeforeRendering: function () {
			this._detachTable();
		},

		exit: function () {
			this._detachTable();
		},

		_detachTable: function () {
			this._disconnectScrollbar();
			if (this._table && this._tableDelegate) {
				this._table.removeEventDelegate(this._tableDelegate);
			}
			this._table = null;
			this._tableDelegate = null;
		},

		_connectScrollbar: function () {
			this._disconnectScrollbar();
			// Mirror the UI5 scrollbar so fixed columns and UI5's own scroll handling stay intact.
			var oBottom = this._table && this._table.getDomRef("hsb");
			var oContent = this._table && this._table.getDomRef("hsb-content");
			var oTop = this.getDomRef("scroll");
			if (!oBottom || !oContent || !oTop) {
				return;
			}

			this._bottom = oBottom;
			this._top = oTop;
			this._onTopScroll = function () {
				oBottom.scrollLeft = oTop.scrollLeft;
			};
			this._onBottomScroll = function () {
				oTop.scrollLeft = oBottom.scrollLeft;
			};
			oTop.addEventListener("scroll", this._onTopScroll);
			oBottom.addEventListener("scroll", this._onBottomScroll);

			this._resizeObserver = new ResizeObserver(this._updateScrollbar.bind(this));
			this._resizeObserver.observe(this.getDomRef());
			this._resizeObserver.observe(oBottom);
			this._resizeObserver.observe(oContent);
			this._mutationObserver = new MutationObserver(this._updateScrollbar.bind(this));
			this._mutationObserver.observe(oBottom, { attributes: true, attributeFilter: ["class", "style", "dir"] });
			this._mutationObserver.observe(oContent, { attributes: true, attributeFilter: ["style"] });
			this._updateScrollbar();
		},

		_disconnectScrollbar: function () {
			if (this._resizeObserver) {
				this._resizeObserver.disconnect();
				this._resizeObserver = null;
			}
			if (this._mutationObserver) {
				this._mutationObserver.disconnect();
				this._mutationObserver = null;
			}
			if (this._top) {
				this._top.removeEventListener("scroll", this._onTopScroll);
				this._bottom.removeEventListener("scroll", this._onBottomScroll);
				this._top = null;
				this._bottom = null;
			}
		},

		_updateScrollbar: function () {
			var oRoot = this.getDomRef();
			var oContent = this.getDomRef("content");
			var oTop = this._top;
			var oBottom = this._bottom;
			if (!oRoot || !oContent || !oTop || !oBottom) {
				return;
			}
			var iRange = oBottom.scrollWidth - oBottom.clientWidth;
			var bVisible = oBottom.clientWidth > 0 && iRange > 0 && !oBottom.classList.contains("sapUiTableHidden");
			oTop.style.display = bVisible ? "block" : "none";
			if (bVisible) {
				oTop.style.marginLeft = (oBottom.getBoundingClientRect().left - oRoot.getBoundingClientRect().left) + "px";
				oTop.style.width = oBottom.clientWidth + "px";
				oTop.style.direction = window.getComputedStyle(oBottom).direction;
				oContent.style.width = (oBottom.clientWidth + iRange) + "px";
				oTop.scrollLeft = oBottom.scrollLeft;
			}
		}
	});
});
