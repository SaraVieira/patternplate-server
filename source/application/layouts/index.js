function layout (props) {
	return `<!doctype html>
	<html>
		<head>
			<title>${props.title}</title>
			<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
			${props.reference.style
				.map((style) => style.wrapper(`<link rel="stylesheet" href="${style.uri}">`))
				.join('\n')}
		</head>
		<body>
			${props.content.markup
				.filter((markup) => markup.environment === 'index')
				.map((markup) => markup.content)
				.join('\n')}
			${props.reference.script
				.map((script) => script.wrapper(`<script src="${script.uri}"></script>`))
				.join('\n')}
		</body>
	</html>
	`;
}
export default layout;
