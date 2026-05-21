import {
  LayoutDashboard, TrendingUp, ArrowLeftRight, Award, Settings,
  Sun, Moon, Search, Bell, ChevronDown, ChevronUp, ChevronRight,
  Plus, X, Eye, EyeOff, Copy, Check, LogOut, Wallet, Star,
  AlertTriangle, Info, ArrowUpRight, ArrowDownRight, Minus,
  RefreshCw, Download, Upload, Filter, MoreHorizontal, MoreVertical,
  Home, Layers, PieChart, BarChart2, Landmark, GraduationCap, Package,
  Bitcoin, Building2, Globe, Cpu, Leaf, Gem,
  type LucideProps,
} from "lucide-react";
import type { ElementType } from "react";

const MAP: Record<string, ElementType> = {
  dashboard: LayoutDashboard,
  investments: TrendingUp,
  transactions: ArrowLeftRight,
  realized: Award,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  search: Search,
  bell: Bell,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "chevron-right": ChevronRight,
  plus: Plus,
  x: X,
  eye: Eye,
  "eye-off": EyeOff,
  copy: Copy,
  check: Check,
  logout: LogOut,
  wallet: Wallet,
  star: Star,
  warning: AlertTriangle,
  info: Info,
  "arrow-up-right": ArrowUpRight,
  "arrow-down-right": ArrowDownRight,
  minus: Minus,
  refresh: RefreshCw,
  download: Download,
  upload: Upload,
  filter: Filter,
  "more-h": MoreHorizontal,
  "more-v": MoreVertical,
  home: Home,
  layers: Layers,
  "pie-chart": PieChart,
  "bar-chart": BarChart2,
  landmark: Landmark,
  graduation: GraduationCap,
  package: Package,
  bitcoin: Bitcoin,
  building: Building2,
  globe: Globe,
  cpu: Cpu,
  leaf: Leaf,
  gem: Gem,
};

interface IconProps extends Omit<LucideProps, "ref"> {
  name: string;
}

export function Icon({ name, strokeWidth = 1.6, size = 18, ...rest }: IconProps) {
  const Component = MAP[name] ?? Info;
  return <Component size={size} strokeWidth={strokeWidth} {...rest} />;
}
