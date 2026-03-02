
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/" | "/previews" | "/previews/[id]" | "/runs" | "/runs/[id]";
		RouteParams(): {
			"/previews/[id]": { id: string };
			"/runs/[id]": { id: string }
		};
		LayoutParams(): {
			"/": { id?: string };
			"/previews": { id?: string };
			"/previews/[id]": { id: string };
			"/runs": { id?: string };
			"/runs/[id]": { id: string }
		};
		Pathname(): "/" | `/previews/${string}` & {} | `/runs/${string}` & {};
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/favicon.svg" | string & {};
	}
}