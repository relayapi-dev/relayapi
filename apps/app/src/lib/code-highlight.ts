// Tiny build/runtime syntax highlighter for the marketing code windows.
// Returns an HTML string (escaped, then tokenized) with warm-toned inline
// colors tuned to the cream/clay dark panel. Inline styles are intentional:
// the tokens are generated at runtime, so Tailwind's JIT can't see classes.

export function highlightCode(code: string): string {
	const keywords =
		/\b(const|let|var|function|return|import|from|export|default|if|else|async|await|new|class|try|catch|throw|for|while|of|in|typeof|instanceof|void|null|undefined|true|false)\b/g;
	const strings = /(["'`])(?:(?=(\\?))\2.)*?\1/g;
	const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)/gm;
	const numbers = /\b(\d+\.?\d*)\b/g;

	let out = code
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// Order matters: comments → strings → keywords → numbers.
	out = out.replace(comments, '<span style="color:#857f73">$&</span>');
	out = out.replace(strings, '<span style="color:#a8b78f">$&</span>');
	out = out.replace(keywords, '<span style="color:#d99a63">$&</span>');
	out = out.replace(numbers, '<span style="color:#cbab78">$&</span>');
	return out;
}
