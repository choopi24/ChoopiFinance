interface HostPillProps {
  host: string;
  label?: string;
}

export function HostPill({ host, label = "Hosted at" }: HostPillProps) {
  return (
    <div className="cf-host-pill">
      <span className="cf-host-dot" aria-hidden="true" />
      <span className="cf-host-label">{label}</span>
      <span className="cf-host-addr">{host}</span>
    </div>
  );
}
