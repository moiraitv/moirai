import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import stylistic from '@stylistic/eslint-plugin';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
	{ ignores: ['**/dist/**', '**/coverage/**', '**/vendor/**', 'playwright-report/**'] },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	...vue.configs['flat/recommended'],
	{ plugins: { '@stylistic': stylistic, jsdoc } },
	{
		files: ['**/*.{js,mjs,cjs}'],
		languageOptions: { globals: globals.node },
		rules: {
			'max-lines': ['error', { max: 1050, skipBlankLines: true, skipComments: true }],
			'@stylistic/brace-style': ['error', 'stroustrup'],
			'@stylistic/function-call-argument-newline': ['error', 'consistent'],
			'@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
			'@stylistic/comma-dangle': ['error', 'always-multiline'],
			curly: ['error', 'all'],
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/indent-binary-ops': ['error', 'tab'],
			'@stylistic/max-statements-per-line': ['error', { max: 1 }],
			'@stylistic/no-multi-spaces': 'error',
			'@stylistic/operator-linebreak': ['error', 'before'],
			'@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
			'@stylistic/semi': ['error', 'always'],
			'jsdoc/check-syntax': 'error',
			'jsdoc/check-tag-names': 'error',
			'jsdoc/require-jsdoc': ['error', {
				contexts: [
					'FunctionDeclaration',
					'ClassDeclaration',
					'MethodDefinition:not([kind="constructor"])',
				],
			}],
		},
	},
	{
		files: ['**/*.{ts,tsx,vue}'],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser },
			parser: vueParser,
			parserOptions: { parser: tseslint.parser, sourceType: 'module' },
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'max-lines': ['error', { max: 1250, skipBlankLines: true, skipComments: true }],
			'@stylistic/brace-style': ['error', 'stroustrup'],
			'@stylistic/function-call-argument-newline': ['error', 'consistent'],
			'@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
			'@stylistic/comma-dangle': ['error', 'always-multiline'],
			curly: ['error', 'all'],
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/indent-binary-ops': ['error', 'tab'],
			'@stylistic/max-statements-per-line': ['error', { max: 1 }],
			'@stylistic/no-multi-spaces': 'error',
			'@stylistic/operator-linebreak': ['error', 'before'],
			'@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
			'@stylistic/semi': ['error', 'always'],
			'jsdoc/check-syntax': 'error',
			'jsdoc/check-tag-names': 'error',
			'jsdoc/require-jsdoc': ['error', {
				contexts: [
					'FunctionDeclaration',
					'ClassDeclaration',
					'MethodDefinition:not([kind="constructor"])',
					'TSInterfaceDeclaration',
					'TSTypeAliasDeclaration',
				],
			}],
			'vue/html-closing-bracket-newline': 'off',
			'vue/html-indent': ['error', 'tab', { attribute: 1, baseIndent: 1, closeBracket: 0 }],
			'vue/html-self-closing': 'off',
			'vue/max-attributes-per-line': 'off',
			'vue/multi-word-component-names': 'off',
			'vue/multiline-html-element-content-newline': 'off',
			'vue/singleline-html-element-content-newline': 'off',
		},
	},
	{
		files: ['**/*.{ts,tsx}'],
		rules: {
			'max-lines': ['error', { max: 1050, skipBlankLines: true, skipComments: true }],
		},
	},
	{
		files: ['tests/**/*'],
		rules: {
			'jsdoc/require-jsdoc': 'off',
			'max-lines': 'off',
		},
	},
];
