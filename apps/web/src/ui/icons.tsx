import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, ...rest };
}

export function CheckIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}
export function CrossIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
export function WarnIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5v3.2M8 11.6v.2" />
    </svg>
  );
}
export function DotIcon(p: IconProps) {
  return (
    <svg {...base(p)} stroke="none" fill="currentColor">
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}
export function ClockIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}
export function ChevronIcon({ open, ...p }: IconProps & { open?: boolean }) {
  return (
    <svg {...base(p)} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
export function Spinner({ size = 16, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} className="animate-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" fill="none" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
export function PrintIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 6V2.5h8V6M4 11H2.5V6.5h11V11H12" />
      <path d="M4 9.5h8v4H4z" />
    </svg>
  );
}
export function CopyIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </svg>
  );
}
