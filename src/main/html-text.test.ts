import { describe, it, expect } from 'vitest';
import { htmlToText } from './html-text';

describe('htmlToText', () => {
  it('preserves line breaks from block elements and <br>', () => {
    const html =
      '<div>DnD Daily Dev Digest — July 08</div>' +
      '<div><br></div>' +
      '<div>PRs Merged (24h): 34</div>' +
      '<ul><li>Dave 19</li><li>Zach 15</li></ul>' +
      '<p>Commits: 32</p>';
    const text = htmlToText(html);
    expect(text).toBe(
      'DnD Daily Dev Digest — July 08\n\n' +
      'PRs Merged (24h): 34\n' +
      'Dave 19\nZach 15\n\n' +
      'Commits: 32',
    );
  });

  it('strips styles, scripts, and inline tags without adding breaks', () => {
    const html =
      '<style>.a{color:red}</style>' +
      '<span>normal </span><strong>BOLD</strong><span> normal</span>';
    expect(htmlToText(html)).toBe('normal BOLD normal');
  });

  it('decodes common entities', () => {
    expect(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f'))
      .toBe('a & b <c> "d" \'e\' f');
  });

  it('collapses runs of blank lines to one', () => {
    expect(htmlToText('<p>a</p><div><br></div><div><br></div><p>b</p>'))
      .toBe('a\n\nb');
  });
});
