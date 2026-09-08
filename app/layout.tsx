import './globals.css';
import Script from 'next/script';

export const metadata = {
  title: 'MediaFlow — Download Video & Audio',
  description:
    'Fast, simple media processing for direct public media URLs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}

        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7616310630908369"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}