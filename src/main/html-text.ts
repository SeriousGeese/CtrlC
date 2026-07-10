// Tag-strip html into readable plain text, preserving line structure.
//
// Used as the text/plain flavor for html clips that were captured without a
// stored plain-text flavor (pre-migration rows, or sources that only offered
// text/html). The main process has no DOM, so this is regex-based: block
// element boundaries become newlines, <br> becomes a newline, everything
// else is stripped.

const BLOCK_CLOSERS =
  /<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre|section|article|header|footer)\s*>/gi;

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_CLOSERS, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')   // trailing spaces before breaks
    .replace(/\n{3,}/g, '\n\n')   // collapse runs of blank lines
    .trim();
}
