"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";

type Props = { children: ReactNode };

export default function AdminAccessGuard({ children }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "allowed">("loading");

  useEffect(() => {
    let active = true;
    api<any>("/v1/auth/me")
      .then((result) => {
        const principal = result?.principal;
        if (!principal?.platformAdmin) {
          router.replace("/");
          return;
        }
        if (principal.platformAdminMfaRequired && (!principal.platformAdminMfaEnabled || !principal.mfaVerifiedAt)) {
          router.replace("/");
          return;
        }
        if (active) setState("allowed");
      })
      .catch(() => router.replace("/"));
    return () => { active = false; };
  }, [router]);

  if (state === "loading") return <main className="login-page"><div className="center">Checking administrator access…</div></main>;
  return <>{children}</>;
}
