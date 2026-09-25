import Link from "next/link";
import CustomerApp from "../components/CustomerApp";
import DashboardV2 from "../components/DashboardV2";
import PlatformManagedAiUi from "../components/PlatformManagedAiUi";

export default function Home() {
  return (
    <>
      <CustomerApp />
      <DashboardV2 />
      <PlatformManagedAiUi />
      <Link
        href="/usage"
        aria-label="Open monthly AI usage"
        style={{
          position: "fixed",
          right: 18,
          bottom: 118,
          zIndex: 60,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderRadius: 999,
          border: "1px solid rgba(79,70,229,.24)",
          background: "#fff",
          color: "#4338ca",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 12px 28px rgba(17,24,39,.12)",
        }}
      >
        AI Usage
      </Link>
      <Link
        href="/channel-ai"
        aria-label="Open channel AI setup"
        style={{
          position: "fixed",
          right: 18,
          bottom: 68,
          zIndex: 60,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderRadius: 999,
          border: "1px solid rgba(79,70,229,.28)",
          background: "#4f46e5",
          color: "#fff",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 12px 28px rgba(79,70,229,.22)",
        }}
      >
        AI Channel Setup
      </Link>
      <Link
        href="/documentation"
        aria-label="Open customer documentation"
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          zIndex: 60,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.18)",
          background: "#111827",
          color: "#fff",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 12px 28px rgba(17,24,39,.22)",
        }}
      >
        ? Documentation
      </Link>
    </>
  );
}
