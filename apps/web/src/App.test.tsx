import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('foundation screen', () => {
  it('clearly identifies the phase without claiming operational features', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'The Autonomous Dispatch Desk',
    );
    expect(screen.getByRole('region', { name: 'Phase 8 ready for review' })).toBeVisible();
    expect(
      screen.getByText('This screen does not expose delivery data or dispatch actions yet.'),
    ).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
