import { describe, expect, it } from 'vitest';
import { LatestRequest } from '../src/lib/latest-request';

describe('LatestRequest', () => {
  it('rejects an older audit response after a newer filter request starts', () => {
    const requests = new LatestRequest();
    const content = requests.begin();
    const session = requests.begin();

    expect(requests.isCurrent(content)).toBe(false);
    expect(requests.isCurrent(session)).toBe(true);
  });

  it('invalidates an in-flight response on unmount', () => {
    const requests = new LatestRequest();
    const token = requests.begin();
    requests.invalidate();
    expect(requests.isCurrent(token)).toBe(false);
  });
});
