'use client';

import { useState, useEffect } from 'react';
import { SearchModal } from './SearchModal';
import { SearchTrigger } from './SearchTrigger';

export function SearchProvider() {
  const [open, setOpen] = useState(false);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <SearchTrigger onClick={() => setOpen(true)} />
      <SearchModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
