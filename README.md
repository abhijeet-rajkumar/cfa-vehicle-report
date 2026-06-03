# CFA Technical Object Characteristics Report

A standard (hand-rolled) **SAPUI5** application that replaces the stock *"Find Objects in Classes"* tile. The user picks a **Class Type** and a **Class**, presses **Go**, and gets a List-Report-style grid of every classified object (Equipment or Functional Location) in that class — with **one dynamically generated column per class characteristic**, populated with each object's value.

- **Framework:** SAPUI5 (not Fiori Elements). `sap.m`, `sap.ui.table`, `sap.f`, `sap.ui.comp`, `sap.ui.export`.
- **Theme:** `sap_horizon` (default, no custom branding).
- **OData:** V2, four released SAP S/4HANA Public Cloud APIs.
- **Runtime wiring:** all OData goes through `@sap/approuter` to destination **`S4HC_Connection`** — no direct API calls, no CORS proxy.

> **v1 scope:** Equipment (Class Type **002**) is implemented end-to-end. Functional Location (**003**) is fully wired in the code via a parallel per-type config (`_typeConfig` in [Main.controller.js](webapp/controller/Main.controller.js)) but **disabled** for v1 — selecting it and pressing Go shows an explanatory message. Flip `enabled: true` on the `"003"` config to turn it on once 002 is validated.

---

## Backend APIs (released, V2)

| Purpose | Service | Used for |
|---|---|---|
| Class master | `API_CLFN_CLASS_SRV` | Class picker + ordered characteristic list (dynamic columns) |
| Characteristic master | `API_CLFN_CHARACTERISTIC_SRV` | Optional characteristic metadata for cell formatting |
| Equipment | `API_EQUIPMENT` | Equipment characteristic values + header (Class Type 002) |
| Functional Location | `API_FUNCTIONALLOCATION` | FL characteristic values + header (Class Type 003) |

All four are declared as `dataSources` in [manifest.json](webapp/manifest.json) and registered as named OData V2 models (`class`, `charc`, `equipment`, `funcloc`).

### Data flow on **Go**
1. **Characteristics (columns):** `GET /A_ClfnClassForKeyDate('{ClassInternalID}')/to_ClassCharacteristic?$filter=CharcIsDisplayRelevant eq 'X'&$orderby=CharcPositionNumber`
2. **Metadata (optional):** `GET /A_ClfnCharacteristicForKeyDate?$filter=<OR of CharcInternalID eq '…'>` — chunked, since OData V2 has no `in` operator. Non-fatal: falls back to the value rows' own typing.
3. **Values:** `GET /EquipClassCharacteristicValue?$filter=Class eq '<class>'&$top=2000&$expand=to_Equipment` (002) or `GET /Value?...&$expand=to_FunctionalLocation` (003).
4. **Pivot** tall `(object, characteristic, value)` rows into wide rows in JS (`_pivotData`): group by object key, multi-valued characteristics joined with `, ` in `CharcValuePositionNumber` order, typed values (`NUM`/`DATE`/`CURR`) resolved from the typed fields.
5. **Columns** built dynamically (`_buildColumns`): fixed columns frozen leftmost, one scrollable column per characteristic in `CharcPositionNumber` order.

---

## Project layout

```
.
├── webapp/
│   ├── controller/        App + Main controllers
│   ├── view/              App + Main XML views
│   ├── model/models.js    device model helper
│   ├── i18n/              all visible texts
│   ├── css/style.css      empty placeholder
│   ├── Component.js
│   ├── manifest.json      data sources + named OData models + routing
│   └── index.html         bootstraps UI5 from the CDN
├── router/                standalone approuter module (deploy)
│   ├── package.json       @sap/approuter
│   └── xs-app.json        deploy routes (serves built app from resources/)
├── xs-app.json            LOCAL-DEV approuter routing (serves webapp/)
├── xs-security.json       xsuaa config (xsappname, redirect-uris)
├── mta.yaml               MTA descriptor (UI5 build + approuter + services)
├── ui5.yaml               BAS / destination dev server
├── ui5-local.yaml         pure-local dev server
├── package.json
└── README.md
```

> Two `xs-app.json` files by design: the **root** one is for local development (`localDir: webapp`, used by the local approuter / BAS preview), and **`router/xs-app.json`** is the deployed one (`localDir: resources`, where the built UI5 app is copied at MTA build time).

---

