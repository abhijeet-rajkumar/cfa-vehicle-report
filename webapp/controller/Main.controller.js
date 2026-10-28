sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Sorter",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/table/Column",
	"sap/ui/table/library",
	"sap/ui/comp/filterbar/FilterGroupItem",
	"sap/m/Input",
	"sap/m/Text",
	"sap/m/Label",
	"sap/m/MessageToast",
	"sap/m/Dialog",
	"sap/m/List",
	"sap/m/StandardListItem",
	"sap/m/Button",
	"sap/m/ProgressIndicator",
	"sap/m/VBox",
	"sap/m/ViewSettingsDialog",
	"sap/m/ViewSettingsItem",
	"sap/ui/comp/valuehelpdialog/ValueHelpDialog",
	"sap/m/DynamicDateRange",
	"sap/ui/core/format/DateFormat",
	"sap/ui/export/Spreadsheet",
	"sap/ui/export/library"
], function (Controller, JSONModel, Sorter, Filter, FilterOperator, TableColumn, tableLibrary, FilterGroupItem, Input, Text, Label, MessageToast, Dialog, List, StandardListItem, Button, ProgressIndicator, VBox, ViewSettingsDialog, ViewSettingsItem, ValueHelpDialog, DynamicDateRange, DateFormat, Spreadsheet, exportLibrary) {
	"use strict";

	var SortOrder = tableLibrary.SortOrder;
	var EdmType = exportLibrary.EdmType;

	// Only released classes are offered in the picker. '1' = Released in SAP classification.
	var CLASS_STATUS_RELEASED = "1";

	var EQUIPMENT_FIXED_CHARACTERISTICS = {
		CABIN_CONFIGURATION: { id: "1894", field: "cabinConfig" },
		OWNER_EQUIPMENT: { id: "1443", field: "ownedBy" }
	};

	function equipmentFixedCharacteristicField(oRow) {
		var sCharacteristic = String(oRow.Characteristic || "");
		var sCharacteristicId = String(oRow.CharacteristicInternalID || "");
		var aNames = Object.keys(EQUIPMENT_FIXED_CHARACTERISTICS);
		for (var i = 0; i < aNames.length; i++) {
			var oCharacteristic = EQUIPMENT_FIXED_CHARACTERISTICS[aNames[i]];
			if (sCharacteristic === aNames[i] || sCharacteristicId === oCharacteristic.id) {
				return oCharacteristic.field;
			}
		}
		return "";
	}

	// Cap on rows fetched from the value collection (brief: $top=2000).
	var MAX_VALUE_ROWS = 2000;

	// Safety cap on master-data list reads (classes, characteristics, headers).
	// Every read is bounded so a wide/unfiltered projection can never trigger the
	// CDS view's internal volume limit (DBSQL_SQL_INTERNAL_DB_ERROR).
	var MAX_LIST_ROWS = 5000;

	// Export batches the value fetch by this many objects per call so S/4HANA never
	// has to materialise the whole class's characteristic values at once.
	var EXPORT_BATCH_SIZE = 100;
	// Per-batch row cap: 100 objects x up to ~99 characteristics, with headroom.
	var EXPORT_VALUE_ROWS = 20000;

	function fmtSAPDateISO(v) {
		if (v === undefined || v === null || v === "") { return ""; }
		var sYear;
		var sMonth;
		var sDay;
		if (v instanceof Date) {
			sYear = v.getFullYear();
			sMonth = v.getMonth() + 1;
			sDay = v.getDate();
		} else {
			var sValue = String(v);
			var mSAP = /\/Date\((-?\d+)/.exec(sValue);
			var mISO = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(sValue);
			if (mSAP) {
				var oDate = new Date(parseInt(mSAP[1], 10));
				sYear = oDate.getUTCFullYear();
				sMonth = oDate.getUTCMonth() + 1;
				sDay = oDate.getUTCDate();
			} else if (mISO) {
				sYear = parseInt(mISO[1], 10);
				sMonth = parseInt(mISO[2], 10);
				sDay = parseInt(mISO[3], 10);
			} else {
				return "";
			}
		}
		if (sMonth < 1 || sMonth > 12 || sDay < 1 || sDay > 31) {
			return "";
		}
		return String(sYear).padStart(4, "0") + "-" +
			String(sMonth).padStart(2, "0") + "-" +
			String(sDay).padStart(2, "0");
	}

	return Controller.extend("com.cfa.vehiclelist.controller.Main", {

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			var oUI = new JSONModel({
				classType: "002",
				classId: "",
				classIds: [],
				multiClass: false,
				classes: [],
				classSelectEnabled: false,
				classBusy: false,

				rows: [],
				columnConfig: [],

				tableBusy: false,
				showTable: false,
				showEmptyState: true,
				showNoData: false,
				noDataTitle: "",
				tableTitle: "",

				// server paging
				pageSize: 25,
				pageInfo: "",
				pagePrevEnabled: false,
				pageNextEnabled: false,

				// hierarchical result rows for the tree table
				showEmpty: false,
				treeRows: [],

				// characteristic filter options (populated when a class is selected)
				charcOptions: [],
				charcBusy: false,
				// planner-group filter options (populated from the loaded class objects)
				plannerOptions: [],
				plannerBusy: false,
				cabinConfigOptions: [],
				equipmentOwnedByOptions: [],
				charcValueOptions: [],
				charcValueBusy: false,

				// sorting options for visible report columns
				sortFields: [],
				sortField: "",
				sortDesc: false,

				// whole-class filter state
				filterActive: false,
				filterInfo: "",

				errorVisible: false,
				errorText: ""
			});
			this.getView().setModel(oUI, "ui");

			// Watch every OData model for auth-expiry: when the approuter/xsuaa
			// session times out the backend returns 401/403 (or an HTML login
			// redirect) and the services silently stop working. Force a re-login.
			this._attachAuthGuards();

			// Result-filter state, shared by the in-grid column filters and the
			// dedicated value-filter fields so the two never overwrite each other.
			// Keyed by column property -> entered filter string.
			this._resultFilters = {};
			this._globalSearch = "";
			this._objectSearch = "";
			// whole-class server-side filter: null = unfiltered, else the matching keys
			this._filteredKeys = null;

			// Default Class Type is 002 (already "selected"), so load its classes immediately.
			this._loadClasses("002");
		},

		/* =========================================================== */
		/* per-class-type configuration                                */
		/* The engine below is type-agnostic; everything that differs   */
		/* between Equipment (002) and Functional Location (003) lives  */
		/* in this table. 003 is structured but disabled for v1.        */
		/* =========================================================== */

		_typeConfig: function (sClassType) {
			var oBundle = this._bundle();
			var mConfig = {
				"002": {
					enabled: true,
					modelName: "equipment",
					valueSet: "/EquipClassCharacteristicValue",
					// the value collection has no readable Class name — filter by the
					// internal class id (same id used to fetch the characteristics)
					filterField: "ClassInternalID",
					// the characteristic id field on a value row (note: NOT CharcInternalID here)
					charcIdField: "CharacteristicInternalID",
					// narrow $select: a wide projection makes this CDS view exceed its
					// internal volume limit and dump (DBSQL_SQL_INTERNAL_DB_ERROR)
					valueSelect: "Equipment,ClassInternalID,CharacteristicInternalID,Characteristic,CharcDataType,CharcValue,CharcValuePositionNumber,CharcFromNumericValue,CharcFromDecimalValue,CharcFromDate,CharcFromAmount,Currency",
					objectKeyField: "Equipment",
					// header read separately ($expand on the value view dumps on the DB).
					// Equipment is time-dependent (key includes ValidityEndDate).
					headerSet: "/Equipment",
					headerSelect: "Equipment,EquipmentName,MaintenancePlant,ValidityEndDate,ManufacturerSerialNumber,OperationStartDate,MaintenancePlannerGroup,FunctionalLocationLabelName,FunctionalLocationName,SuperordinateEquipment,TechnicalObjectSortCode",
					headerHasValidity: true,
					// raw header field used by the Start-Up Date range filter
					dateFilterField: "OperationStartDate",
					// class-assignment entity used to page the objects in a class
					keyClassSet: "/EquipmentClass",
					// single-call header fetch: expand the class->object navigation so
					// one request returns every object's header data for the class.
					headerExpandNav: "to_Equipment",
					headerExpandSelect: "Equipment,to_Equipment/Equipment,to_Equipment/EquipmentName,to_Equipment/MaintenancePlant,to_Equipment/ValidityEndDate,to_Equipment/ManufacturerSerialNumber,to_Equipment/OperationStartDate,to_Equipment/MaintenancePlannerGroup,to_Equipment/FunctionalLocationLabelName,to_Equipment/FunctionalLocationName,to_Equipment/SuperordinateEquipment,to_Equipment/TechnicalObjectSortCode",
					fixedColumns: [
						{ key: "objNumber", label: oBundle.getText("colEquipment"), width: "11rem", get: function (sKey) { return sKey; } },
						{ key: "objDesc", label: oBundle.getText("colDescription"), width: "18rem", get: function (sKey, oHeader) { return oHeader.EquipmentName; } },
						{ key: "objClass", label: oBundle.getText("colClass"), width: "11rem", get: function (sKey, oHeader, oRow, oCtx) { return (oCtx.classByKey && oCtx.classByKey[sKey] && oCtx.classByKey[sKey].Class) || oCtx.className; } },
						{ key: "ManufacturerSerialNumber", label: oBundle.getText("colSerialNo"), width: "12rem", get: function (sKey, oHeader) { return oHeader.ManufacturerSerialNumber; } },
						{ key: "SuperiorObject", label: oBundle.getText("colSuperiorObj"), width: "20rem", get: function (sKey, oHeader) {
							var sLabel = oHeader.FunctionalLocationLabelName || oHeader.SuperordinateEquipment || "";
							var sName = oHeader.FunctionalLocationName || "";
							return (sLabel && sName) ? (sLabel + " (" + sName + ")") : sLabel;
						} },
						{ key: "OperationStartDate", label: oBundle.getText("colStartUp"), width: "10rem", get: function (sKey, oHeader) { return fmtSAPDateISO(oHeader.OperationStartDate); } },
						{ key: "MaintenancePlannerGroup", label: oBundle.getText("colPlannerGroup"), width: "9rem", get: function (sKey, oHeader) { return oHeader.MaintenancePlannerGroup; } },
						{ key: "MaintenancePlant", label: oBundle.getText("colMaintPlant"), width: "9rem", get: function (sKey, oHeader) { return oHeader.MaintenancePlant; } }
					]
				},
				"003": {
					enabled: true,
					modelName: "funcloc",
					valueSet: "/Value",
					filterField: "ClassInternalID",
					// the FL value entity keys the characteristic by CharcInternalID
					charcIdField: "CharcInternalID",
					valueSelect: "FunctionalLocation,ClassInternalID,CharcInternalID,Characteristic,CharcDataType,CharcValue,CharcValuePositionNumber,CharcFromNumericValue,CharcFromDecimalValue,CharcFromDate,CharcFromAmount,Currency",
					objectKeyField: "FunctionalLocation",
					headerSet: "/FunctionalLocation",
					headerSelect: "FunctionalLocation,FunctionalLocationName,FunctionalLocationCategory,SuperiorFunctionalLocation,ManufacturerSerialNumber,OperationStartDate,MaintenancePlannerGroup",
					headerHasValidity: false,
					dateFilterField: "OperationStartDate",
					keyClassSet: "/FunctionalLocationClass",
					headerExpandNav: "to_FunctionalLocation",
					headerExpandSelect: "FunctionalLocation,to_FunctionalLocation/FunctionalLocation,to_FunctionalLocation/FunctionalLocationName,to_FunctionalLocation/FunctionalLocationCategory,to_FunctionalLocation/SuperiorFunctionalLocation,to_FunctionalLocation/ManufacturerSerialNumber,to_FunctionalLocation/OperationStartDate,to_FunctionalLocation/MaintenancePlannerGroup",
					fixedColumns: [
						{ key: "objNumber", label: oBundle.getText("colFuncLoc"), width: "14rem", get: function (sKey) { return sKey; } },
						{ key: "objDesc", label: oBundle.getText("colDescription"), width: "18rem", get: function (sKey, oHeader) { return oHeader.FunctionalLocationName; } },
						{ key: "objClass", label: oBundle.getText("colClass"), width: "11rem", get: function (sKey, oHeader, oRow, oCtx) { return (oCtx.classByKey && oCtx.classByKey[sKey] && oCtx.classByKey[sKey].Class) || oCtx.className; } },
						{ key: "SuperiorObject", label: oBundle.getText("colSuperiorObj"), width: "16rem", get: function (sKey, oHeader) { return oHeader.SuperiorFunctionalLocation; } },
						{ key: "MaintenancePlannerGroup", label: oBundle.getText("colPlannerGroup"), width: "9rem", get: function (sKey, oHeader) { return oHeader.MaintenancePlannerGroup; } },
						{ key: "FunctionalLocationCategory", label: oBundle.getText("colCategory"), width: "8rem", get: function (sKey, oHeader) { return oHeader.FunctionalLocationCategory; } }
					]
				}
			};
			return mConfig[sClassType];
		},

		/* =========================================================== */
		/* event handlers                                              */
		/* =========================================================== */

		onClassTypeChange: function (oEvent) {
			var sClassType = oEvent.getSource().getSelectedKey();
			var oUI = this._ui();

			// Class dropdown is dependent: clear it and reload for the new type.
			oUI.setProperty("/classIds", []);
			oUI.setProperty("/multiClass", false);
			oUI.setProperty("/classes", []);
			oUI.setProperty("/classSelectEnabled", false);
			this._unionCache = null; // characteristic union belongs to the old type

			// Reset the result area back to the initial empty state.
			this._resetResults();

			this._loadClasses(sClassType);
		},

		onClassChange: async function () {
			var sClassId = this.byId("classSelect").getSelectedKey();
			var oUI = this._ui();
			var aIds = sClassId ? [sClassId] : [];
			this._resetResults();
			var iToken = this._filterClassLoadToken;
			oUI.setProperty("/classId", sClassId || "");
			oUI.setProperty("/classIds", aIds);
			oUI.setProperty("/multiClass", false);

			if (!aIds.length) {
				oUI.setProperty("/charcBusy", false);
				return;
			}

			var aClasses = (oUI.getProperty("/classes") || []).filter(function (oClass) {
				return oClass.ClassInternalID === sClassId;
			});
			if (!aClasses.length) {
				this._showError(this._bundle().getText("classNotFound"));
				return;
			}
			var oCfg = this._typeConfig("002");
			oUI.setProperty("/charcBusy", true);
			try {
				var oUnion = await this._fetchUnionCharacteristics(aIds);
				if (iToken !== this._filterClassLoadToken) { return; }
				this._filterClassCtx = {
					oCfg: oCfg,
					sClassId: sClassId,
					aChars: oUnion.chars,
					mMeta: oUnion.meta
				};
				oUI.setProperty("/charcOptions", oUnion.chars.map(function (oChar) {
					return { key: oChar.CharcInternalID, text: oChar.Characteristic };
				}));
				var mOptions = await this._loadNamedCharacteristicOptions(oCfg, sClassId, oUnion);
				if (iToken !== this._filterClassLoadToken) { return; }
				oUI.setProperty("/cabinConfigOptions", mOptions.cabinConfiguration);
				oUI.setProperty("/equipmentOwnedByOptions", mOptions.equipmentOwnedBy);
			} catch (oError) {
				if (iToken === this._filterClassLoadToken) {
					this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				}
			} finally {
				if (iToken === this._filterClassLoadToken) {
					oUI.setProperty("/charcBusy", false);
				}
			}
		},

		onSubClassChange: async function () {
			var oUI = this._ui();
			var aIds = this.byId("charcSelect").getSelectedKeys();
			oUI.setProperty("/charcValueOptions", []);
			var oValueFilter = this.byId("charcValueFilter");
			if (oValueFilter) {
				oValueFilter.setSelectedKeys([]);
			}
			var iToken = (this._subClassLoadToken = (this._subClassLoadToken || 0) + 1);
			if (!aIds.length || !this._filterClassCtx) {
				oUI.setProperty("/charcValueBusy", false);
				return;
			}
			try {
				oUI.setProperty("/charcValueBusy", true);
				var aOptions = await this._loadCharacteristicValueOptions(this._filterClassCtx, aIds);
				if (iToken === this._subClassLoadToken) {
					oUI.setProperty("/charcValueOptions", aOptions);
				}
			} catch (oError) {
				if (iToken === this._subClassLoadToken) {
					this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				}
			} finally {
				if (iToken === this._subClassLoadToken) {
					oUI.setProperty("/charcValueBusy", false);
				}
			}
		},

		onClearPress: function () {
			var oUI = this._ui();
			oUI.setProperty("/classIds", []);
			oUI.setProperty("/classId", "");
			oUI.setProperty("/multiClass", false);
			// clear the Class field's own selection + any typed text
			var oClass = this.byId("classSelect");
			if (oClass) {
				if (oClass.setSelectedKey) { oClass.setSelectedKey(""); }
				if (oClass.setValue) { oClass.setValue(""); }
			}
			this._resetResults();
		},

		onGoPress: function () {
			var oUI = this._ui();
			var sClassType = "002";
			var sClassId = this.byId("classSelect").getSelectedKey();
			var aClassIds = sClassId ? [sClassId] : [];

			this._hideError();

			if (!aClassIds.length) {
				MessageToast.show(this._bundle().getText("selectClassFirst"));
				return;
			}

			var oCfg = this._typeConfig(sClassType);

			// Honour the brief: 002 first; 003 is wired but not enabled in v1.
			if (!oCfg || !oCfg.enabled) {
				this._showError(this._bundle().getText("typeNotSupported"));
				return;
			}

			var aAllClasses = oUI.getProperty("/classes") || [];
			var aClasses = aClassIds.map(function (sId) {
				var oC = aAllClasses.filter(function (c) { return c.ClassInternalID === sId; })[0];
				return oC ? { ClassInternalID: oC.ClassInternalID, Class: oC.Class, ClassType: sClassType } : null;
			}).filter(Boolean);

			if (!aClasses.length) {
				this._showError(this._bundle().getText("classNotFound"));
				return;
			}

			var oAgeRange = this._getVehicleAgeRange();
			if (!oAgeRange.valid) {
				this._showError(oAgeRange.error);
				return;
			}

			this._loadResults(oCfg, aClasses);
		},

		onColumnSort: function (oEvent) {
			// Drive the in-memory sort explicitly so behaviour is deterministic.
			oEvent.preventDefault();

			var oColumn = oEvent.getParameter("column");
			var sNewOrder = oEvent.getParameter("sortOrder");
			var bDescending = sNewOrder === SortOrder.Descending;
			var sProperty = oColumn.getSortProperty();
			if (!sProperty) {
				return;
			}

			var oTable = this.byId("resultTable");
			if (this._pageCtx) {
					this._pageCtx.sortField = sProperty;
					this._pageCtx.sortDesc = bDescending;
					this._sortKeys();
					this._reflectSortOnColumns();
					this._loadPage(0);
				}
				return;

			// Reflect the sort indicator on the active column only.
			oTable.getColumns().forEach(function (c) {
				var bActive = c === oColumn;
				c.setSorted(bActive);
				if (bActive) {
					c.setSortOrder(sNewOrder);
				}
			});
		},

		onColumnFilter: function (oEvent) {
			oEvent.preventDefault();
			var oColumn = oEvent.getParameter("column");
			var sValue = oEvent.getParameter("value");
			var sProp = oColumn.getFilterProperty();
			if (!sProp) {
				return;
			}
			oColumn.setFiltered(!!sValue);
			this._setResultFilter(sProp, sValue);
		},

		onValueFilterChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var sProp = oInput.data("prop");
			var sValue = oEvent.getParameter("value");
			if (sProp) {
				this._setResultFilter(sProp, sValue);
			}
		},

		onResultSearch: function (oEvent) {
			// handles both the `search` and `liveChange` events
			var sValue = oEvent.getParameter("newValue");
			if (sValue === undefined || sValue === null) {
				sValue = oEvent.getParameter("query") || "";
			}
			this._globalSearch = (sValue || "").trim();
			this._applyResultFilters();
		},

		/**
		 * Standalone object search: look up an object number, determine its class
		 * (prompt if it's in several), and show just that object.
		 */
		onObjectValueHelp: function (oEvent) {
			var oMultiInput = oEvent.getSource();
			if (!this._oObjectVHD) {
				this._oObjectVHD = new ValueHelpDialog({
					title: this._bundle().getText("objectVHDTitle"),
					supportRanges: true,
					supportRangesOnly: true,
					key: "objNumber",
					ok: this._onObjectVHDOk.bind(this),
					cancel: function () { this._oObjectVHD.close(); }.bind(this),
					afterClose: function () { if (this._oObjectVHD) { this._oObjectVHD.destroy(); this._oObjectVHD = null; } }.bind(this)
				});
				this.getView().addDependent(this._oObjectVHD);
				this._oObjectVHD.setRangeKeyFields([{
					key: "objNumber",
					label: this._bundle().getText("filterObjectSearch"),
					type: "string"
				}]);
			}
			this._oObjectVHD.setTokens(oMultiInput.getTokens());
			this._oObjectVHD.open();
		},

		_onObjectVHDOk: function (oEvent) {
			var aTokens = oEvent.getParameter("tokens");
			this.byId("objectSearch").setTokens(aTokens);
			this._oObjectVHD.close();
		},

		/** Value Help for the characteristic value filter (conditions tab). When a
		 *  single DATE characteristic is selected the dialog uses date pickers so the
		 *  user enters real dates rather than free text. */
		onCharcValueValueHelp: function (oEvent) {
			this._openRangesVHD(oEvent.getSource(), this._bundle().getText("charcValueVHDTitle"), this._charcValueVHDType());
		},

		/** Range-field type for the characteristic-value value help, based on the
		 *  selected characteristic's data type ("date" for DATE, else "string"). */
		_charcValueVHDType: function () {
			var oSel = this.byId("charcSelect");
			var aIds = oSel ? oSel.getSelectedKeys() : [];
			if (aIds.length !== 1) { return "string"; }
			var mMeta = (this._pageCtx && this._pageCtx.mMeta) ||
				(this._unionCache && this._unionCache.value && this._unionCache.value.meta) || {};
			var oM = mMeta[aIds[0]];
			return (oM && oM.CharcDataType === "DATE") ? "date" : "string";
		},

		/* ---- header-field value helps (serial / superior / planner / start-up) ---- */

		onSerialValueHelp: function (oEvent) {
			this._openRangesVHD(oEvent.getSource(), this._bundle().getText("filterSerial"), "string");
		},
		onSuperiorValueHelp: function (oEvent) {
			this._openRangesVHD(oEvent.getSource(), this._bundle().getText("filterSuperior"), "string");
		},

		/**
		 * Open a SAP-standard ranges Value Help Dialog (conditions tab only) for a
		 * MultiInput filter. A fresh dialog is created each time and destroyed on
		 * close, so conditions never leak between openings.
		 * @param {sap.m.MultiInput} oMultiInput the filter field
		 * @param {string} sLabel field label (dialog title + range key label)
		 * @param {string} sType range key field type ("string" or "date")
		 */
		_openRangesVHD: function (oMultiInput, sLabel, sType) {
			var oVHD = new ValueHelpDialog({
				title: sLabel,
				supportRanges: true,
				supportRangesOnly: true,
				key: "value",
				ok: function (oEvent) {
					oMultiInput.setTokens(oEvent.getParameter("tokens"));
					oVHD.close();
				},
				cancel: function () { oVHD.close(); },
				afterClose: function () { oVHD.destroy(); }
			});
			this.getView().addDependent(oVHD);
			oVHD.setRangeKeyFields([{ key: "value", label: sLabel, type: sType }]);
			oVHD.setTokens(oMultiInput.getTokens());
			oVHD.open();
		},

		/** MultiInput tokens changed (typed or removed) -> run the object search. */
		onObjectTokenUpdate: function () {
			var that = this;
			// defer so getTokens() reflects the committed tokens
			setTimeout(function () { that._runObjectSearch(); }, 0);
		},

		/** Resolve & display the objects represented by the MultiInput tokens. */
		_runObjectSearch: function () {
			var oMultiInput = this.byId("objectSearch");
			if (!oMultiInput) {
				return;
			}
			var aNums = [];
			oMultiInput.getTokens().forEach(function (oToken) {
				var oRange = oToken.data("range");
				var sVal = oRange ? oRange.value1 : oToken.getKey();
				if (sVal === undefined || sVal === null || sVal === "") {
					sVal = oToken.getText();
				}
				sVal = String(sVal == null ? "" : sVal).trim();
				if (sVal) {
					aNums.push(sVal);
				}
			});
			if (!aNums.length) {
				return;
			}
			if (aNums.length > 1) {
				this._searchObjects(aNums);
			} else {
				this._searchObject(aNums[0]);
			}
		},

		_onObjectSearchLegacy: function (oEvent) {
			var sVal = oEvent.getParameter("query");
			if (sVal === undefined || sVal === null) {
				sVal = oEvent.getParameter("newValue") || "";
			}
			sVal = (sVal || "").trim();
			this._objectSearch = sVal;
			if (!sVal) {
				// clearing the box shouldn't wipe the screen — just stop searching
				return;
			}
			// allow several objects at once (comma / space / semicolon separated)
			var aNums = sVal.split(/[\s,;]+/).filter(Boolean);
			if (aNums.length > 1) {
				this._searchObjects(aNums);
			} else {
				this._searchObject(aNums[0]);
			}
		},

		/**
		 * Resolve the class(es) an object belongs to, then load it (or prompt to
		 * choose when it's classified in more than one class).
		 * @param {string} sNum the object number
		 */
		_searchObject: async function (sNum) {
			var oUI = this._ui();
			var sType = "002";
			var oCfg = this._typeConfig(sType);

			this._hideError();
			if (!oCfg || !oCfg.enabled) {
				this._showError(this._bundle().getText("typeNotSupported"));
				return;
			}

			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/tableBusy", true);

			try {
				var aAssign = await this._read(this._model(oCfg.modelName), oCfg.keyClassSet, {
					"$filter": oCfg.objectKeyField + " eq '" + this._esc(sNum) + "'",
					"$select": oCfg.objectKeyField + ",ClassInternalID,ClassType,Class",
					"$top": MAX_LIST_ROWS
				});

				// distinct classes the object is assigned to
				var oSeen = {};
				var aClasses = [];
				aAssign.forEach(function (o) {
					if (o.ClassInternalID && !oSeen[o.ClassInternalID]) {
						oSeen[o.ClassInternalID] = true;
						aClasses.push({ ClassInternalID: o.ClassInternalID, ClassType: o.ClassType, Class: o.Class });
					}
				});

				if (!aClasses.length) {
					oUI.setProperty("/rows", []);
					oUI.setProperty("/showTable", false);
					oUI.setProperty("/showNoData", true);
					oUI.setProperty("/noDataTitle", this._bundle().getText("objectNotFound", [sNum]));
					oUI.setProperty("/tableBusy", false);
					return;
				}

				oUI.setProperty("/tableBusy", false);
				if (aClasses.length === 1) {
					await this._loadSingleObject(oCfg, sNum, aClasses[0]);
				} else {
					this._promptClassChoice(oCfg, sNum, aClasses);
				}
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/tableBusy", false);
			}
		},

		/** Load a single object's row for a resolved class. */
		_loadSingleObject: async function (oCfg, sNum, oClass) {
			var oUI = this._ui();
			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/tableBusy", true);

			try {
				// reflect the resolved class in the filter bar
				oUI.setProperty("/classType", oClass.ClassType);
				oUI.setProperty("/classId", oClass.ClassInternalID);

				var aChars = await this._fetchCharacteristics(oClass.ClassInternalID);
				var mMeta = await this._fetchCharcMetadata(aChars);
				this._buildColumns(aChars, oCfg);

				var aKeys = [sNum];
				var mHeaders = await this._fetchHeaders(oCfg, aKeys);
				var mClassByKey = {};
				mClassByKey[sNum] = { ClassInternalID: oClass.ClassInternalID, Class: oClass.Class };
				var oContext = { className: oClass.Class, classId: oClass.ClassInternalID, classByKey: mClassByKey };

				this._pageCtx = {
					oCfg: oCfg,
					sClassId: oClass.ClassInternalID,
					sClassType: oClass.ClassType,
					className: oClass.Class,
					aChars: aChars,
					mMeta: mMeta,
					keys: aKeys,
					headers: mHeaders,
					classByKey: mClassByKey,
					sortVals: this._buildSortVals(oCfg, aKeys, mHeaders, oContext, oUnion.chars),
					sortField: "TechnicalObject",
					sortDesc: false
				};

				await this._loadPage(0);
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * Search several objects at once. Resolves each object's class, builds a
		 * union of characteristics across the involved classes as columns, and shows
		 * all the objects together (paged).
		 * @param {string[]} aNums object numbers
		 */
		_searchObjects: async function (aNums) {
			var oUI = this._ui();
			var that = this;
			var sType = "002";
			var oCfg = this._typeConfig(sType);

			this._hideError();
			if (!oCfg || !oCfg.enabled) {
				this._showError(this._bundle().getText("typeNotSupported"));
				return;
			}

			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/tableBusy", true);

			try {
				// resolve class assignments for all requested objects
				var sOr = aNums.map(function (n) {
					return oCfg.objectKeyField + " eq '" + that._esc(n) + "'";
				}).join(" or ");
				var aAssign = await this._read(this._model(oCfg.modelName), oCfg.keyClassSet, {
					"$filter": "(" + sOr + ")",
					"$select": oCfg.objectKeyField + ",ClassInternalID,ClassType,Class",
					"$top": MAX_LIST_ROWS
				});

				if (!aAssign.length) {
					oUI.setProperty("/rows", []);
					oUI.setProperty("/treeRows", []);
					oUI.setProperty("/showTable", false);
					oUI.setProperty("/showNoData", true);
					oUI.setProperty("/noDataTitle", this._bundle().getText("objectNotFound", [aNums.join(", ")]));
					oUI.setProperty("/tableBusy", false);
					return;
				}

				// first class per object + the distinct set of involved classes
				var mClassByKey = {};
				var oClassSeen = {};
				var aClassIds = [];
				aAssign.forEach(function (o) {
					var k = o[oCfg.objectKeyField];
					if (k && !mClassByKey[k]) {
						mClassByKey[k] = { ClassInternalID: o.ClassInternalID, Class: o.Class };
						if (!oClassSeen[o.ClassInternalID]) {
							oClassSeen[o.ClassInternalID] = true;
							aClassIds.push(o.ClassInternalID);
						}
					}
				});

				// union of characteristics across the involved classes
				var oUnion = await this._fetchUnionCharacteristics(aClassIds);
				this._buildColumns(oUnion.chars, oCfg);

				var aResolved = Object.keys(mClassByKey);
				var mHeaders = await this._fetchHeaders(oCfg, aResolved);
				var oContext = {
					className: aClassIds.length === 1 ? mClassByKey[aResolved[0]].Class : this._bundle().getText("multipleClasses"),
					classId: null,
					classByKey: mClassByKey
				};

				this._pageCtx = {
					oCfg: oCfg,
					sClassId: null,
					sClassType: sType,
					className: oContext.className,
					aChars: oUnion.chars,
					mMeta: oUnion.meta,
					classByKey: mClassByKey,
					keys: aResolved,
					headers: mHeaders,
					sortVals: this._buildSortVals(oCfg, aResolved, mHeaders, oContext, oUnion.chars),
					sortField: "TechnicalObject",
					sortDesc: false
				};

				this._sortKeys();
				await this._loadPage(0);
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * Fetch and union the characteristics of several classes (dedup by id,
		 * preserving first-seen order), plus their merged metadata.
		 * @param {string[]} aClassIds class internal ids
		 * @returns {Promise<{chars: object[], meta: object}>}
		 */
		_fetchUnionCharacteristics: async function (aClassIds) {
			var that = this;
			// memoise on the class-id set so selecting a class (which builds the
			// Characteristic filter) and then pressing Go don't fetch twice
			var sKey = aClassIds.slice().sort().join(",");
			if (this._unionCache && this._unionCache.key === sKey) {
				return this._unionCache.value;
			}
			var aPerClass = await Promise.all(aClassIds.map(function (sId) {
				return that._fetchCharacteristics(sId);
			}));
			var aUnion = [];
			var oSeen = {};
			aPerClass.forEach(function (aChars) {
				aChars.forEach(function (oChar) {
					if (!oSeen[oChar.CharcInternalID]) {
						oSeen[oChar.CharcInternalID] = true;
						aUnion.push(oChar);
					}
				});
			});
			var mMeta = await this._fetchCharcMetadata(aUnion);
			this._unionCache = { key: sKey, value: { chars: aUnion, meta: mMeta } };
			return this._unionCache.value;
		},

		/** Prompt the user to pick a class when an object is in several. */
		_promptClassChoice: function (oCfg, sNum, aClasses) {
			var that = this;
			var oList = new List();
			aClasses.forEach(function (oClass) {
				oList.addItem(new StandardListItem({
					title: oClass.Class || oClass.ClassInternalID,
					description: that._bundle().getText("filterClassType") + " " + oClass.ClassType,
					type: "Active",
					press: function () {
						oDialog.close();
						that._loadSingleObject(oCfg, sNum, oClass);
					}
				}));
			});
			var oDialog = new Dialog({
				title: that._bundle().getText("pickClassTitle", [sNum]),
				contentWidth: "24rem",
				content: [oList],
				endButton: new Button({
					text: that._bundle().getText("cancelButton"),
					press: function () { oDialog.close(); }
				}),
				afterClose: function () { oDialog.destroy(); }
			});
			this.getView().addDependent(oDialog);
			oDialog.open();
		},

		/** "Show empty characteristics" toggled — rebuild the tree for the page. */
		onShowEmptyChange: function () {
			if (!this._pageCtx) {
				return;
			}
			var aRows = this._ui().getProperty("/rows") || [];
			this._ui().setProperty("/treeRows", this._buildTreeRows(aRows, this._pageCtx.aChars));
		},

		onPrevPage: function () {
			if (this._currentPage > 0) {
				this._loadPage(this._currentPage - 1);
			}
		},

		onNextPage: function () {
			this._loadPage((this._currentPage || 0) + 1);
		},

		onPageSizeChange: function (oEvent) {
			var iSize = parseInt(oEvent.getParameter("selectedItem").getKey(), 10) || 25;
			this._ui().setProperty("/pageSize", iSize);
			// jump back to the first page at the new size
			this._loadPage(0);
		},

		/**
		 * Export EVERY object in the current selection (all pages) using the visible
		 * report columns. Values are fetched in batches of EXPORT_BATCH_SIZE objects
		 * so S/4HANA never has to materialise the whole class at once; a modal
		 * progress dialog reports each batch and can be cancelled.
		 */
		onExport: async function () {
			var that = this;
			var oBundle = this._bundle();
			var ctx = this._pageCtx;
			var oTable = this.byId("equipmentTreeTable");
			var aColumns = oTable.getColumns().filter(function (oColumn) {
				return oColumn.getVisible();
			}).map(function (oColumn) {
				var oTemplate = oColumn.getTemplate();
				var oBinding = oTemplate && oTemplate.getBindingInfo("text");
				var oLabel = oColumn.getLabel();
				return {
					label: oLabel.getText(),
					property: oBinding.parts[0].path
				};
			});

			if (!ctx || !ctx.keys || !ctx.keys.length) {
				MessageToast.show(oBundle.getText("nothingToExport"));
				return;
			}

			var aAllKeys = ctx.keys.slice();
			var iTotal = aAllKeys.length;
			var aChunks = this._chunk(aAllKeys, EXPORT_BATCH_SIZE);

			// ---- progress dialog ----
			this._exportCancelled = false;
			var oProgress = new ProgressIndicator({ percentValue: 0, displayValue: "0%", width: "100%", height: "1.25rem" });
			var oStatus = new Text({ text: oBundle.getText("exportProgress", [0, iTotal]) });
			var oDialog = new Dialog({
				title: oBundle.getText("exportDialogTitle"),
				contentWidth: "28rem",
				escapeHandler: function (o) { o.reject(); }, // don't let ESC close mid-run
				content: [ new VBox({ width: "100%", items: [ oStatus, oProgress ] }).addStyleClass("sapUiContentPadding") ],
				beginButton: new Button({
					text: oBundle.getText("cancelButton"),
					press: function () { that._exportCancelled = true; }
				})
			});
			this.getView().addDependent(oDialog);
			oDialog.open();

			var oContext = { className: ctx.className, classId: ctx.sClassId, classByKey: ctx.classByKey };
			var aRows = [];

			try {
				for (var i = 0; i < aChunks.length; i++) {
					if (this._exportCancelled) {
						break;
					}
					var aChunk = aChunks[i];
					var aValues = await this._fetchValuesForKeys(ctx.oCfg, aChunk, ctx.sClassId, ctx.classByKey, EXPORT_VALUE_ROWS);
					aRows = aRows.concat(this._pivotData(aValues, ctx.aChars, ctx.mMeta, ctx.oCfg, oContext, ctx.headers, aChunk));

					var iDone = Math.min((i + 1) * EXPORT_BATCH_SIZE, iTotal);
					var iPct = Math.round((iDone / iTotal) * 100);
					oProgress.setPercentValue(iPct);
					oProgress.setDisplayValue(iPct + "%");
					oStatus.setText(oBundle.getText("exportProgress", [iDone, iTotal]));
				}
			} catch (oError) {
				oDialog.close();
				oDialog.destroy();
				this._showError(oBundle.getText("dataLoadError", [this._extractError(oError)]));
				return;
			}

			if (this._exportCancelled) {
				oDialog.close();
				oDialog.destroy();
				MessageToast.show(oBundle.getText("exportCancelled"));
				return;
			}

			// ---- build the workbook ----
			oStatus.setText(oBundle.getText("exportBuilding"));
			oDialog.getBeginButton().setEnabled(false);

			var aExportRows = [];
			this._buildTreeRows(aRows, ctx.aChars).forEach(function (oRow) {
				aExportRows.push(oRow);
				(oRow.children || []).forEach(function (oChild) {
					aExportRows.push(oChild);
				});
			});

			var oSheet = new Spreadsheet({
				workbook: {
					columns: aColumns.map(function (c) {
						return { label: c.label, property: c.property, type: EdmType.String };
					})
				},
				dataSource: aExportRows,
				fileName: "CFAVehicleReport.xlsx"
			});
			oSheet.build().finally(function () {
				oSheet.destroy();
				oDialog.close();
				oDialog.destroy();
			});
		},

		/* =========================================================== */
		/* class picker population (API 1)                             */
		/* =========================================================== */

		_loadClasses: function (sClassType) {
			var oUI = this._ui();
			oUI.setProperty("/classBusy", true);

			var oModel = this._model("class");
			var that = this;

			this._read(oModel, "/A_ClfnClassForKeyDate", {
				"$filter": "ClassType eq '" + this._esc(sClassType) + "' and ClassStatus eq '" + CLASS_STATUS_RELEASED + "'",
				"$select": "ClassInternalID,Class,ClassType,ClassStatus,ClassGroup",
				"$top": MAX_LIST_ROWS,
				"$orderby": "Class"
			}).then(function (aResults) {
				var aClasses = aResults.map(function (o) {
					return {
						ClassInternalID: o.ClassInternalID,
						Class: o.Class,
						ClassGroup: o.ClassGroup || "",
						// "FLEET_TANKER - Fleet"  (group appended when present)
						__display: o.ClassGroup ? (o.Class + " - " + o.ClassGroup) : o.Class
					};
				});
				oUI.setProperty("/classes", aClasses);
				oUI.setProperty("/classSelectEnabled", aClasses.length > 0);
				oUI.setProperty("/classBusy", false);
			}).catch(function (oError) {
				oUI.setProperty("/classes", []);
				oUI.setProperty("/classSelectEnabled", false);
				oUI.setProperty("/classBusy", false);
				that._showError(that._bundle().getText("classLoadError", [that._extractError(oError)]));
			});
		},

		/* =========================================================== */
		/* result orchestration                                        */
		/* =========================================================== */

		_loadResults: async function (oCfg, aClasses) {
			var oUI = this._ui();
			var that = this;
			var sClassType = "002";
			var aClassIds = aClasses.map(function (c) { return c.ClassInternalID; });
			var sClassKey = aClassIds.slice().sort().join(",");

			// Same class set already loaded -> just re-apply the filters (no re-fetch
			// of keys/headers). Makes changing a filter + Go instant.
			if (this._pageCtx && this._pageCtx.classKey === sClassKey) {
				await this._applyAllFilters();
				return;
			}

			// NOTE: filters are intentionally NOT cleared here. Users now set filters
			// (characteristic, value, object number, ...) against the selected class
			// before pressing Go; onClassChange already reset the characteristic
			// selection when the class changed, so nothing stale remains.

			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/tableBusy", true);

			try {
				// union of characteristics across the selected class(es)
				var oUnion = await this._fetchUnionCharacteristics(aClassIds);
				this._buildColumns(oUnion.chars, oCfg);

				// ONE request per class: keys + per-object class map + headers, via the
				// class->object expand (replaces the separate keys read and the
				// previously chunked header reads).
				var oObjects = await this._fetchClassObjects(oCfg, aClasses, sClassType);
				var mClassByKey = oObjects.classByKey;
				var aAllKeys = oObjects.allKeys;
				var mHeaders = oObjects.headers;
				var bMulti = aClasses.length > 1;
				var oContext = {
					className: bMulti ? this._bundle().getText("multipleClasses") : aClasses[0].Class,
					classId: bMulti ? null : aClasses[0].ClassInternalID,
					classByKey: mClassByKey
				};

				this._pageCtx = {
					oCfg: oCfg,
					sClassType: sClassType,
					classKey: sClassKey,
					sClassId: oContext.classId,
					className: oContext.className,
					classByKey: mClassByKey,
					aChars: oUnion.chars,
					mMeta: oUnion.meta,
					allKeys: aAllKeys,
					keys: aAllKeys.slice(),
					headers: mHeaders,
					sortVals: this._buildSortVals(oCfg, aAllKeys, mHeaders, oContext, oUnion.chars),
					sortField: "TechnicalObject",
					sortDesc: false
				};

				oUI.setProperty("/charcOptions", oUnion.chars.map(function (oChar) {
					return { key: oChar.CharcInternalID, text: oChar.Characteristic };
				}));
				// Planner Group filter options: the distinct planner groups actually
				// present in the loaded class(es), so the dropdown only offers real values.
				oUI.setProperty("/plannerOptions", this._distinctHeaderValues(mHeaders, aAllKeys, "MaintenancePlannerGroup"));
				oUI.setProperty("/multiClass", bMulti);

				await this._applyAllFilters();
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/showEmptyState", true);
				oUI.setProperty("/tableBusy", false);
			}
		},

		_loadResultsLegacy: async function (oCfg, sClassId, oClass) {
			var oUI = this._ui();

			// when the class changes, clear the (now class-specific) filters
			if (!this._pageCtx || this._pageCtx.sClassId !== sClassId ||
				this._pageCtx.sClassType !== "002") {
				this._clearFilters();
			}

			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/tableBusy", true);

			try {
				var sClassType = "002";
				var aChars = await this._fetchCharacteristics(sClassId);
				var mMeta = await this._fetchCharcMetadata(aChars);
				this._buildColumns(aChars, oCfg);

				// Load the whole class's object keys + headers up front (both are thin),
				// so we can sort across the whole class while still fetching the heavy
				// characteristic values only for the visible page.
				var aKeys = await this._fetchAllObjectKeys(oCfg, sClassId, sClassType);
				var mHeaders = await this._fetchHeaders(oCfg, aKeys);
				var oContext = { className: oClass.Class, classId: sClassId };

				this._pageCtx = {
					oCfg: oCfg,
					sClassId: sClassId,
					sClassType: sClassType,
					className: oClass.Class,
					aChars: aChars,
					mMeta: mMeta,
					allKeys: aKeys,
					keys: aKeys.slice(),
					headers: mHeaders,
					sortVals: this._buildSortVals(oCfg, aKeys, mHeaders, oContext, aChars),
					sortField: "TechnicalObject",
					sortDesc: false
				};

				// characteristics available to the filter (from this class)
				oUI.setProperty("/charcOptions", aChars.map(function (oChar) {
					return { key: oChar.CharcInternalID, text: oChar.Characteristic };
				}));

				// apply the filter-bar criteria (object number / characteristic / value)
				await this._applyAllFilters();
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/showEmptyState", true);
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * Read the active filter criteria from the Adapt-Filters value fields:
		 * one condition per non-empty characteristic field, plus the object-number field.
		 * @returns {{charcs: object[], object: string}}
		 */
		/**
		 * Fetch ALL object keys for the class (thin — one column) from the
		 * class-assignment entity.
		 * @returns {Promise<string[]>}
		 */
		/**
		 * Apply the filter-bar criteria to the loaded class: object-number conditions
		 * (matched in memory against the keys we already hold) AND characteristic-value
		 * conditions (resolved server-side), then sort + show page 1.
		 */
		/** Clear all values in the visible report filters. */
		_clearFilters: function () {
			var that = this;

			["cabinConfigFilter", "equipmentOwnedByFilter", "charcSelect", "charcValueFilter", "vehicleAgeFrom", "vehicleAgeTo"].forEach(function (sId) {
				var oCtrl = that.byId(sId);
				if (!oCtrl) { return; }
				if (oCtrl.setSelectedKeys) { oCtrl.setSelectedKeys([]); }
				if (oCtrl.setValue) { oCtrl.setValue(""); }
				if (oCtrl.setValueState) { oCtrl.setValueState("None"); }
			});

		},

		_applyAllFilters: async function () {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			var oUI = this._ui();
			oUI.setProperty("/tableBusy", true);

			try {
				var aKeys = (ctx.allKeys || []).slice();
				var oAgeRange = this._getVehicleAgeRange();
				if (!oAgeRange.valid) {
					this._showError(oAgeRange.error);
					oUI.setProperty("/tableBusy", false);
					return;
				}

				var aNamedFilters = [
					{ controlId: "cabinConfigFilter", characteristic: "Cabin Configuration" },
					{ controlId: "equipmentOwnedByFilter", characteristic: "Equipment Owned by" }
				];
				for (var i = 0; i < aNamedFilters.length; i++) {
					var oFilter = aNamedFilters[i];
					var aValues = this._selectedKeys(oFilter.controlId);
					var sCharcId = this._findCharacteristicId(ctx.aChars, oFilter.characteristic);
					if (aValues.length && sCharcId) {
						var oNamedSet = await this._resolveValueKeys(ctx, aValues.map(function (sValue) {
							return { operation: "EQ", value1: sValue };
						}), [sCharcId]);
						aKeys = aKeys.filter(function (sKey) { return !!oNamedSet[sKey]; });
					}
				}

				if (oAgeRange.active) {
					aKeys = aKeys.filter(function (sKey) {
						var iAgeMonths = this._vehicleAgeMonths((ctx.headers[sKey] || {}).OperationStartDate);
						if (iAgeMonths === null) {
							return false;
						}
						return (oAgeRange.from === null || iAgeMonths >= oAgeRange.from * 12) &&
							(oAgeRange.to === null || iAgeMonths <= oAgeRange.to * 12);
					}, this);
				}

				var aCharcIds = this._selectedKeys("charcSelect");
				var aCharcValues = this._selectedKeys("charcValueFilter");
				if (aCharcIds.length) {
					var oCharcSet = aCharcValues.length
						? await this._resolveValueKeys(ctx, aCharcValues.map(function (sValue) {
							return { operation: "EQ", value1: sValue };
						}), aCharcIds)
						: await this._resolveHasValueKeys(ctx, aCharcIds, aKeys);
					aKeys = aKeys.filter(function (sKey) { return !!oCharcSet[sKey]; });
				}

				ctx.keys = aKeys;
				await this._ensureReportSortValues(ctx, ctx.sortField);
				this._sortKeys();
				await this._loadPage(0);
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * Extract filter conditions from a MultiInput. Each condition is
		 * { operation, value1, value2 } from the value-help range data, or a plain
		 * "contains" for a directly-typed token. IMPORTANT: also picks up text the
		 * user typed but did NOT turn into a token (i.e. typed then clicked Go without
		 * pressing Enter) so the filter still applies.
		 */
		_tokenConditions: function (oMultiInput) {
			if (!oMultiInput || !oMultiInput.getTokens) {
				return [];
			}
			var aConds = oMultiInput.getTokens().map(function (oToken) {
				var oRange = oToken.data("range");
				if (oRange && oRange.operation) {
					return { operation: oRange.operation, value1: oRange.value1, value2: oRange.value2, exclude: !!oRange.exclude };
				}
				// a plain typed token -> forgiving "contains" match
				return { operation: "Contains", value1: oToken.getKey() || oToken.getText(), value2: null };
			});
			// include text typed straight into the field but not yet tokenised
			var sTyped = oMultiInput.getValue ? (oMultiInput.getValue() || "").trim() : "";
			if (sTyped) {
				aConds.push({ operation: "Contains", value1: sTyped, value2: null });
			}
			return aConds.filter(function (oCond) {
				// keep empty / not-empty conditions (they carry no value); drop any other
				// condition that has no value to match.
				return oCond.operation === "Empty" ||
					(oCond.value1 !== undefined && oCond.value1 !== null && oCond.value1 !== "");
			});
		},

		/** Client-side match of a string value against a single condition. */
		_matchCondition: function (sVal, oCond) {
			var s = String(sVal == null ? "" : sVal);
			var v1 = String(oCond.value1 == null ? "" : oCond.value1);
			var v2 = String(oCond.value2 == null ? "" : oCond.value2);
			var cmp = function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); };
			var sl = s.toLowerCase();
			var v1l = v1.toLowerCase();
			switch (oCond.operation) {
				case "EQ": return sl === v1l;
				case "Contains": return sl.indexOf(v1l) !== -1;
				case "StartsWith": return sl.indexOf(v1l) === 0;
				case "EndsWith": return sl.length >= v1l.length && sl.lastIndexOf(v1l) === sl.length - v1l.length;
				case "GT": return cmp(s, v1) > 0;
				case "GE": return cmp(s, v1) >= 0;
				case "LT": return cmp(s, v1) < 0;
				case "LE": return cmp(s, v1) <= 0;
				case "BT": return cmp(s, v1) >= 0 && cmp(s, v2) <= 0;
				default: return s.indexOf(v1) !== -1;
			}
		},

		_selectedKeys: function (sControlId) {
			var oControl = this.byId(sControlId);
			return oControl && oControl.getSelectedKeys ? oControl.getSelectedKeys() : [];
		},

		_findCharacteristicId: function (aChars, sName) {
			function norm(s) { return String(s || "").trim().toLowerCase(); }
			// the class characteristic is exposed by its technical name
			// (e.g. CABIN_CONFIGURATION), so also accept that name for the fixed filters
			var aAliases = {
				"cabin configuration": ["CABIN_CONFIGURATION"],
				"equipment owned by": ["OWNER_EQUIPMENT"]
			}[norm(sName)] || [];
			var aExpected = [norm(sName)].concat(aAliases.map(norm));
			var oChar = (aChars || []).filter(function (oItem) {
				return aExpected.indexOf(norm(oItem.Characteristic)) !== -1;
			})[0];
			return oChar ? oChar.CharcInternalID : "";
		},

		_loadNamedCharacteristicOptions: async function (oCfg, sClassId, oUnion) {
			var aPairs = [
				{ name: "Cabin Configuration", property: "cabinConfiguration" },
				{ name: "Equipment Owned by", property: "equipmentOwnedBy" }
			];
			var mOptions = {};
			for (var i = 0; i < aPairs.length; i++) {
				var oPair = aPairs[i];
				var sCharcId = this._findCharacteristicId(oUnion.chars, oPair.name);
				mOptions[oPair.property] = sCharcId
					? await this._loadCharacteristicValueOptions({
						oCfg: oCfg,
						sClassId: sClassId,
						mMeta: oUnion.meta
					}, [sCharcId])
					: [];
			}
			return mOptions;
		},

		_loadCharacteristicValueOptions: async function (ctx, aCharcIds) {
			var that = this;
			var oModel = this._model(ctx.oCfg.modelName);
			var aResponses = await Promise.all(aCharcIds.map(function (sCharcId) {
				return that._read(oModel, ctx.oCfg.valueSet, {
					"$filter": ctx.oCfg.filterField + " eq '" + that._esc(ctx.sClassId) +
						"' and " + ctx.oCfg.charcIdField + " eq '" + that._esc(sCharcId) + "'",
					"$select": ctx.oCfg.valueSelect,
					"$top": MAX_VALUE_ROWS
				}).then(function (aRows) { return { charcId: sCharcId, rows: aRows }; });
			}));
			var oSeen = {};
			aResponses.forEach(function (oResponse) {
				oResponse.rows.forEach(function (oRow) {
					if (oRow.ClassInternalID !== ctx.sClassId) {
						return;
					}
					var sValue = that._formatCellValue(oRow, ctx.mMeta[oResponse.charcId]);
					if (sValue) {
						oSeen[sValue] = true;
					}
				});
			});
			return Object.keys(oSeen).sort(function (a, b) {
				return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
			}).map(function (sValue) {
				return { key: sValue, text: sValue };
			});
		},

		/** Distinct, sorted, non-empty values of a header field across the keys,
		 *  shaped as { key, text } options for a dropdown. */
		_distinctHeaderValues: function (mHeaders, aKeys, sField) {
			var oSeen = {};
			(aKeys || []).forEach(function (k) {
				var v = mHeaders[k] && mHeaders[k][sField];
				if (v !== undefined && v !== null && v !== "") {
					oSeen[v] = true;
				}
			});
			return Object.keys(oSeen).sort().map(function (v) {
				return { key: v, text: v };
			});
		},

		/** Floor an epoch to the start of its calendar day (local time). */
		_dayFloor: function (nEpoch) {
			var d = new Date(nEpoch);
			return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		},

		/**
		 * Resolve object keys (within the class) whose value — in any selected
		 * characteristic, or any characteristic if none selected — matches ANY of the
		 * value conditions. One server query per value condition.
		 * @returns {Promise<object>} map objectKey -> true
		 */
		_resolveValueKeys: async function (ctx, aValConds, aCharcIds) {
			var that = this;
			var oCfg = ctx.oCfg;
			var sKeyField = oCfg.objectKeyField;
			var oModel = this._model(oCfg.modelName);
			var mMeta = ctx.mMeta || {};

			// When characteristic(s) are selected we know the data type, so each query
			// is scoped to that characteristic and filters the TYPED field for its type
			// (CharcFromNumericValue / CharcFromDate / CharcFromAmount), else the
			// CharcValue string. With NO characteristic selected the type is unknown, so
			// we OR across all types (string + numeric + date) per condition, since SAP
			// stores each value in the field for its type (CharcValue is empty for NUM
			// and DATE), and search across every characteristic.
			var aSpecs = [];
			if (aCharcIds.length) {
				aCharcIds.forEach(function (sCharcId) {
					var sType = (mMeta[sCharcId] && mMeta[sCharcId].CharcDataType) || "CHAR";
					aValConds.forEach(function (oCond) {
						aSpecs.push(oCfg.charcIdField + " eq '" + that._esc(sCharcId) + "' and (" + that._typedValueFilter(oCond, sType) + ")");
					});
				});
			} else {
				aValConds.forEach(function (oCond) {
					// No characteristic selected: search across ALL types and OR them. Always
					// match the CharcValue string; additionally match the typed date field for
					// a date-looking value, or the typed numeric fields (NUM + CURR) for a
					// number. Non-matching typed fields are null on a row, so they never add
					// false positives. Rows are still intersected with the loaded class objects.
					var aOr = [that._valueConditionFilter(oCond)];
					if (that._isDateValue(oCond.value1)) {
						var sDate = that._dateFilter("CharcFromDate", oCond);
						if (sDate) { aOr.push(sDate); }
					} else if (that._isNumericValue(oCond.value1)) {
						var sNum = that._numericFilter("CharcFromNumericValue", oCond);
						if (sNum) { aOr.push(sNum); }
						var sAmt = that._numericFilter("CharcFromAmount", oCond);
						if (sAmt) { aOr.push(sAmt); }
					}
					aSpecs.push(aOr.length > 1 ? "(" + aOr.join(" or ") + ")" : aOr[0]);
				});
			}

			var aSets = await Promise.all(aSpecs.map(function (sFilter) {
				return that._read(oModel, oCfg.valueSet, {
					"$filter": sFilter,
					"$select": sKeyField + ",ClassInternalID",
					"$top": MAX_VALUE_ROWS
				}).then(function (aRows) {
					var oSet = {};
					aRows.forEach(function (r) {
						var oC = ctx.classByKey && ctx.classByKey[r[sKeyField]];
						if (oC && r.ClassInternalID === oC.ClassInternalID) {
							oSet[r[sKeyField]] = true;
						}
					});
					return oSet;
				});
			}));

			var oUnion = {};
			aSets.forEach(function (oSet) {
				Object.keys(oSet).forEach(function (k) { oUnion[k] = true; });
			});
			return oUnion;
		},

		/**
		 * Resolve, from the candidate keys, the ones that HAVE a value for the selected
		 * characteristic(s) — for the empty / not-empty filter. Type-aware: the value
		 * lives in the typed field for the characteristic's data type
		 * (CharcFromNumericValue for NUM, CharcFromDate for DATE, etc. — CharcValue is
		 * empty for those). Scoped to the candidate keys (chunked) so the result is exact
		 * for the loaded objects and never truncated by the row cap. Union across chars.
		 */
		_resolveHasValueKeys: async function (ctx, aCharcIds, aKeys) {
			var that = this;
			var oCfg = ctx.oCfg;
			var sKeyField = oCfg.objectKeyField;
			var oModel = this._model(oCfg.modelName);
			var mMeta = ctx.mMeta || {};
			var oHas = {};
			if (!aCharcIds.length || !aKeys || !aKeys.length) { return oHas; }

			var aChunks = this._chunk(aKeys, 200);
			var aReqs = [];
			aCharcIds.forEach(function (sCharcId) {
				var sType = (mMeta[sCharcId] && mMeta[sCharcId].CharcDataType) || "CHAR";
				var sHas = sType === "NUM" ? "(CharcFromNumericValue ne null or CharcFromDecimalValue ne null)"
					: sType === "CURR" ? "CharcFromAmount ne null"
					: sType === "DATE" ? "CharcFromDate ne null"
					: "CharcValue ne ''";
				aChunks.forEach(function (aChunk) {
					var sKeys = "(" + aChunk.map(function (k) { return sKeyField + " eq '" + that._esc(k) + "'"; }).join(" or ") + ")";
					aReqs.push(sKeys + " and " + oCfg.charcIdField + " eq '" + that._esc(sCharcId) + "' and (" + sHas + ")");
				});
			});

			var aSets = await Promise.all(aReqs.map(function (sFilter) {
				return that._read(oModel, oCfg.valueSet, {
					"$filter": sFilter,
					"$select": sKeyField,
					"$top": MAX_LIST_ROWS
				}).then(function (aRows) {
					var oSet = {};
					aRows.forEach(function (r) { oSet[r[sKeyField]] = true; });
					return oSet;
				});
			}));
			aSets.forEach(function (oSet) { Object.keys(oSet).forEach(function (k) { oHas[k] = true; }); });
			return oHas;
		},

		/** Build the server filter for a value condition against the right field for
		 *  the characteristic's data type. Falls back to a CharcValue string match. */
		_typedValueFilter: function (oCond, sType) {
			var sTyped = null;
			if (sType === "NUM") {
				sTyped = this._numericFilter("CharcFromNumericValue", oCond);
			} else if (sType === "CURR") {
				sTyped = this._numericFilter("CharcFromAmount", oCond);
			} else if (sType === "DATE") {
				sTyped = this._dateFilter("CharcFromDate", oCond);
			}
			return sTyped || this._valueConditionFilter(oCond);
		},

		/** Numeric OData clause (Edm.Double/Decimal accept plain number literals). */
		_numericFilter: function (sField, oCond) {
			var n1 = parseFloat(oCond.value1);
			if (isNaN(n1)) { return null; } // not a number -> let caller fall back
			var n2 = parseFloat(oCond.value2);
			switch (oCond.operation) {
				case "EQ": return sField + " eq " + n1;
				case "GT": return sField + " gt " + n1;
				case "GE": return sField + " ge " + n1;
				case "LT": return sField + " lt " + n1;
				case "LE": return sField + " le " + n1;
				case "BT": return "(" + sField + " ge " + n1 + " and " + sField + " le " + (isNaN(n2) ? n1 : n2) + ")";
				default: return sField + " eq " + n1; // typed/contains on a number -> equals
			}
		},

		/** Date OData clause against an Edm.DateTime field (datetime'...' literals,
		 *  matched at day granularity). */
		_dateFilter: function (sField, oCond) {
			var d1 = this._parseFilterDate(oCond.value1);
			if (!d1) { return null; }
			var that = this;
			var dayAfter = function (d) { var x = new Date(d.getTime()); x.setDate(x.getDate() + 1); return x; };
			switch (oCond.operation) {
				case "EQ":
					return "(" + sField + " ge " + that._odataDateLit(d1) + " and " + sField + " lt " + that._odataDateLit(dayAfter(d1)) + ")";
				case "GT": return sField + " ge " + that._odataDateLit(dayAfter(d1));
				case "GE": return sField + " ge " + that._odataDateLit(d1);
				case "LT": return sField + " lt " + that._odataDateLit(d1);
				case "LE": return sField + " lt " + that._odataDateLit(dayAfter(d1));
				case "BT":
					var d2 = this._parseFilterDate(oCond.value2) || d1;
					return "(" + sField + " ge " + that._odataDateLit(d1) + " and " + sField + " lt " + that._odataDateLit(dayAfter(d2)) + ")";
				default:
					return "(" + sField + " ge " + that._odataDateLit(d1) + " and " + sField + " lt " + that._odataDateLit(dayAfter(d1)) + ")";
			}
		},

		/** Tolerant parse of a user-entered or VHD-supplied date -> Date, or null.
		 *  Day-first (Australian) for d/m/y; ISO and month-name forms also handled. */
		_parseFilterDate: function (v) {
			if (v === undefined || v === null || v === "") { return null; }
			if (v instanceof Date) { return v; }
			var s = String(v).trim();
			var m = /\/Date\((-?\d+)/.exec(s);
			if (m) { return new Date(parseInt(m[1], 10)); }
			// dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy (day first)
			m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
			if (m) {
				var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
				if (yy < 100) { yy += 2000; }
				if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) { return new Date(yy, mm - 1, dd); }
			}
			// ISO yyyy-mm-dd
			m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
			if (m) { return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)); }
			// fallback: native parse handles "Jan 1, 1992", "1 Jan 1992", etc.
			var t = Date.parse(s);
			return isNaN(t) ? null : new Date(t);
		},

		/** Format a Date as an OData V2 datetime literal at midnight (local day). */
		_odataDateLit: function (d) {
			var p = function (n) { return (n < 10 ? "0" : "") + n; };
			return "datetime'" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T00:00:00'";
		},

		/** True when the value is a day-first date (dd/mm/yyyy, dd.mm.yyyy or
		 *  dd-mm-yyyy). Such a value is only meaningful for DATE characteristics, so
		 *  the caller searches CharcFromDate rather than substring-matching CharcValue. */
		_isDateValue: function (v) {
			if (v === undefined || v === null) { return false; }
			return (/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/).test(String(v).trim());
		},

		/** True when the value is a plain number (integer or decimal). Used to also
		 *  match the typed numeric fields (CharcFromNumericValue / CharcFromAmount)
		 *  when no characteristic is selected. */
		_isNumericValue: function (v) {
			if (v === undefined || v === null || v === "") { return false; }
			return (/^-?\d+(\.\d+)?$/).test(String(v).trim());
		},

		/** Build a CharcValue (string) OData clause for a value condition. */
		_valueConditionFilter: function (oCond) {
			var v1 = this._esc(oCond.value1);
			var v2 = this._esc(oCond.value2);
			switch (oCond.operation) {
				case "EQ": return "CharcValue eq '" + v1 + "'";
				case "StartsWith": return "startswith(CharcValue,'" + v1 + "')";
				case "BT": return "(CharcValue ge '" + v1 + "' and CharcValue le '" + v2 + "')";
				case "GT": return "CharcValue gt '" + v1 + "'";
				case "GE": return "CharcValue ge '" + v1 + "'";
				case "LT": return "CharcValue lt '" + v1 + "'";
				case "LE": return "CharcValue le '" + v1 + "'";
				default: return "substringof('" + v1 + "',CharcValue)";
			}
		},

		_fetchAllObjectKeys: async function (oCfg, sClassId, sClassType) {
			var sKeyField = oCfg.objectKeyField;
			var aRows = await this._read(this._model(oCfg.modelName), oCfg.keyClassSet, {
				"$filter": "ClassInternalID eq '" + this._esc(sClassId) + "' and ClassType eq '" + this._esc(sClassType) + "'",
				"$select": sKeyField,
				"$orderby": sKeyField,
				"$top": MAX_LIST_ROWS
			});
			return aRows.map(function (o) { return o[sKeyField]; }).filter(Boolean);
		},

		/**
		 * Pre-compute the sortable (fixed-column) values per object from the headers,
		 * so sorting the whole class is a cheap client-side compare.
		 * @returns {object} map objectKey -> { fixedColumnKey: value }
		 */
		_buildSortVals: function (oCfg, aKeys, mHeaders, oContext, aChars) {
			var mSortVals = {};
			aKeys.forEach(function (sKey) {
				var oHeader = mHeaders[sKey] || {};
				var o = {};
				oCfg.fixedColumns.forEach(function (oFixed) {
					var v = oFixed.get(sKey, oHeader, null, oContext);
					o[oFixed.key] = (v === undefined || v === null) ? "" : String(v);
				});
				o.TechnicalObject = o.objNumber || "";
				o.TechnicalObjectDescription = o.objDesc || "";
				o.VehicleAge = this._vehicleAge(oHeader.OperationStartDate);
				o.Class = o.objClass || "";
				o.SubClassName = (aChars || []).map(function (oChar) {
					return oChar.Characteristic || "";
				}).join(", ");
				o.SubClassValue = "";
				o.CabinConfiguration = "";
				o.EquipmentOwnedBy = "";
				o.OdometerReading = "";
				o.StartUpDate = fmtSAPDateISO(oHeader.OperationStartDate);
				o.ManufacturerSerialNumber = oHeader.ManufacturerSerialNumber || "";
				o.TechnicalID = oHeader.TechnicalObjectSortCode || "";
				mSortVals[sKey] = o;
			}, this);
			return mSortVals;
		},

		/** Sort the working key list by the active sort field (numeric-aware). */
		_sortKeys: function () {
			var ctx = this._pageCtx;
			if (!ctx || !ctx.keys || !ctx.sortVals) {
				return;
			}
			var sField = ctx.sortField;
			var bDesc = ctx.sortDesc;
			var mVals = ctx.sortVals;
			this._ui().setProperty("/sortField", sField);
			this._ui().setProperty("/sortDesc", bDesc);
			ctx.keys.sort(function (a, b) {
				var va = (mVals[a] && mVals[a][sField]) || "";
				var vb = (mVals[b] && mVals[b][sField]) || "";
				var c = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
				return bDesc ? -c : c;
			});
		},

		/** Apply a sort field/direction across the whole class and reload page 1. */
		_setSort: async function (sField, bDesc) {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			var oUI = this._ui();
			ctx.sortField = sField;
			ctx.sortDesc = !!bDesc;
			oUI.setProperty("/sortField", sField);
			oUI.setProperty("/sortDesc", !!bDesc);
			oUI.setProperty("/tableBusy", true);
			try {
				await this._ensureReportSortValues(ctx, sField);
				this._sortKeys();
				this._reflectSortOnColumns();
				await this._loadPage(0);
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
			} finally {
				oUI.setProperty("/tableBusy", false);
			}
		},

		_ensureReportSortValues: async function (ctx, sField) {
			var aChars = ctx.aChars || [];
			var aRelevantIds = [];
			if (sField === "SubClassValue") {
				aRelevantIds = aChars.map(function (oChar) { return oChar.CharcInternalID; });
			} else if (sField === "CabinConfiguration") {
				aRelevantIds = [this._findCharacteristicId(aChars, "Cabin Configuration")].filter(Boolean);
			} else if (sField === "OdometerReading") {
				aRelevantIds = [this._findCharacteristicId(aChars, "Odometer Reading")].filter(Boolean);
			} else {
				return;
			}
			if (!aRelevantIds.length) {
				return;
			}
			var mValues = ctx.reportCharValues || (ctx.reportCharValues = {});
			var mFetched = ctx.reportCharValueIds || (ctx.reportCharValueIds = {});
			var aKeysToFetch = (ctx.keys || []).filter(function (sKey) {
				return aRelevantIds.some(function (sId) { return !mFetched[sKey] || !mFetched[sKey][sId]; });
			});
			var aChunks = this._chunk(aKeysToFetch, 25);
			for (var i = 0; i < aChunks.length; i++) {
				var aRows = await this._fetchValuesForKeys(ctx.oCfg, aChunks[i], ctx.sClassId, ctx.classByKey);
				aRows.forEach(function (oRow) {
					var sObjectKey = oRow[ctx.oCfg.objectKeyField];
					var sCharcId = oRow[ctx.oCfg.charcIdField];
					if (aRelevantIds.indexOf(sCharcId) === -1) {
						return;
					}
					var mObjectValues = mValues[sObjectKey] || (mValues[sObjectKey] = {});
					var aCell = mObjectValues[sCharcId] || (mObjectValues[sCharcId] = []);
					aCell.push({
						position: parseInt(oRow.CharcValuePositionNumber, 10) || 0,
						value: this._formatCellValue(oRow, ctx.mMeta[sCharcId])
					});
				}, this);
				aChunks[i].forEach(function (sKey) {
					mFetched[sKey] = mFetched[sKey] || {};
					aRelevantIds.forEach(function (sId) { mFetched[sKey][sId] = true; });
				});
			}

			var sCabinId = this._findCharacteristicId(aChars, "Cabin Configuration");
			var sOwnerId = this._findCharacteristicId(aChars, "Equipment Owned by");
			var sOdometerId = this._findCharacteristicId(aChars, "Odometer Reading");
			(ctx.keys || []).forEach(function (sKey) {
				var mObjectValues = mValues[sKey] || {};
				function valueFor(sCharcId) {
					if (!sCharcId || !mFetched[sKey] || !mFetched[sKey][sCharcId]) {
						return "";
					}
					return (mObjectValues[sCharcId] || [])
						.sort(function (a, b) { return a.position - b.position; })
						.map(function (oItem) { return oItem.value; })
						.filter(Boolean)
						.join(", ");
				}
				var oSort = ctx.sortVals[sKey] || (ctx.sortVals[sKey] = {});
				oSort.CabinConfiguration = valueFor(sCabinId);
				oSort.EquipmentOwnedBy = valueFor(sOwnerId);
				oSort.OdometerReading = valueFor(sOdometerId);
				oSort.SubClassValue = aRelevantIds.map(function (sCharcId) {
					return valueFor(sCharcId);
				}).filter(Boolean).join(", ");
			});
		},

		/** Sort by a visible report column, toggling direction when selected again. */
		onSortFieldPress: function (oEvent) {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			var oItem = oEvent.getSource().getBindingContext("ui").getObject();
			var bDesc = (ctx.sortField === oItem.key) ? !ctx.sortDesc : false;
			this._setSort(oItem.key, bDesc);
		},

		/** Open the sort dialog for the visible report columns. */
		onSortPress: function () {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			if (!this._oSortDialog) {
				this._oSortDialog = new ViewSettingsDialog({ confirm: this.onSortConfirm.bind(this) });
				this.getView().addDependent(this._oSortDialog);
			}
			this._oSortDialog.removeAllSortItems();
			(this._ui().getProperty("/sortFields") || []).forEach(function (oField) {
				this._oSortDialog.addSortItem(new ViewSettingsItem({
					key: oField.key,
					text: oField.label,
					selected: oField.key === ctx.sortField
				}));
			}, this);
			this._oSortDialog.setSortDescending(!!ctx.sortDesc);
			this._oSortDialog.open();
		},

		onSortConfirm: function (oEvent) {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			var oItem = oEvent.getParameter("sortItem");
			var sField = oItem ? oItem.getKey() : "TechnicalObject";
			ctx.sortDesc = oEvent.getParameter("sortDescending");
			this._setSort(sField, ctx.sortDesc);
		},

		/** Reflect the active sort on the table column headers. */
		_reflectSortOnColumns: function () {
			var ctx = this._pageCtx;
			var oTable = this.byId("resultTable");
			if (!ctx || !oTable) {
				return;
			}
			var sOrder = ctx.sortDesc ? SortOrder.Descending : SortOrder.Ascending;
			oTable.getColumns().forEach(function (oCol) {
				var bActive = oCol.getSortProperty() === ctx.sortField;
				oCol.setSorted(bActive);
				if (bActive) {
					oCol.setSortOrder(sOrder);
				}
			});
		},

		/**
		 * Load one page of objects (server paging): fetch the page's object keys from
		 * the class-assignment entity, then only those objects' values + headers.
		 * @param {int} iPageIndex zero-based page index
		 */
		_loadPage: async function (iPageIndex) {
			var ctx = this._pageCtx;
			if (!ctx) {
				return;
			}
			var oUI = this._ui();
			var iPageSize = oUI.getProperty("/pageSize") || 25;
			oUI.setProperty("/tableBusy", true);
			oUI.setProperty("/showEmptyState", false);

			try {
				// 1. page of object keys (+ total count)
				var aKeys, iTotal;
				if (ctx.keys) {
					// filtered: page the pre-resolved matching keys client-side
					iTotal = ctx.keys.length;
					aKeys = ctx.keys.slice(iPageIndex * iPageSize, (iPageIndex * iPageSize) + iPageSize);
				} else {
					// unfiltered: server paging via the class-assignment entity
					var oPage = await this._fetchObjectKeyPage(ctx, iPageIndex * iPageSize, iPageSize);
					aKeys = oPage.keys;
					iTotal = oPage.count;
				}

				if (!aKeys.length) {
					oUI.setProperty("/rows", []);
					oUI.setProperty("/treeRows", []);
					oUI.setProperty("/showTable", false);
					oUI.setProperty("/showNoData", true);
					oUI.setProperty("/noDataTitle", this._bundle().getText("noDataTitle", [ctx.className]));
					this._updatePagination(0, iPageSize, iTotal || 0);
					return;
				}

				// 2. values for just these objects (cheap key filter), kept to their class
				var aValues = await this._fetchValuesForKeys(ctx.oCfg, aKeys, ctx.sClassId, ctx.classByKey);

				// 3. headers for these objects
				var mHeaders = ctx.headers || await this._fetchHeaders(ctx.oCfg, aKeys);

				// 4. pivot — seed with the page keys so every object shows a row even
				//    if it has no display-relevant values
				var oContext = { className: ctx.className, classId: ctx.sClassId, classByKey: ctx.classByKey };
				var aRows = this._pivotData(aValues, ctx.aChars, ctx.mMeta, ctx.oCfg, oContext, mHeaders, aKeys);

				// 5. odometer readings from the fleet odometer CDS view
				ctx.odometer = await this._fetchOdometerReadings(aKeys);

				oUI.setProperty("/rows", aRows);
				oUI.setProperty("/treeRows", this._buildTreeRows(aRows, ctx.aChars));
				oUI.setProperty("/showNoData", false);
				oUI.setProperty("/showTable", true);
				this._updatePagination(iPageIndex, iPageSize, iTotal);

				// re-apply any active page-local filters/search to the new page
				this._applyResultFilters();
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
			} finally {
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * Load odometer readings for the given equipment keys from
		 * YY1_FLEET_ODOMETER (latest reading per equipment). Failures are
		 * non-fatal: the column then falls back to the characteristic value.
		 * @param {string[]} aKeys equipment numbers
		 * @returns {Promise<object>} map equipment -> formatted reading
		 */
		_fetchOdometerReadings: async function (aKeys) {
			var mOut = {};
			var oModel = this._model("odometer");
			if (!oModel || !aKeys.length) {
				return mOut;
			}
			var mLatest = {};
			try {
				var aChunks = this._chunk(aKeys, 20);
				for (var i = 0; i < aChunks.length; i++) {
					var sFilter = aChunks[i].map(function (sKey) {
						return "Equipment eq '" + this._esc(sKey) + "'";
					}, this).join(" or ");
					var aRows = await this._read(oModel, "/YY1_FLEET_ODOMETER", {
						"$filter": sFilter,
						"$top": MAX_LIST_ROWS
					});
					aRows.forEach(function (oRow) {
						var sEquipment = oRow.Equipment;
						var sReading = this._pickOdometerValue(oRow);
						if (!sEquipment || sReading === "") {
							return;
						}
						var sStamp = this._pickOdometerStamp(oRow);
						var oPrev = mLatest[sEquipment];
						if (!oPrev || sStamp >= oPrev.stamp) {
							mLatest[sEquipment] = { stamp: sStamp, value: sReading };
						}
					}, this);
				}
			} catch (oError) {
				return {};
			}
			Object.keys(mLatest).forEach(function (sKey) {
				mOut[sKey] = mLatest[sKey].value;
			});
			return mOut;
		},

		/** Reading field of a fleet odometer row (first property named like odometer/reading/mileage). */
		_pickOdometerValue: function (oRow) {
			var aKeys = Object.keys(oRow).filter(function (k) {
				return k !== "__metadata" && /odometer|reading|mileage|counter/i.test(k) && !/unit|date|time|uom/i.test(k);
			});
			if (!aKeys.length) {
				return "";
			}
			var v = oRow[aKeys[0]];
			return (v === null || v === undefined || v === "") ? "" : this._numStr(v);
		},

		/** Sortable recency stamp of a fleet odometer row (date/time fields concatenated). */
		_pickOdometerStamp: function (oRow) {
			return Object.keys(oRow).filter(function (k) {
				return /date|time/i.test(k) && k !== "__metadata";
			}).sort().map(function (k) {
				var v = oRow[k];
				return v instanceof Date ? v.toISOString() : String(v == null ? "" : v);
			}).join("|");
		},

		/** Update pagination state + labels for the given page. */
		_updatePagination: function (iPageIndex, iPageSize, iTotal) {
			var oUI = this._ui();
			var iPages = Math.max(1, Math.ceil(iTotal / iPageSize));
			var iCurrent = iPageIndex + 1;
			var iFrom = iTotal === 0 ? 0 : (iPageIndex * iPageSize) + 1;
			var iTo = Math.min(iTotal, (iPageIndex + 1) * iPageSize);

			this._currentPage = iPageIndex;
			this._totalObjects = iTotal;
			oUI.setProperty("/tableTitle", this._bundle().getText("tableTitle", [iTotal]));
			oUI.setProperty("/pageInfo", this._bundle().getText("pageInfo", [iCurrent, iPages, iFrom, iTo]));
			oUI.setProperty("/pagePrevEnabled", iPageIndex > 0);
			oUI.setProperty("/pageNextEnabled", iCurrent < iPages);
		},

		/**
		 * API 1 — ordered, display-relevant characteristics of the class.
		 * @param {string} sClassId ClassInternalID
		 * @returns {Promise<object[]>} characteristics sorted by CharcPositionNumber
		 */
		_fetchCharacteristics: async function (sClassId) {
			var oModel = this._model("class");
			var sPath = "/A_ClfnClassForKeyDate('" + this._esc(sClassId) + "')/to_ClassCharacteristic";

			// Fetch all of the class's characteristics (the CharcIsDisplayRelevant flag
			// is often not maintained, so we can't hard-filter on it server-side).
			var aResults = await this._read(oModel, sPath, {
				"$orderby": "CharcPositionNumber",
				"$select": "CharcInternalID,Characteristic,CharcPositionNumber,CharcIsDisplayRelevant",
				"$top": MAX_LIST_ROWS
			});

			// Guard the ordering client-side too (orderby is also applied server-side).
			var aSorted = aResults.slice().sort(function (a, b) {
				return (parseInt(a.CharcPositionNumber, 10) || 0) - (parseInt(b.CharcPositionNumber, 10) || 0);
			});

			// Prefer display-relevant characteristics, but fall back to all of them
			// when the flag isn't set (otherwise there would be no characteristic columns).
			var aDisplay = aSorted.filter(function (c) { return c.CharcIsDisplayRelevant === "X"; });
			return aDisplay.length ? aDisplay : aSorted;
		},

		/**
		 * API 2 — optional characteristic metadata, keyed by CharcInternalID.
		 * Failure here is non-fatal: the value rows already carry CharcDataType,
		 * so we fall back to those if this call cannot be made.
		 * @param {object[]} aChars characteristics from API 1
		 * @returns {Promise<object>} map CharcInternalID -> metadata
		 */
		_fetchCharcMetadata: async function (aChars) {
			var mMeta = {};
			if (!aChars.length) {
				return mMeta;
			}

			var oModel = this._model("charc");
			var that = this;
			var aIds = aChars.map(function (c) { return c.CharcInternalID; });

			// OData V2 has no `in` operator — build OR filters, chunked to keep URLs sane.
			var aChunks = this._chunk(aIds, 40);

			try {
				var aResponses = await Promise.all(aChunks.map(function (aChunk) {
					var sFilter = aChunk.map(function (id) {
						return "CharcInternalID eq '" + that._esc(id) + "'";
					}).join(" or ");
					return that._read(oModel, "/A_ClfnCharacteristicForKeyDate", {
						"$filter": sFilter,
						"$select": "CharcInternalID,CharcDataType,CharcDecimals,CharcValueUnit,Currency,CharcGroup,CharcGroupName",
						"$top": MAX_LIST_ROWS
					});
				}));

				aResponses.forEach(function (aRows) {
					aRows.forEach(function (o) { mMeta[o.CharcInternalID] = o; });
				});
			} catch (oError) {
				// swallow — formatting falls back to the value rows' own typing
				return mMeta;
			}

			return mMeta;
		},

		/**
		 * One page of object keys for the class, plus the total count, from the
		 * class-assignment entity (one cheap row per object in the class).
		 * @param {object} ctx the page context (oCfg, sClassId, sClassType)
		 * @param {int} iSkip rows to skip
		 * @param {int} iTop page size
		 * @returns {Promise<{keys: string[], count: int}>}
		 */
		_fetchObjectKeyPage: async function (ctx, iSkip, iTop) {
			var oCfg = ctx.oCfg;
			var oModel = this._model(oCfg.modelName);
			var sKeyField = oCfg.objectKeyField;
			var oData = await this._readWithCount(oModel, oCfg.keyClassSet, {
				"$filter": "ClassInternalID eq '" + this._esc(ctx.sClassId) + "' and ClassType eq '" + this._esc(ctx.sClassType) + "'",
				"$select": sKeyField,
				"$orderby": sKeyField,
				"$skip": iSkip,
				"$top": iTop,
				"$inlinecount": "allpages"
			});
			var aKeys = oData.results.map(function (o) { return o[sKeyField]; }).filter(Boolean);
			return { keys: aKeys, count: oData.count };
		},

		/**
		 * Value rows for a specific set of objects. Filters on the object key (cheap —
		 * avoids the expensive ClassInternalID filter), then narrows to the selected
		 * class client-side (an object's values span all its classes).
		 * @param {object} oCfg the per-type config
		 * @param {string[]} aKeys object numbers on the current page
		 * @param {string} sClassId the selected ClassInternalID
		 * @returns {Promise<object[]>} value rows for this class
		 */
		_fetchValuesForKeys: async function (oCfg, aKeys, sClassId, mClassByKey, iTop) {
			var oModel = this._model(oCfg.modelName);
			var sKeyField = oCfg.objectKeyField;
			var that = this;
			var sOr = aKeys.map(function (k) {
				return sKeyField + " eq '" + that._esc(k) + "'";
			}).join(" or ");
			var aRows = await this._read(oModel, oCfg.valueSet, {
				"$filter": "(" + sOr + ")",
				"$select": oCfg.valueSelect,
				// the key OR-filter bounds the query to these objects, so a high cap is
				// safe — it only limits rows returned, not the rows the DB scans
				"$top": iTop || MAX_VALUE_ROWS
			});
			var aClassRows = [];
			var aEquipmentFixedRows = [];
			var mFixedRows = {};
			aRows.forEach(function (oRow) {
				var sFixedField = oCfg.modelName === "equipment"
					? equipmentFixedCharacteristicField(oRow)
					: "";
				if (sFixedField) {
					var sFixedKey = oRow[sKeyField] + "\u0000" + sFixedField;
					var iExisting = mFixedRows[sFixedKey];
					if (iExisting === undefined) {
						mFixedRows[sFixedKey] = aEquipmentFixedRows.length;
						aEquipmentFixedRows.push(oRow);
					} else if ((aEquipmentFixedRows[iExisting].CharcValue === undefined ||
						aEquipmentFixedRows[iExisting].CharcValue === null ||
						aEquipmentFixedRows[iExisting].CharcValue === "") &&
						oRow.CharcValue !== undefined && oRow.CharcValue !== null && oRow.CharcValue !== "") {
						aEquipmentFixedRows[iExisting] = oRow;
					}
				}

				// Keep normal values for the resolved class, but retain the two
				// equipment-level fields across all of an equipment's class rows.
				var oClass = mClassByKey && mClassByKey[oRow[sKeyField]];
				var bInClass = mClassByKey
					? oClass && oRow.ClassInternalID === oClass.ClassInternalID
					: oRow.ClassInternalID === sClassId;
				if (!sFixedField && bInClass) {
					aClassRows.push(oRow);
				}
			});
			return aClassRows.concat(aEquipmentFixedRows);
		},

		/* =========================================================== */
		/* pivot: tall (object,charc,value) rows -> wide object rows    */
		/* =========================================================== */

		/**
		 * Load the object keys, per-object class map AND headers for the selected
		 * class(es) in a SINGLE request per class, by expanding the class->object
		 * navigation (to_Equipment / to_FunctionalLocation). The class-assignment
		 * row carries the key; the expanded entity carries the header — so one call
		 * replaces both the keys read and the (previously chunked) header reads.
		 * @param {object} oCfg type config
		 * @param {object[]} aClasses [{ ClassInternalID, Class }]
		 * @param {string} sClassType "002" | "003"
		 * @returns {Promise<{allKeys: string[], classByKey: object, headers: object}>}
		 */
		_fetchClassObjects: async function (oCfg, aClasses, sClassType) {
			var that = this;
			var oModel = this._model(oCfg.modelName);
			var sKeyField = oCfg.objectKeyField;
			var sNav = oCfg.headerExpandNav;

			var aPerClass = await Promise.all(aClasses.map(function (oClass) {
				return that._read(oModel, oCfg.keyClassSet, {
					"$filter": "ClassInternalID eq '" + that._esc(oClass.ClassInternalID) + "' and ClassType eq '" + that._esc(sClassType) + "'",
					"$expand": sNav,
					"$select": oCfg.headerExpandSelect,
					"$top": MAX_LIST_ROWS
				}).then(function (aRows) {
					return { cls: oClass, rows: aRows };
				});
			}));

			var mClassByKey = {};
			var aAllKeys = [];
			var mHeaders = {};

			aPerClass.forEach(function (o) {
				o.rows.forEach(function (oRow) {
					var sKey = oRow[sKeyField];
					if (!sKey) {
						return;
					}
					// keep the first class that claims an object (multi-class union)
					if (!mClassByKey[sKey]) {
						mClassByKey[sKey] = { ClassInternalID: o.cls.ClassInternalID, Class: o.cls.Class };
						aAllKeys.push(sKey);
					}
					// header from the expanded object (may be null for no-validity rows)
					var oHeader = oRow[sNav];
					if (oHeader) {
						var hk = oHeader[sKeyField] || sKey;
						var oPrev = mHeaders[hk];
						if (!oPrev || !oCfg.headerHasValidity ||
							that._epoch(oHeader.ValidityEndDate) >= that._epoch(oPrev.ValidityEndDate)) {
							mHeaders[hk] = oHeader;
						}
					}
				});
			});

			return { allKeys: aAllKeys, classByKey: mClassByKey, headers: mHeaders };
		},

		/**
		 * Lightweight fetch of the distinct planner groups in the selected class(es),
		 * used to populate the Planner Group dropdown the moment a class is chosen.
		 * Expands the class->object navigation but selects ONLY the planner field, so
		 * the payload is a fraction of the full object load.
		 * @returns {Promise<object[]>} [{ key, text }] planner-group options
		 */
		_fetchPlannerOptions: async function (oCfg, aClasses, sClassType) {
			var that = this;
			var oModel = this._model(oCfg.modelName);
			var sNav = oCfg.headerExpandNav;
			var oSeen = {};

			await Promise.all(aClasses.map(function (oClass) {
				return that._read(oModel, oCfg.keyClassSet, {
					"$filter": "ClassInternalID eq '" + that._esc(oClass.ClassInternalID) + "' and ClassType eq '" + that._esc(sClassType) + "'",
					"$expand": sNav,
					"$select": oCfg.objectKeyField + "," + sNav + "/MaintenancePlannerGroup",
					"$top": MAX_LIST_ROWS
				}).then(function (aRows) {
					aRows.forEach(function (oRow) {
						var oHeader = oRow[sNav];
						var v = oHeader && oHeader.MaintenancePlannerGroup;
						if (v !== undefined && v !== null && v !== "") {
							oSeen[v] = true;
						}
					});
				});
			}));

			return Object.keys(oSeen).sort().map(function (v) {
				return { key: v, text: v };
			});
		},

		_fetchHeaders: async function (oCfg, aKeys) {
			var mHeaders = {};
			var sKeyField = oCfg.objectKeyField;
			var that = this;

			if (!aKeys || !aKeys.length) {
				return mHeaders;
			}

			var oModel = this._model(oCfg.modelName);
			var aChunks = this._chunk(aKeys, 100);

			var aResponses = await Promise.all(aChunks.map(function (aChunk) {
				var sFilter = aChunk.map(function (k) {
					return sKeyField + " eq '" + that._esc(k) + "'";
				}).join(" or ");
				return that._read(oModel, oCfg.headerSet, {
					"$filter": sFilter,
					"$select": oCfg.headerSelect,
					"$top": MAX_LIST_ROWS
				});
			}));

			aResponses.forEach(function (aRows) {
				aRows.forEach(function (oRow) {
					var k = oRow[sKeyField];
					// for time-dependent headers, keep the latest validity record
					var oPrev = mHeaders[k];
					if (!oPrev || !oCfg.headerHasValidity ||
						that._epoch(oRow.ValidityEndDate) >= that._epoch(oPrev.ValidityEndDate)) {
						mHeaders[k] = oRow;
					}
				});
			});

			return mHeaders;
		},

		_pivotData: function (aValues, aChars, mMeta, oCfg, oContext, mHeaders, aSeedKeys) {
			var that = this;
			var sKeyField = oCfg.objectKeyField;
			var sCharcIdField = oCfg.charcIdField;
			var oGroups = {};
			var aOrder = [];

			function ensureGroup(sKey, oRow) {
				var oGroup = oGroups[sKey];
				if (!oGroup) {
					var oHeader = (mHeaders && mHeaders[sKey]) || {};
					oGroup = { __key: sKey, __cells: {}, cabinConfig: null, ownedBy: null };

					// fixed columns (oRow may be null for a seeded object with no values)
					oCfg.fixedColumns.forEach(function (oFixed) {
						var vValue = oFixed.get(sKey, oHeader, oRow || {}, oContext);
						oGroup[oFixed.key] = (vValue === undefined || vValue === null) ? "" : String(vValue);
					});

					oGroups[sKey] = oGroup;
					aOrder.push(sKey);
				}
				return oGroup;
			}

			// seed a row for every object on the page, in page (key) order
			(aSeedKeys || []).forEach(function (sKey) {
				if (sKey) {
					ensureGroup(sKey, null);
				}
			});

			aValues.forEach(function (oRow) {
				var sKey = oRow[sKeyField];
				if (!sKey) {
					return;
				}
				var oGroup = ensureGroup(sKey, oRow);
				var sFixedField = oCfg.modelName === "equipment"
					? equipmentFixedCharacteristicField(oRow)
					: "";
				if (sFixedField) {
					oGroup[sFixedField] = (oRow.CharcValue === undefined || oRow.CharcValue === null || oRow.CharcValue === "")
						? null
						: oRow.CharcValue;
				}

				// characteristic cell — accumulate for multi-value handling
				var sCharcId = oRow[sCharcIdField];
				var aBucket = oGroup.__cells[sCharcId];
				if (!aBucket) {
					aBucket = [];
					oGroup.__cells[sCharcId] = aBucket;
				}
				aBucket.push({
					pos: parseInt(oRow.CharcValuePositionNumber, 10) || 0,
					val: that._formatCellValue(oRow, mMeta[sCharcId])
				});
			});

			// finalise: one output row per object, dynamic cells flattened/joined
			return aOrder.map(function (sKey) {
				var oGroup = oGroups[sKey];
				var oOut = {};

				oCfg.fixedColumns.forEach(function (oFixed) {
					oOut[oFixed.key] = oGroup[oFixed.key];
				});
				oOut.cabinConfig = oGroup.cabinConfig;
				oOut.ownedBy = oGroup.ownedBy;

				aChars.forEach(function (oChar) {
					var aBucket = oGroup.__cells[oChar.CharcInternalID] || [];
					var sValue = aBucket
						.sort(function (a, b) { return a.pos - b.pos; })
						.map(function (e) { return e.val; })
						.filter(function (v) { return v !== "" && v !== null && v !== undefined; })
						.join(", ");
					oOut["C_" + oChar.CharcInternalID] = sValue;
				});

				return oOut;
			});
		},

		/**
		 * Resolve the display value of a single value row, honouring its data type.
		 * @param {object} oRow a value row
		 * @param {object} [oMeta] optional metadata for the characteristic
		 * @returns {string} formatted value
		 */
		_formatCellValue: function (oRow, oMeta) {
			var sType = (oMeta && oMeta.CharcDataType) || oRow.CharcDataType || "CHAR";

			switch (sType) {
				case "NUM":
					if (this._has(oRow.CharcFromNumericValue)) {
						return this._numStr(oRow.CharcFromNumericValue);
					}
					if (this._has(oRow.CharcFromDecimalValue)) {
						return this._numStr(oRow.CharcFromDecimalValue);
					}
					return this._str(oRow.CharcValue);
				case "DATE":
					return this._formatDate(oRow.CharcFromDate) || this._str(oRow.CharcValue);
				case "CURR":
					if (this._has(oRow.CharcFromAmount)) {
						var sAmount = this._numStr(oRow.CharcFromAmount);
						return oRow.Currency ? (sAmount + " " + oRow.Currency) : sAmount;
					}
					return this._str(oRow.CharcValue);
				default:
					return this._str(oRow.CharcValue);
			}
		},

		/* =========================================================== */
		/* dynamic column construction                                 */
		/* =========================================================== */

		/**
		 * Build equipment rows with characteristic name/value children for the report.
		 * @param {object[]} aRows pivoted rows
		 * @param {object[]} aChars ordered characteristics
		 * @returns {object[]} tree-table rows
		 */
		_buildTreeRows: function (aRows, aChars) {
			var mHeaders = this._pageCtx ? this._pageCtx.headers : {};
			var bShowEmpty = !!this._ui().getProperty("/showEmpty");
			var aSelectedCharcIds = this._selectedKeys("charcSelect");
			var aSelectedValues = this._selectedKeys("charcValueFilter");
			var sOdometerId = this._findCharacteristicId(aChars, "Odometer Reading");
			var mOdometer = (this._pageCtx && this._pageCtx.odometer) || {};

			return aRows.map(function (oRow) {
				var oHeader = mHeaders[oRow.objNumber] || {};
				var oOut = {
					TechnicalObject: oRow.objNumber || "",
					TechnicalObjectDescription: oRow.objDesc || "",
					VehicleAge: this._vehicleAge(oHeader.OperationStartDate),
					Class: oRow.objClass || "",
					CabinConfiguration: oRow.cabinConfig,
					EquipmentOwnedBy: oRow.ownedBy,
					OdometerReading: mOdometer[oRow.objNumber] || (sOdometerId ? (oRow["C_" + sOdometerId] || "") : ""),
					StartUpDate: fmtSAPDateISO(oRow.OperationStartDate),
					ManufacturerSerialNumber: oRow.ManufacturerSerialNumber || "",
					TechnicalID: oHeader.TechnicalObjectSortCode || "",
					children: []
				};
				var aChildren = [];
				aChars.forEach(function (oChar) {
					if (aSelectedCharcIds.length && aSelectedCharcIds.indexOf(oChar.CharcInternalID) === -1) {
						return;
					}
					var sVal = oRow["C_" + oChar.CharcInternalID] || "";
					if (aSelectedValues.length) {
						var aMatchingValues = sVal.split(", ").filter(function (sValue) {
							return aSelectedValues.indexOf(sValue) !== -1;
						});
						if (!aMatchingValues.length) {
							return;
						}
						sVal = aMatchingValues.join(", ");
					}
					if (sVal || bShowEmpty) {
						var oChild = Object.assign({}, oOut);
						oChild.SubClassName = oChar.Characteristic;
						oChild.SubClassValue = sVal || "-";
						aChildren.push(oChild);
					}
				});
				var ctx = this._pageCtx;
				if (ctx && (ctx.sortField === "SubClassName" || ctx.sortField === "SubClassValue")) {
					var sSortField = ctx.sortField;
					var bDesc = !!ctx.sortDesc;
					aChildren.sort(function (a, b) {
						var iOrder = (a[sSortField] || "").localeCompare(b[sSortField] || "", undefined, {
							numeric: true,
							sensitivity: "base"
						});
						return bDesc ? -iOrder : iOrder;
					});
				}
				oOut.children = aChildren;
				return oOut;
			}, this);
		},

		_vehicleAge: function (vStartDate) {
			var iMonths = this._vehicleAgeMonths(vStartDate);
			if (iMonths === null) {
				return "";
			}
			var iYears = Math.floor(iMonths / 12);
			iMonths %= 12;
			var oBundle = this._bundle();
			return iYears + " " + oBundle.getText(iYears === 1 ? "vehicleAgeYear" : "vehicleAgeYears") +
				" " + iMonths + " " + oBundle.getText(iMonths === 1 ? "vehicleAgeMonth" : "vehicleAgeMonths");
		},

		_vehicleAgeMonths: function (vStartDate) {
			var sStartDate = fmtSAPDateISO(vStartDate);
			var aDateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sStartDate);
			if (!aDateParts) {
				return null;
			}
			var dStart = new Date(Date.UTC(
				parseInt(aDateParts[1], 10),
				parseInt(aDateParts[2], 10) - 1,
				parseInt(aDateParts[3], 10)
			));
			if (dStart.getUTCFullYear() !== parseInt(aDateParts[1], 10) ||
				dStart.getUTCMonth() !== parseInt(aDateParts[2], 10) - 1 ||
				dStart.getUTCDate() !== parseInt(aDateParts[3], 10)) {
				return null;
			}
			var dToday = new Date();
			var iMonths = (dToday.getUTCFullYear() - dStart.getUTCFullYear()) * 12 +
				dToday.getUTCMonth() - dStart.getUTCMonth();
			if (dToday.getUTCDate() < dStart.getUTCDate()) {
				iMonths--;
			}
			return Math.max(0, iMonths);
		},

		_getVehicleAgeRange: function () {
			var oFrom = this.byId("vehicleAgeFrom");
			var oTo = this.byId("vehicleAgeTo");
			var sFrom = oFrom ? (oFrom.getValue() || "").trim() : "";
			var sTo = oTo ? (oTo.getValue() || "").trim() : "";
			var iFrom = sFrom ? Number(sFrom) : null;
			var iTo = sTo ? Number(sTo) : null;
			var sError = "";
			var bInvalidFrom = sFrom !== "" && (!/^\d+$/.test(sFrom) || !isFinite(iFrom));
			var bInvalidTo = sTo !== "" && (!/^\d+$/.test(sTo) || !isFinite(iTo));

			if (bInvalidFrom || bInvalidTo) {
				sError = this._bundle().getText("vehicleAgeRangeInvalid");
			} else if (iFrom !== null && iTo !== null && iFrom > iTo) {
				sError = this._bundle().getText("vehicleAgeRangeOrderInvalid");
			}

			[oFrom, oTo].forEach(function (oInput) {
				if (oInput) {
					oInput.setValueState(sError ? "Error" : "None");
					oInput.setValueStateText(sError);
				}
			});

			return {
				valid: !sError,
				error: sError,
				active: sFrom !== "" || sTo !== "",
				from: iFrom,
				to: iTo
			};
		},

		_buildColumns: function (aChars, oCfg) {
			// Keep the flat column model for spreadsheet export and sorting.
			this._resultFilters = {};
			this._globalSearch = "";

			var aColumnConfig = [];

			// fixed object-master columns
			oCfg.fixedColumns.forEach(function (oFixed) {
				aColumnConfig.push({ label: oFixed.label, property: oFixed.key });
			});

			// dynamic columns: one per characteristic, in position order
			aChars.forEach(function (oChar) {
				aColumnConfig.push({ label: oChar.Characteristic, property: "C_" + oChar.CharcInternalID });
			});

			this._ui().setProperty("/columnConfig", aColumnConfig);

			// sortable fields used by the result toolbar
			this._ui().setProperty("/sortFields", [
				{ key: "TechnicalObject", label: this._bundle().getText("colTechnicalObject") },
				{ key: "TechnicalObjectDescription", label: this._bundle().getText("colTechnicalObjectDescription") },
				{ key: "VehicleAge", label: this._bundle().getText("colVehicleAge") },
				{ key: "Class", label: this._bundle().getText("colClass") },
				{ key: "SubClassName", label: this._bundle().getText("colSubClassName") },
				{ key: "SubClassValue", label: this._bundle().getText("colSubClassValue") },
				{ key: "CabinConfiguration", label: this._bundle().getText("filterCabinConfig") },
				{ key: "EquipmentOwnedBy", label: this._bundle().getText("filterOwnedBy") },
				{ key: "OdometerReading", label: this._bundle().getText("filterOdometer") },
				{ key: "StartUpDate", label: this._bundle().getText("colStartUpGeneralData") }
			]);
		},

		/**
		 * Rebuild the whole-class filter fields in the filter bar — one per
		 * characteristic plus the object number. They live in the "Adapt Filters"
		 * dialog (visibleInFilterBar=false); the values are read on Go and applied
		 * server-side across the whole class (see _readCriteria/_applyCriteria).
		 * @param {object[]} aColumnConfig [{label, property}]
		 */
		_buildValueFilters: function (aColumnConfig) {
			var oFilterBar = this.byId("filterbar");
			if (!oFilterBar) {
				return;
			}

			// remove previously generated value-filter items
			oFilterBar.getFilterGroupItems()
				.filter(function (oItem) { return oItem.getGroupName() === "values"; })
				.forEach(function (oItem) {
					oFilterBar.removeFilterGroupItem(oItem);
					oItem.destroy();
				});

			var sGroupTitle = this._bundle().getText("valueFilterGroupTitle");

			aColumnConfig.forEach(function (oCol) {
				// only object number + characteristics are server-filterable
				if (oCol.property !== "objNumber" && oCol.property.indexOf("C_") !== 0) {
					return;
				}
				var oInput = new Input({ value: "", placeholder: oCol.label });
				oInput.data("prop", oCol.property);

				oFilterBar.addFilterGroupItem(new FilterGroupItem({
					groupName: "values",
					groupTitle: sGroupTitle,
					name: oCol.property,
					label: oCol.label,
					visibleInFilterBar: false,
					control: oInput
				}));
			});
		},

		/* =========================================================== */
		/* result filtering (in-memory)                                */
		/* =========================================================== */

		/**
		 * Record a single property's filter value and re-apply the combined filter.
		 * @param {string} sProp column property
		 * @param {string} sValue filter text ("" clears it)
		 */
		_setResultFilter: function (sProp, sValue) {
			if (sValue && sValue.trim()) {
				this._resultFilters[sProp] = sValue.trim();
			} else {
				delete this._resultFilters[sProp];
			}
			this._applyResultFilters();
		},

		/**
		 * Rebuild the binding filter from every per-column filter (AND) plus the
		 * global search (OR across all columns), then refresh the count.
		 */
		_applyResultFilters: function () {
			// list-only build: the in-grid result filter no longer exists
			var oTable = this.byId("resultTable");
			if (!oTable) {
				return;
			}
			var oBinding = oTable.getBinding("rows");
			if (!oBinding) {
				return;
			}

			var aFilters = Object.keys(this._resultFilters).map(function (sProp) {
				return new Filter(sProp, FilterOperator.Contains, this._resultFilters[sProp]);
			}, this);

			if (this._globalSearch) {
				var aCols = this._ui().getProperty("/columnConfig") || [];
				var aOr = aCols.map(function (oCol) {
					return new Filter(oCol.property, FilterOperator.Contains, this._globalSearch);
				}, this);
				if (aOr.length) {
					aFilters.push(new Filter({ filters: aOr, and: false }));
				}
			}

			oBinding.filter(aFilters.length ? new Filter({ filters: aFilters, and: true }) : []);

			// Filters are page-local (server paging). Paging owns the main title;
			// here we only annotate the page label with the on-page match count.
			if (aFilters.length) {
				var iShown = oBinding.getLength();
				var iPageRows = (this._ui().getProperty("/rows") || []).length;
				this._ui().setProperty("/pageInfo", this._bundle().getText("pageInfoFiltered", [iShown, iPageRows]));
			} else if (this._currentPage !== undefined) {
				// no filter -> restore the normal page label
				this._updatePagination(this._currentPage, this._ui().getProperty("/pageSize") || 25, this._totalObjects || 0);
			}
		},

		/**
		 * Push a value into the dedicated filter-bar field for a property so it
		 * stays consistent when the user filters via the column menu instead.
		 * @param {string} sProp column property
		 * @param {string} sValue filter text
		 */
		_syncValueFilterField: function (sProp, sValue) {
			var oFilterBar = this.byId("filterbar");
			if (!oFilterBar) {
				return;
			}
			oFilterBar.getFilterGroupItems().forEach(function (oItem) {
				if (oItem.getGroupName() === "values" && oItem.getName() === sProp) {
					var oControl = oItem.getControl();
					if (oControl && oControl.setValue) {
						oControl.setValue(sValue || "");
					}
				}
			});
		},

		/* =========================================================== */
		/* OData helper                                                 */
		/* =========================================================== */

		/**
		 * Promisified ODataModel.read returning the result array (or [data] for a single entity).
		 * @param {sap.ui.model.odata.v2.ODataModel} oModel the model
		 * @param {string} sPath entity set / navigation path
		 * @param {object} [mUrlParameters] OData system query options
		 * @returns {Promise<object[]>} result rows
		 */
		_read: function (oModel, sPath, mUrlParameters) {
			var that = this;
			return new Promise(function (resolve, reject) {
				oModel.read(sPath, {
					urlParameters: mUrlParameters,
					success: function (oData) {
						that._onAuthOk();
						if (oData && Array.isArray(oData.results)) {
							resolve(oData.results);
						} else if (oData) {
							resolve([oData]);
						} else {
							resolve([]);
						}
					},
					error: function (oError) {
						if (that._isAuthError(oError)) { that._forceReauth(); }
						reject(oError);
					}
				});
			});
		},

		/* =========================================================== */
		/* small utilities                                             */
		/* =========================================================== */

		_readWithCount: function (oModel, sPath, mUrlParameters) {
			var that = this;
			return new Promise(function (resolve, reject) {
				oModel.read(sPath, {
					urlParameters: mUrlParameters,
					success: function (oData) {
						that._onAuthOk();
						var aResults = (oData && Array.isArray(oData.results)) ? oData.results : (oData ? [oData] : []);
						var iCount = (oData && oData.__count !== undefined) ? parseInt(oData.__count, 10) : aResults.length;
						resolve({ results: aResults, count: isNaN(iCount) ? aResults.length : iCount });
					},
					error: function (oError) {
						if (that._isAuthError(oError)) { that._forceReauth(); }
						reject(oError);
					}
				});
			});
		},

		/* =========================================================== */
		/* auth-expiry handling                                        */
		/* When the approuter / xsuaa session times out the backend    */
		/* returns 401/403 (or an HTML login page) on every OData call  */
		/* and the app silently stops working. We detect that and force */
		/* a full-page reload, which makes the standalone approuter     */
		/* redirect through the IdP login and back with a fresh token.  */
		/* =========================================================== */

		_REAUTH_KEY: "cfaReauthAt",

		// Attach model-level failure listeners so even reads that don't go
		// through _read/_readWithCount (e.g. metadata, bindings) are covered.
		_attachAuthGuards: function () {
			var that = this;
			["class", "charc", "equipment", "funcloc"].forEach(function (sName) {
				var oModel = that._model(sName);
				if (!oModel || oModel.__cfaAuthGuard) { return; }
				oModel.__cfaAuthGuard = true;
				var fnFail = function (oEvent) {
					if (that._isAuthError(oEvent.getParameters ? oEvent.getParameters() : oEvent)) {
						that._forceReauth();
					}
				};
				if (oModel.attachRequestFailed) { oModel.attachRequestFailed(fnFail); }
				if (oModel.attachMetadataFailed) { oModel.attachMetadataFailed(fnFail); }
			});
		},

		// Recognise an authentication / session-expiry failure from the many
		// shapes UI5 surfaces (per-read error object vs. event parameters).
		_isAuthError: function (oErr) {
			if (!oErr) { return false; }
			var oResp = oErr.response || oErr;
			var iStatus = parseInt(oErr.statusCode || oResp.statusCode || oResp.status, 10);
			if (iStatus === 401 || iStatus === 403) { return true; }
			// status 0 = redirect to the IdP that the browser blocked from XHR.
			if (iStatus === 0 && (oErr.statusCode === 0 || oResp.statusCode === 0)) { return true; }
			// Fallback: the approuter answered with the HTML login page instead
			// of JSON/XML (happens when the session cookie is gone).
			var sBody = oErr.responseText || oResp.responseText || oResp.body || "";
			if (typeof sBody === "string" && sBody) {
				var sLower = sBody.slice(0, 4000).toLowerCase();
				if (sLower.indexOf("samlrequest") !== -1 ||
					sLower.indexOf("j_security_check") !== -1 ||
					(sLower.indexOf("<html") !== -1 && sLower.indexOf("login") !== -1)) {
					return true;
				}
			}
			return false;
		},

		// A successful call proves the session is healthy again — clear the
		// re-auth guard so the next genuine expiry can trigger a fresh reload.
		_onAuthOk: function () {
			try {
				if (window.sessionStorage) { window.sessionStorage.removeItem(this._REAUTH_KEY); }
			} catch (e) { /* sessionStorage may be unavailable */ }
		},

		_forceReauth: function () {
			// Guard against reload loops: if we already tried to re-auth very
			// recently and it still failed, the problem isn't a stale session
			// (e.g. a real 403 authorisation error). Surface a message instead.
			var iNow = Date.now();
			var iLast = 0;
			try {
				if (window.sessionStorage) {
					iLast = parseInt(window.sessionStorage.getItem(this._REAUTH_KEY), 10) || 0;
				}
			} catch (e) { /* ignore */ }

			if (iLast && (iNow - iLast) < 30000) {
				// Already reloaded once and it didn't help — stop looping.
				if (!this._bReauthNotified) {
					this._bReauthNotified = true;
					var oUI = this._ui();
					oUI.setProperty("/tableBusy", false);
					oUI.setProperty("/classBusy", false);
					oUI.setProperty("/errorVisible", true);
					oUI.setProperty("/errorText", this._bundle().getText("sessionExpiredManual"));
				}
				return;
			}

			if (this._bReauthInProgress) { return; }
			this._bReauthInProgress = true;
			try {
				if (window.sessionStorage) { window.sessionStorage.setItem(this._REAUTH_KEY, String(iNow)); }
			} catch (e) { /* ignore */ }

			try { MessageToast.show(this._bundle().getText("sessionExpiredReloading")); } catch (e) { /* ignore */ }

			// Full-page navigation so the approuter can run its login redirect.
			window.setTimeout(function () {
				window.location.reload();
			}, 800);
		},

		_ui: function () {
			return this.getView().getModel("ui");
		},

		_model: function (sName) {
			return this.getOwnerComponent().getModel(sName);
		},

		_bundle: function () {
			return this.getOwnerComponent().getModel("i18n").getResourceBundle();
		},

		_esc: function (sValue) {
			// escape single quotes for OData string literals
			return String(sValue == null ? "" : sValue).replace(/'/g, "''");
		},

		_chunk: function (aArray, iSize) {
			var aOut = [];
			for (var i = 0; i < aArray.length; i += iSize) {
				aOut.push(aArray.slice(i, i + iSize));
			}
			return aOut;
		},

		_has: function (v) {
			return v !== undefined && v !== null && v !== "";
		},

		_str: function (v) {
			return (v === undefined || v === null) ? "" : String(v);
		},

		_trimDecimal: function (v) {
			// V2 Edm.Decimal arrives as a string like "12.500000000" — drop trailing zeros.
			var s = String(v);
			if (s.indexOf(".") === -1) {
				return s;
			}
			return s.replace(/0+$/, "").replace(/\.$/, "");
		},

		/**
		 * Format a numeric value for display. SAP returns NUM characteristic values
		 * as Edm.Double, often in exponential form (e.g. "1.0E+00"), which the naive
		 * decimal-trim mangles to "1.0E". Parse it as a real number instead.
		 */
		_numStr: function (v) {
			if (!this._has(v)) {
				return "";
			}
			var n = parseFloat(v);
			return isNaN(n) ? this._str(v) : String(n);
		},

		_epoch: function (v) {
			if (!this._has(v)) {
				return 0;
			}
			if (v instanceof Date) {
				return v.getTime();
			}
			var m = /\/Date\((-?\d+)/.exec(String(v));
			return m ? parseInt(m[1], 10) : 0;
		},

		_formatDate: function (v) {
			if (!this._has(v)) {
				return "";
			}
			var oDate;
			if (v instanceof Date) {
				oDate = v;
			} else if (typeof v === "string") {
				var m = /\/Date\((-?\d+)/.exec(v);
				if (m) {
					oDate = new Date(parseInt(m[1], 10));
				} else {
					return v; // already a display string
				}
			} else {
				return String(v);
			}
			if (!this._oDateFormat) {
				this._oDateFormat = DateFormat.getDateInstance();
			}
			return this._oDateFormat.format(oDate);
		},

		_resetResults: function () {
			var oUI = this._ui();
			this._filterClassLoadToken = (this._filterClassLoadToken || 0) + 1;
			this._subClassLoadToken = (this._subClassLoadToken || 0) + 1;
			oUI.setProperty("/rows", []);
			oUI.setProperty("/treeRows", []);
			oUI.setProperty("/columnConfig", []);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showEmptyState", true);
			oUI.setProperty("/tableTitle", "");
			oUI.setProperty("/pageInfo", "");
			oUI.setProperty("/pagePrevEnabled", false);
			oUI.setProperty("/pageNextEnabled", false);
			this._pageCtx = null;
			this._filterClassCtx = null;
			this._currentPage = 0;
			this._totalObjects = 0;
			this._objectSearch = "";
			this._filteredKeys = null;
			oUI.setProperty("/filterActive", false);
			oUI.setProperty("/filterInfo", "");
			this._clearFilters();
			oUI.setProperty("/charcOptions", []);
			oUI.setProperty("/charcBusy", false);
			oUI.setProperty("/charcValueOptions", []);
			oUI.setProperty("/charcValueBusy", false);
			oUI.setProperty("/cabinConfigOptions", []);
			oUI.setProperty("/equipmentOwnedByOptions", []);
			oUI.setProperty("/plannerOptions", []);
			oUI.setProperty("/plannerBusy", false);
			this._unionCache = null;

			// drop page-local search state
			this._resultFilters = {};
			this._globalSearch = "";
			var oSearch = this.byId("resultSearch");
			if (oSearch) {
				oSearch.setValue("");
			}

			var oTable = this.byId("resultTable");
			if (oTable) {
				oTable.removeAllColumns();
			}
		},

		_showError: function (sText) {
			var oUI = this._ui();
			oUI.setProperty("/errorText", sText);
			oUI.setProperty("/errorVisible", true);
		},

		_hideError: function () {
			var oUI = this._ui();
			oUI.setProperty("/errorVisible", false);
			oUI.setProperty("/errorText", "");
		},

		_extractError: function (oError) {
			if (!oError) {
				return this._bundle().getText("unknownError");
			}
			// Try to surface the backend message from the OData error response.
			if (oError.responseText) {
				try {
					var oBody = JSON.parse(oError.responseText);
					if (oBody && oBody.error && oBody.error.message && oBody.error.message.value) {
						return oBody.error.message.value;
					}
				} catch (e) {
					// responseText was not JSON — fall through
				}
			}
			return oError.message || this._bundle().getText("unknownError");
		}
	});
});
