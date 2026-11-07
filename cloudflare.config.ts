import { defineConfig, triggers } from "cf/config";

export default defineConfig({
	accountId: "c9bf3d8e875ffe933a9bf895695e0fd1",
	worker: {
		name: "datum-scheduler",
		compatibilityDate: "2026-01-01",
		entrypoint: "src/index.ts",
		triggers: [
			triggers.scheduled({
				schedule: "*/5 * * * *",
			}),
		],
	},
});
