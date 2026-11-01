import path from 'node:path';

// Vendored from sindresorhus/is-path-inside (MIT); see is-path-inside.LICENSE.
export default function isPathInside(childPath, parentPath) {
	const relation = path.relative(parentPath, childPath);

	return Boolean(
		relation &&
		relation !== '..' &&
		!relation.startsWith(`..${path.sep}`) &&
		relation !== path.resolve(childPath)
	);
}