## Running it

### A. In SAP Business Application Studio (recommended)
The dev server proxies `/sap/...` through the **`S4HC_Connection`** destination, so you develop against the real backend.

1. `npm install`
2. Edit [ui5.yaml](ui5.yaml) → set the `backend[0].url` to your S/4HANA Public Cloud host (the `destination` field already targets `S4HC_Connection`; in BAS the destination is honoured).
3. `npm start` → opens `index.html`.

> The destination **`S4HC_Connection`** must exist in your BTP subaccount **and** be visible to BAS (dev space). It must point at the S/4HANA Public Cloud tenant with a **Communication User** authorized for all four APIs (Communication Scenarios: Classification, Equipment, Functional Location).

### B. Pure local (no destination)
Use [ui5-local.yaml](ui5-local.yaml) and point `backend[0].url` at a reachable backend (on-prem gateway, an SSH/`cf ssh` tunnel, or a mock). Auth is whatever that backend expects.

```
npm run start-local
```

> UI5 itself is loaded from the public CDN (pinned `1.120.20` in [index.html](webapp/index.html)), so no UI5 resources destination is needed in either mode.

---

## Deploying to BTP Cloud Foundry

This app runs **standalone behind a standard approuter** (no FLP tile, no HTML5 Application Repository). Deployment is packaged as an **MTA** ([mta.yaml](mta.yaml)) with three pieces:

1. **`cfa-charlist-ui`** — build-only module: runs `npm install` + `npm run build` and emits `dist/`. It deploys nothing on its own; its output is fed to the approuter.
2. **`cfa-charlist-approuter`** ([router/](router/)) — the standalone approuter. At build time the UI5 `dist/` is copied into `router/resources/`, which [router/xs-app.json](router/xs-app.json) serves statically while routing `^/sap/opu/odata/sap/(.*)$` → destination **`S4HC_Connection`** (xsuaa, csrf).
3. **Services** — a managed **`xsuaa`** instance (from [xs-security.json](xs-security.json)) and a managed **`destination`** (lite) instance so the approuter can read the subaccount-level `S4HC_Connection`.

### Build & deploy
```bash
npm install -g mbt        # Cloud MTA Build Tool (one-time)
cf install-plugin multiapps   # MultiApps CF plugin (one-time)

mbt build                 # -> mta_archives/cfa-characteristics-report_1.0.0.mtar
cf deploy mta_archives/cfa-characteristics-report_1.0.0.mtar
```

After deploy, open the `cfa-charlist-approuter` app's route.

### Prerequisites the BTP admin must provide
- **Destination `S4HC_Connection`** at subaccount level → S/4HANA Public Cloud tenant, auth `OAuth2ClientCredentials` (or `BasicAuthentication`) using a **Communication User** with the four communication arrangements active (Classification, Equipment, Functional Location).
- The Cloud Foundry org/space and entitlements for the `xsuaa` (application plan) and `destination` (lite) services.
- Adjust `oauth2-configuration.redirect-uris` in [xs-security.json](xs-security.json) to your landscape's domain (the shipped `https://*.hana.ondemand.com/**` covers the common public regions).

### Auth note (dev vs prod)
- **Production BTP:** `authenticationType: xsuaa` (as shipped in both `xs-app.json` files). Confirm with your destination admin.
- **Local approuter testing:** you may switch the **root** `xs-app.json` routes to `authenticationType: none` and run a standalone approuter with a `default-env.json` that holds the destination + a `destinations` env var. Do **not** ship `none` to production, and never commit `default-env.json` (already git-ignored).

---

## Implemented List-Report features
- Dependent **Class Type → Class** filter bar with an explicit **Go** (no auto-load); Class dropdown disabled until classes load and cleared on type change.
- **Dynamic columns** — never hard-coded; built from the characteristic list.
- **Frozen** fixed columns (object no., description, class, master-data) + scrollable characteristic columns (`sap.ui.table.Table`, Grid).
- In-memory **column sort**, **show/hide** + **freeze** via the column menu, **column reorder**.
- **Export to Spreadsheet** (`sap.ui.export.Spreadsheet`).
- **Total: X** count in the table toolbar.
- Clear **loading / empty / no-data** states and an **error `MessageStrip`** that surfaces the backend message.

## Not in v1 (by design)
No Fiori Elements, no mock data, no tests, no custom branding/CSS, no FLP tile, and no live 003 path.
