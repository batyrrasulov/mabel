/** Minimal Mabel monogram that inherits the surrounding text color. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 17V7l5.5 6 5.5-6v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 4.5h1.75M19.375 3.625v1.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}
