import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  BarChart3,
  Box,
  Calendar,
  Check,
  Crown,
  Download,
  Droplets,
  Hand,
  Home,
  Lock,
  LogOut,
  Milk,
  Minus,
  Package,
  Pencil,
  Phone,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShoppingCart,
  Store,
  Trash2,
  User,
  Users,
  Volume2,
  Wallet,
} from 'lucide-react';
import type { IconName } from '../types';

export function Icon({
  name,
  size = 20,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const cls = `icon ${className}`.trim();
  const props = { size, strokeWidth: 2.2, className: cls, 'aria-hidden': true as const };

  switch (name) {
    case 'sale':
      return <ShoppingCart {...props} />;
    case 'stock':
      return <Package {...props} />;
    case 'wallet':
      return <Wallet {...props} />;
    case 'chart':
      return <BarChart3 {...props} />;
    case 'bottle':
      return <Droplets {...props} />;
    case 'can':
      return <Milk {...props} />;
    case 'crown':
      return <Crown {...props} />;
    case 'box':
      return <Box {...props} />;
    case 'hand':
      return <Hand {...props} />;
    case 'check':
      return <Check {...props} />;
    case 'warning':
      return <AlertTriangle {...props} />;
    case 'speaker':
      return <Volume2 {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'plus':
      return <Plus {...props} />;
    case 'minus':
      return <Minus {...props} />;
    case 'trash':
      return <Trash2 {...props} />;
    case 'edit':
      return <Pencil {...props} />;
    case 'phone':
      return <Phone {...props} />;
    case 'back':
      return <ArrowLeft {...props} />;
    case 'user':
      return <User {...props} />;
    case 'users':
      return <Users {...props} />;
    case 'receipt':
      return <Receipt {...props} />;
    case 'calendar':
      return <Calendar {...props} />;
    case 'refresh':
      return <RefreshCw {...props} />;
    case 'return':
      return <RotateCcw {...props} />;
    case 'home':
      return <Home {...props} />;
    case 'cash':
      return <Banknote {...props} />;
    case 'print':
      return <Printer {...props} />;
    case 'download':
      return <Download {...props} />;
    case 'store':
      return <Store {...props} />;
    case 'shield':
      return <Shield {...props} />;
    case 'lock':
      return <Lock {...props} />;
    case 'logout':
      return <LogOut {...props} />;
    default:
      return <Droplets {...props} />;
  }
}
