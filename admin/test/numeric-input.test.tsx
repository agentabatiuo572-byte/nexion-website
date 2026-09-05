// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NumericInput, parseNumericInput } from '../src/lib/numeric-input';

afterEach(cleanup);

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <NumericInput aria-label="number" value={value} onValueChange={setValue} />;
}

describe('NumericInput', () => {
  it('preserves decimal keystroke intermediate states instead of rewriting them as integers', () => {
    const view = render(<Harness initial="" />);
    const input = view.getByLabelText('number') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '0.' } });
    expect(input.value).toBe('0.');
    fireEvent.change(input, { target: { value: '0.25' } });
    expect(input.value).toBe('0.25');

    fireEvent.change(input, { target: { value: '1.' } });
    expect(input.value).toBe('1.');
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(input.value).toBe('1.5');
  });

  it('converts only at the validation or submit boundary', () => {
    expect(parseNumericInput('0.25')).toBe(0.25);
    expect(parseNumericInput('1.5')).toBe(1.5);
    expect(parseNumericInput('')).toBeNull();
    expect(parseNumericInput('not-a-number')).toBeNull();
  });
});
