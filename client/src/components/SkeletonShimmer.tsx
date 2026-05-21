interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  rounded?: boolean;
}

export function SkeletonShimmer({ width, height, className = "", rounded }: SkeletonProps) {
  return (
    <span
      className={["skel", rounded ? "rounded-full" : "rounded-sm", className].filter(Boolean).join(" ")}
      style={{ width, height, display: "block" }}
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="cf-card p-5 flex flex-col gap-3">
      <SkeletonShimmer height={14} width="40%" />
      <SkeletonShimmer height={32} width="60%" />
      {Array.from({ length: lines - 1 }).map((_, i) => (
        <SkeletonShimmer key={i} height={12} width={`${70 - i * 10}%`} />
      ))}
    </div>
  );
}
