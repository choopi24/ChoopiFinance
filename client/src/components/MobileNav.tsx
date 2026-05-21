import { NavLink } from "react-router-dom";
import { LayoutDashboard, TrendingUp, Plus, Award, Settings } from "lucide-react";

const ITEMS = [
  { to: "/",            icon: <LayoutDashboard size={20} strokeWidth={1.6} />, label: "Home" },
  { to: "/investments", icon: <TrendingUp      size={20} strokeWidth={1.6} />, label: "Invest" },
  { to: "/add",         icon: null,                                             label: "Add",    cta: true },
  { to: "/realized",    icon: <Award           size={20} strokeWidth={1.6} />, label: "P&L" },
  { to: "/settings",    icon: <Settings        size={20} strokeWidth={1.6} />, label: "More" },
];

interface MobileNavProps {
  onAdd?: () => void;
}

export function MobileNav({ onAdd }: MobileNavProps) {
  return (
    <nav className="cf-mobile-nav">
      {ITEMS.map((item) =>
        item.cta ? (
          <button key="add" className="cf-mnav-item" onClick={onAdd} type="button" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            <span className="cf-mnav-cta">
              <Plus size={22} strokeWidth={2} />
            </span>
          </button>
        ) : (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              ["cf-mnav-item", isActive ? "is-active" : ""].filter(Boolean).join(" ")
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        )
      )}
    </nav>
  );
}
