import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../src/components/button';

describe('Button', () => {
  it('asChild renders the child element itself (regression: Slot threw on the loader sibling)', () => {
    const html = renderToStaticMarkup(
      <Button asChild variant="outline">
        <a href="/capture">Report</a>
      </Button>,
    );
    expect(html.startsWith('<a ')).toBe(true);
    expect(html).toContain('href="/capture"');
    expect(html).toContain('inline-flex'); // button styling merged onto the link
    expect(html).not.toContain('<button');
  });

  it('loading disables a plain button and shows the spinner', () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin');
  });
});
