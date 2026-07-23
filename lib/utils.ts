// Tailwind class merging helper expected by shadcn-style components
// (AI Elements + components/ui/*). Standard implementation per shadcn's
// CLI scaffolding.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
