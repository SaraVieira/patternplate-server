import {merge, omit} from 'lodash';

import flatPick from './utilities/flat-pick';
import getPatternRetriever from './utilities/get-pattern-retriever';

async function getPattern(application, id, environment) {
	const retrieve = await getPatternRetriever(application);
	const results = await retrieve(id, {environments: [environment]}, environment);
	return results;
}

export default async function(application, id, environment) {
	const [pattern] = await getPattern(application, id, environment);
	const result = pattern && pattern.toJSON ? pattern.toJSON() : pattern;

	if (!result) {
		return result;
	}

	const copy = omit(merge({}, result), ['results', 'dependencies']);
	copy.results = {index: result.results};
	copy.dependencies = flatPick(result, 'dependencies', ['id', 'manifest']);
	return copy;
}