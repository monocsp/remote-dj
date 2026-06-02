import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

// Tell React this is an act()-aware test environment (silences the warning).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A trivial pure component to prove the jsdom + react test wiring works.
function Hello({ name }: { name: string }) {
  return <h1>안녕, {name}</h1>;
}

describe('web test wiring', () => {
  it('renders a component into jsdom', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Hello name="DJ" />);
    });

    expect(container.querySelector('h1')?.textContent).toBe('안녕, DJ');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
