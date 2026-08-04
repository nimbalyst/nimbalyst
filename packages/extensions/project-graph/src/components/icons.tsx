import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const baseProps = {
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function IconGraph(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="14" r="2.4" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7.8 7.2 L10.6 12.6 M16.2 7.2 L13.4 12.6 M11 15.6 L6.5 17.6 M13 15.6 L17.5 17.6" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconEyeOpen(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function IconStar(props: IconProps & { filled?: boolean }) {
  const { filled, ...rest } = props;
  return (
    <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <polygon points="12 2 15 9 22 9.3 17 14 18.5 21 12 17.5 5.5 21 7 14 2 9.3 9 9 12 2" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconFit(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <polyline points="4 14 4 20 10 20" />
      <polyline points="20 10 20 4 14 4" />
      <line x1="14" y1="10" x2="20" y2="4" />
      <line x1="4" y1="20" x2="10" y2="14" />
    </svg>
  );
}

export function IconLayout(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconShare(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

export function IconArrow(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M5 3l5 17 3-7 7-3z" />
    </svg>
  );
}

export function IconHand(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M8 13V5a1.5 1.5 0 1 1 3 0v6" />
      <path d="M11 11V4a1.5 1.5 0 1 1 3 0v7" />
      <path d="M14 11V6a1.5 1.5 0 1 1 3 0v8" />
      <path d="M17 8a1.5 1.5 0 1 1 3 0v6a8 8 0 0 1-8 8h-1a8 8 0 0 1-7.4-5l-1.6-4a1.5 1.5 0 0 1 2.4-1.6L6 13" />
    </svg>
  );
}

export function IconLasso(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="9" r="6" />
      <path d="M8 14c-2 2-2 5 0 6" />
    </svg>
  );
}

export function IconLaunch(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M14 3h7v7" />
      <path d="M10 14L21 3" />
      <path d="M21 14v7H3V3h7" />
    </svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}
