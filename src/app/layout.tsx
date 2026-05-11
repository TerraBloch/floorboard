import type { ReactNode } from 'react';

/**
 * Root layout. Required by the Next.js App Router even though Floorboard's
 * V1 surface is API-only. The single visible page (src/app/page.tsx) is
 * intentionally bare — Floorboard is a data layer, not a UI.
 */
export const metadata = {
  title: 'Floorboard',
  description: 'Open-data aggregation layer for Bitcoin Ordinals listings.',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
