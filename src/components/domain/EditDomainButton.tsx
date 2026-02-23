'use client';

import { useState } from 'react';
import { EditDomainModal } from './EditDomainModal';

interface EditDomainButtonProps {
  domain: {
    id: string;
    slug: string;
    title: string;
    subtitle: string;
    description: string;
    icon: string;
    color: string;
    severity: 'critical' | 'high' | 'medium';
    tags: string[];
    sub_problems: string[];
    best_practices: string[];
  };
}

export function EditDomainButton({ domain }: EditDomainButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-[var(--glass-border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--accent-blue)]/40 cursor-pointer transition-colors duration-200"
        title="编辑问题域"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />
        </svg>
      </button>
      <EditDomainModal open={open} onClose={() => setOpen(false)} domain={domain} />
    </>
  );
}
