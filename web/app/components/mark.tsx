// The TrulyOpenRouter mark: one monochrome line glyph on a 24 grid, strokes inheriting the text colour.
// The T of Truly with its crossbar as the route: a filled client node on one end, the open host on the
// other. Never recoloured, rotated, or filled in the host ring; minimum size 16px.

export function Mark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="TrulyOpenRouter"
      className={className}
    >
      <path d="M12 7v13" />
      <path d="M5.9 7h9.7" />
      <circle cx="3.6" cy="7" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="7" r="2.8" />
    </svg>
  );
}

/// @notice Mark plus wordmark, for page headers.
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark size={size} />
      <span className="flex items-baseline tracking-[-0.024em]">
        <span className="text-[18px] font-semibold">Truly</span>
        <span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span>
      </span>
    </span>
  );
}
