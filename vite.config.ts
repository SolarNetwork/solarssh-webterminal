import { defineConfig } from "vite";

export default defineConfig({
	root: "src/main",
	publicDir: "../../public",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	base: "./",
	server: {
		port: 8080,
	},
	define: {
		APP_VERSION: JSON.stringify(process.env.npm_package_version),
	},
	// Silence Sass deprecation warnings (Bootstrap).
	// See https://getbootstrap.com/docs/5.3/getting-started/vite/#configure-vite
	css: {
		preprocessorOptions: {
			scss: {
				silenceDeprecations: [
					"import",
					"mixed-decls",
					"color-functions",
					"global-builtin",
				],
			},
		},
	},
});
