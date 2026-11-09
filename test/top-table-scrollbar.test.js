const assert = require("node:assert/strict");
const test = require("node:test");

let definition;
global.sap = {
	ui: {
		define: function (dependencies, factory) {
			definition = factory({ extend: function (name, implementation) { return implementation; } });
		},
		getCore: function () { return { byId: function () { return table; } }; }
	}
};
global.window = { getComputedStyle: function () { return { direction: "ltr" }; } };

class Observer {
	constructor(callback) { this.callback = callback; }
	observe() {}
	disconnect() { this.disconnected = true; }
}
global.ResizeObserver = Observer;
global.MutationObserver = Observer;

require("../webapp/control/TopTableScrollbar");

function element(width, scrollWidth, left) {
	return {
		clientWidth: width,
		scrollWidth: scrollWidth,
		scrollLeft: 0,
		style: {},
		classList: { contains: function () { return false; } },
		getBoundingClientRect: function () { return { left: left }; },
		addEventListener: function (name, callback) { this.listener = callback; },
		removeEventListener: function () { this.listener = null; }
	};
}

let table;

test("synchronizes both scrollbars and adapts to layout and rendering changes", function () {
	const root = element(800, 800, 20);
	const top = element(500, 1400, 0);
	const topContent = element(0, 0, 0);
	const bottom = element(500, 1400, 220);
	const bottomContent = element(1400, 1400, 0);
	let delegate;
	table = {
		getDomRef: function (suffix) { return suffix === "hsb" ? bottom : bottomContent; },
		addEventDelegate: function (value) { delegate = value; },
		removeEventDelegate: function (value) { assert.equal(value, delegate); delegate = null; }
	};
	const scrollbar = Object.assign({}, definition, {
		getTable: function () { return "table"; },
		getDomRef: function (suffix) {
			return suffix === "scroll" ? top : suffix === "content" ? topContent : root;
		}
	});

	scrollbar.onAfterRendering();
	assert.equal(top.style.display, "block");
	assert.equal(top.style.marginLeft, "200px");
	assert.equal(top.style.width, "500px");
	assert.equal(topContent.style.width, "1400px");

	top.scrollLeft = 300;
	top.listener();
	assert.equal(bottom.scrollLeft, 300);
	bottom.scrollLeft = 600;
	bottom.listener();
	assert.equal(top.scrollLeft, 600);

	bottom.scrollWidth = 500;
	scrollbar._updateScrollbar();
	assert.equal(top.style.display, "none");
	bottom.scrollWidth = 1000;
	scrollbar._updateScrollbar();
	assert.equal(top.style.display, "block");
	assert.equal(topContent.style.width, "1000px");

	delegate.onBeforeRendering();
	assert.equal(top.listener, null);
	assert.equal(bottom.listener, null);
	delegate.onAfterRendering();
	assert.equal(typeof top.listener, "function");
	scrollbar.exit();
	assert.equal(delegate, null);
	assert.equal(top.listener, null);
	assert.equal(bottom.listener, null);
});
