import path from 'path';
import {debuglog} from 'util';

import boxen from 'boxen';
import {merge, uniq} from 'lodash';
import {padEnd, padStart} from 'lodash/fp';
import minimatch from 'minimatch';
import ora from 'ora';
import throat from 'throat';

import getEnvironments from '../../../library/utilities/get-environments';
import getPatternMtimes from '../../../library/utilities/get-pattern-mtimes';
import getPatterns from '../../../library/utilities/get-patterns';
import writeSafe from '../../../library/filesystem/write-safe';
import {loadTransforms} from '../../../library/transforms';
import {normalizeFormats} from '../../../library/pattern';

/*
import {resolve} from 'path';

import exists from 'path-exists';

import copyDirectory from '../../../library/filesystem/copy-directory';
import makeDirectory from '../../../library/filesystem/make-directory';
import {ok, wait, warn} from '../../../library/log/decorations';

export default async application => {
	const cwd = application.runtime.patterncwd || application.runtime.cwd;
	const staticRoot = resolve(cwd, 'static');
	const assetRoot = resolve(cwd, 'assets');

	const buildRoot = resolve(cwd, 'build');
	const buildDirectory = resolve(buildRoot, `build-bundles`);
	const patternBuildDirectory = resolve(buildDirectory, 'patterns');

	if (await exists(staticRoot)) {
		const staticTarget = resolve(patternBuildDirectory, 'static');
		application.log.info(wait`Copying asset files from "${assetRoot}" to ${staticTarget}`);
		await makeDirectory(staticTarget);
		await copyDirectory(staticRoot, staticTarget);
		application.log.info(ok`Copied asset files`);
	} else {
		application.log.warn(warn`No asset files at "${staticRoot}"`);
	}
};
*/

export default async (application, settings) => {
	if (!settings) {
		throw new Error('build-bundles is not configured in .tasks');
	}

	if (!settings.patterns) {
		throw new Error('build-bundles dependens on valid patterns config');
	}

	if (!settings.transforms) {
		throw new Error('build-bundles dependens on valid transfoms config');
	}

	const debug = debuglog('bundles');
	const spinner = ora().start();

	debug('calling bundles with');
	debug(settings);

	const cwd = process.cwd();
	const base = path.resolve(cwd, 'patterns');
	const buildBase = path.resolve(cwd, 'build', `build-bundles`);

	const {
		cache, log, transforms,
		pattern: {factory}
	} = application;

	// Override pattern config
	settings.patterns.formats = normalizeFormats(settings.patterns.formats);
	application.configuration.patterns = settings.patterns;

	// Reinitialize transforms
	application.configuration.transforms = settings.transforms || {};
	application.transforms = (await loadTransforms(settings.transforms || {}))(application);

	const warnings = [];
	const warn = application.log.warn;
	application.log.warn = (...args) => {
		if (args.some(arg => arg.includes('Deprecation'))) {
			warnings.push(args);
			return;
		}
		warn(...args);
	};

	// Get environments
	const loadedEnvironments = await getEnvironments(base, {
		cache,
		log
	});

	// Environments have to apply on all patterns
	const environments = loadedEnvironments.map(environment => {
		environment.applyTo = '**/*';
		return environment;
	});

	// Get available patterns
	const availablePatterns = await getPatternMtimes(base, {
		resolveDependencies: true
	});

	let envCount = 1;
	const envs = environments
		.filter(environment => environment.include && environment.include.length);

	spinner.stop();

	const envMaxLength = envs.map(e => e.name.length).reduce((a, b) => a > b ? a : b, 0);
	const envMaxPad = padEnd(envMaxLength + 1);
	const envCountPad = padStart(String(envs.length).length);

	// For each environment with an include key, build a bundle for each enabled format
	await Promise.all(envs
		.map(throat(1, async environment => {
			const {environment: envConfig, include, exclude, formats} = environment;
			const includePatterns = include || [];
			const excludePatterns = exclude || ['@'];
			const envSpinner = ora().start();
			const envr = `${envMaxPad(environment.name)} [env: ${envCountPad(envCount)}/${envs.length}]`;

			// Get patterns matching the include config
			const includedPatterns = availablePatterns.filter(available => {
				const {id} = available;
				return includePatterns.some(pattern => minimatch(id, pattern)) &&
					!excludePatterns.concat('@environments/**/*').some(pattern => minimatch(id, pattern));
			});

			if (!includedPatterns.length) {
				application.log.warn(`No patterns to read for environment ${environment.name}. Check the .includes key of the environment configuration.`);
			}

			// Merge environment config into transform config
			const config = merge(
				{},
				{
					patterns: settings.patterns,
					transforms: settings.transforms
				},
				envConfig,
				{
					environments: [environment.name]
				}
			);

			const filters = merge({}, settings.filters, {
				inFormats: formats,
				environments: [environment.name]
			});

			let read = 0;
			const readPad = padStart(String(includedPatterns.length).length);

			// build all patterns matching the include config
			const readPatterns = await Promise.all(includedPatterns
				.map(throat(1, async pattern => {
					const {id} = pattern;
					envSpinner.text = `${envr}: read [patterns: ${readPad(read)}/${includedPatterns.length}] ${pattern.id}`;

					const [result] = await getPatterns({
						id,
						base,
						config,
						factory,
						transforms,
						log,
						filters,
						environment
					}, cache, ['read']);

					read += 1;
					return result;
				})));

			// construct a virtual pattern
			const bundlePattern = await factory(
				environment.name,
				base,
				config,
				transforms,
				filters,
				cache
			);

			envSpinner.text = `${envr}: read ✔`;

			// add the built patterns as dependencies
			const env = {name: environment.name, version: environment.version};
			envSpinner.text = `${envr}: read ✔ | transform`;
			bundlePattern.inject(env, readPatterns);

			// build the bundle
			const builtBundle = await bundlePattern.transform();
			envSpinner.text = `${envr}: read ✔ | transform ✔`;

			let writeCount = 0;
			const artifacts = Object.entries(builtBundle.results);
			// write the bundle
			const writing = artifacts
				.map(throat(1, async entry => {
					const [resultName, result] = entry;
					const resultPath = path.resolve(
						buildBase,
						resultName.toLowerCase(),
						`${environment.name}.${result.out}`
					);
					envSpinner.text = `${envr}: read ✔ | transform ✔ | write [files: ${writeCount}/${artifacts.length}]`;
					const written = await writeSafe(resultPath, result.buffer);
					writeCount += 1;
					return written;
				}));

			await Promise.all(writing);
			envSpinner.text = `${envr}: read ✔ | transform ✔ | write ✔`;
			envSpinner.succeed();
			envSpinner.stop();
			envCount += 1;
		}
	)));

	spinner.stop();

	const messages = uniq(warnings)
		.map(warning => warning.join(' '));

	messages.forEach(message => {
		console.log(boxen(message, {borderColor: 'yellow', padding: 1}));
	});
};
