export const metadata = {
  title: "RecruiterOS Backend",
  description: "LinkedIn engine, campaigns, prospects, response inbox, and team auth API.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0c0c14", color: "#f4f4f8", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
