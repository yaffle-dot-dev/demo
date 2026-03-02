const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.svg"]),
	mimeTypes: {".svg":"image/svg+xml"},
	_: {
		client: {start:"_app/immutable/entry/start.CatDiPhR.js",app:"_app/immutable/entry/app.P7yiUI7u.js",imports:["_app/immutable/entry/start.CatDiPhR.js","_app/immutable/chunks/DZ2OXfsk.js","_app/immutable/chunks/C0wMLhX3.js","_app/immutable/chunks/CjNdWmPA.js","_app/immutable/chunks/keRmnD5T.js","_app/immutable/entry/app.P7yiUI7u.js","_app/immutable/chunks/C0wMLhX3.js","_app/immutable/chunks/BhFlenhc.js","_app/immutable/chunks/B9JY7kjw.js","_app/immutable/chunks/keRmnD5T.js","_app/immutable/chunks/BHTzCGT3.js","_app/immutable/chunks/C2hS6Gk-.js","_app/immutable/chunks/DTdQurqe.js","_app/immutable/chunks/CjNdWmPA.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./chunks/0-4uI0rYQ-.js')),
			__memo(() => import('./chunks/1-vm1Hs_k0.js')),
			__memo(() => import('./chunks/2-B_fnfQNk.js')),
			__memo(() => import('./chunks/3-XuE55sd9.js')),
			__memo(() => import('./chunks/4-DfY7QQVj.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/previews/[id]",
				pattern: /^\/previews\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			},
			{
				id: "/runs/[id]",
				pattern: /^\/runs\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

const prerendered = new Set([]);

const base = "";

export { base, manifest, prerendered };
//# sourceMappingURL=manifest.js.map
