sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Sorter",
	"sap/ui/table/Column",
	"sap/ui/table/library",
	"sap/m/Text",
	"sap/m/Label",
	"sap/m/MessageToast",
	"sap/ui/core/format/DateFormat",
	"sap/ui/export/Spreadsheet",
	"sap/ui/export/library"
], function (Controller, JSONModel, Sorter, TableColumn, tableLibrary, Text, Label, MessageToast, DateFormat, Spreadsheet, exportLibrary) {
	"use strict";

	var SortOrder = tableLibrary.SortOrder;
	var EdmType = exportLibrary.EdmType;

	// Only released classes are offered in the picker. '1' = Released in SAP classification.
	var CLASS_STATUS_RELEASED = "1";

	// Cap on rows fetched from the value collection (brief: $top=2000).
	var MAX_VALUE_ROWS = 2000;

	return Controller.extend("com.cfa.charlist.controller.Main", {

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			var oUI = new JSONModel({
				classType: "002",
				classId: "",
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

				errorVisible: false,
				errorText: ""
			});
			this.getView().setModel(oUI, "ui");

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
					expandNav: "to_Equipment",
					objectKeyField: "Equipment",
					fixedColumns: [
						{ key: "objNumber", label: oBundle.getText("colEquipment"), width: "11rem", get: function (sKey) { return sKey; } },
						{ key: "objDesc", label: oBundle.getText("colDescription"), width: "18rem", get: function (sKey, oHeader) { return oHeader.EquipmentName; } },
						{ key: "objClass", label: oBundle.getText("colClass"), width: "11rem", get: function (sKey, oHeader, oRow) { return oRow.Class; } },
						{ key: "MaintenancePlant", label: oBundle.getText("colMaintPlant"), width: "9rem", get: function (sKey, oHeader) { return oHeader.MaintenancePlant; } }
					]
				},
				"003": {
					enabled: false,
					modelName: "funcloc",
					valueSet: "/Value",
					expandNav: "to_FunctionalLocation",
					objectKeyField: "FunctionalLocation",
					fixedColumns: [
						{ key: "objNumber", label: oBundle.getText("colFuncLoc"), width: "14rem", get: function (sKey) { return sKey; } },
						{ key: "objDesc", label: oBundle.getText("colDescription"), width: "18rem", get: function (sKey, oHeader) { return oHeader.FunctionalLocationName; } },
						{ key: "objClass", label: oBundle.getText("colClass"), width: "11rem", get: function (sKey, oHeader, oRow) { return oRow.Class; } },
						{ key: "FunctionalLocationCategory", label: oBundle.getText("colCategory"), width: "8rem", get: function (sKey, oHeader) { return oHeader.FunctionalLocationCategory; } },
						{ key: "SuperiorFunctionalLocation", label: oBundle.getText("colSuperiorFL"), width: "14rem", get: function (sKey, oHeader) { return oHeader.SuperiorFunctionalLocation; } }
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
			oUI.setProperty("/classId", "");
			oUI.setProperty("/classes", []);
			oUI.setProperty("/classSelectEnabled", false);

			// Reset the result area back to the initial empty state.
			this._resetResults();

			this._loadClasses(sClassType);
		},

		onClearPress: function () {
			var oUI = this._ui();
			oUI.setProperty("/classId", "");
			this._resetResults();
		},

		onGoPress: function () {
			var oUI = this._ui();
			var sClassType = this.byId("classTypeSelect").getSelectedKey();
			var sClassId = this.byId("classSelect").getSelectedKey();

			this._hideError();

			if (!sClassId) {
				MessageToast.show(this._bundle().getText("selectClassFirst"));
				return;
			}

			var oCfg = this._typeConfig(sClassType);

			// Honour the brief: 002 first; 003 is wired but not enabled in v1.
			if (!oCfg || !oCfg.enabled) {
				this._showError(this._bundle().getText("typeNotSupported"));
				return;
			}

			var oClass = (oUI.getProperty("/classes") || []).filter(function (c) {
				return c.ClassInternalID === sClassId;
			})[0];

			if (!oClass) {
				this._showError(this._bundle().getText("classNotFound"));
				return;
			}

			this._loadResults(oCfg, sClassId, oClass);
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
			oTable.getBinding("rows").sort(new Sorter(sProperty, bDescending));

			// Reflect the sort indicator on the active column only.
			oTable.getColumns().forEach(function (c) {
				var bActive = c === oColumn;
				c.setSorted(bActive);
				if (bActive) {
					c.setSortOrder(sNewOrder);
				}
			});
		},

		onExport: function () {
			var oUI = this._ui();
			var aColumns = oUI.getProperty("/columnConfig") || [];
			var aRows = oUI.getProperty("/rows") || [];

			if (!aRows.length) {
				MessageToast.show(this._bundle().getText("nothingToExport"));
				return;
			}

			var oSettings = {
				workbook: {
					columns: aColumns.map(function (c) {
						return { label: c.label, property: c.property, type: EdmType.String };
					})
				},
				dataSource: aRows,
				fileName: "CharacteristicsReport.xlsx"
			};

			var oSheet = new Spreadsheet(oSettings);
			oSheet.build().finally(function () {
				oSheet.destroy();
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

		_loadResults: async function (oCfg, sClassId, oClass) {
			var oUI = this._ui();
			oUI.setProperty("/showEmptyState", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/tableBusy", true);

			try {
				// 1. characteristic structure = the dynamic columns, in user sequence
				var aChars = await this._fetchCharacteristics(sClassId);

				// 2. optional characteristic metadata for cell formatting
				var mMeta = await this._fetchCharcMetadata(aChars);

				// 3. the actual values for the chosen class
				var aValues = await this._fetchValues(oCfg, oClass.Class);

				// 4. pivot tall -> wide
				var aRows = this._pivotData(aValues, aChars, mMeta, oCfg);

				// 5. build the columns (fixed + one per characteristic)
				this._buildColumns(aChars, oCfg);

				oUI.setProperty("/rows", aRows);

				if (aRows.length === 0) {
					oUI.setProperty("/showTable", false);
					oUI.setProperty("/showNoData", true);
					oUI.setProperty("/noDataTitle", this._bundle().getText("noDataTitle", [oClass.Class]));
				} else {
					oUI.setProperty("/showNoData", false);
					oUI.setProperty("/showTable", true);
					oUI.setProperty("/tableTitle", this._bundle().getText("tableTitle", [aRows.length]));
				}
			} catch (oError) {
				this._showError(this._bundle().getText("dataLoadError", [this._extractError(oError)]));
				oUI.setProperty("/showEmptyState", true);
			} finally {
				oUI.setProperty("/tableBusy", false);
			}
		},

		/**
		 * API 1 — ordered, display-relevant characteristics of the class.
		 * @param {string} sClassId ClassInternalID
		 * @returns {Promise<object[]>} characteristics sorted by CharcPositionNumber
		 */
		_fetchCharacteristics: async function (sClassId) {
			var oModel = this._model("class");
			var sPath = "/A_ClfnClassForKeyDate('" + this._esc(sClassId) + "')/to_ClassCharacteristic";

			var aResults = await this._read(oModel, sPath, {
				"$filter": "CharcIsDisplayRelevant eq 'X'",
				"$orderby": "CharcPositionNumber",
				"$select": "CharcInternalID,Characteristic,CharcPositionNumber"
			});

			// Guard the ordering client-side too (orderby is also applied server-side).
			return aResults.slice().sort(function (a, b) {
				return (parseInt(a.CharcPositionNumber, 10) || 0) - (parseInt(b.CharcPositionNumber, 10) || 0);
			});
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
						"$select": "CharcInternalID,CharcDataType,CharcDecimals,CharcValueUnit,Currency"
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
		 * API 3/4 — value rows for one class, with the object header expanded.
		 * @param {object} oCfg the per-type config
		 * @param {string} sClassName the readable Class code
		 * @returns {Promise<object[]>} value rows
		 */
		_fetchValues: function (oCfg, sClassName) {
			var oModel = this._model(oCfg.modelName);
			return this._read(oModel, oCfg.valueSet, {
				"$filter": "Class eq '" + this._esc(sClassName) + "'",
				"$top": MAX_VALUE_ROWS,
				"$expand": oCfg.expandNav
			});
		},

		/* =========================================================== */
		/* pivot: tall (object,charc,value) rows -> wide object rows    */
		/* =========================================================== */

		_pivotData: function (aValues, aChars, mMeta, oCfg) {
			var that = this;
			var sKeyField = oCfg.objectKeyField;
			var oGroups = {};
			var aOrder = [];

			aValues.forEach(function (oRow) {
				var sKey = oRow[sKeyField];
				if (!sKey) {
					return;
				}

				var oGroup = oGroups[sKey];
				if (!oGroup) {
					var oHeader = oRow[oCfg.expandNav] || {};
					oGroup = { __key: sKey, __header: oHeader, __anchor: oRow, __cells: {} };

					// fixed columns
					oCfg.fixedColumns.forEach(function (oFixed) {
						var vValue = oFixed.get(sKey, oHeader, oRow);
						oGroup[oFixed.key] = (vValue === undefined || vValue === null) ? "" : String(vValue);
					});

					oGroups[sKey] = oGroup;
					aOrder.push(sKey);
				}

				// characteristic cell — accumulate for multi-value handling
				var sCharcId = oRow.CharcInternalID;
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
						return this._trimDecimal(oRow.CharcFromNumericValue);
					}
					if (this._has(oRow.CharcFromDecimalValue)) {
						return this._trimDecimal(oRow.CharcFromDecimalValue);
					}
					return this._str(oRow.CharcValue);
				case "DATE":
					return this._formatDate(oRow.CharcFromDate) || this._str(oRow.CharcValue);
				case "CURR":
					if (this._has(oRow.CharcFromAmount)) {
						var sAmount = this._trimDecimal(oRow.CharcFromAmount);
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

		_buildColumns: function (aChars, oCfg) {
			var oTable = this.byId("resultTable");
			oTable.removeAllColumns();

			var aColumnConfig = [];

			// fixed columns (frozen, leftmost)
			oCfg.fixedColumns.forEach(function (oFixed) {
				oTable.addColumn(new TableColumn({
					label: new Label({ text: oFixed.label }),
					template: new Text({ text: "{ui>" + oFixed.key + "}", wrapping: false }),
					width: oFixed.width,
					sortProperty: oFixed.key,
					autoResizable: true
				}));
				aColumnConfig.push({ label: oFixed.label, property: oFixed.key });
			});

			// freeze the fixed columns
			oTable.setFixedColumnCount(oCfg.fixedColumns.length);

			// dynamic columns: one per characteristic, in position order
			aChars.forEach(function (oChar) {
				var sProp = "C_" + oChar.CharcInternalID;
				oTable.addColumn(new TableColumn({
					label: new Label({ text: oChar.Characteristic, tooltip: oChar.Characteristic }),
					template: new Text({ text: "{ui>" + sProp + "}", wrapping: false }),
					width: "10rem",
					sortProperty: sProp,
					autoResizable: true
				}));
				aColumnConfig.push({ label: oChar.Characteristic, property: sProp });
			});

			this._ui().setProperty("/columnConfig", aColumnConfig);
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
			return new Promise(function (resolve, reject) {
				oModel.read(sPath, {
					urlParameters: mUrlParameters,
					success: function (oData) {
						if (oData && Array.isArray(oData.results)) {
							resolve(oData.results);
						} else if (oData) {
							resolve([oData]);
						} else {
							resolve([]);
						}
					},
					error: reject
				});
			});
		},

		/* =========================================================== */
		/* small utilities                                             */
		/* =========================================================== */

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
			oUI.setProperty("/rows", []);
			oUI.setProperty("/columnConfig", []);
			oUI.setProperty("/showTable", false);
			oUI.setProperty("/showNoData", false);
			oUI.setProperty("/showEmptyState", true);
			oUI.setProperty("/tableTitle", "");
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
