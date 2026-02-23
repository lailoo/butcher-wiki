'use client';

interface SolutionCardProps {
  solution: {
    project: string;
    title: string;
    design_philosophy: string[];
    pros: string[];
    cons: string[];
    applicable_scenarios: string[];
  };
  color: string;
}

export function SolutionCard({ solution, color }: SolutionCardProps) {
  return (
    <div
      className="glass-card relative p-6 overflow-hidden"
      style={{ '--glow-color': `${color}40` } as React.CSSProperties}
      data-color={color}
    >
      {/* Project badge */}
      <div className="flex items-center gap-2 mb-4">
        <div
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm font-medium text-[var(--text-primary)]">{solution.project}</span>
      </div>

      {/* Title */}
      <h3 className="text-base font-medium text-[var(--text-primary)] mb-3">{solution.title}</h3>

      {/* Design Philosophy */}
      <div className="mb-4">
        <p className="text-xs text-[var(--text-muted)] mb-2">设计思想</p>
        <ul className="space-y-1">
          {solution.design_philosophy.map((p, i) => (
            <li key={i} className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
              <span className="text-[var(--text-muted)] mt-0.5">›</span>
              {p}
            </li>
          ))}
        </ul>
      </div>

      {/* Pros & Cons */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-xs text-emerald-400/60 mb-1.5">优势</p>
          {solution.pros.slice(0, 3).map((p, i) => (
            <p key={i} className="text-xs text-[var(--text-secondary)] mb-1">+ {p}</p>
          ))}
        </div>
        <div>
          <p className="text-xs text-rose-400/60 mb-1.5">劣势</p>
          {solution.cons.slice(0, 3).map((c, i) => (
            <p key={i} className="text-xs text-[var(--text-secondary)] mb-1">- {c}</p>
          ))}
        </div>
      </div>

      {/* Scenarios */}
      <div className="flex flex-wrap gap-1.5">
        {solution.applicable_scenarios.slice(0, 3).map((s, i) => (
          <span
            key={i}
            className="text-[10px] text-[var(--text-muted)] bg-[var(--code-bg)] px-2 py-0.5 rounded-full"
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
