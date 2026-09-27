import { useId } from 'react';
import './brand.css';

export default function BrandLogo() {
  const filterId = useId();
  return (
    <svg
      className="terra-logo"
      viewBox="133 91 1906 472"
      aria-hidden="true"
      focusable="false"
      style={{ '--logo-filter': `url(#${filterId})` }}
    >
      <defs>
        <filter id={filterId} colorInterpolationFilters="sRGB">
          {/* Lift the dark ink for dark surfaces while preserving the red accent. */}
          <feColorMatrix values="0 -1 0 0 1  -1 0 0 0 1  -1 0 0 0 1  0 0 0 1 0" />
        </filter>
      </defs>
      <image className="terra-logo__art" href="/terra-ai.png" width="2172" height="724" />
    </svg>
  );
}
