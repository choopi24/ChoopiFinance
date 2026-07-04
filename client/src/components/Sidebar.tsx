import { NavLink } from "react-router-dom";
import { LayoutDashboard, TrendingUp, ArrowLeftRight, Award, Settings, LogOut } from "lucide-react";
import type { NavId } from "@choopi/shared";

interface NavItem {
  id: NavId;
  label: string;
  icon: React.ReactNode;
  to: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "dashboard",    label: "Dashboard",    icon: <LayoutDashboard  size={18} strokeWidth={1.6} />, to: "/dashboard" },
  { id: "investments",  label: "Investments",  icon: <TrendingUp       size={18} strokeWidth={1.6} />, to: "/investments" },
  { id: "transactions", label: "Transactions", icon: <ArrowLeftRight   size={18} strokeWidth={1.6} />, to: "/transactions" },
  { id: "realized",     label: "Realized P&L", icon: <Award            size={18} strokeWidth={1.6} />, to: "/realized" },
  { id: "settings",     label: "Settings",     icon: <Settings         size={18} strokeWidth={1.6} />, to: "/settings" },
];

interface SidebarProps {
  userName?: string;
  userEmail?: string;
  onLogout?: () => void;
}

export function Sidebar({ userName = "You", userEmail, onLogout }: SidebarProps) {
  return (
    <aside className="cf-sidebar">
      <div className="cf-brand">
        <div className="cf-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="22" height="22">
            <defs>
              <linearGradient id="cf-grad-sidebar" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--accent)" />
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#cf-grad-sidebar)" />
            <path d="M11 20.5V11.5a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <circle cx="21" cy="20.5" r="1.5" fill="white" />
          </svg>
        </div>
        <div className="cf-brand-text">
          <div className="cf-brand-name">Choopi</div>
          <div className="cf-brand-sub">Finance</div>
        </div>
      </div>

      <nav className="cf-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => ["cf-nav-item", isActive ? "is-active" : ""].filter(Boolean).join(" ")}
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="cf-side-footer">
        <div className="cf-user">
          <div className="cf-avatar">{userName.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{userName}</div>
            {userEmail && <div style={{ fontSize: 11, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{userEmail}</div>}
          </div>
          {onLogout && (
            <button
              onClick={onLogout}
              style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", display: "flex", padding: 4 }}
              title="Sign out"
            >
              <LogOut size={16} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
