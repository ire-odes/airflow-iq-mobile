import {
  Thermometer, Droplet, Gauge, Wind, MoveRight, Layers, CloudDrizzle, Smile,
  Cloud, CloudSun, Zap, Sun, LayoutDashboard, HardDrive, Settings, Building2,
  MapPin, Barcode, Clock, Activity, User, Mail, Fingerprint, Lock, Users,
  LogOut, Moon, Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight, AlertTriangle, AlertCircle, CheckCircle2,
  RefreshCw, Play, Pause, SkipBack, AudioWaveform, Sparkles, TrendingUp,
  TrendingDown, Calendar, ArrowLeftRight, Radio, Battery, Wrench, Home,
  Bell, Search, Info, Volume2, BarChart3, Download,
  Truck, Package, ShoppingCart, Store, Receipt, CreditCard, Minus, Crown,
  ExternalLink,
} from "lucide-react";

// Maps the string icon names used in metrics.js / acoustic.js to components.
const ICONS = {
  thermometer: Thermometer, droplet: Droplet, gauge: Gauge, wind: Wind,
  "move-right": MoveRight, layers: Layers, "cloud-drizzle": CloudDrizzle,
  smile: Smile, cloud: Cloud, "cloud-sun": CloudSun, zap: Zap, sun: Sun,
  dashboard: LayoutDashboard, device: HardDrive, settings: Settings,
  building: Building2, location: MapPin, barcode: Barcode, clock: Clock,
  pulse: Activity, user: User, mail: Mail, fingerprint: Fingerprint,
  lock: Lock, users: Users, logout: LogOut, moon: Moon, plus: Plus,
  pencil: Pencil, trash: Trash2, close: X, check: Check,
  "chevron-down": ChevronDown, "chevron-up": ChevronUp,
  "chevron-left": ChevronLeft, "chevron-right": ChevronRight,
  warning: AlertTriangle, alert: AlertCircle, success: CheckCircle2,
  refresh: RefreshCw, play: Play, pause: Pause, restart: SkipBack,
  waveform: AudioWaveform, sparkles: Sparkles, "trending-up": TrendingUp,
  "trending-down": TrendingDown, calendar: Calendar, swap: ArrowLeftRight,
  rfid: Radio, battery: Battery, wrench: Wrench, home: Home, bell: Bell,
  search: Search, info: Info, volume: Volume2, chart: BarChart3,
  download: Download, truck: Truck, package: Package, cart: ShoppingCart,
  store: Store, receipt: Receipt, card: CreditCard, minus: Minus,
  crown: Crown, external: ExternalLink,
};

export default function Icon({ name, size = 16, ...rest }) {
  const Cmp = ICONS[name] || Info;
  return <Cmp size={size} {...rest} />;
}
