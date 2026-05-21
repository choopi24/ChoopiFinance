type SegmentSize = "sm" | "md" | "lg";

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: SegmentSize;
}

const SIZE_CLASS: Record<SegmentSize, string> = {
  sm: "cf-segment cf-segment-sm",
  md: "cf-segment",
  lg: "cf-segment cf-segment-lg",
};

export function Segment<T extends string>({ options, value, onChange, size = "md" }: SegmentProps<T>) {
  return (
    <div className={SIZE_CLASS[size]}>
      {options.map((opt) => (
        <button
          key={opt.value}
          className={opt.value === value ? "is-on" : ""}
          onClick={() => onChange(opt.value)}
          type="button"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
