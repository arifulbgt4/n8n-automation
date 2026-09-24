import Link from "next/link";
import CustomerApp from "../components/CustomerApp";

export default function Home() {
  return (
    <>
      <CustomerApp />
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
