import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { ToastProvider } from '../components/ui';
import '../styles.css';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'theme-color', content: '#0b6e4f' },
      { title: 'KudiWatch — Pay for real human attention' },
    ],
    links: [{ rel: 'manifest', href: '/manifest.webmanifest' }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ToastProvider>
          <Outlet />
        </ToastProvider>
        <Scripts />
      </body>
    </html>
  );
}
