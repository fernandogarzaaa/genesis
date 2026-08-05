import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the Genesis shell', () => {
    render(<App />);
    // The sidebar brand name is always visible when the shell mounts
    expect(screen.getByText('GENESIS')).toBeInTheDocument();
  });
});
