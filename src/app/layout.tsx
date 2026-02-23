import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { I18nProvider } from '@/i18n/I18nProvider';
import { NavBar } from '@/components/layout/NavBar';

export const metadata: Metadata = {
  title: 'Butcher Wiki — Agent 工程组件切割机',
  description: '把开源项目大卸八块，提取可移植的 Agent 工程组件',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var t = localStorage.getItem('theme');
            if (!t) t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
            document.documentElement.dataset.theme = t;
          })();
        `}} />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var lang = localStorage.getItem('language');
            if (lang === 'en') {
              document.documentElement.lang = 'en';
              document.documentElement.classList.add('i18n-loading');
            }
          })();
        `}} />
      </head>
      <body className="min-h-screen bg-[var(--bg-primary)] transition-colors duration-300">
        <I18nProvider>
          <ThemeProvider>
            <NavBar />
            <main className="pt-20">{children}</main>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
