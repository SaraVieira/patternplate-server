import {find} from 'lodash';
import getPatternRetriever from './utilities/get-pattern-retriever';

export default async function(application, id, filters, out, environment) {
	filters.environments = [environment].filter(Boolean);

	const [pattern] = await getPatternRetriever(application)(
		id, filters, environment, ['read', 'transform']
	);

	const result = pattern.toJSON ? pattern.toJSON() : pattern;

	// find a file with matching out format
	const file = find(Object.values(result.results), {out}) || {};
	return file.demoBuffer || file.buffer || '';
}
