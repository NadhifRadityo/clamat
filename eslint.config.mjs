import path from "path";
import { includeIgnoreFile } from "@eslint/compat";
import eslintJavascript from "@eslint/js";
import eslintStylistic from "@stylistic/eslint-plugin";
import eslintPerfectionist from "eslint-plugin-perfectionist";
import eslintUnusedImports from "eslint-plugin-unused-imports";
import { defineConfig } from "eslint/config";
import globals from "globals";
import eslintTypescript from "typescript-eslint";

const gitignoreFile = path.join(import.meta.dirname, ".gitignore");
const tsConfigFile = path.join(import.meta.dirname, "tsconfig.json");

export const rootConfig = [
	includeIgnoreFile(gitignoreFile),
	eslintJavascript.configs.recommended,
	{ files: ["**/*.ts"], extends: [eslintTypescript.configs.recommended] },
	eslintStylistic.configs.recommended,
	{
		plugins: {
			"perfectionist": eslintPerfectionist,
			"unused-imports": eslintUnusedImports
		}
	},
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-useless-constructor": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
			"@typescript-eslint/no-non-null-asserted-optional-chain": "error",
			"@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
			"@typescript-eslint/non-nullable-type-assertion-style": "error",
			"@typescript-eslint/strict-boolean-expressions": ["error", {
				allowString: false,
				allowNumber: false,
				allowNullableObject: false
			}]
		}
	},
	{
		rules: {
			"no-empty-pattern": "off",
			"curly": ["warn", "multi-or-nest"],
			"eqeqeq": "off",
			"import/no-anonymous-default-export": "off",
			"no-bitwise": "off",
			"no-return-assign": "off",
			"no-unused-vars": "off",
			"no-useless-constructor": "off",
			"no-empty": ["error", { "allowEmptyCatch": true }],
			"no-constant-condition": ["warn", { "checkLoops": false }],
			"object-shorthand": "off",
			"require-await": "off",
			"unused-imports/no-unused-imports": ["warn"],
			"unused-imports/no-unused-vars": ["warn", {
				vars: "all",
				varsIgnorePattern: "^_",
				args: "after-used",
				argsIgnorePattern: "^_",
				caughtErrors: "all",
				caughtErrorsIgnorePattern: "^_"
			}],
			"perfectionist/sort-imports": ["warn", {
				newlinesBetween: 0,
				type: "natural",
				groups: [
					"value-builtin",
					"value-external",
					"type-builtin",
					"type-external",
					{ newlinesBetween: 1 },
					"value-internal",
					"value-subpath",
					"type-internal",
					"type-subpath",
					{ newlinesBetween: 1 },
					"value-parent",
					"value-sibling",
					"value-index",
					"type-parent",
					"type-sibling",
					"type-index",
					"side-effect-style",
					"ts-equals-import",
					"unknown"
				]
			}],
			"perfectionist/sort-named-imports": ["warn", {
				type: "line-length",
				order: "asc",
				fallbackSort: { type: "natural", order: "asc" },
				groups: ["value-import", "type-import"]
			}],
			"@stylistic/no-trailing-spaces": ["warn"],
			"@stylistic/arrow-parens": ["warn", "as-needed"],
			"@stylistic/semi": ["warn", "always"],
			"@stylistic/no-extra-semi": ["warn"],
			"@stylistic/comma-dangle": ["warn", "never"],
			"@stylistic/indent": ["warn", "tab", { SwitchCase: 1 }],
			"@stylistic/keyword-spacing": ["warn", {
				after: true,
				overrides: {
					if: { after: false },
					for: { after: false },
					while: { after: false },
					catch: { after: false },
					switch: { after: false },
					await: { after: false }
				}
			}],
			"@stylistic/no-tabs": "off",
			"@stylistic/object-curly-spacing": ["warn", "always"],
			"@stylistic/quotes": ["warn", "double", { avoidEscape: true, allowTemplateLiterals: "avoidEscape" }],
			"@stylistic/member-delimiter-style": ["warn", {
				multilineDetection: "brackets",
				multiline: {
					delimiter: "semi",
					requireLast: true
				},
				singleline: {
					delimiter: "comma",
					requireLast: false
				}
			}],
			"@stylistic/indent-binary-ops": ["warn", "tab"],
			"@stylistic/multiline-ternary": "off",
			"@stylistic/operator-linebreak": ["warn", "after"],
			"@stylistic/brace-style": ["warn", "1tbs", { allowSingleLine: true }],
			"@stylistic/max-statements-per-line": ["warn", { max: 5 }],
			"@stylistic/lines-between-class-members": "off",
			"@stylistic/space-before-function-paren": "off",
			"@stylistic/quote-props": "off",
			"@stylistic/no-multi-spaces": ["warn", { ignoreEOLComments: true }]
		}
	}
];

export default defineConfig([
	{
		languageOptions: {
			parser: eslintTypescript.parser,
			parserOptions: {
				project: tsConfigFile,
				tsconfigRootDir: import.meta.dirname
			},
			globals: {
				...globals.node
			}
		}
	},
	...rootConfig
]);
